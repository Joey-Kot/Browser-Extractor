use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime},
};

use tokio::sync::{Mutex, Notify, OwnedSemaphorePermit, RwLock};
use uuid::Uuid;

use crate::{
    capture::CaptureAssembler,
    model::{
        api::{CleanupStatus, ExtractionRequest, ExtractionStats, JobSnapshot, JobStatus},
        capture::CaptureMetadata,
        errors::ErrorDetail,
    },
};

struct JobInner {
    status: JobStatus,
    cleanup_status: CleanupStatus,
    final_url: Option<String>,
    title: Option<String>,
    mime_type: Option<String>,
    markdown: Option<String>,
    html: Option<String>,
    warnings: Vec<crate::model::capture::TraversalWarning>,
    stats: ExtractionStats,
    error: Option<ErrorDetail>,
    completed_at: Option<SystemTime>,
    conversion_done: bool,
}

pub struct JobRecord {
    pub id: Uuid,
    pub request: ExtractionRequest,
    pub created_at: SystemTime,
    inner: RwLock<JobInner>,
    notify: Notify,
    permit: Mutex<Option<OwnedSemaphorePermit>>,
    assembler: Mutex<Option<CaptureAssembler>>,
    inflight_reserved: AtomicU64,
    cleanup_lease_started: AtomicBool,
}

impl JobRecord {
    pub fn new(request: ExtractionRequest) -> Arc<Self> {
        Arc::new(Self {
            id: Uuid::new_v4(),
            request,
            created_at: SystemTime::now(),
            inner: RwLock::new(JobInner {
                status: JobStatus::Queued,
                cleanup_status: CleanupStatus::NotStarted,
                final_url: None,
                title: None,
                mime_type: None,
                markdown: None,
                html: None,
                warnings: Vec::new(),
                stats: ExtractionStats::default(),
                error: None,
                completed_at: None,
                conversion_done: false,
            }),
            notify: Notify::new(),
            permit: Mutex::new(None),
            assembler: Mutex::new(None),
            inflight_reserved: AtomicU64::new(0),
            cleanup_lease_started: AtomicBool::new(false),
        })
    }

    pub async fn snapshot(&self) -> JobSnapshot {
        let inner = self.inner.read().await;
        JobSnapshot {
            id: self.id,
            request: self.request.clone(),
            status: inner.status,
            cleanup_status: inner.cleanup_status,
            final_url: inner.final_url.clone(),
            title: inner.title.clone(),
            mime_type: inner.mime_type.clone(),
            markdown: inner.markdown.clone(),
            html: inner.html.clone(),
            warnings: inner.warnings.clone(),
            stats: inner.stats.clone(),
            error: inner.error.clone(),
            created_at: self.created_at,
            completed_at: inner.completed_at,
        }
    }

    pub async fn status(&self) -> JobStatus {
        self.inner.read().await.status
    }

    pub async fn cleanup_status(&self) -> CleanupStatus {
        self.inner.read().await.cleanup_status
    }

    pub async fn set_status(&self, status: JobStatus) {
        let mut inner = self.inner.write().await;
        if !inner.status.is_terminal() {
            inner.status = status;
        }
    }

    pub async fn set_permit(&self, permit: OwnedSemaphorePermit) {
        *self.permit.lock().await = Some(permit);
    }

    pub async fn has_permit(&self) -> bool {
        self.permit.lock().await.is_some()
    }

    pub async fn release_permit(&self) {
        self.permit.lock().await.take();
    }

    pub async fn install_assembler(
        &self,
        assembler: CaptureAssembler,
    ) -> Result<(), Box<CaptureAssembler>> {
        let mut slot = self.assembler.lock().await;
        if slot.is_some() {
            return Err(Box::new(assembler));
        }
        *slot = Some(assembler);
        Ok(())
    }

    pub async fn with_assembler<T>(
        &self,
        operation: impl FnOnce(&mut CaptureAssembler) -> T,
    ) -> Option<T> {
        let mut slot = self.assembler.lock().await;
        slot.as_mut().map(operation)
    }

    pub async fn take_assembler(&self) -> Option<CaptureAssembler> {
        self.assembler.lock().await.take()
    }

    pub fn add_inflight_reserved(&self, bytes: u64) {
        self.inflight_reserved.fetch_add(bytes, Ordering::Relaxed);
    }

    pub fn take_inflight_reserved(&self) -> u64 {
        self.inflight_reserved.swap(0, Ordering::AcqRel)
    }

    pub fn start_cleanup_lease_once(&self) -> bool {
        !self.cleanup_lease_started.swap(true, Ordering::AcqRel)
    }

    pub async fn mark_capture_complete(
        &self,
        metadata: &CaptureMetadata,
        html_bytes: u64,
        scroll_rounds: u32,
        matched_items: u32,
        warnings: Vec<crate::model::capture::TraversalWarning>,
    ) -> bool {
        let mut inner = self.inner.write().await;
        if inner.status.is_terminal() {
            return false;
        }
        inner.status = JobStatus::Converting;
        inner.cleanup_status = CleanupStatus::Cleaning;
        inner.final_url = Some(metadata.final_url.clone());
        inner.title = Some(metadata.title.clone());
        inner.mime_type = Some(metadata.mime_type.clone());
        inner.stats.html_bytes = html_bytes;
        inner.stats.scroll_rounds = scroll_rounds;
        inner.stats.matched_items = matched_items;
        inner.warnings = warnings;
        true
    }

    pub async fn finish_conversion(&self, markdown: String, html: Option<String>) {
        let mut inner = self.inner.write().await;
        if inner.status.is_terminal() {
            return;
        }
        inner.markdown = Some(markdown);
        inner.html = html;
        inner.conversion_done = true;
        if !inner.status.is_terminal() && inner.cleanup_status == CleanupStatus::Cleaning {
            inner.status = JobStatus::Closing;
        }
        finalize_locked(&mut inner, self.created_at);
        drop(inner);
        self.notify.notify_waiters();
    }

    pub async fn mark_failed(&self, error: ErrorDetail, cleanup_required: bool) {
        let mut inner = self.inner.write().await;
        if inner.status.is_terminal() {
            return;
        }
        inner.status = JobStatus::Failed;
        inner.error = Some(error);
        inner.conversion_done = true;
        inner.cleanup_status = next_cleanup_status(inner.cleanup_status, cleanup_required);
        finalize_locked(&mut inner, self.created_at);
        drop(inner);
        self.notify.notify_waiters();
    }

    pub async fn mark_cancelled(&self, cleanup_required: bool) {
        let mut inner = self.inner.write().await;
        if !inner.status.is_terminal() {
            inner.status = JobStatus::Cancelled;
            inner.error = Some(ErrorDetail::new(
                crate::model::errors::ErrorCode::Cancelled,
                "任务已取消",
                false,
            ));
            inner.conversion_done = true;
        }
        inner.cleanup_status = next_cleanup_status(inner.cleanup_status, cleanup_required);
        finalize_locked(&mut inner, self.created_at);
        drop(inner);
        self.notify.notify_waiters();
    }

    pub async fn mark_timed_out(&self, cleanup_required: bool) {
        let mut inner = self.inner.write().await;
        if !inner.status.is_terminal() {
            inner.status = JobStatus::TimedOut;
            inner.error = Some(ErrorDetail::new(
                crate::model::errors::ErrorCode::JobTimeout,
                "任务超过硬超时",
                true,
            ));
            inner.conversion_done = true;
        }
        inner.cleanup_status = next_cleanup_status(inner.cleanup_status, cleanup_required);
        finalize_locked(&mut inner, self.created_at);
        drop(inner);
        self.notify.notify_waiters();
    }

    pub async fn mark_closed(&self) {
        let mut inner = self.inner.write().await;
        inner.cleanup_status = CleanupStatus::Closed;
        finalize_locked(&mut inner, self.created_at);
        drop(inner);
        self.notify.notify_waiters();
    }

    pub async fn mark_cleanup_unconfirmed(&self) {
        let mut inner = self.inner.write().await;
        if inner.cleanup_status == CleanupStatus::Cleaning {
            inner.cleanup_status = CleanupStatus::CleanupUnconfirmed;
            finalize_locked(&mut inner, self.created_at);
        }
        drop(inner);
        self.notify.notify_waiters();
    }

    pub async fn is_api_done(&self) -> bool {
        let inner = self.inner.read().await;
        is_api_done(&inner)
    }

    pub async fn wait_done(&self, duration: Duration) -> bool {
        let wait = async {
            loop {
                let notified = self.notify.notified();
                if self.is_api_done().await {
                    return;
                }
                notified.await;
            }
        };
        tokio::time::timeout(duration, wait).await.is_ok()
    }
}

fn cleanup_finished(status: CleanupStatus) -> bool {
    matches!(
        status,
        CleanupStatus::Closed | CleanupStatus::CleanupUnconfirmed
    )
}

fn next_cleanup_status(current: CleanupStatus, cleanup_required: bool) -> CleanupStatus {
    if cleanup_finished(current) {
        current
    } else if cleanup_required {
        CleanupStatus::Cleaning
    } else {
        CleanupStatus::Closed
    }
}

fn is_api_done(inner: &JobInner) -> bool {
    inner.status.is_terminal() && cleanup_finished(inner.cleanup_status)
}

fn finalize_locked(inner: &mut JobInner, created_at: SystemTime) {
    if inner.error.is_none() && inner.conversion_done && cleanup_finished(inner.cleanup_status) {
        inner.status = JobStatus::Completed;
    }
    if is_api_done(inner) && inner.completed_at.is_none() {
        inner.completed_at = Some(SystemTime::now());
        inner.stats.elapsed_ms = created_at.elapsed().unwrap_or_default().as_millis() as u64;
    }
}

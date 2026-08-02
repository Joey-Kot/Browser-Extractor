use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};

use tokio::sync::{mpsc, Mutex as TokioMutex, Semaphore};
use tracing::{debug, warn};
use uuid::Uuid;

use crate::{
    bridge::BridgeHub,
    capture::{
        limits::{release_inflight, reserve_inflight},
        CaptureAssembler,
    },
    config::Config,
    conversion::ConversionService,
    model::{
        api::{CleanupStatus, ExtractionRequest, JobStatus},
        capture::{CaptureChunk, CaptureEnd, CaptureMetadata},
        errors::{ErrorCode, ErrorDetail},
    },
};

use super::{JobRecord, JobStore};

pub struct JobScheduler {
    config: Arc<Config>,
    jobs: Arc<JobStore>,
    bridge: Arc<BridgeHub>,
    conversion: Arc<ConversionService>,
    browser_slots: Arc<Semaphore>,
    queue_tx: mpsc::Sender<Uuid>,
    queue_rx: StdMutex<Option<mpsc::Receiver<Uuid>>>,
    submission_lock: TokioMutex<()>,
    inflight_bytes: AtomicU64,
}

impl JobScheduler {
    pub fn new(
        config: Arc<Config>,
        jobs: Arc<JobStore>,
        bridge: Arc<BridgeHub>,
        conversion: Arc<ConversionService>,
    ) -> Self {
        let (queue_tx, queue_rx) = mpsc::channel(config.executor.max_queue_size);
        Self {
            browser_slots: Arc::new(Semaphore::new(config.executor.max_concurrency)),
            config,
            jobs,
            bridge,
            conversion,
            queue_tx,
            queue_rx: StdMutex::new(Some(queue_rx)),
            submission_lock: TokioMutex::new(()),
            inflight_bytes: AtomicU64::new(0),
        }
    }

    pub fn start(self: Arc<Self>) {
        let receiver = self
            .queue_rx
            .lock()
            .expect("scheduler queue mutex poisoned")
            .take()
            .expect("scheduler can only be started once");
        tokio::spawn(self.clone().dispatch_loop(receiver));
        tokio::spawn(self.clone().sweeper_loop());
    }

    pub async fn enqueue(
        self: &Arc<Self>,
        mut request: ExtractionRequest,
        idempotency_key: Option<&str>,
    ) -> Result<(Arc<JobRecord>, bool), ErrorDetail> {
        let _submission_guard = self.submission_lock.lock().await;
        if let Some(key) = idempotency_key
            && let Some(job) = self.jobs.get_by_idempotency(key)
        {
            return Ok((job, false));
        }

        if !self.bridge.is_connected().await {
            return Err(ErrorDetail::new(
                ErrorCode::BrowserUnavailable,
                "Chrome 扩展尚未连接",
                true,
            ));
        }

        request.job_timeout_ms =
            effective_job_timeout_ms(request.job_timeout_ms, self.config.executor.job_timeout_ms);
        let job = self.jobs.create(request, idempotency_key);
        if self.queue_tx.try_send(job.id).is_err() {
            self.jobs.remove(&job.id);
            return Err(ErrorDetail::new(ErrorCode::QueueFull, "任务队列已满", true));
        }

        let timeout_ms = job.request.job_timeout_ms;
        let scheduler = self.clone();
        let job_id = job.id;
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
            scheduler.timeout_job(job_id).await;
        });

        Ok((job, true))
    }

    pub fn inflight_bytes(&self) -> u64 {
        self.inflight_bytes.load(Ordering::Relaxed)
    }

    async fn dispatch_loop(self: Arc<Self>, mut receiver: mpsc::Receiver<Uuid>) {
        while let Some(id) = receiver.recv().await {
            let Some(job) = self.jobs.get(&id) else {
                continue;
            };
            if job.status().await != JobStatus::Queued {
                continue;
            }

            let permit = match self.browser_slots.clone().acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => break,
            };
            if job.status().await != JobStatus::Queued {
                drop(permit);
                continue;
            }

            job.set_permit(permit).await;
            job.set_status(JobStatus::Dispatched).await;
            if let Err(error) = self.bridge.send_extract(job.id, &job.request).await {
                job.release_permit().await;
                job.mark_failed(error, false).await;
            }
        }
    }

    async fn sweeper_loop(self: Arc<Self>) {
        let interval_seconds = self.config.jobs.result_ttl_seconds.clamp(5, 60);
        loop {
            tokio::time::sleep(Duration::from_secs(interval_seconds)).await;
            self.jobs.purge_expired().await;
        }
    }

    pub async fn accepted(&self, id: Uuid) {
        if let Some(job) = self.jobs.get(&id) {
            job.set_status(JobStatus::CreatingTab).await;
        }
    }

    pub async fn progress(&self, id: Uuid, stage: &str) {
        let Some(job) = self.jobs.get(&id) else {
            return;
        };
        let status = match stage {
            "creating_tab" => JobStatus::CreatingTab,
            "navigating" => JobStatus::Navigating,
            "waiting" => JobStatus::Waiting,
            "collecting" => JobStatus::Collecting,
            "receiving" => JobStatus::Receiving,
            "closing" => JobStatus::Closing,
            _ => return,
        };
        job.set_status(status).await;
    }

    pub async fn capture_begin(
        self: &Arc<Self>,
        id: Uuid,
        metadata: CaptureMetadata,
    ) -> Result<(), ErrorDetail> {
        let job = self.job_or_protocol_error(id)?;
        let assembler = CaptureAssembler::new(metadata, self.config.capture.max_result_bytes)?;
        if job.install_assembler(assembler).await.is_err() {
            return Err(ErrorDetail::new(
                ErrorCode::ProtocolError,
                "重复收到 capture_begin",
                false,
            ));
        }
        job.set_status(JobStatus::Receiving).await;
        Ok(())
    }

    pub async fn capture_chunk(
        self: &Arc<Self>,
        id: Uuid,
        chunk: CaptureChunk,
    ) -> Result<(), ErrorDetail> {
        let job = self.job_or_protocol_error(id)?;
        let bytes = chunk.html.len() as u64;
        if bytes > self.config.capture.chunk_bytes as u64 {
            return Err(ErrorDetail::new(
                ErrorCode::ProtocolError,
                "内容块超过 chunk_bytes 限制",
                false,
            ));
        }
        reserve_inflight(
            &self.inflight_bytes,
            bytes,
            self.config.capture.max_total_inflight_bytes,
        )?;

        let result = match job
            .with_assembler(|assembler| {
                let result = assembler.push(chunk);
                if result.is_ok() {
                    job.add_inflight_reserved(bytes);
                }
                result
            })
            .await
        {
            Some(result) => result,
            None => {
                release_inflight(&self.inflight_bytes, bytes);
                return Err(ErrorDetail::new(
                    ErrorCode::ProtocolError,
                    "capture_chunk 之前缺少 capture_begin",
                    false,
                ));
            }
        };
        match result {
            Ok(_) => Ok(()),
            Err(error) => {
                release_inflight(&self.inflight_bytes, bytes);
                Err(error)
            }
        }
    }

    pub async fn capture_end(
        self: &Arc<Self>,
        id: Uuid,
        end: CaptureEnd,
    ) -> Result<(), ErrorDetail> {
        let job = self.job_or_protocol_error(id)?;
        let assembler = job.take_assembler().await.ok_or_else(|| {
            ErrorDetail::new(
                ErrorCode::ProtocolError,
                "capture_end 之前缺少 capture_begin",
                false,
            )
        })?;
        let reserved = job.take_inflight_reserved();
        let capture = match assembler.finish(end) {
            Ok(capture) => capture,
            Err(error) => {
                release_inflight(&self.inflight_bytes, reserved);
                return Err(error);
            }
        };
        release_inflight(&self.inflight_bytes, reserved);

        let should_convert = job
            .mark_capture_complete(
                &capture.metadata,
                capture.raw_bytes,
                capture.scroll_rounds,
                capture.matched_items,
                capture.warnings.clone(),
            )
            .await;
        self.bridge.send_capture_ack(id).await?;
        if !should_convert {
            return Ok(());
        }
        self.start_cleanup_lease(job.clone());

        let scheduler = self.clone();
        tokio::spawn(async move {
            let include_html = job.request.output.include_html;
            match scheduler.conversion.convert(capture).await {
                Ok(result) => {
                    let html = include_html.then_some(result.normalized_html);
                    job.finish_conversion(result.markdown, html).await;
                }
                Err(error) => {
                    job.mark_failed(error, true).await;
                }
            }
        });
        Ok(())
    }

    pub async fn extension_error(self: &Arc<Self>, id: Uuid, error: ErrorDetail) {
        let Some(job) = self.jobs.get(&id) else {
            return;
        };
        let cleanup_required = job.has_permit().await;
        job.mark_failed(error, cleanup_required).await;
        self.discard_capture(&job).await;
        let _ = self.bridge.send_error_ack(id).await;
        if cleanup_required {
            self.start_cleanup_lease(job);
        }
    }

    pub async fn closed(&self, id: Uuid) {
        let Some(job) = self.jobs.get(&id) else {
            return;
        };
        self.discard_capture(&job).await;
        job.mark_closed().await;
        job.release_permit().await;
    }

    pub async fn cancel(self: &Arc<Self>, id: Uuid) -> Option<Arc<JobRecord>> {
        let job = self.jobs.get(&id)?;
        if job.is_api_done().await {
            return Some(job);
        }
        let active = job.has_permit().await;
        job.mark_cancelled(active).await;
        self.discard_capture(&job).await;
        if active {
            let _ = self.bridge.send_cancel(id, "api_cancelled").await;
            self.start_cleanup_lease(job.clone());
        }
        Some(job)
    }

    async fn timeout_job(self: Arc<Self>, id: Uuid) {
        let Some(job) = self.jobs.get(&id) else {
            return;
        };
        if job.is_api_done().await {
            return;
        }
        let active = job.has_permit().await;
        job.mark_timed_out(active).await;
        self.discard_capture(&job).await;
        if active {
            let _ = self.bridge.send_cancel(id, "job_timeout").await;
            self.start_cleanup_lease(job);
        }
    }

    fn start_cleanup_lease(self: &Arc<Self>, job: Arc<JobRecord>) {
        if !job.start_cleanup_lease_once() {
            return;
        }
        let scheduler = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(
                scheduler.config.executor.cleanup_timeout_ms,
            ))
            .await;
            if job.cleanup_status().await == CleanupStatus::Cleaning {
                warn!(job_id = %job.id, "cleanup confirmation timed out");
                job.mark_cleanup_unconfirmed().await;
                job.release_permit().await;
                scheduler.discard_capture(&job).await;
            }
        });
    }

    pub async fn sync_state(self: &Arc<Self>, extension_jobs: HashSet<Uuid>) {
        let jobs = self.jobs.all();
        let mut active = HashSet::new();
        for job in &jobs {
            if job.has_permit().await && !job.status().await.is_terminal() {
                active.insert(job.id);
            }
        }

        for unknown in extension_jobs.difference(&active) {
            let _ = self
                .bridge
                .send_cancel(*unknown, "orphaned_after_sync")
                .await;
        }

        for job in jobs {
            if job.has_permit().await && !extension_jobs.contains(&job.id) {
                debug!(job_id = %job.id, "extension no longer owns active job");
                job.mark_failed(
                    ErrorDetail::new(
                        ErrorCode::BrowserUnavailable,
                        "扩展状态同步中缺少活动任务",
                        true,
                    ),
                    false,
                )
                .await;
                self.discard_capture(&job).await;
                job.release_permit().await;
            }
        }
    }

    pub fn handle_disconnect(self: &Arc<Self>) {
        let scheduler = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(
                scheduler.config.executor.cleanup_timeout_ms,
            ))
            .await;
            if scheduler.bridge.is_connected().await {
                return;
            }
            for job in scheduler.jobs.all() {
                if job.has_permit().await {
                    job.mark_failed(
                        ErrorDetail::new(
                            ErrorCode::BrowserUnavailable,
                            "扩展连接中断且未在宽限期内恢复",
                            true,
                        ),
                        true,
                    )
                    .await;
                    job.mark_cleanup_unconfirmed().await;
                    scheduler.discard_capture(&job).await;
                    job.release_permit().await;
                }
            }
        });
    }

    fn job_or_protocol_error(&self, id: Uuid) -> Result<Arc<JobRecord>, ErrorDetail> {
        self.jobs.get(&id).ok_or_else(|| {
            ErrorDetail::new(ErrorCode::ProtocolError, format!("未知任务 {id}"), false)
        })
    }

    async fn discard_capture(&self, job: &JobRecord) {
        drop(job.take_assembler().await);
        let reserved = job.take_inflight_reserved();
        release_inflight(&self.inflight_bytes, reserved);
    }
}

fn effective_job_timeout_ms(requested: u64, configured_maximum: u64) -> u64 {
    requested.min(configured_maximum)
}

#[cfg(test)]
mod tests {
    use super::effective_job_timeout_ms;

    #[test]
    fn configured_timeout_caps_client_deadline() {
        assert_eq!(effective_job_timeout_ms(300_000, 120_000), 120_000);
        assert_eq!(effective_job_timeout_ms(30_000, 120_000), 30_000);
    }
}

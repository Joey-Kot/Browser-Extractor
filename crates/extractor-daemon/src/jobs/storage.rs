use std::{
    sync::Arc,
    time::{Duration, SystemTime},
};

use dashmap::DashMap;
use uuid::Uuid;

use crate::model::api::{ExtractionRequest, JobStatus};

use super::JobRecord;

pub struct JobStore {
    jobs: DashMap<Uuid, Arc<JobRecord>>,
    idempotency: DashMap<String, Uuid>,
    result_ttl: Duration,
    max_completed_jobs: usize,
}

impl JobStore {
    pub fn new(result_ttl_seconds: u64, max_completed_jobs: usize) -> Self {
        Self {
            jobs: DashMap::new(),
            idempotency: DashMap::new(),
            result_ttl: Duration::from_secs(result_ttl_seconds),
            max_completed_jobs,
        }
    }

    pub fn get(&self, id: &Uuid) -> Option<Arc<JobRecord>> {
        self.jobs.get(id).map(|entry| entry.value().clone())
    }

    pub fn get_by_idempotency(&self, key: &str) -> Option<Arc<JobRecord>> {
        let id = *self.idempotency.get(key)?.value();
        self.get(&id)
    }

    pub fn create(
        &self,
        request: ExtractionRequest,
        idempotency_key: Option<&str>,
    ) -> Arc<JobRecord> {
        let job = JobRecord::new(request);
        self.jobs.insert(job.id, job.clone());
        if let Some(key) = idempotency_key {
            self.idempotency.insert(key.to_owned(), job.id);
        }
        job
    }

    pub fn remove(&self, id: &Uuid) {
        self.jobs.remove(id);
        self.idempotency.retain(|_, value| value != id);
    }

    pub fn all(&self) -> Vec<Arc<JobRecord>> {
        self.jobs
            .iter()
            .map(|entry| entry.value().clone())
            .collect()
    }

    pub async fn queued_count(&self) -> usize {
        let mut count = 0;
        for job in self.all() {
            if job.status().await == JobStatus::Queued {
                count += 1;
            }
        }
        count
    }

    pub async fn active_browser_count(&self) -> usize {
        let mut count = 0;
        for job in self.all() {
            if job.has_permit().await {
                count += 1;
            }
        }
        count
    }

    pub async fn purge_expired(&self) {
        let now = SystemTime::now();
        let mut completed = Vec::new();

        for job in self.all() {
            let snapshot = job.snapshot().await;
            if let Some(completed_at) = snapshot.completed_at {
                let age = now.duration_since(completed_at).unwrap_or_default();
                if age >= self.result_ttl {
                    self.remove(&job.id);
                } else {
                    completed.push((completed_at, job.id));
                }
            }
        }

        if completed.len() > self.max_completed_jobs {
            completed.sort_by_key(|(time, _)| *time);
            let excess = completed.len() - self.max_completed_jobs;
            for (_, id) in completed.into_iter().take(excess) {
                self.remove(&id);
            }
        }
    }
}

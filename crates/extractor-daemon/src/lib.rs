pub mod api;
pub mod bridge;
pub mod capture;
pub mod config;
pub mod conversion;
pub mod jobs;
pub mod model;

use std::sync::Arc;

use bridge::BridgeHub;
use config::Config;
use conversion::ConversionService;
use jobs::{JobScheduler, JobStore};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub jobs: Arc<JobStore>,
    pub bridge: Arc<BridgeHub>,
    pub scheduler: Arc<JobScheduler>,
    pub conversion: Arc<ConversionService>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        let config = Arc::new(config);
        let jobs = Arc::new(JobStore::new(
            config.jobs.result_ttl_seconds,
            config.jobs.max_completed_jobs,
        ));
        let bridge = Arc::new(BridgeHub::new(config.clone()));
        let conversion = Arc::new(ConversionService::new(config.clone()));
        let scheduler = Arc::new(JobScheduler::new(
            config.clone(),
            jobs.clone(),
            bridge.clone(),
            conversion.clone(),
        ));

        bridge.attach_scheduler(Arc::downgrade(&scheduler));

        Self {
            config,
            jobs,
            bridge,
            scheduler,
            conversion,
        }
    }
}

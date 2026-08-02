use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum ExtractionMode {
    Feed,
    Document,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractionRequest {
    pub url: String,
    pub mode: ExtractionMode,
    pub wait_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_selectors: Option<Vec<String>>,
    pub exclude_selectors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub traversal: Option<TraversalOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll: Option<ScrollOptions>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScrollOptions {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_distance_px: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraversalOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow_dom: Option<TraversalTargetOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iframes: Option<TraversalTargetOptions>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraversalTargetOptions {
    pub enabled: bool,
    pub max_depth: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum JobStatus {
    Queued,
    Dispatched,
    CreatingTab,
    Navigating,
    Waiting,
    Collecting,
    Receiving,
    Closing,
    Converting,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
}

impl JobStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::TimedOut
        )
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractionResponse {
    pub id: Uuid,
    pub status: JobStatus,
    pub final_url: Option<String>,
    pub title: Option<String>,
    pub markdown: Option<String>,
    pub error: Option<ApiErrorDetail>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ErrorEnvelope {
    pub error: ApiErrorDetail,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ApiErrorDetail {
    pub code: String,
    pub message: String,
    #[allow(dead_code)]
    pub retryable: bool,
}

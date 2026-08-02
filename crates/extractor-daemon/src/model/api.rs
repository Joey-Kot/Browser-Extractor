use std::time::{Duration, SystemTime};

use serde::{Deserialize, Deserializer, Serialize};
use url::Url;
use uuid::Uuid;

use super::errors::{ErrorCode, ErrorDetail};

fn default_wait_ms() -> u64 {
    30_000
}

fn default_job_timeout_ms() -> u64 {
    120_000
}

fn default_load_timeout_ms() -> u64 {
    30_000
}

fn default_settle_ms() -> u64 {
    1_000
}

fn default_include_selectors() -> Vec<String> {
    vec!["body".to_owned()]
}

fn deserialize_include_selectors<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let selectors = Vec::<String>::deserialize(deserializer)?;
    Ok(if selectors.is_empty() {
        default_include_selectors()
    } else {
        selectors
    })
}

fn default_scroll_settle_ms() -> u64 {
    700
}

fn default_max_scroll_distance_px() -> u32 {
    60_000
}

fn default_traversal_depth() -> u32 {
    3
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtractionMode {
    #[default]
    Document,
    Feed,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VisibilityMode {
    #[default]
    Background,
    Foreground,
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractionRequest {
    pub url: String,
    #[serde(default)]
    pub mode: ExtractionMode,
    #[serde(default = "default_wait_ms")]
    pub wait_ms: u64,
    #[serde(default = "default_job_timeout_ms")]
    pub job_timeout_ms: u64,
    #[serde(default = "default_load_timeout_ms")]
    pub load_timeout_ms: u64,
    #[serde(default = "default_settle_ms")]
    pub settle_ms: u64,
    #[serde(default)]
    pub visibility_mode: VisibilityMode,
    #[serde(default)]
    pub wait_for_selector: Option<String>,
    #[serde(
        default = "default_include_selectors",
        deserialize_with = "deserialize_include_selectors"
    )]
    pub include_selectors: Vec<String>,
    #[serde(default)]
    pub exclude_selectors: Vec<String>,
    #[serde(default)]
    pub traversal: TraversalOptions,
    #[serde(default)]
    pub scroll: ScrollOptions,
    #[serde(default)]
    pub output: OutputOptions,
}

impl ExtractionRequest {
    pub fn validate(&self) -> Result<Url, ErrorDetail> {
        let parsed = Url::parse(&self.url)
            .map_err(|_| ErrorDetail::new(ErrorCode::InvalidUrl, "URL 格式无效", false))?;

        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(ErrorDetail::new(
                ErrorCode::UnsupportedScheme,
                "仅允许 http 和 https URL",
                false,
            ));
        }

        if self.job_timeout_ms == 0 || self.load_timeout_ms == 0 {
            return Err(ErrorDetail::new(
                ErrorCode::InvalidUrl,
                "超时时间必须大于 0",
                false,
            ));
        }

        if self.mode == ExtractionMode::Feed && !self.scroll.enabled {
            return Err(ErrorDetail::new(
                ErrorCode::ProtocolError,
                "feed 模式要求 scroll.enabled=true",
                false,
            ));
        }

        if self.scroll.max_distance_px == 0 {
            return Err(ErrorDetail::new(
                ErrorCode::ProtocolError,
                "最大滚动距离必须大于 0",
                false,
            ));
        }

        if self.traversal.shadow_dom.max_depth == 0 || self.traversal.iframes.max_depth == 0 {
            return Err(ErrorDetail::new(
                ErrorCode::ProtocolError,
                "穿透深度必须大于 0",
                false,
            ));
        }

        Ok(parsed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraversalTargetOptions {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_traversal_depth")]
    pub max_depth: u32,
}

impl Default for TraversalTargetOptions {
    fn default() -> Self {
        Self {
            enabled: false,
            max_depth: default_traversal_depth(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraversalOptions {
    #[serde(default)]
    pub shadow_dom: TraversalTargetOptions,
    #[serde(default)]
    pub iframes: TraversalTargetOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScrollOptions {
    pub enabled: bool,
    #[serde(default = "default_max_scroll_distance_px")]
    pub max_distance_px: u32,
    #[serde(default = "default_scroll_settle_ms")]
    pub settle_ms: u64,
    #[serde(default)]
    pub dedupe: DedupeOptions,
}

impl Default for ScrollOptions {
    fn default() -> Self {
        Self {
            enabled: false,
            max_distance_px: default_max_scroll_distance_px(),
            settle_ms: default_scroll_settle_ms(),
            dedupe: DedupeOptions::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DedupeStrategy {
    #[default]
    Auto,
    Attribute,
    Link,
    HtmlHash,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DedupeOptions {
    #[serde(default)]
    pub strategy: DedupeStrategy,
    #[serde(default)]
    pub attribute: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutputOptions {
    #[serde(default)]
    pub include_html: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupStatus {
    NotStarted,
    Cleaning,
    Closed,
    CleanupUnconfirmed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionStats {
    pub elapsed_ms: u64,
    pub scroll_rounds: u32,
    pub matched_items: u32,
    pub html_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionView {
    pub id: Uuid,
    pub status: JobStatus,
    pub cleanup_status: CleanupStatus,
    pub requested_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<super::capture::TraversalWarning>,
    pub stats: ExtractionStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorDetail>,
}

#[derive(Debug, Clone)]
pub struct JobSnapshot {
    pub id: Uuid,
    pub request: ExtractionRequest,
    pub status: JobStatus,
    pub cleanup_status: CleanupStatus,
    pub final_url: Option<String>,
    pub title: Option<String>,
    pub mime_type: Option<String>,
    pub markdown: Option<String>,
    pub html: Option<String>,
    pub warnings: Vec<super::capture::TraversalWarning>,
    pub stats: ExtractionStats,
    pub error: Option<ErrorDetail>,
    pub created_at: SystemTime,
    pub completed_at: Option<SystemTime>,
}

impl JobSnapshot {
    pub fn view(&self) -> ExtractionView {
        ExtractionView {
            id: self.id,
            status: self.status,
            cleanup_status: self.cleanup_status,
            requested_url: self.request.url.clone(),
            final_url: self.final_url.clone(),
            title: self.title.clone(),
            mime_type: self.mime_type.clone(),
            markdown: self.markdown.clone(),
            html: self.html.clone(),
            warnings: self.warnings.clone(),
            stats: self.stats.clone(),
            error: self.error.clone(),
        }
    }

    pub fn elapsed(&self) -> Duration {
        self.created_at.elapsed().unwrap_or_default()
    }
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatusResponse {
    pub extension_connected: bool,
    pub browser_instance_id: Option<String>,
    pub extension_version: Option<String>,
    pub active_browser_jobs: usize,
    pub queued_jobs: usize,
    pub max_concurrency: usize,
    pub inflight_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: ErrorDetail,
}

#[cfg(test)]
mod tests {
    use super::{DedupeStrategy, ExtractionRequest};

    #[test]
    fn minimal_feed_scroll_uses_defaults() {
        let request: ExtractionRequest = serde_json::from_str(
            r#"{"url":"https://example.com/feed","mode":"feed","scroll":{"enabled":true}}"#,
        )
        .unwrap();

        request.validate().unwrap();
        assert_eq!(request.include_selectors, ["body"]);
        assert!(request.scroll.enabled);
        assert_eq!(request.scroll.max_distance_px, 60_000);
        assert_eq!(request.scroll.settle_ms, 700);
        assert!(matches!(
            request.scroll.dedupe.strategy,
            DedupeStrategy::Auto
        ));
        assert_eq!(request.scroll.dedupe.attribute, None);
        assert_eq!(request.scroll.dedupe.selector, None);
    }

    #[test]
    fn content_selectors_default_to_body_and_preserve_explicit_values() {
        let omitted: ExtractionRequest =
            serde_json::from_str(r#"{"url":"https://example.com"}"#).unwrap();
        assert_eq!(omitted.include_selectors, ["body"]);

        let empty: ExtractionRequest =
            serde_json::from_str(r#"{"url":"https://example.com","includeSelectors":[]}"#).unwrap();
        assert_eq!(empty.include_selectors, ["body"]);
        let normalized = serde_json::to_value(&empty).unwrap();
        assert_eq!(normalized["includeSelectors"], serde_json::json!(["body"]));
        assert!(normalized.get("requireSelectorMatch").is_none());

        let explicit: ExtractionRequest =
            serde_json::from_str(r#"{"url":"https://example.com","includeSelectors":["article"]}"#)
                .unwrap();
        assert_eq!(explicit.include_selectors, ["article"]);
    }

    #[test]
    fn explicit_scroll_requires_enabled() {
        let error = serde_json::from_str::<ExtractionRequest>(
            r#"{"url":"https://example.com","scroll":{}}"#,
        )
        .unwrap_err();

        assert!(error.to_string().contains("enabled"));
    }

    #[test]
    fn scroll_uses_a_positive_distance_budget_and_rejects_removed_fields() {
        let invalid: ExtractionRequest = serde_json::from_str(
            r#"{"url":"https://example.com","scroll":{"enabled":true,"maxDistancePx":0}}"#,
        )
        .unwrap();
        assert!(invalid.validate().is_err());

        for removed in [
            "itemSelectors",
            "containerSelector",
            "stepPx",
            "maxRounds",
            "idleRoundsToStop",
        ] {
            let json = format!(
                r#"{{"url":"https://example.com","scroll":{{"enabled":true,"{removed}":1}}}}"#
            );
            assert!(serde_json::from_str::<ExtractionRequest>(&json).is_err());
        }
    }

    #[test]
    fn traversal_is_disabled_by_default_and_accepts_independent_depths() {
        let defaults: ExtractionRequest =
            serde_json::from_str(r#"{"url":"https://example.com"}"#).unwrap();
        assert!(!defaults.traversal.shadow_dom.enabled);
        assert_eq!(defaults.traversal.shadow_dom.max_depth, 3);
        assert!(!defaults.traversal.iframes.enabled);
        assert_eq!(defaults.traversal.iframes.max_depth, 3);

        let enabled: ExtractionRequest = serde_json::from_str(
            r#"{
                "url":"https://example.com",
                "traversal":{
                    "shadowDom":{"enabled":true,"maxDepth":5},
                    "iframes":{"enabled":true,"maxDepth":2}
                }
            }"#,
        )
        .unwrap();
        enabled.validate().unwrap();
        assert!(enabled.traversal.shadow_dom.enabled);
        assert_eq!(enabled.traversal.shadow_dom.max_depth, 5);
        assert!(enabled.traversal.iframes.enabled);
        assert_eq!(enabled.traversal.iframes.max_depth, 2);

        let default_depth: ExtractionRequest = serde_json::from_str(
            r#"{
                "url":"https://example.com",
                "traversal":{"iframes":{"enabled":true}}
            }"#,
        )
        .unwrap();
        assert!(default_depth.traversal.iframes.enabled);
        assert_eq!(default_depth.traversal.iframes.max_depth, 3);

        let invalid: ExtractionRequest = serde_json::from_str(
            r#"{
                "url":"https://example.com",
                "traversal":{"iframes":{"enabled":true,"maxDepth":0}}
            }"#,
        )
        .unwrap();
        assert!(invalid.validate().is_err());
    }
}

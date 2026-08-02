use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureType {
    Document,
    Feed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMetadata {
    pub capture_type: CaptureType,
    pub selection_applied: bool,
    pub final_url: String,
    pub title: String,
    pub mime_type: String,
    #[serde(default)]
    pub mime_type_unknown: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChunkKind {
    Document,
    Item,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureChunk {
    pub sequence: u64,
    pub kind: ChunkKind,
    #[serde(default)]
    pub key: Option<String>,
    pub html: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureEnd {
    pub chunks: u64,
    pub total_bytes: u64,
    pub checksum: String,
    #[serde(default)]
    pub scroll_rounds: u32,
    #[serde(default)]
    pub matched_items: u32,
    #[serde(default)]
    pub warnings: Vec<TraversalWarning>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TraversalWarningKind {
    Iframe,
    ShadowRoot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraversalWarning {
    pub kind: TraversalWarningKind,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub depth: u32,
}

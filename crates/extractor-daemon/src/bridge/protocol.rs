use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::model::{
    capture::{CaptureChunk, CaptureEnd, CaptureMetadata},
    errors::{ErrorCode, ErrorDetail},
};

pub const PROTOCOL_VERSION: u32 = 4;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundEnvelope {
    pub version: u32,
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(default)]
    pub request_id: Option<Uuid>,
    #[serde(default)]
    pub payload: Value,
}

impl InboundEnvelope {
    pub fn request_id(&self) -> Result<Uuid, ErrorDetail> {
        self.request_id.ok_or_else(|| {
            ErrorDetail::new(
                ErrorCode::ProtocolError,
                format!("{} 消息缺少 requestId", self.message_type),
                false,
            )
        })
    }

    pub fn payload_as<T: serde::de::DeserializeOwned>(&self) -> Result<T, ErrorDetail> {
        serde_json::from_value(self.payload.clone()).map_err(|error| {
            ErrorDetail::new(
                ErrorCode::ProtocolError,
                format!("{} payload 无效: {error}", self.message_type),
                false,
            )
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloPayload {
    pub extension_token: String,
    pub browser_instance_id: String,
    pub browser_name: String,
    pub extension_version: String,
    pub protocol_version: u32,
}

#[derive(Debug, Deserialize)]
pub struct ProgressPayload {
    pub stage: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatePayload {
    #[serde(default)]
    pub active_jobs: Vec<SyncJob>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncJob {
    pub request_id: Uuid,
    #[serde(default)]
    pub tab_ids: Vec<i64>,
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct PingPayload {
    #[serde(default)]
    pub nonce: Option<String>,
}

pub type CaptureBeginPayload = CaptureMetadata;
pub type CaptureChunkPayload = CaptureChunk;
pub type CaptureEndPayload = CaptureEnd;

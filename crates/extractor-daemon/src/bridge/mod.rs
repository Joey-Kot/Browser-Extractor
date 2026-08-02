pub mod chunks;
pub mod protocol;
pub mod session;

use std::sync::{Arc, RwLock as StdRwLock, Weak};

use serde_json::json;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

use crate::{
    api::auth::constant_time_eq,
    config::Config,
    jobs::JobScheduler,
    model::{
        api::ExtractionRequest,
        errors::{ErrorCode, ErrorDetail},
    },
};

use self::protocol::{HelloPayload, PROTOCOL_VERSION};

#[derive(Debug, Clone)]
pub struct BridgeMetadata {
    pub browser_instance_id: String,
    pub browser_name: String,
    pub extension_version: String,
    pub protocol_version: u32,
}

struct BridgeConnection {
    session_id: Uuid,
    metadata: BridgeMetadata,
    sender: mpsc::Sender<String>,
}

pub struct BridgeHub {
    config: Arc<Config>,
    connection: RwLock<Option<BridgeConnection>>,
    scheduler: StdRwLock<Weak<JobScheduler>>,
}

impl BridgeHub {
    pub fn new(config: Arc<Config>) -> Self {
        Self {
            config,
            connection: RwLock::new(None),
            scheduler: StdRwLock::new(Weak::new()),
        }
    }

    pub fn attach_scheduler(&self, scheduler: Weak<JobScheduler>) {
        *self
            .scheduler
            .write()
            .expect("bridge scheduler lock poisoned") = scheduler;
    }

    pub fn scheduler(&self) -> Option<Arc<JobScheduler>> {
        self.scheduler
            .read()
            .expect("bridge scheduler lock poisoned")
            .upgrade()
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub async fn register(
        &self,
        hello: HelloPayload,
        sender: mpsc::Sender<String>,
    ) -> Result<Uuid, ErrorDetail> {
        if !constant_time_eq(
            hello.extension_token.as_bytes(),
            self.config.bridge.extension_token.as_bytes(),
        ) {
            return Err(ErrorDetail::new(
                ErrorCode::Unauthorized,
                "扩展 token 无效",
                false,
            ));
        }
        if hello.protocol_version != PROTOCOL_VERSION {
            return Err(ErrorDetail::new(
                ErrorCode::ProtocolError,
                "扩展协议版本不受支持",
                false,
            ));
        }
        if !self.config.bridge.browser_instance_id.is_empty()
            && self.config.bridge.browser_instance_id != hello.browser_instance_id
        {
            return Err(ErrorDetail::new(
                ErrorCode::InstanceConflict,
                "浏览器实例与配置不匹配",
                false,
            ));
        }

        let mut connection = self.connection.write().await;
        if connection.is_some() {
            return Err(ErrorDetail::new(
                ErrorCode::InstanceConflict,
                "已有 Chrome 扩展实例连接",
                true,
            ));
        }

        let session_id = Uuid::new_v4();
        *connection = Some(BridgeConnection {
            session_id,
            metadata: BridgeMetadata {
                browser_instance_id: hello.browser_instance_id,
                browser_name: hello.browser_name,
                extension_version: hello.extension_version,
                protocol_version: hello.protocol_version,
            },
            sender,
        });
        Ok(session_id)
    }

    pub async fn disconnect(&self, session_id: Uuid) {
        let mut connection = self.connection.write().await;
        let matches = connection
            .as_ref()
            .map(|active| active.session_id == session_id)
            .unwrap_or(false);
        if matches {
            connection.take();
            drop(connection);
            if let Some(scheduler) = self.scheduler() {
                scheduler.handle_disconnect();
            }
        }
    }

    pub async fn is_connected(&self) -> bool {
        self.connection.read().await.is_some()
    }

    pub async fn metadata(&self) -> Option<BridgeMetadata> {
        self.connection
            .read()
            .await
            .as_ref()
            .map(|connection| connection.metadata.clone())
    }

    pub async fn send_extract(
        &self,
        request_id: Uuid,
        request: &ExtractionRequest,
    ) -> Result<(), ErrorDetail> {
        self.send_json(json!({
            "version": PROTOCOL_VERSION,
            "type": "extract",
            "requestId": request_id,
            "payload": request,
        }))
        .await
    }

    pub async fn send_capture_ack(&self, request_id: Uuid) -> Result<(), ErrorDetail> {
        self.send_control(request_id, "capture_ack", json!({}))
            .await
    }

    pub async fn send_chunk_ack(&self, request_id: Uuid, sequence: u64) -> Result<(), ErrorDetail> {
        self.send_control(request_id, "chunk_ack", json!({ "upToSequence": sequence }))
            .await
    }

    pub async fn send_error_ack(&self, request_id: Uuid) -> Result<(), ErrorDetail> {
        self.send_control(request_id, "error_ack", json!({})).await
    }

    pub async fn send_cancel(&self, request_id: Uuid, reason: &str) -> Result<(), ErrorDetail> {
        self.send_control(request_id, "cancel", json!({ "reason": reason }))
            .await
    }

    pub async fn send_error(
        &self,
        request_id: Option<Uuid>,
        error: &ErrorDetail,
    ) -> Result<(), ErrorDetail> {
        self.send_json(json!({
            "version": PROTOCOL_VERSION,
            "type": "error",
            "requestId": request_id,
            "payload": error,
        }))
        .await
    }

    pub async fn send_pong(&self, nonce: Option<String>) -> Result<(), ErrorDetail> {
        self.send_json(json!({
            "version": PROTOCOL_VERSION,
            "type": "pong",
            "payload": { "nonce": nonce },
        }))
        .await
    }

    async fn send_control(
        &self,
        request_id: Uuid,
        message_type: &str,
        payload: serde_json::Value,
    ) -> Result<(), ErrorDetail> {
        self.send_json(json!({
            "version": PROTOCOL_VERSION,
            "type": message_type,
            "requestId": request_id,
            "payload": payload,
        }))
        .await
    }

    async fn send_json(&self, value: serde_json::Value) -> Result<(), ErrorDetail> {
        let sender = self
            .connection
            .read()
            .await
            .as_ref()
            .map(|connection| connection.sender.clone())
            .ok_or_else(|| {
                ErrorDetail::new(ErrorCode::BrowserUnavailable, "Chrome 扩展未连接", true)
            })?;
        sender
            .send(value.to_string())
            .await
            .map_err(|_| ErrorDetail::new(ErrorCode::BrowserUnavailable, "扩展连接写入失败", true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_rejects_invalid_extension_token() {
        let mut config = Config::default();
        config.bridge.extension_token = "expected-token".into();
        let hub = BridgeHub::new(Arc::new(config));
        let (sender, _receiver) = mpsc::channel(1);
        let error = hub
            .register(
                HelloPayload {
                    extension_token: "wrong-token".into(),
                    browser_instance_id: "browser".into(),
                    browser_name: "Chrome".into(),
                    extension_version: "0.1.0".into(),
                    protocol_version: PROTOCOL_VERSION,
                },
                sender,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Unauthorized);
        assert!(!hub.is_connected().await);
    }
}

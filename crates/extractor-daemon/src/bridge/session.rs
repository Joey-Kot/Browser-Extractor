use std::{collections::HashSet, sync::Arc, time::Duration};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::mpsc;
use tracing::{info, warn};
use uuid::Uuid;

use crate::model::errors::{ErrorCode, ErrorDetail};

use super::{
    protocol::{
        CaptureBeginPayload, CaptureChunkPayload, CaptureEndPayload, HelloPayload, InboundEnvelope,
        PingPayload, ProgressPayload, SyncStatePayload, PROTOCOL_VERSION,
    },
    BridgeHub,
};

pub fn router(hub: Arc<BridgeHub>) -> Router {
    Router::new().route("/bridge", get(upgrade)).with_state(hub)
}

async fn upgrade(
    State(hub): State<Arc<BridgeHub>>,
    websocket: WebSocketUpgrade,
) -> impl IntoResponse {
    websocket.on_upgrade(move |socket| run_socket(hub, socket))
}

async fn run_socket(hub: Arc<BridgeHub>, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let hello_message = tokio::time::timeout(Duration::from_secs(10), stream.next()).await;
    let hello = match hello_message {
        Ok(Some(Ok(Message::Text(text)))) => match parse_hello(&text) {
            Ok(hello) => hello,
            Err(error) => {
                let _ = sink
                    .send(Message::Text(error_message(None, &error).into()))
                    .await;
                return;
            }
        },
        _ => {
            let error = ErrorDetail::new(ErrorCode::ProtocolError, "连接后必须先发送 hello", false);
            let _ = sink
                .send(Message::Text(error_message(None, &error).into()))
                .await;
            return;
        }
    };

    let (sender, mut receiver) = mpsc::channel::<String>(128);
    let session_id = match hub.register(hello.clone(), sender.clone()).await {
        Ok(session_id) => session_id,
        Err(error) => {
            let _ = sink
                .send(Message::Text(error_message(None, &error).into()))
                .await;
            return;
        }
    };

    info!(
        browser_instance_id = %hello.browser_instance_id,
        extension_version = %hello.extension_version,
        "extension connected"
    );

    let welcome = json!({
        "version": PROTOCOL_VERSION,
        "type": "welcome",
        "payload": {
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": session_id,
            "maxUnackedChunks": hub.config().capture.max_unacked_chunks,
            "chunkBytes": hub.config().capture.chunk_bytes,
            "pingIntervalSeconds": hub.config().bridge.ping_interval_seconds
        }
    })
    .to_string();
    if sink.send(Message::Text(welcome.into())).await.is_err() {
        hub.disconnect(session_id).await;
        return;
    }

    let ping_seconds = hub.config().bridge.ping_interval_seconds.max(5);
    let writer = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(ping_seconds));
        interval.tick().await;
        loop {
            tokio::select! {
                message = receiver.recv() => {
                    match message {
                        Some(message) => {
                            if sink.send(Message::Text(message.into())).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
                _ = interval.tick() => {
                    let ping = json!({
                        "version": PROTOCOL_VERSION,
                        "type": "ping",
                        "payload": { "nonce": Uuid::new_v4().to_string() }
                    }).to_string();
                    if sink.send(Message::Text(ping.into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    while let Some(message) = stream.next().await {
        match message {
            Ok(Message::Text(text)) => {
                if let Err(error) = handle_message(hub.clone(), &text).await {
                    warn!(message = %error.message, "bridge protocol error");
                    let request_id = serde_json::from_str::<InboundEnvelope>(&text)
                        .ok()
                        .and_then(|envelope| envelope.request_id);
                    let _ = hub.send_error(request_id, &error).await;
                    if let (Some(id), Some(scheduler)) = (request_id, hub.scheduler()) {
                        scheduler.extension_error(id, error).await;
                    }
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(Message::Ping(data)) => {
                let _ = sender.send(
                    json!({"version": PROTOCOL_VERSION, "type": "pong", "payload": {"data": data.to_vec()}})
                        .to_string(),
                ).await;
            }
            Ok(Message::Pong(_)) | Ok(Message::Binary(_)) => {}
        }
    }

    writer.abort();
    hub.disconnect(session_id).await;
    info!(session_id = %session_id, "extension disconnected");
}

fn parse_hello(text: &str) -> Result<HelloPayload, ErrorDetail> {
    let envelope: InboundEnvelope = serde_json::from_str(text).map_err(|error| {
        ErrorDetail::new(
            ErrorCode::ProtocolError,
            format!("hello JSON 无效: {error}"),
            false,
        )
    })?;
    if envelope.version != PROTOCOL_VERSION || envelope.message_type != "hello" {
        return Err(ErrorDetail::new(
            ErrorCode::ProtocolError,
            format!("第一条消息必须是协议版本 {PROTOCOL_VERSION} 的 hello"),
            false,
        ));
    }
    envelope.payload_as()
}

async fn handle_message(hub: Arc<BridgeHub>, text: &str) -> Result<(), ErrorDetail> {
    let envelope: InboundEnvelope = serde_json::from_str(text).map_err(|error| {
        ErrorDetail::new(
            ErrorCode::ProtocolError,
            format!("消息 JSON 无效: {error}"),
            false,
        )
    })?;
    if envelope.version != PROTOCOL_VERSION {
        return Err(ErrorDetail::new(
            ErrorCode::ProtocolError,
            "消息协议版本不受支持",
            false,
        ));
    }
    let scheduler = hub
        .scheduler()
        .ok_or_else(|| ErrorDetail::new(ErrorCode::InternalError, "任务调度器尚未初始化", true))?;

    match envelope.message_type.as_str() {
        "accepted" => scheduler.accepted(envelope.request_id()?).await,
        "progress" => {
            let id = envelope.request_id()?;
            let payload: ProgressPayload = envelope.payload_as()?;
            scheduler.progress(id, &payload.stage).await;
        }
        "capture_begin" => {
            let id = envelope.request_id()?;
            let payload: CaptureBeginPayload = envelope.payload_as()?;
            scheduler.capture_begin(id, payload).await?;
        }
        "capture_chunk" => {
            let id = envelope.request_id()?;
            let payload: CaptureChunkPayload = envelope.payload_as()?;
            let sequence = payload.sequence;
            scheduler.capture_chunk(id, payload).await?;
            hub.send_chunk_ack(id, sequence).await?;
        }
        "capture_end" => {
            let id = envelope.request_id()?;
            let payload: CaptureEndPayload = envelope.payload_as()?;
            scheduler.capture_end(id, payload).await?;
        }
        "error" => {
            let id = envelope.request_id()?;
            let payload: ErrorDetail = envelope.payload_as()?;
            scheduler.extension_error(id, payload).await;
        }
        "closed" => scheduler.closed(envelope.request_id()?).await,
        "sync_state" => {
            let payload: SyncStatePayload = envelope.payload_as()?;
            let ids = payload
                .active_jobs
                .into_iter()
                .map(|job| job.request_id)
                .collect::<HashSet<_>>();
            scheduler.sync_state(ids).await;
        }
        "ping" => {
            let payload: PingPayload = envelope.payload_as()?;
            hub.send_pong(payload.nonce).await?;
        }
        "pong" => {}
        other => {
            return Err(ErrorDetail::new(
                ErrorCode::ProtocolError,
                format!("不支持的消息类型: {other}"),
                false,
            ));
        }
    }
    Ok(())
}

fn error_message(request_id: Option<Uuid>, error: &ErrorDetail) -> String {
    json!({
        "version": PROTOCOL_VERSION,
        "type": "error",
        "requestId": request_id,
        "payload": error,
    })
    .to_string()
}

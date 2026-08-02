use std::time::Duration;

use extractor_daemon::{
    bridge::{self, protocol::PROTOCOL_VERSION},
    config::Config,
    model::api::{ExtractionRequest, JobStatus},
    AppState,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[tokio::test]
async fn simulated_extension_completes_a_document_job() {
    let mut config = Config::default();
    config.server.api_token = "api-token".into();
    config.bridge.extension_token = "extension-token".into();
    config.executor.cleanup_timeout_ms = 1_000;
    let state = AppState::new(config);
    state.scheduler.clone().start();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let bridge_server = tokio::spawn({
        let hub = state.bridge.clone();
        async move {
            axum::serve(listener, bridge::session::router(hub))
                .await
                .unwrap();
        }
    });

    let url = format!("ws://{address}/bridge");
    let (socket, _) = connect_async(url).await.unwrap();
    let (mut writer, mut reader) = socket.split();
    writer
        .send(Message::Text(
            json!({
                "version": PROTOCOL_VERSION,
                "type": "hello",
                "payload": {
                    "extensionToken": "extension-token",
                    "browserInstanceId": "test-browser",
                    "browserName": "Chrome",
                    "extensionVersion": "0.1.0",
                    "protocolVersion": PROTOCOL_VERSION
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    assert_eq!(next_json(&mut reader).await["type"], "welcome");

    let request: ExtractionRequest = serde_json::from_value(json!({
        "url": "https://example.com/article",
        "waitMs": 0,
        "includeSelectors": ["article"]
    }))
    .unwrap();
    let (job, created) = state
        .scheduler
        .enqueue(request.clone(), Some("bridge-flow"))
        .await
        .unwrap();
    assert!(created);
    let (same_job, created_again) = state
        .scheduler
        .enqueue(request, Some("bridge-flow"))
        .await
        .unwrap();
    assert!(!created_again);
    assert_eq!(same_job.id, job.id);

    let extract = next_json(&mut reader).await;
    assert_eq!(extract["type"], "extract");
    assert_eq!(extract["version"], PROTOCOL_VERSION);
    assert!(extract["payload"].get("requireSelectorMatch").is_none());
    let request_id = extract["requestId"].as_str().unwrap();
    assert_eq!(request_id, job.id.to_string());

    send_request_message(&mut writer, request_id, "accepted", json!({})).await;
    send_request_message(
        &mut writer,
        request_id,
        "capture_begin",
        json!({
            "captureType": "document",
            "selectionApplied": true,
            "finalUrl": "https://example.com/article",
            "title": "Example",
            "mimeType": "text/html",
            "mimeTypeUnknown": false
        }),
    )
    .await;

    let html = "<article><h1>Example</h1><p>Body text for the bridge test.</p></article>";
    send_request_message(
        &mut writer,
        request_id,
        "capture_chunk",
        json!({
            "sequence": 0,
            "kind": "document",
            "key": null,
            "html": html
        }),
    )
    .await;
    let chunk_ack = next_json(&mut reader).await;
    assert_eq!(chunk_ack["type"], "chunk_ack");
    assert_eq!(chunk_ack["payload"]["upToSequence"], 0);

    send_request_message(
        &mut writer,
        request_id,
        "capture_end",
        json!({
            "chunks": 1,
            "totalBytes": html.len(),
            "checksum": hex::encode(Sha256::digest(html.as_bytes())),
            "scrollRounds": 0,
            "matchedItems": 0,
            "warnings": [{
                "kind": "iframe",
                "message": "frame detached",
                "url": "https://frame.example/embed",
                "depth": 1
            }]
        }),
    )
    .await;
    assert_eq!(next_json(&mut reader).await["type"], "capture_ack");
    send_request_message(&mut writer, request_id, "closed", json!({})).await;

    assert!(job.wait_done(Duration::from_secs(2)).await);
    let snapshot = job.snapshot().await;
    assert_eq!(snapshot.status, JobStatus::Completed);
    assert_eq!(snapshot.warnings.len(), 1);
    assert!(snapshot
        .markdown
        .as_deref()
        .unwrap_or_default()
        .contains("# Example"));
    let view = serde_json::to_value(snapshot.view()).unwrap();
    assert_eq!(view["warnings"][0]["kind"], "iframe");

    writer
        .send(Message::Text(
            json!({
                "version": PROTOCOL_VERSION,
                "type": "sync_state",
                "payload": {
                    "activeJobs": [{
                        "requestId": request_id,
                        "tabIds": [123],
                        "status": "collecting"
                    }]
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let cancel = tokio::time::timeout(Duration::from_secs(1), next_json(&mut reader))
        .await
        .expect("terminal extension job should be cancelled");
    assert_eq!(cancel["type"], "cancel");
    assert_eq!(cancel["requestId"], request_id);

    writer.send(Message::Close(None)).await.unwrap();
    bridge_server.abort();
}

async fn send_request_message<S>(
    writer: &mut S,
    request_id: &str,
    message_type: &str,
    payload: Value,
) where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Debug,
{
    writer
        .send(Message::Text(
            json!({
                "version": PROTOCOL_VERSION,
                "type": message_type,
                "requestId": request_id,
                "payload": payload
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
}

async fn next_json<S>(reader: &mut S) -> Value
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match reader.next().await.unwrap().unwrap() {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => continue,
            Message::Close(_) | Message::Frame(_) => panic!("bridge closed unexpectedly"),
        }
    }
}

use std::{fs, path::PathBuf};

use extractor_daemon::{
    bridge::protocol::PROTOCOL_VERSION,
    model::{
        api::ExtractionRequest,
        capture::{CaptureChunk, CaptureEnd, CaptureMetadata, CaptureType, ChunkKind},
    },
};
use serde_json::Value;

#[test]
fn schema_declares_all_protocol_messages() {
    let root = repository_root();
    let schema: Value =
        serde_json::from_str(&fs::read_to_string(root.join("spec/bridge.schema.json")).unwrap())
            .unwrap();
    let messages = schema["$defs"]["BridgeMessage"]["oneOf"]
        .as_array()
        .unwrap();
    assert_eq!(messages.len(), 17);
    assert_eq!(
        schema["$defs"]["ProtocolVersion"]["const"],
        PROTOCOL_VERSION
    );
    assert_eq!(
        schema["$defs"]["ExtractionRequest"]["properties"]["includeSelectors"]["minItems"],
        1
    );
    assert!(schema["$defs"]["ExtractionRequest"]["properties"]
        .get("requireSelectorMatch")
        .is_none());
    let scroll = &schema["$defs"]["ScrollOptions"]["properties"];
    assert_eq!(scroll["maxDistancePx"]["minimum"], 1);
    for removed in [
        "containerSelector",
        "itemSelectors",
        "stepPx",
        "maxRounds",
        "idleRoundsToStop",
    ] {
        assert!(
            scroll.get(removed).is_none(),
            "legacy field remains: {removed}"
        );
    }

    let generated = fs::read_to_string(root.join("extension/src/generated/protocol.ts")).unwrap();
    assert!(generated.contains("export type ProtocolVersion = 4;"));
    assert!(generated.contains("maxDistancePx: number;"));
    for removed in [
        "containerSelector",
        "itemSelectors",
        "stepPx",
        "maxRounds",
        "idleRoundsToStop",
    ] {
        assert!(
            !generated.contains(removed),
            "legacy generated field remains: {removed}"
        );
    }
}

#[test]
fn capture_examples_match_rust_models() {
    let root = repository_root();
    let begin: Value = serde_json::from_str(
        &fs::read_to_string(root.join("spec/examples/capture-begin.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(begin["version"], PROTOCOL_VERSION);
    let metadata: CaptureMetadata = serde_json::from_value(begin["payload"].clone()).unwrap();
    assert_eq!(metadata.capture_type, CaptureType::Feed);

    let chunk: Value = serde_json::from_str(
        &fs::read_to_string(root.join("spec/examples/capture-chunk.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(chunk["version"], PROTOCOL_VERSION);
    let chunk: CaptureChunk = serde_json::from_value(chunk["payload"].clone()).unwrap();
    assert_eq!(chunk.kind, ChunkKind::Item);

    let end: Value = serde_json::from_str(
        &fs::read_to_string(root.join("spec/examples/capture-end.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(end["version"], PROTOCOL_VERSION);
    let _: CaptureEnd = serde_json::from_value(end["payload"].clone()).unwrap();
}

#[test]
fn extract_request_example_uses_scroll_defaults() {
    let root = repository_root();
    let request: ExtractionRequest = serde_json::from_str(
        &fs::read_to_string(root.join("spec/examples/extract-request.json")).unwrap(),
    )
    .unwrap();

    request.validate().unwrap();
    assert_eq!(request.include_selectors, ["body"]);
    assert!(request.scroll.enabled);
    assert_eq!(request.scroll.max_distance_px, 60_000);
    assert_eq!(request.scroll.settle_ms, 700);
    assert!(!request.traversal.shadow_dom.enabled);
    assert_eq!(request.traversal.shadow_dom.max_depth, 3);
    assert!(!request.traversal.iframes.enabled);
    assert_eq!(request.traversal.iframes.max_depth, 3);
}

#[test]
fn yaml_specifications_are_well_formed() {
    let root = repository_root();
    let _: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(root.join("spec/openapi.yaml")).unwrap()).unwrap();
    let _: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(root.join("spec/errors.yaml")).unwrap()).unwrap();
}

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_owned()
}

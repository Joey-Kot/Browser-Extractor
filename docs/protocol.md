# Bridge protocol

spec/bridge.schema.json is authoritative. Protocol version 4 uses JSON text frames over:

    ws://127.0.0.1:17321/bridge

The first `hello` message carries `extensionToken`; credentials are never placed in the WebSocket URL.

The extension must send hello as its first frame. The daemon responds with welcome, including chunkBytes and maxUnackedChunks. Only one extension instance may be active.

Normal sequence:

    extract
    accepted
    progress*
    capture_begin
    capture_chunk <-> chunk_ack
    capture_end
    capture_ack
    closed

The extension must not discard an unacknowledged chunk. It may have at most maxUnackedChunks outstanding. The capture_end checksum is SHA-256 over the UTF-8 bytes of all chunk html fields in sequence order. `capture_end.warnings` carries recoverable Shadow Root or iframe traversal skips; warnings do not fail the capture.

The normalized extraction payload always contains at least one `includeSelectors` value. Omitted or empty API values become `["body"]` before dispatch. It also contains `traversal.shadowDom` and `traversal.iframes`, each with `enabled` and `maxDepth`; both are disabled by default. `spec/bridge.schema.json` remains the source for generated TypeScript protocol types.

For inferred feed content blocks larger than chunkBytes, consecutive item chunks use the same key. The daemon concatenates adjacent chunks with the same key before wrapping the block in Capture HTML.

Protocol version 4 removes explicit scroll-container and feed-item selectors. A normalized scroll payload contains `enabled`, `maxDistancePx`, `settleMs`, and `dedupe`; container discovery, step sizing, and stopping passes are extension implementation details.

Failure sequence:

    error
    error_ack
    closed

Cancellation sequence:

    cancel
    closed

Both peers exchange ping and pong. On reconnect, the extension sends sync_state. Unknown extension jobs are cancelled; daemon jobs missing from extension state fail and release their browser resources.

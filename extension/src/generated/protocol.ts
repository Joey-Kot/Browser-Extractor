/* eslint-disable */
/** Generated from spec/bridge.schema.json. Do not edit directly. */

/**
 * Authoritative protocol shared by the Rust daemon and Chrome extension.
 */
export type BridgeMessage =
  | HelloMessage
  | WelcomeMessage
  | ExtractMessage
  | AcceptedMessage
  | ProgressMessage
  | CaptureBeginMessage
  | CaptureChunkMessage
  | CaptureEndMessage
  | ChunkAckMessage
  | CaptureAckMessage
  | ErrorMessage
  | ErrorAckMessage
  | CancelMessage
  | ClosedMessage
  | SyncStateMessage
  | PingMessage
  | PongMessage;
export type ProtocolVersion = 4;
export type RequestId = string;
export type ExtractionMode = "document" | "feed";
export type VisibilityMode = "background" | "foreground" | "auto";
export type ProgressStage = "creating_tab" | "navigating" | "waiting" | "collecting" | "receiving" | "closing";
export type CaptureType = "document" | "feed";
export type ChunkKind = "document" | "item";
export type ErrorCode =
  | "invalid_url"
  | "unsupported_scheme"
  | "unauthorized"
  | "browser_unavailable"
  | "instance_conflict"
  | "queue_full"
  | "protocol_error"
  | "debugger_attach_failed"
  | "tab_create_failed"
  | "tab_closed"
  | "navigation_failed"
  | "load_timeout"
  | "job_timeout"
  | "selector_invalid"
  | "selector_not_found"
  | "unsupported_content_type"
  | "extraction_failed"
  | "capture_backpressure"
  | "result_too_large"
  | "conversion_failed"
  | "cancelled"
  | "cleanup_unconfirmed"
  | "internal_error"
  | "result_expired"
  | "not_found";

export interface HelloMessage {
  version: ProtocolVersion;
  type: "hello";
  payload: HelloPayload;
}
export interface HelloPayload {
  extensionToken: string;
  browserInstanceId: string;
  browserName: string;
  extensionVersion: string;
  protocolVersion: ProtocolVersion;
}
export interface WelcomeMessage {
  version: ProtocolVersion;
  type: "welcome";
  payload: WelcomePayload;
}
export interface WelcomePayload {
  protocolVersion: ProtocolVersion;
  sessionId: RequestId;
  maxUnackedChunks: number;
  chunkBytes: number;
  pingIntervalSeconds: number;
}
export interface ExtractMessage {
  version: ProtocolVersion;
  type: "extract";
  requestId: RequestId;
  payload: ExtractionRequest;
}
export interface ExtractionRequest {
  url: string;
  mode: ExtractionMode;
  waitMs: number;
  jobTimeoutMs: number;
  loadTimeoutMs: number;
  settleMs: number;
  visibilityMode: VisibilityMode;
  waitForSelector?: string | null;
  /**
   * @minItems 1
   */
  includeSelectors: [string, ...string[]];
  excludeSelectors: string[];
  traversal?: TraversalOptions;
  scroll: ScrollOptions;
  output: OutputOptions;
}
/**
 * Recursive serialization options applied after selectors run in the top-level document.
 */
export interface TraversalOptions {
  shadowDom: TraversalTargetOptions;
  iframes: TraversalTargetOptions;
}
export interface TraversalTargetOptions {
  enabled: boolean;
  maxDepth: number;
}
/**
 * Automatic vertical scrolling. Container discovery, step sizing, and stopping passes are extension-managed.
 */
export interface ScrollOptions {
  enabled: boolean;
  /**
   * Maximum cumulative distance traveled by each detected container.
   */
  maxDistancePx: number;
  settleMs: number;
  dedupe: DedupeOptions;
}
export interface DedupeOptions {
  strategy: "auto" | "attribute" | "link" | "html_hash";
  attribute?: string | null;
  selector?: string | null;
}
export interface OutputOptions {
  includeHtml: boolean;
}
export interface AcceptedMessage {
  version: ProtocolVersion;
  type: "accepted";
  requestId: RequestId;
  payload: {};
}
export interface ProgressMessage {
  version: ProtocolVersion;
  type: "progress";
  requestId: RequestId;
  payload: ProgressPayload;
}
export interface ProgressPayload {
  stage: ProgressStage;
  detail?: string;
}
export interface CaptureBeginMessage {
  version: ProtocolVersion;
  type: "capture_begin";
  requestId: RequestId;
  payload: CaptureBeginPayload;
}
export interface CaptureBeginPayload {
  captureType: CaptureType;
  selectionApplied: boolean;
  finalUrl: string;
  title: string;
  mimeType: string;
  mimeTypeUnknown?: boolean;
}
export interface CaptureChunkMessage {
  version: ProtocolVersion;
  type: "capture_chunk";
  requestId: RequestId;
  payload: CaptureChunkPayload;
}
export interface CaptureChunkPayload {
  sequence: number;
  kind: ChunkKind;
  key?: string | null;
  html: string;
}
export interface CaptureEndMessage {
  version: ProtocolVersion;
  type: "capture_end";
  requestId: RequestId;
  payload: CaptureEndPayload;
}
export interface CaptureEndPayload {
  chunks: number;
  totalBytes: number;
  checksum: string;
  scrollRounds?: number;
  matchedItems?: number;
  warnings?: TraversalWarning[];
}
export interface TraversalWarning {
  kind: "iframe" | "shadow_root";
  message: string;
  url?: string;
  depth: number;
}
export interface ChunkAckMessage {
  version: ProtocolVersion;
  type: "chunk_ack";
  requestId: RequestId;
  payload: {
    upToSequence: number;
  };
}
export interface CaptureAckMessage {
  version: ProtocolVersion;
  type: "capture_ack";
  requestId: RequestId;
  payload: {};
}
export interface ErrorMessage {
  version: ProtocolVersion;
  type: "error";
  requestId?: RequestId | null;
  payload: ErrorPayload;
}
export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}
export interface ErrorAckMessage {
  version: ProtocolVersion;
  type: "error_ack";
  requestId: RequestId;
  payload: {};
}
export interface CancelMessage {
  version: ProtocolVersion;
  type: "cancel";
  requestId: RequestId;
  payload: {
    reason: string;
  };
}
export interface ClosedMessage {
  version: ProtocolVersion;
  type: "closed";
  requestId: RequestId;
  payload: {};
}
export interface SyncStateMessage {
  version: ProtocolVersion;
  type: "sync_state";
  payload: SyncStatePayload;
}
export interface SyncStatePayload {
  activeJobs: {
    requestId: RequestId;
    tabIds: number[];
    status: string;
  }[];
}
export interface PingMessage {
  version: ProtocolVersion;
  type: "ping";
  payload: PingPayload;
}
export interface PingPayload {
  nonce?: string | null;
  [k: string]: unknown;
}
export interface PongMessage {
  version: ProtocolVersion;
  type: "pong";
  payload: PingPayload;
}

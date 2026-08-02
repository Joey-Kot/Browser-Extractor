export * from "./generated/protocol";

import type { BridgeMessage, ErrorCode, ErrorPayload } from "./generated/protocol";

export const PROTOCOL_VERSION = 4 as const;

export function parseBridgeMessage(data: string): BridgeMessage {
  const value: unknown = JSON.parse(data);
  if (!value || typeof value !== "object") {
    throw new Error("Bridge message must be an object");
  }
  const candidate = value as { version?: unknown; type?: unknown };
  if (candidate.version !== PROTOCOL_VERSION || typeof candidate.type !== "string") {
    throw new Error("Unsupported bridge message");
  }
  return value as BridgeMessage;
}

export class ExtractorError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "ExtractorError";
    this.code = code;
    this.retryable = retryable;
  }

  toPayload(): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable
    };
  }
}

export function asExtractorError(error: unknown): ExtractorError {
  if (error instanceof ExtractorError) {
    return error;
  }
  if (error instanceof Error) {
    return new ExtractorError("extraction_failed", error.message, false);
  }
  return new ExtractorError("extraction_failed", String(error), false);
}

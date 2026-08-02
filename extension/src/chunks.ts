import type { BridgeClient } from "./bridge";
import type { ChunkKind } from "./generated/protocol";
import { PROTOCOL_VERSION } from "./protocol";
import { IncrementalSha256 } from "./sha256";

interface PendingChunk {
  resolve: () => void;
  reject: (error: Error) => void;
  promise: Promise<void>;
}

export class ChunkSender {
  private sequence = 0;
  private totalBytes = 0;
  private readonly pending = new Map<number, PendingChunk>();
  private readonly checksum = new IncrementalSha256();
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly bridge: BridgeClient,
    private readonly requestId: string
  ) {}

  get chunks(): number {
    return this.sequence;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  async sendDocument(html: string): Promise<void> {
    for (const part of splitUtf8(html, this.bridge.limits.chunkBytes)) {
      await this.sendPiece("document", null, part);
    }
  }

  async sendItem(key: string, html: string): Promise<void> {
    for (const part of splitUtf8(html, this.bridge.limits.chunkBytes)) {
      await this.sendPiece("item", key, part);
    }
  }

  acknowledge(upToSequence: number): void {
    for (const [sequence, pending] of this.pending) {
      if (sequence <= upToSequence) {
        pending.resolve();
        this.pending.delete(sequence);
      }
    }
  }

  async finish(): Promise<{ checksum: string; chunks: number; totalBytes: number }> {
    await Promise.all([...this.pending.values()].map((pending) => pending.promise));
    return {
      checksum: this.checksum.digestHex(),
      chunks: this.sequence,
      totalBytes: this.totalBytes
    };
  }

  rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async sendPiece(
    kind: ChunkKind,
    key: string | null,
    html: string
  ): Promise<void> {
    while (this.pending.size >= this.bridge.limits.maxUnackedChunks) {
      await Promise.race([...this.pending.values()].map((pending) => pending.promise));
    }
    const sequence = this.sequence;
    const bytes = this.encoder.encode(html);
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => undefined);
    this.pending.set(sequence, { resolve, reject, promise });
    this.checksum.update(bytes);
    this.totalBytes += bytes.byteLength;
    this.sequence += 1;
    this.bridge.send({
      version: PROTOCOL_VERSION,
      type: "capture_chunk",
      requestId: this.requestId,
      payload: { sequence, kind, key, html }
    });
  }
}

export function* splitUtf8(input: string, maximumBytes: number): Generator<string> {
  if (maximumBytes < 4) {
    throw new Error("chunkBytes must be at least 4");
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);
  if (bytes.byteLength <= maximumBytes) {
    yield input;
    return;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  while (offset < bytes.byteLength) {
    let end = Math.min(bytes.byteLength, offset + maximumBytes);
    if (end < bytes.byteLength) {
      while (end > offset && (bytes[end]! & 0xc0) === 0x80) {
        end -= 1;
      }
    }
    if (end === offset) {
      throw new Error("chunkBytes cannot contain one UTF-8 character");
    }
    yield decoder.decode(bytes.subarray(offset, end));
    offset = end;
  }
}

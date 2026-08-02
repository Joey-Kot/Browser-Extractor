import { BridgeClient } from "./bridge";
import { CdpSession } from "./cdp";
import { ChunkSender } from "./chunks";
import { cleanupJob } from "./cleanup";
import { executeCapture } from "./extractor";
import type {
  BridgeMessage,
  ExtractionRequest,
  ProgressStage
} from "./generated/protocol";
import {
  asExtractorError,
  ExtractorError,
  PROTOCOL_VERSION
} from "./protocol";
import {
  listPersistedJobs,
  persistJobState,
  removeJobState
} from "./storage";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface JobContext {
  requestId: string;
  request: ExtractionRequest;
  createdAt: number;
  mainTabId: number | null;
  ownedTabIds: Set<number>;
  cdp: CdpSession | null;
  sender: ChunkSender;
  abortController: AbortController;
  captureAck: Deferred;
  errorAck: Deferred;
  cancelledByDaemon: boolean;
  cleanupPromise: Promise<void> | null;
  closedSent: boolean;
  status: string;
}

export class JobManager {
  private readonly jobs = new Map<string, JobContext>();

  constructor(private readonly bridge: BridgeClient) {
    chrome.tabs.onCreated.addListener((tab) => {
      void this.trackChildTab(tab);
    });
  }

  async initialize(): Promise<void> {
    const persisted = await listPersistedJobs();
    for (const job of persisted) {
      await Promise.allSettled(job.ownedTabIds.map((tabId) => chrome.tabs.remove(tabId)));
      await removeJobState(job.requestId);
    }
  }

  async handleMessage(message: BridgeMessage): Promise<void> {
    switch (message.type) {
      case "welcome":
        await this.syncState();
        break;
      case "extract":
        this.startJob(message.requestId, message.payload);
        break;
      case "cancel":
        await this.cancelJob(message.requestId);
        break;
      case "chunk_ack":
        this.jobs
          .get(message.requestId)
          ?.sender.acknowledge(message.payload.upToSequence);
        break;
      case "capture_ack":
        this.jobs.get(message.requestId)?.captureAck.resolve();
        break;
      case "error_ack":
        this.jobs.get(message.requestId)?.errorAck.resolve();
        break;
      case "error":
        if (message.requestId) {
          const job = this.jobs.get(message.requestId);
          if (job) {
            job.cancelledByDaemon = true;
            const error = new ExtractorError(
              message.payload.code,
              message.payload.message,
              message.payload.retryable
            );
            job.sender.rejectAll(error);
            job.abortController.abort();
          }
        }
        break;
      case "ping":
      case "pong":
      case "hello":
      case "accepted":
      case "progress":
      case "capture_begin":
      case "capture_chunk":
      case "capture_end":
      case "closed":
      case "sync_state":
        break;
    }
  }

  async syncState(): Promise<void> {
    if (!this.bridge.isConnected()) {
      return;
    }
    this.bridge.send({
      version: PROTOCOL_VERSION,
      type: "sync_state",
      payload: {
        activeJobs: [...this.jobs.values()].map((job) => ({
          requestId: job.requestId,
          tabIds: [...job.ownedTabIds],
          status: job.status
        }))
      }
    });
  }

  async handleDisconnect(): Promise<void> {
    const contexts = [...this.jobs.values()];
    const error = new ExtractorError(
      "browser_unavailable",
      "Bridge connection was lost",
      true
    );
    for (const context of contexts) {
      this.jobs.delete(context.requestId);
      context.cancelledByDaemon = true;
      context.abortController.abort();
      context.sender.rejectAll(error);
    }
    await Promise.allSettled(contexts.map((context) => this.cleanup(context)));
  }

  private startJob(requestId: string, request: ExtractionRequest): void {
    if (this.jobs.has(requestId)) {
      this.bridge.send({
        version: PROTOCOL_VERSION,
        type: "accepted",
        requestId,
        payload: {}
      });
      return;
    }
    const context: JobContext = {
      requestId,
      request,
      createdAt: Date.now(),
      mainTabId: null,
      ownedTabIds: new Set(),
      cdp: null,
      sender: new ChunkSender(this.bridge, requestId),
      abortController: new AbortController(),
      captureAck: deferred(),
      errorAck: deferred(),
      cancelledByDaemon: false,
      cleanupPromise: null,
      closedSent: false,
      status: "accepted"
    };
    this.jobs.set(requestId, context);
    this.bridge.send({
      version: PROTOCOL_VERSION,
      type: "accepted",
      requestId,
      payload: {}
    });
    void this.runJob(context);
  }

  private async runJob(context: JobContext): Promise<void> {
    try {
      await this.progress(context, "creating_tab");
      const tab = await chrome.tabs.create({
        url: "about:blank",
        active: context.request.visibilityMode === "foreground"
      });
      if (tab.id === undefined) {
        throw new ExtractorError("tab_create_failed", "Chrome returned no tab id", true);
      }
      context.mainTabId = tab.id;
      context.ownedTabIds.add(tab.id);
      await this.persist(context);

      context.cdp = new CdpSession(tab.id);
      await context.cdp.attach();
      await this.progress(context, "navigating");
      const navigation = await context.cdp.navigate(
        context.request.url,
        context.request.loadTimeoutMs,
        context.abortController.signal
      );

      await executeCapture({
        requestId: context.requestId,
        request: context.request,
        cdp: context.cdp,
        bridge: this.bridge,
        sender: context.sender,
        signal: context.abortController.signal,
        deadlineAt: context.createdAt + context.request.jobTimeoutMs,
        mimeType: navigation.mimeType,
        mimeTypeUnknown: navigation.mimeTypeUnknown,
        progress: (stage) => this.progress(context, stage)
      });
      await withTimeout(
        context.captureAck.promise,
        Math.min(30000, context.request.jobTimeoutMs),
        "capture_ack timed out"
      );
    } catch (error) {
      if (!context.cancelledByDaemon) {
        const extractionError = asExtractorError(error);
        if (this.bridge.isConnected()) {
          this.bridge.send({
            version: PROTOCOL_VERSION,
            type: "error",
            requestId: context.requestId,
            payload: extractionError.toPayload()
          });
          await Promise.race([
            context.errorAck.promise,
            new Promise<void>((resolve) => setTimeout(resolve, 2000))
          ]);
        }
      }
    } finally {
      await this.cleanup(context);
      this.sendClosed(context);
      this.jobs.delete(context.requestId);
    }
  }

  private async cancelJob(requestId: string): Promise<void> {
    const context = this.jobs.get(requestId);
    if (!context) {
      if (this.bridge.isConnected()) {
        this.bridge.send({
          version: PROTOCOL_VERSION,
          type: "closed",
          requestId,
          payload: {}
        });
      }
      return;
    }
    context.cancelledByDaemon = true;
    context.abortController.abort();
    context.sender.rejectAll(
      new ExtractorError("cancelled", "Job was cancelled by daemon", false)
    );
    await this.cleanup(context);
    this.sendClosed(context);
  }

  private async cleanup(context: JobContext): Promise<void> {
    if (!context.cleanupPromise) {
      context.cleanupPromise = cleanupJob({
        requestId: context.requestId,
        cdp: context.cdp,
        ownedTabIds: context.ownedTabIds,
        abortController: context.abortController
      });
    }
    await context.cleanupPromise;
  }

  private sendClosed(context: JobContext): void {
    if (context.closedSent || !this.bridge.isConnected()) {
      return;
    }
    context.closedSent = true;
    this.bridge.send({
      version: PROTOCOL_VERSION,
      type: "closed",
      requestId: context.requestId,
      payload: {}
    });
  }

  private async progress(
    context: JobContext,
    stage: ProgressStage
  ): Promise<void> {
    context.status = stage;
    await this.persist(context);
    this.bridge.send({
      version: PROTOCOL_VERSION,
      type: "progress",
      requestId: context.requestId,
      payload: { stage }
    });
  }

  private async persist(context: JobContext): Promise<void> {
    if (context.mainTabId === null) {
      return;
    }
    await persistJobState({
      requestId: context.requestId,
      mainTabId: context.mainTabId,
      ownedTabIds: [...context.ownedTabIds],
      status: context.status,
      createdAt: context.createdAt
    });
  }

  private async trackChildTab(tab: chrome.tabs.Tab): Promise<void> {
    if (tab.id === undefined || tab.openerTabId === undefined) {
      return;
    }
    for (const context of this.jobs.values()) {
      if (!context.ownedTabIds.has(tab.openerTabId)) {
        continue;
      }
      context.ownedTabIds.add(tab.id);
      await this.persist(context);
      await chrome.tabs.remove(tab.id).catch(() => undefined);
      return;
    }
  }
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(
  promise: Promise<void>,
  timeoutMs: number,
  message: string
): Promise<void> {
  return Promise.race([
    promise,
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new ExtractorError("protocol_error", message, true)), timeoutMs);
    })
  ]);
}

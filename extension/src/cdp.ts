import { ExtractorError } from "./protocol";

// @types/chrome 0.0.268 predates Chrome 125 flat debugger sessions.
type DebuggerSession = chrome.debugger.Debuggee & { sessionId?: string };
type EventListener = (
  params: Record<string, unknown>,
  source: DebuggerSession
) => void;

interface RemoteObject {
  objectId?: string;
  value?: unknown;
}

interface RuntimeResponse {
  result?: RemoteObject;
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
}

interface ChildTarget {
  sessionId: string;
  frameId: string;
  url: string;
  initialized: Promise<void>;
}

interface FrameReadiness {
  readyState: string;
  url: string;
  loaderId: string;
}

export interface NodeRecord<T> {
  backendNodeId: number;
  metadata: T;
}

export class CdpSession {
  readonly tabId: number;
  private readonly target: chrome.debugger.Debuggee;
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly childTargetsByFrameId = new Map<string, ChildTarget>();
  private readonly childTargetsBySessionId = new Map<string, ChildTarget>();
  private readonly childTargetWaiters = new Set<() => void>();
  private attached = false;
  private frameAutoAttachEnabled = false;
  private readonly eventRouter: (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object
  ) => void;

  constructor(tabId: number) {
    this.tabId = tabId;
    this.target = { tabId };
    this.eventRouter = (source, method, params) => {
      if (source.tabId !== this.tabId) {
        return;
      }
      const session = source as DebuggerSession;
      const eventParams = (params ?? {}) as Record<string, unknown>;
      if (method === "Target.attachedToTarget") {
        this.handleAttachedTarget(eventParams);
      } else if (method === "Target.detachedFromTarget") {
        this.handleDetachedTarget(eventParams);
      }
      for (const listener of this.listeners.get(method) ?? []) {
        listener(eventParams, session);
      }
    };
  }

  async attach(): Promise<void> {
    try {
      await chrome.debugger.attach(this.target, "1.3");
      this.attached = true;
      chrome.debugger.onEvent.addListener(this.eventRouter);
      await Promise.all([
        this.send("Page.enable"),
        this.send("Runtime.enable"),
        this.send("Network.enable")
      ]);
    } catch (error) {
      throw new ExtractorError(
        "debugger_attach_failed",
        error instanceof Error ? error.message : String(error),
        true
      );
    }
  }

  async send<T extends object = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<T> {
    try {
      const target: DebuggerSession = sessionId
        ? { ...this.target, sessionId }
        : this.target;
      return (await chrome.debugger.sendCommand(target, method, params)) as unknown as T;
    } catch (error) {
      throw new ExtractorError(
        "extraction_failed",
        "CDP " + method + " failed: " + (error instanceof Error ? error.message : String(error)),
        true
      );
    }
  }

  async sendWithTimeout<T extends object = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string | undefined,
    timeoutMs: number,
    signal: AbortSignal,
    timeoutMessage: string
  ): Promise<T> {
    return this.withAbortAndTimeout(
      this.send<T>(method, params, sessionId),
      timeoutMs,
      signal,
      timeoutMessage
    );
  }

  on(method: string, listener: EventListener): () => void {
    const listeners = this.listeners.get(method) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(method);
      }
    };
  }

  async navigate(
    url: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<{ mimeType: string; mimeTypeUnknown: boolean }> {
    let mimeType = "";
    const removeResponseListener = this.on("Network.responseReceived", (params) => {
      if (params.type !== "Document") {
        return;
      }
      const response = params.response as { mimeType?: unknown } | undefined;
      if (typeof response?.mimeType === "string") {
        mimeType = response.mimeType;
      }
    });
    const loaded = this.waitForEvent("Page.loadEventFired", timeoutMs, signal);
    try {
      const result = await this.send<{ errorText?: string }>("Page.navigate", { url });
      if (result.errorText) {
        throw new ExtractorError("navigation_failed", result.errorText, true);
      }
      await loaded;
      return {
        mimeType: mimeType || "text/html",
        mimeTypeUnknown: mimeType.length === 0
      };
    } finally {
      removeResponseListener();
    }
  }

  async evaluate<T>(expression: string, awaitPromise = true): Promise<T> {
    const response = await this.send<RuntimeResponse>("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: false
    });
    this.assertRuntimeSuccess(response);
    return response.result?.value as T;
  }

  async evaluateNodeRecords<T>(
    expression: string,
    metadataFunctionDeclaration: string
  ): Promise<Array<NodeRecord<T>>> {
    const objectGroup = "browser-extractor-" + crypto.randomUUID();
    try {
      const recordsResponse = await this.send<RuntimeResponse>("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: false,
        objectGroup,
        userGesture: false
      });
      this.assertRuntimeSuccess(recordsResponse);
      const recordsObjectId = recordsResponse.result?.objectId;
      if (!recordsObjectId) {
        throw new ExtractorError(
          "extraction_failed",
          "Page selection did not return an object array",
          false
        );
      }

      const metadataResponse = await this.send<RuntimeResponse>("Runtime.callFunctionOn", {
        objectId: recordsObjectId,
        functionDeclaration: metadataFunctionDeclaration,
        awaitPromise: true,
        returnByValue: true,
        objectGroup,
        userGesture: false
      });
      this.assertRuntimeSuccess(metadataResponse);
      const metadata = metadataResponse.result?.value as T[] | undefined;
      if (!Array.isArray(metadata)) {
        throw new ExtractorError(
          "extraction_failed",
          "Page selection metadata was not an array",
          false
        );
      }

      const nodesResponse = await this.send<RuntimeResponse>("Runtime.callFunctionOn", {
        objectId: recordsObjectId,
        functionDeclaration: "function() { return this.map((entry) => entry.node); }",
        awaitPromise: true,
        returnByValue: false,
        objectGroup,
        userGesture: false
      });
      this.assertRuntimeSuccess(nodesResponse);
      const nodesObjectId = nodesResponse.result?.objectId;
      if (!nodesObjectId) {
        throw new ExtractorError(
          "extraction_failed",
          "Page selection did not return node handles",
          false
        );
      }

      const properties = await this.send<{
        result?: Array<{ name: string; value?: RemoteObject }>;
      }>("Runtime.getProperties", {
        objectId: nodesObjectId,
        ownProperties: true,
        accessorPropertiesOnly: false,
        generatePreview: false
      });
      const nodeObjects = (properties.result ?? [])
        .filter((property) => /^\d+$/.test(property.name))
        .sort((left, right) => Number(left.name) - Number(right.name))
        .map((property) => property.value?.objectId);

      if (
        nodeObjects.length !== metadata.length ||
        nodeObjects.some((objectId) => !objectId)
      ) {
        throw new ExtractorError(
          "extraction_failed",
          "Page selection node handles did not match their metadata",
          false
        );
      }

      const backendNodeIds: number[] = [];
      for (let offset = 0; offset < nodeObjects.length; offset += 32) {
        const batch = nodeObjects.slice(offset, offset + 32);
        const descriptions = await Promise.all(
          batch.map((objectId) =>
            this.send<{ node: { backendNodeId: number } }>("DOM.describeNode", {
              objectId,
              depth: 0,
              pierce: false
            })
          )
        );
        backendNodeIds.push(...descriptions.map((item) => item.node.backendNodeId));
      }

      return backendNodeIds.map((backendNodeId, index) => ({
        backendNodeId,
        metadata: metadata[index] as T
      }));
    } finally {
      await this.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
    }
  }

  async enableFrameTraversal(): Promise<void> {
    if (this.frameAutoAttachEnabled) {
      return;
    }
    this.frameAutoAttachEnabled = true;
    await this.enableAutoAttach();
  }

  async waitForFrameSession(
    frameId: string,
    expectedUrl: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<{ sessionId: string; url: string; loaderId: string }> {
    const started = Date.now();
    let lastError: unknown = null;
    while (true) {
      if (signal.aborted) {
        throw new ExtractorError("cancelled", "Job was cancelled", false);
      }
      if (Date.now() - started >= timeoutMs) {
        if (lastError instanceof Error) {
          throw lastError;
        }
        throw new ExtractorError(
          "extraction_failed",
          "Frame debugger session or document was not ready before timeout",
          true
        );
      }
      const target = this.childTargetsByFrameId.get(frameId);
      if (target) {
        try {
          await this.withAbortAndTimeout(
            target.initialized,
            Math.max(1, timeoutMs - (Date.now() - started)),
            signal,
            "Frame debugger session initialization timed out"
          );
          if (this.childTargetsByFrameId.get(frameId) === target) {
            const remaining = timeoutMs - (Date.now() - started);
            if (remaining <= 0) {
              throw new ExtractorError(
                "extraction_failed",
                "Frame document was not ready before timeout",
                true
              );
            }
            const readiness = await this.readFrameReadiness(
              target.sessionId,
              remaining,
              signal
            );
            if (this.childTargetsByFrameId.get(frameId) !== target) {
              continue;
            }
            const expected = preferredExpectedFrameUrl(expectedUrl, target.url);
            if (frameDocumentIsReady(readiness, expected)) {
              target.url = readiness.url || target.url;
              return {
                sessionId: target.sessionId,
                url: target.url,
                loaderId: readiness.loaderId
              };
            }
            lastError = null;
          }
        } catch (error) {
          if (error instanceof ExtractorError && error.code === "cancelled") {
            throw error;
          }
          lastError = error;
        }
      }
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) {
        if (lastError instanceof Error) {
          throw lastError;
        }
        throw new ExtractorError(
          "extraction_failed",
          "Frame debugger session or document was not ready before timeout",
          true
        );
      }
      await this.waitForChildTargetChange(Math.min(remaining, 100), signal);
    }
  }

  async detach(): Promise<void> {
    chrome.debugger.onEvent.removeListener(this.eventRouter);
    this.listeners.clear();
    if (!this.attached) {
      return;
    }
    if (this.frameAutoAttachEnabled) {
      await this.send("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true
      }).catch(() => undefined);
    }
    this.attached = false;
    try {
      await chrome.debugger.detach(this.target);
    } catch {
      // A missing tab or already detached target is clean.
    } finally {
      this.childTargetsByFrameId.clear();
      this.childTargetsBySessionId.clear();
      this.notifyChildTargetWaiters();
    }
  }

  private assertRuntimeSuccess(response: RuntimeResponse): void {
    if (!response.exceptionDetails) {
      return;
    }
    throw new ExtractorError(
      "extraction_failed",
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Page evaluation failed",
      false
    );
  }

  private handleAttachedTarget(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
    const targetInfo = params.targetInfo as
      | { targetId?: unknown; type?: unknown; url?: unknown }
      | undefined;
    if (
      !sessionId ||
      targetInfo?.type !== "iframe" ||
      typeof targetInfo.targetId !== "string"
    ) {
      return;
    }

    let resolveInitialized!: () => void;
    let rejectInitialized!: (error: Error) => void;
    const initialized = new Promise<void>((resolve, reject) => {
      resolveInitialized = resolve;
      rejectInitialized = reject;
    });
    const target: ChildTarget = {
      sessionId,
      frameId: targetInfo.targetId,
      url: typeof targetInfo.url === "string" ? targetInfo.url : "",
      initialized
    };
    void initialized.catch(() => undefined);
    this.childTargetsByFrameId.set(target.frameId, target);
    this.childTargetsBySessionId.set(target.sessionId, target);
    this.notifyChildTargetWaiters();

    void this.initializeChildTarget(target)
      .then(resolveInitialized)
      .catch((error: unknown) => {
        this.removeChildTarget(target);
        rejectInitialized(error instanceof Error ? error : new Error(String(error)));
      });
  }

  private handleDetachedTarget(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
    if (!sessionId) {
      return;
    }
    const target = this.childTargetsBySessionId.get(sessionId);
    if (!target) {
      return;
    }
    this.removeChildTarget(target);
  }

  private removeChildTarget(target: ChildTarget): void {
    if (this.childTargetsBySessionId.get(target.sessionId) === target) {
      this.childTargetsBySessionId.delete(target.sessionId);
    }
    if (this.childTargetsByFrameId.get(target.frameId) === target) {
      this.childTargetsByFrameId.delete(target.frameId);
    }
    this.notifyChildTargetWaiters();
  }

  private async initializeChildTarget(target: ChildTarget): Promise<void> {
    await Promise.all([
      this.send("DOM.enable", { includeWhitespace: "all" }, target.sessionId),
      this.send("Page.enable", undefined, target.sessionId),
      this.send("Runtime.enable", undefined, target.sessionId)
    ]);
    await this.refreshChildFrameIdentity(target);
    await this.enableAutoAttach(target.sessionId);
  }

  private async readFrameReadiness(
    sessionId: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<FrameReadiness> {
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    const before = await this.sendWithTimeout<{
      frameTree?: { frame?: { loaderId?: unknown; url?: unknown } };
    }>(
      "Page.getFrameTree",
      undefined,
      sessionId,
      remaining(),
      signal,
      "Frame loader check timed out"
    );
    const runtime = await this.sendWithTimeout<RuntimeResponse>(
      "Runtime.evaluate",
      {
        expression: "({ readyState: document.readyState, url: location.href })",
        awaitPromise: false,
        returnByValue: true,
        userGesture: false
      },
      sessionId,
      remaining(),
      signal,
      "Frame readiness check timed out"
    );
    const after = await this.sendWithTimeout<{
      frameTree?: { frame?: { loaderId?: unknown; url?: unknown } };
    }>(
      "Page.getFrameTree",
      undefined,
      sessionId,
      remaining(),
      signal,
      "Frame loader confirmation timed out"
    );
    this.assertRuntimeSuccess(runtime);
    const value = runtime.result?.value as
      | { readyState?: unknown; url?: unknown }
      | undefined;
    const beforeFrame = before.frameTree?.frame;
    const frame = after.frameTree?.frame;
    const runtimeUrl = typeof value?.url === "string" ? value.url : "";
    const frameUrl = typeof frame?.url === "string" ? frame.url : "";
    const beforeLoaderId =
      typeof beforeFrame?.loaderId === "string" ? beforeFrame.loaderId : "";
    const loaderId = typeof frame?.loaderId === "string" ? frame.loaderId : "";
    const stable =
      (!beforeLoaderId || !loaderId || beforeLoaderId === loaderId) &&
      sameFrameDocumentUrl(runtimeUrl, frameUrl);
    return {
      readyState:
        stable && typeof value?.readyState === "string" ? value.readyState : "",
      url: runtimeUrl || frameUrl,
      loaderId
    };
  }

  private async refreshChildFrameIdentity(target: ChildTarget): Promise<void> {
    const response = await this.send<{
      frameTree?: { frame?: { id?: unknown; url?: unknown } };
    }>("Page.getFrameTree", undefined, target.sessionId).catch(() => null);
    const frame = response?.frameTree?.frame;
    if (
      !frame ||
      typeof frame.id !== "string" ||
      this.childTargetsBySessionId.get(target.sessionId) !== target
    ) {
      return;
    }
    if (this.childTargetsByFrameId.get(target.frameId) === target) {
      this.childTargetsByFrameId.delete(target.frameId);
    }
    target.frameId = frame.id;
    if (typeof frame.url === "string") {
      target.url = frame.url;
    }
    this.childTargetsByFrameId.set(target.frameId, target);
    this.notifyChildTargetWaiters();
  }

  private async enableAutoAttach(sessionId?: string): Promise<void> {
    await this.send(
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: "iframe", exclude: false }]
      },
      sessionId
    );
  }

  private waitForChildTargetChange(
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        this.childTargetWaiters.delete(done);
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        this.childTargetWaiters.delete(done);
        reject(new ExtractorError("cancelled", "Job was cancelled", false));
      };
      timer = setTimeout(done, timeoutMs);
      this.childTargetWaiters.add(done);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private notifyChildTargetWaiters(): void {
    for (const waiter of [...this.childTargetWaiters]) {
      waiter();
    }
  }

  private withAbortAndTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    signal: AbortSignal,
    message: string
  ): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(
        new ExtractorError("cancelled", "Job was cancelled", false)
      );
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(new ExtractorError("cancelled", "Job was cancelled", false));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new ExtractorError("extraction_failed", message, true));
      }, timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        }
      );
    });
  }

  private waitForEvent(
    method: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let remove = (): void => undefined;
      let timer: ReturnType<typeof setTimeout>;
      const abort = () => {
        cleanup();
        reject(new ExtractorError("cancelled", "Job was cancelled", false));
      };
      function cleanup(): void {
        clearTimeout(timer);
        remove();
        signal.removeEventListener("abort", abort);
      }
      remove = this.on(method, (params) => {
        cleanup();
        resolve(params);
      });
      timer = setTimeout(() => {
        cleanup();
        reject(new ExtractorError("load_timeout", "Page load timed out", true));
      }, timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

function preferredExpectedFrameUrl(ownerUrl: string, targetUrl: string): string {
  return isProvisionalFrameUrl(targetUrl) ? ownerUrl || targetUrl : targetUrl;
}

function frameDocumentIsReady(
  readiness: FrameReadiness,
  expectedUrl: string
): boolean {
  if (readiness.readyState !== "complete" || !readiness.url) {
    return false;
  }
  return !(
    !isProvisionalFrameUrl(expectedUrl) &&
    isProvisionalFrameUrl(readiness.url)
  );
}

function isProvisionalFrameUrl(value: string): boolean {
  return value === "" || /^about:blank(?:[?#].*)?$/i.test(value);
}

function sameFrameDocumentUrl(left: string, right: string): boolean {
  if (!left || !right) {
    return true;
  }
  return stripFragment(left) === stripFragment(right);
}

function stripFragment(value: string): string {
  const hash = value.indexOf("#");
  return hash === -1 ? value : value.slice(0, hash);
}

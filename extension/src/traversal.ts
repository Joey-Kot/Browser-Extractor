import { CdpSession } from "./cdp";
import type {
  TraversalOptions,
  TraversalWarning
} from "./generated/protocol";
import { ExtractorError } from "./protocol";

const REMOVED_ELEMENTS = new Set(["script", "style", "noscript", "template"]);
const URL_ATTRIBUTES = new Set(["href", "src", "poster", "action", "formaction"]);
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

export interface CdpDomNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName: string;
  nodeValue: string;
  attributes?: string[];
  children?: CdpDomNode[];
  documentURL?: string;
  baseURL?: string;
  shadowRootType?: "user-agent" | "open" | "closed";
  shadowRoots?: CdpDomNode[];
  frameId?: string;
  contentDocument?: CdpDomNode;
}

interface SerializationContext {
  baseUrl: string;
  shadowDepth: number;
  frameDepth: number;
  applyUserExclusions: boolean;
  sessionId?: string;
}

interface SerializationState {
  cdp: CdpSession | null;
  options: TraversalOptions;
  signal: AbortSignal;
  excludedNodeIds: Set<number>;
  warnings: TraversalWarning[];
  warningKeys: Set<string>;
  deadlineAt: number;
  operationTimeoutMs: () => number;
}

export class TraversalSerializer {
  private readonly warnings: TraversalWarning[] = [];
  private readonly warningKeys = new Set<string>();
  private rootBaseUrl: string | null = null;

  constructor(
    private readonly cdp: CdpSession,
    private readonly options: TraversalOptions,
    private readonly signal: AbortSignal,
    private readonly deadlineAt: number,
    private readonly commandTimeoutMs: number
  ) {}

  async initialize(): Promise<void> {
    if (this.options.iframes.enabled) {
      await this.cdp.enableFrameTraversal();
    }
    await this.cdp.sendWithTimeout(
      "DOM.enable",
      { includeWhitespace: "all" },
      undefined,
      this.nextOperationTimeoutMs(),
      this.signal,
      "Top-level DOM initialization timed out"
    );
    const document = await this.cdp.sendWithTimeout<{ root: CdpDomNode }>(
      "DOM.getDocument",
      { depth: 0, pierce: false },
      undefined,
      this.nextOperationTimeoutMs(),
      this.signal,
      "Top-level document lookup timed out"
    );
    this.rootBaseUrl = document.root.baseURL ?? document.root.documentURL ?? "";
  }

  async serializeBackendNode(
    backendNodeId: number,
    excludedNodeIds: Set<number>,
    contentsOnly = false
  ): Promise<string> {
    this.throwIfAborted();
    const response = await this.cdp.sendWithTimeout<{ node: CdpDomNode }>(
      "DOM.describeNode",
      {
        backendNodeId,
        depth: -1,
        pierce: false
      },
      undefined,
      this.nextOperationTimeoutMs(),
      this.signal,
      "Top-level DOM capture timed out"
    );
    const state = this.state(excludedNodeIds);
    const context: SerializationContext = {
      baseUrl: this.rootBaseUrl ?? "",
      shadowDepth: 0,
      frameDepth: 0,
      applyUserExclusions: true
    };
    return serializeSelectedNode(response.node, context, state, contentsOnly);
  }

  getWarnings(): TraversalWarning[] {
    return [...this.warnings];
  }

  private state(excludedNodeIds: Set<number>): SerializationState {
    return {
      cdp: this.cdp,
      options: this.options,
      signal: this.signal,
      excludedNodeIds,
      warnings: this.warnings,
      warningKeys: this.warningKeys,
      deadlineAt: this.deadlineAt,
      operationTimeoutMs: () => this.nextOperationTimeoutMs()
    };
  }

  private nextOperationTimeoutMs(): number {
    this.throwIfAborted();
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) {
      throw new ExtractorError("job_timeout", "Job deadline expired", false);
    }
    return Math.max(1, Math.min(this.commandTimeoutMs, remaining));
  }

  private throwIfAborted(): void {
    if (this.signal.aborted) {
      throw new ExtractorError("cancelled", "Job was cancelled", false);
    }
  }
}

export async function serializeCdpDomForTest(
  node: CdpDomNode,
  options: TraversalOptions,
  contentsOnly = false,
  excludedNodeIds = new Set<number>()
): Promise<string> {
  const state: SerializationState = {
    cdp: null,
    options,
    signal: new AbortController().signal,
    excludedNodeIds,
    warnings: [],
    warningKeys: new Set(),
    deadlineAt: Number.POSITIVE_INFINITY,
    operationTimeoutMs: () => 30_000
  };
  const context: SerializationContext = {
    baseUrl: "https://top.example/root/page",
    shadowDepth: 0,
    frameDepth: 0,
    applyUserExclusions: true
  };
  return serializeSelectedNode(node, context, state, contentsOnly);
}

async function serializeSelectedNode(
  node: CdpDomNode,
  context: SerializationContext,
  state: SerializationState,
  contentsOnly: boolean
): Promise<string> {
  if (
    context.applyUserExclusions &&
    state.excludedNodeIds.has(node.backendNodeId)
  ) {
    return "";
  }
  return contentsOnly
    ? serializeElementContents(node, context, state)
    : serializeNode(node, context, state);
}

async function serializeNode(
  node: CdpDomNode,
  context: SerializationContext,
  state: SerializationState
): Promise<string> {
  throwIfAborted(state.signal);
  switch (node.nodeType) {
    case 1:
      return serializeElement(node, context, state);
    case 3:
      return escapeText(node.nodeValue);
    case 8:
      return "<!--" + node.nodeValue.replaceAll("--", "- -") + "-->";
    case 10:
      return "<!doctype " + escapeText(node.nodeName || "html") + ">";
    case 9:
    case 11:
      return serializeChildren(node, context, state);
    default:
      return "";
  }
}

async function serializeElement(
  node: CdpDomNode,
  context: SerializationContext,
  state: SerializationState
): Promise<string> {
  const tagName = node.localName || node.nodeName;
  const normalizedTagName = tagName.toLowerCase();
  if (
    REMOVED_ELEMENTS.has(normalizedTagName) ||
    (context.applyUserExclusions && state.excludedNodeIds.has(node.backendNodeId))
  ) {
    return "";
  }

  const attributes = serializeAttributes(node.attributes ?? [], context.baseUrl);
  let html = "<" + tagName + attributes + ">";
  if (!VOID_ELEMENTS.has(normalizedTagName)) {
    html += await serializeElementContents(node, context, state);
    html += "</" + tagName + ">";
  }

  if (normalizedTagName === "iframe" && state.options.iframes.enabled) {
    html += await serializeFrame(node, context, state);
  }
  return html;
}

async function serializeElementContents(
  node: CdpDomNode,
  context: SerializationContext,
  state: SerializationState
): Promise<string> {
  return (
    (await serializeChildren(node, context, state)) +
    (await serializeShadowRoots(node, context, state))
  );
}

async function serializeChildren(
  node: CdpDomNode,
  context: SerializationContext,
  state: SerializationState
): Promise<string> {
  const parts: string[] = [];
  for (const child of node.children ?? []) {
    if (child.shadowRootType) {
      continue;
    }
    parts.push(await serializeNode(child, context, state));
  }
  return parts.join("");
}

async function serializeShadowRoots(
  host: CdpDomNode,
  context: SerializationContext,
  state: SerializationState
): Promise<string> {
  if (!state.options.shadowDom.enabled) {
    return "";
  }
  const depth = context.shadowDepth + 1;
  if (depth > state.options.shadowDom.maxDepth) {
    return "";
  }

  const parts: string[] = [];
  for (const root of host.shadowRoots ?? []) {
    const rootType = root.shadowRootType ?? "open";
    if (rootType === "user-agent") {
      continue;
    }
    const childContext: SerializationContext = {
      ...context,
      shadowDepth: depth,
      applyUserExclusions: false
    };
    try {
      const loadedRoot = await loadSubtree(
        root,
        childContext,
        state,
        "Shadow Root DOM capture timed out"
      );
      parts.push(
        '<section data-extractor-shadow-root="' +
          escapeAttribute(rootType) +
          '" data-extractor-shadow-depth="' +
          depth +
          '">' +
          (await serializeChildren(loadedRoot, childContext, state)) +
          "</section>"
      );
    } catch (error) {
      rethrowTerminalTraversalError(error, state);
      addWarning(state, {
        kind: "shadow_root",
        message: error instanceof Error ? error.message : String(error),
        depth
      });
    }
  }
  return parts.join("");
}

async function serializeFrame(
  owner: CdpDomNode,
  context: SerializationContext,
  state: SerializationState
): Promise<string> {
  const depth = context.frameDepth + 1;
  if (depth > state.options.iframes.maxDepth) {
    return "";
  }

  const ownerUrl = frameOwnerUrl(owner, context.baseUrl);
  const frameDeadline = Date.now() + state.operationTimeoutMs();
  try {
    if (owner.contentDocument) {
      const document = await loadSubtree(
        owner.contentDocument,
        context,
        state,
        "Frame DOM capture timed out",
        remainingFrameTimeout(frameDeadline, state)
      );
      return serializeFrameDocument(document, depth, context, state, ownerUrl);
    }
    if (!owner.frameId || !state.cdp) {
      return "";
    }

    while (true) {
      const target = await state.cdp.waitForFrameSession(
        owner.frameId,
        ownerUrl,
        remainingFrameTimeout(frameDeadline, state),
        state.signal
      );
      const response = await state.cdp.sendWithTimeout<{ root: CdpDomNode }>(
        "DOM.getDocument",
        { depth: -1, pierce: false },
        target.sessionId,
        remainingFrameTimeout(frameDeadline, state),
        state.signal,
        "Frame DOM capture timed out"
      );
      const confirmed = await state.cdp.waitForFrameSession(
        owner.frameId,
        ownerUrl,
        remainingFrameTimeout(frameDeadline, state),
        state.signal
      );
      if (
        confirmed.sessionId !== target.sessionId ||
        (target.loaderId &&
          confirmed.loaderId &&
          confirmed.loaderId !== target.loaderId) ||
        !sameDocumentUrl(response.root.documentURL ?? "", confirmed.url)
      ) {
        continue;
      }
      const childContext: SerializationContext = {
        ...context,
        sessionId: confirmed.sessionId
      };
      return serializeFrameDocument(
        response.root,
        depth,
        childContext,
        state,
        confirmed.url || ownerUrl
      );
    }
  } catch (error) {
    rethrowTerminalTraversalError(error, state);
    addWarning(state, {
      kind: "iframe",
      message: error instanceof Error ? error.message : String(error),
      ...(ownerUrl ? { url: ownerUrl } : {}),
      depth
    });
    return "";
  }
}

async function serializeFrameDocument(
  document: CdpDomNode,
  depth: number,
  parentContext: SerializationContext,
  state: SerializationState,
  fallbackUrl = ""
): Promise<string> {
  const documentUrl = document.documentURL || fallbackUrl;
  const baseUrl = document.baseURL || documentUrl || parentContext.baseUrl;
  const body = findElement(document, "body");
  const childContext: SerializationContext = {
    ...parentContext,
    baseUrl,
    frameDepth: depth,
    applyUserExclusions: false
  };
  const contents = body
    ? await serializeElementContents(body, childContext, state)
    : await serializeDocumentContents(document, childContext, state);
  const origin = urlOrigin(documentUrl);
  return (
    '<section data-extractor-frame-url="' +
    escapeAttribute(documentUrl) +
    '" data-extractor-frame-depth="' +
    depth +
    '"' +
    (origin ? ' data-extractor-frame-origin="' + escapeAttribute(origin) + '"' : "") +
    ">" +
    contents +
    "</section>"
  );
}

async function serializeDocumentContents(
  document: CdpDomNode,
  context: SerializationContext,
  state: SerializationState
): Promise<string> {
  const documentElement = findElement(document, "html");
  if (!documentElement) {
    return serializeChildren(document, context, state);
  }
  const body = findElement(documentElement, "body");
  return body
    ? serializeElementContents(body, context, state)
    : serializeChildren(documentElement, context, state);
}

function findElement(node: CdpDomNode, localName: string): CdpDomNode | null {
  if ((node.localName || node.nodeName).toLowerCase() === localName) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findElement(child, localName);
    if (found) {
      return found;
    }
  }
  return null;
}

function serializeAttributes(attributes: string[], baseUrl: string): string {
  const parts: string[] = [];
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const rawName = attributes[index];
    const rawValue = attributes[index + 1];
    if (rawName === undefined || rawValue === undefined) {
      continue;
    }
    const name = rawName.toLowerCase();
    const value = URL_ATTRIBUTES.has(name)
      ? absolutizeUrl(rawValue, baseUrl)
      : rawValue;
    parts.push(" " + rawName + '="' + escapeAttribute(value) + '"');
  }
  return parts.join("");
}

function absolutizeUrl(value: string, baseUrl: string): string {
  const trimmed = value.trim();
  if (
    /^(?:data|mailto|tel|javascript|vbscript):/i.test(trimmed) ||
    !baseUrl
  ) {
    return value;
  }
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return value;
  }
}

function frameOwnerUrl(owner: CdpDomNode, baseUrl: string): string {
  const attributes = owner.attributes ?? [];
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    if (attributes[index]?.toLowerCase() === "src") {
      const value = attributes[index + 1] ?? "";
      return value.trim() ? absolutizeUrl(value, baseUrl) : "";
    }
  }
  return owner.documentURL ?? "";
}

function urlOrigin(value: string): string {
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value);
    return url.origin === "null" ? "" : url.origin;
  } catch {
    return "";
  }
}

function addWarning(state: SerializationState, warning: TraversalWarning): void {
  const key = [warning.kind, warning.url ?? "", warning.depth, warning.message].join("|");
  if (state.warningKeys.has(key)) {
    return;
  }
  state.warningKeys.add(key);
  state.warnings.push(warning);
}

async function loadSubtree(
  node: CdpDomNode,
  context: SerializationContext,
  state: SerializationState,
  timeoutMessage: string,
  timeoutMs = state.operationTimeoutMs()
): Promise<CdpDomNode> {
  if (node.children !== undefined || !state.cdp) {
    return node;
  }
  const response = await state.cdp.sendWithTimeout<{ node: CdpDomNode }>(
    "DOM.describeNode",
    {
      backendNodeId: node.backendNodeId,
      depth: -1,
      pierce: false
    },
    context.sessionId,
    timeoutMs,
    state.signal,
    timeoutMessage
  );
  return response.node;
}

function remainingFrameTimeout(
  frameDeadline: number,
  state: SerializationState
): number {
  throwIfAborted(state.signal);
  const remaining = Math.min(frameDeadline, state.deadlineAt) - Date.now();
  if (remaining <= 0) {
    if (state.deadlineAt <= frameDeadline) {
      throw new ExtractorError("job_timeout", "Job deadline expired", false);
    }
    throw new ExtractorError("extraction_failed", "Frame traversal timed out", true);
  }
  return Math.max(1, remaining);
}

function rethrowTerminalTraversalError(
  error: unknown,
  state: SerializationState
): void {
  if (
    error instanceof ExtractorError &&
    (error.code === "cancelled" || error.code === "job_timeout")
  ) {
    throw error;
  }
  if (state.signal.aborted) {
    throw new ExtractorError("cancelled", "Job was cancelled", false);
  }
  if (Date.now() >= state.deadlineAt) {
    throw new ExtractorError("job_timeout", "Job deadline expired", false);
  }
}

function sameDocumentUrl(capturedUrl: string, currentUrl: string): boolean {
  if (!capturedUrl || !currentUrl) {
    return true;
  }
  return withoutFragment(capturedUrl) === withoutFragment(currentUrl);
}

function withoutFragment(value: string): string {
  const hash = value.indexOf("#");
  return hash === -1 ? value : value.slice(0, hash);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ExtractorError("cancelled", "Job was cancelled", false);
  }
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

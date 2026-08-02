import { BridgeClient } from "./bridge";
import { CdpSession } from "./cdp";
import { ChunkSender } from "./chunks";
import type {
  ExtractionRequest,
  ProgressStage,
  TraversalOptions
} from "./generated/protocol";
import { ExtractorError, PROTOCOL_VERSION } from "./protocol";
import { advanceScrollableContainers } from "./scroller";
import {
  assertIncludeSelectorsMatch,
  collectFeedCandidates,
  collectFeedCandidateReferences,
  effectiveIncludeSelectors,
  extractDocument,
  findExcludedNodeIds,
  getPageInfo,
  selectDocumentNodeReferences,
  validateSelectors,
  waitForDomSettle,
  waitForSelector
} from "./selectors";
import { TraversalSerializer } from "./traversal";

const IDLE_SCROLL_PASSES_TO_STOP = 2;

export interface CaptureRuntime {
  requestId: string;
  request: ExtractionRequest;
  cdp: CdpSession;
  bridge: BridgeClient;
  sender: ChunkSender;
  signal: AbortSignal;
  deadlineAt: number;
  mimeType: string;
  mimeTypeUnknown: boolean;
  progress: (stage: ProgressStage) => Promise<void>;
}

export async function executeCapture(runtime: CaptureRuntime): Promise<void> {
  const { request, cdp, signal } = runtime;
  const includeSelectors = effectiveIncludeSelectors(request.includeSelectors);
  await validateSelectors(cdp, [
    request.waitForSelector,
    ...includeSelectors,
    ...request.excludeSelectors,
    request.scroll.dedupe.selector
  ]);

  await runtime.progress("waiting");
  if (request.waitForSelector) {
    await waitForSelector(cdp, request.waitForSelector, request.loadTimeoutMs, signal);
  }
  await waitForDomSettle(cdp, request.settleMs);
  await assertIncludeSelectorsMatch(cdp, includeSelectors);
  await runtime.progress("collecting");

  const page = await getPageInfo(cdp);
  const mime = runtime.mimeType;
  assertSupportedMimeType(mime);
  const traversal = traversalOptions(request);
  const serializer = traversalEnabled(traversal)
    ? new TraversalSerializer(
        cdp,
        traversal,
        signal,
        runtime.deadlineAt,
        request.loadTimeoutMs
      )
    : null;
  await serializer?.initialize();

  if (request.mode === "document") {
    await captureDocument(runtime, page, mime, serializer, includeSelectors);
  } else {
    await captureFeed(runtime, page, mime, serializer, includeSelectors);
  }
}

async function captureDocument(
  runtime: CaptureRuntime,
  page: { finalUrl: string; title: string },
  mimeType: string,
  serializer: TraversalSerializer | null,
  includeSelectors: string[]
): Promise<void> {
  const scrollRounds = runtime.request.scroll.enabled
    ? await scrollDocumentToEnd(runtime, includeSelectors)
    : 0;
  const capture = serializer
    ? await extractTraversedDocument(runtime, serializer, includeSelectors)
    : await extractDocument(
        runtime.cdp,
        includeSelectors,
        runtime.request.excludeSelectors
      );
  runtime.bridge.send({
    version: PROTOCOL_VERSION,
    type: "capture_begin",
    requestId: runtime.requestId,
    payload: {
      captureType: "document",
      selectionApplied: capture.selectionApplied,
      finalUrl: page.finalUrl,
      title: page.title,
      mimeType,
      mimeTypeUnknown: runtime.mimeTypeUnknown
    }
  });
  await runtime.progress("receiving");
  await runtime.sender.sendDocument(capture.html);
  const end = await runtime.sender.finish();
  runtime.bridge.send({
    version: PROTOCOL_VERSION,
    type: "capture_end",
    requestId: runtime.requestId,
    payload: {
      ...end,
      scrollRounds,
      matchedItems: 0,
      warnings: serializer?.getWarnings() ?? []
    }
  });
}

async function scrollDocumentToEnd(
  runtime: CaptureRuntime,
  includeSelectors: string[]
): Promise<number> {
  let idleScrollPasses = 0;
  let scrollRounds = 0;
  while (idleScrollPasses < IDLE_SCROLL_PASSES_TO_STOP) {
    assertCaptureActive(runtime);
    const advance = await advanceScrollableContainers(
      runtime.cdp,
      includeSelectors,
      runtime.request.scroll.maxDistancePx
    );
    if (advance.advancedContainers === 0) {
      idleScrollPasses += 1;
    } else {
      idleScrollPasses = 0;
      scrollRounds += 1;
    }
    if (idleScrollPasses < IDLE_SCROLL_PASSES_TO_STOP) {
      await waitForDomSettle(runtime.cdp, runtime.request.scroll.settleMs);
    }
  }
  return scrollRounds;
}

async function captureFeed(
  runtime: CaptureRuntime,
  page: { finalUrl: string; title: string },
  mimeType: string,
  serializer: TraversalSerializer | null,
  includeSelectors: string[]
): Promise<void> {
  runtime.bridge.send({
    version: PROTOCOL_VERSION,
    type: "capture_begin",
    requestId: runtime.requestId,
    payload: {
      captureType: "feed",
      selectionApplied: true,
      finalUrl: page.finalUrl,
      title: page.title,
      mimeType,
      mimeTypeUnknown: runtime.mimeTypeUnknown
    }
  });
  await runtime.progress("receiving");

  const { scrollRounds, matchedItems } = await captureAutomaticFeed(
    runtime,
    serializer,
    includeSelectors
  );

  const end = await runtime.sender.finish();
  runtime.bridge.send({
    version: PROTOCOL_VERSION,
    type: "capture_end",
    requestId: runtime.requestId,
    payload: {
      ...end,
      scrollRounds,
      matchedItems,
      warnings: serializer?.getWarnings() ?? []
    }
  });
}

async function captureAutomaticFeed(
  runtime: CaptureRuntime,
  serializer: TraversalSerializer | null,
  includeSelectors: string[]
): Promise<{ scrollRounds: number; matchedItems: number }> {
  const seen = new Set<string>();
  let idleScrollPasses = 0;
  let scrollRounds = 0;
  let matchedItems = 0;

  while (true) {
    assertCaptureActive(runtime);
    await assertIncludeSelectorsMatch(runtime.cdp, includeSelectors);
    const candidates = serializer
      ? await collectTraversedFeedCandidates(
          runtime,
          serializer,
          includeSelectors
        )
      : await collectFeedCandidates(
          runtime.cdp,
          includeSelectors,
          runtime.request.excludeSelectors,
          runtime.request.scroll.dedupe.attribute,
          runtime.request.scroll.dedupe.selector
        );
    for (const candidate of candidates) {
      const key = await dedupeKey(runtime.request, candidate);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      await runtime.sender.sendItem(key, candidate.html);
      matchedItems += 1;
    }

    const advance = await advanceScrollableContainers(
      runtime.cdp,
      includeSelectors,
      runtime.request.scroll.maxDistancePx
    );
    if (advance.advancedContainers === 0) {
      idleScrollPasses += 1;
    } else {
      idleScrollPasses = 0;
      scrollRounds += 1;
    }
    if (idleScrollPasses >= IDLE_SCROLL_PASSES_TO_STOP) {
      break;
    }
    await waitForDomSettle(runtime.cdp, runtime.request.scroll.settleMs);
  }

  return { scrollRounds, matchedItems };
}

async function extractTraversedDocument(
  runtime: CaptureRuntime,
  serializer: TraversalSerializer,
  includeSelectors: string[]
): Promise<{ html: string; selectionApplied: boolean }> {
  const selection = await selectDocumentNodeReferences(
    runtime.cdp,
    includeSelectors
  );
  const excludedNodeIds = await findExcludedNodeIds(
    runtime.cdp,
    runtime.request.excludeSelectors
  );
  const html: string[] = [];
  for (const node of selection.nodes) {
    html.push(
      await serializer.serializeBackendNode(
        node.backendNodeId,
        excludedNodeIds,
        node.contentsOnly
      )
    );
  }
  return {
    html: html.filter(Boolean).join("\n"),
    selectionApplied: selection.selectionApplied
  };
}

async function collectTraversedFeedCandidates(
  runtime: CaptureRuntime,
  serializer: TraversalSerializer,
  includeSelectors: string[]
): Promise<Array<{
  html: string;
  attributeValue: string | null;
  link: string | null;
  autoKey: string | null;
}>> {
  const references = await collectFeedCandidateReferences(
    runtime.cdp,
    includeSelectors,
    runtime.request.scroll.dedupe.attribute,
    runtime.request.scroll.dedupe.selector
  );
  const excludedNodeIds = await findExcludedNodeIds(
    runtime.cdp,
    runtime.request.excludeSelectors
  );
  const candidates = [];
  for (const reference of references) {
    const html = await serializer.serializeBackendNode(
      reference.backendNodeId,
      excludedNodeIds,
      reference.contentsOnly
    );
    if (!html) {
      continue;
    }
    candidates.push({
      html,
      attributeValue: reference.attributeValue,
      link: reference.link,
      autoKey: reference.autoKey
    });
  }
  return candidates;
}

function assertCaptureActive(runtime: CaptureRuntime): void {
  if (runtime.signal.aborted) {
    throw new ExtractorError("cancelled", "Job was cancelled", false);
  }
  if (Date.now() >= runtime.deadlineAt) {
    throw new ExtractorError("job_timeout", "Extraction deadline exceeded", true);
  }
}

function traversalOptions(request: ExtractionRequest): TraversalOptions {
  return request.traversal ?? {
    shadowDom: { enabled: false, maxDepth: 3 },
    iframes: { enabled: false, maxDepth: 3 }
  };
}

function traversalEnabled(options: TraversalOptions): boolean {
  return options.shadowDom.enabled || options.iframes.enabled;
}

async function dedupeKey(
  request: ExtractionRequest,
  candidate: {
    html: string;
    attributeValue: string | null;
    link: string | null;
    autoKey: string | null;
  }
): Promise<string> {
  switch (request.scroll.dedupe.strategy) {
    case "attribute":
      return candidate.attributeValue ?? (await hashText(candidate.html));
    case "link":
      return candidate.link ?? (await hashText(candidate.html));
    case "html_hash":
      return hashText(candidate.html);
    case "auto":
      return candidate.autoKey ?? (await hashText(candidate.html));
  }
}

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function assertSupportedMimeType(mimeType: string): void {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (
    mime === "" ||
    mime === "text/html" ||
    mime === "application/xhtml+xml" ||
    mime === "text/plain" ||
    mime === "application/json" ||
    mime.endsWith("+json")
  ) {
    return;
  }
  throw new ExtractorError(
    "unsupported_content_type",
    "Unsupported content type: " + mimeType,
    false
  );
}

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
import type { FeedCandidate } from "./selectors";
import { TraversalSerializer } from "./traversal";

const IDLE_SCROLL_PASSES_TO_STOP = 2;
const MINIMUM_IDLE_OBSERVATION_MS = 2_500;

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
  await waitForDomSettle(cdp, request.settleMs, Math.min(
    request.loadTimeoutMs, runtime.deadlineAt - Date.now()
  ));
  assertCaptureActive(runtime);
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
  const retained = new Map<string, {
    html: string; autoKey: string | null; nodePosition: number; nodeKey: string
  }>();
  const nodeKeys = new Map<string, string>();
  const orderedKeys: string[] = [];
  const scrolling = runtime.request.scroll.enabled
    ? await captureAutomaticContent(runtime, serializer, includeSelectors, async (key, candidate) => {
        const previousKey = nodeKeys.get(candidate.nodeKey);
        const previous = previousKey === undefined ? undefined : retained.get(previousKey);
        if (previousKey !== undefined && previousKey !== key && previous &&
          previous.nodeKey === candidate.nodeKey &&
          previous.autoKey === null && candidate.autoKey === null &&
          Math.abs(previous.nodePosition - candidate.nodePosition) < 1) {
          // Updating a live anonymous node is not evidence of DOM eviction.
          retained.delete(previousKey);
          const index = orderedKeys.indexOf(previousKey);
          if (index >= 0) {
            if (orderedKeys.includes(key)) orderedKeys.splice(index, 1);
            else orderedKeys[index] = key;
          }
        }
        retained.set(key, {
          html: candidate.html, autoKey: candidate.autoKey,
          nodePosition: candidate.nodePosition, nodeKey: candidate.nodeKey
        });
        nodeKeys.set(candidate.nodeKey, key);
      }, {
        preserveDocumentContext: true,
        onCollected: (keys) => {
          // Insert new records before the next surviving sibling/context block.
          // A conclusion seen on the first pass stays after later replies.
          const known = new Set(orderedKeys);
          let nextKey: string | undefined;
          for (const key of [...keys].reverse()) {
            if (!known.has(key)) {
              const index = nextKey === undefined ? orderedKeys.length : orderedKeys.indexOf(nextKey);
              orderedKeys.splice(index, 0, key);
              known.add(key);
            }
            nextKey = key;
          }
        }
      })
    : null;
  const evicted = scrolling && [...retained.keys()].some((key) => !scrolling.finalKeys.has(key));
  let capture: { html: string; selectionApplied: boolean };
  if (evicted) {
    // No single live DOM snapshot can contain content evicted by virtualization.
    capture = {
      html: '<section data-extractor-scroll-history="true">\n' +
        orderedKeys.map((key) => retained.get(key)!.html).join("\n") + "\n</section>",
      selectionApplied: true
    };
  } else {
    capture = serializer
      ? await extractTraversedDocument(runtime, serializer, includeSelectors)
      : await extractDocument(runtime.cdp, includeSelectors, runtime.request.excludeSelectors);
  }
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
      scrollRounds: scrolling?.scrollRounds ?? 0,
      matchedItems: 0,
      warnings: serializer?.getWarnings() ?? []
    }
  });
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

  const { scrollRounds, matchedItems } = await captureAutomaticContent(
    runtime,
    serializer,
    includeSelectors,
    async (key, candidate, isNew) => {
      if (isNew) await runtime.sender.sendItem(key, candidate.html);
    }
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

async function captureAutomaticContent(
  runtime: CaptureRuntime,
  serializer: TraversalSerializer | null,
  includeSelectors: string[],
  retain: (key: string, candidate: FeedCandidate, isNew: boolean) => Promise<void>,
  options?: { preserveDocumentContext: boolean; onCollected: (keys: Set<string>) => void }
): Promise<{ scrollRounds: number; matchedItems: number; finalKeys: Set<string> }> {
  const seen = new Set<string>();
  let idleScrollPasses = 0;
  let scrollRounds = 0;
  let matchedItems = 0;
  let finalKeys = new Set<string>();
  let lastMovementAt = Date.now();
  const idleObservationMs = Math.min(runtime.request.loadTimeoutMs, Math.max(
    MINIMUM_IDLE_OBSERVATION_MS,
    runtime.request.settleMs,
    runtime.request.scroll.settleMs * 2
  ));

  while (true) {
    assertCaptureActive(runtime);
    // Readiness was checked before entering the loop. A virtualizer may briefly
    // remove all matching items while fetching its next window.
    const candidates = serializer
      ? await collectTraversedFeedCandidates(
          runtime,
          serializer,
          includeSelectors,
          options?.preserveDocumentContext
        )
      : await collectFeedCandidates(
          runtime.cdp,
          includeSelectors,
          runtime.request.excludeSelectors,
          runtime.request.scroll.dedupe.attribute,
          runtime.request.scroll.dedupe.selector,
          options?.preserveDocumentContext
        );
    finalKeys = new Set();
    for (const candidate of candidates) {
      const key = candidate.isContext
        ? "context:" + candidate.nodeKey
        : (options?.preserveDocumentContext ? "content:" : "") + await dedupeKey(runtime.request, candidate);
      finalKeys.add(key);
      const isNew = !seen.has(key);
      if (isNew) {
        seen.add(key);
        matchedItems += 1;
      }
      await retain(key, candidate, isNew);
    }
    options?.onCollected(finalKeys);

    const advance = await advanceScrollableContainers(
      runtime.cdp,
      includeSelectors,
      runtime.request.scroll.maxDistancePx,
      runtime.request.excludeSelectors
    );
    if (advance.advancedContainers === 0) {
      idleScrollPasses += 1;
    } else {
      idleScrollPasses = 0;
      scrollRounds += 1;
      lastMovementAt = Date.now();
    }
    if (idleScrollPasses >= IDLE_SCROLL_PASSES_TO_STOP) {
      const idleMs = Date.now() - lastMovementAt;
      const pending = runtime.cdp.hasPendingPageRequests();
      if ((!advance.budgetAvailable && !pending) ||
        idleMs >= runtime.request.loadTimeoutMs ||
        (idleMs >= idleObservationMs && !pending)) {
        break;
      }
    }
    const quietMs = advance.advancedContainers > 0
      ? runtime.request.scroll.settleMs
      : Math.max(100, runtime.request.scroll.settleMs);
    await waitForDomSettle(runtime.cdp, quietMs, Math.min(
      Math.max(250, runtime.request.scroll.settleMs * 2),
      runtime.deadlineAt - Date.now()
    ));
  }

  return { scrollRounds, matchedItems, finalKeys };
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
  includeSelectors: string[],
  preserveDocumentContext = false
): Promise<FeedCandidate[]> {
  const references = await collectFeedCandidateReferences(
    runtime.cdp,
    includeSelectors,
    runtime.request.scroll.dedupe.attribute,
    runtime.request.scroll.dedupe.selector,
    runtime.request.excludeSelectors,
    preserveDocumentContext
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
      isContext: reference.isContext,
      nodeKey: reference.nodeKey,
      nodePosition: reference.nodePosition,
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

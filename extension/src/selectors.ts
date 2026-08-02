import { CdpSession } from "./cdp";
import { ExtractorError } from "./protocol";

export interface FeedCandidate {
  html: string;
  attributeValue: string | null;
  link: string | null;
  autoKey: string | null;
}

export interface FeedCandidateReference extends Omit<FeedCandidate, "html"> {
  backendNodeId: number;
  contentsOnly: boolean;
}

export interface DocumentNodeReference {
  backendNodeId: number;
  contentsOnly: boolean;
}

export interface DocumentNodeSelection {
  nodes: DocumentNodeReference[];
  selectionApplied: boolean;
  matched: number;
}

export function effectiveIncludeSelectors(selectors: string[]): string[] {
  return selectors.length === 0 ? ["body"] : selectors;
}

export async function validateSelectors(
  cdp: CdpSession,
  selectors: Array<string | null | undefined>
): Promise<void> {
  const values = selectors.filter(
    (value): value is string => value !== null && value !== undefined
  );
  const result = await cdp.evaluate<{ invalid: string | null }>(
    invoke(validateSelectorsInPage, values)
  );
  if (result.invalid !== null) {
    throw new ExtractorError(
      "selector_invalid",
      "Invalid CSS selector: " + result.invalid,
      false
    );
  }
}

export async function assertIncludeSelectorsMatch(
  cdp: CdpSession,
  includeSelectors: string[]
): Promise<void> {
  const matched = await cdp.evaluate<boolean>(
    invoke(hasAnySelectorMatchInPage, includeSelectors)
  );
  if (!matched) {
    throw new ExtractorError(
      "selector_not_found",
      "includeSelectors did not match any element",
      false
    );
  }
}

export async function waitForSelector(
  cdp: CdpSession,
  selector: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal.aborted) {
      throw new ExtractorError("cancelled", "Job was cancelled", false);
    }
    const matched = await cdp.evaluate<boolean>(
      "Boolean(document.querySelector(" + JSON.stringify(selector) + "))"
    );
    if (matched) {
      return;
    }
    await delay(150, signal);
  }
  throw new ExtractorError(
    "selector_not_found",
    "Page did not match waitForSelector before timeout",
    false
  );
}

export async function waitForDomSettle(cdp: CdpSession, settleMs: number): Promise<void> {
  if (settleMs <= 0) {
    return;
  }
  await cdp.evaluate<void>(invoke(waitForDomSettleInPage, settleMs));
}

export async function extractDocument(
  cdp: CdpSession,
  includeSelectors: string[],
  excludeSelectors: string[]
): Promise<{ html: string; selectionApplied: boolean }> {
  const result = await cdp.evaluate<{
    html: string;
    selectionApplied: boolean;
    matched: number;
  }>(
    invoke(
      extractDocumentInPage,
      {
        includeSelectors,
        excludeSelectors
      },
      [findNodes, outermostNodes, cloneAndClean]
    )
  );
  if (result.matched === 0) {
    throw new ExtractorError(
      "selector_not_found",
      "includeSelectors did not match any element",
      false
    );
  }
  return result;
}

export async function selectDocumentNodeReferences(
  cdp: CdpSession,
  includeSelectors: string[]
): Promise<DocumentNodeSelection> {
  const records = await cdp.evaluateNodeRecords<{ contentsOnly: boolean }>(
    invoke(
      selectDocumentRecordsInPage,
      { includeSelectors },
      [findNodes, outermostNodes]
    ),
    "function() { return this.map((entry) => ({ contentsOnly: entry.contentsOnly })); }"
  );
  if (records.length === 0) {
    throw new ExtractorError(
      "selector_not_found",
      "includeSelectors did not match any element",
      false
    );
  }
  return {
    nodes: records.map((record) => ({
      backendNodeId: record.backendNodeId,
      contentsOnly: record.metadata.contentsOnly
    })),
    selectionApplied: true,
    matched: records.length
  };
}

export async function findExcludedNodeIds(
  cdp: CdpSession,
  excludeSelectors: string[]
): Promise<Set<number>> {
  if (excludeSelectors.length === 0) {
    return new Set();
  }
  const records = await cdp.evaluateNodeRecords<Record<string, never>>(
    invoke(findNodeRecordsInPage, excludeSelectors, [findNodes]),
    "function() { return this.map(() => ({})); }"
  );
  return new Set(records.map((record) => record.backendNodeId));
}

export async function collectFeedCandidates(
  cdp: CdpSession,
  includeSelectors: string[],
  excludeSelectors: string[],
  attribute: string | null | undefined,
  linkSelector: string | null | undefined
): Promise<FeedCandidate[]> {
  return cdp.evaluate<FeedCandidate[]>(
    invoke(collectFeedCandidatesInPage, {
      includeSelectors,
      excludeSelectors,
      attribute: attribute ?? null,
      linkSelector: linkSelector ?? null
    }, [
      findNodes,
      outermostNodes,
      inferContentBlocks,
      collectMatchingNodes,
      collectRepeatedSiblingNodes,
      structuralSignature,
      hasMeaningfulContent,
      fallbackContentNodes,
      preferredLinkForNode,
      automaticKeyForNode,
      cloneAndClean
    ])
  );
}

export async function collectFeedCandidateReferences(
  cdp: CdpSession,
  includeSelectors: string[],
  attribute: string | null | undefined,
  linkSelector: string | null | undefined
): Promise<FeedCandidateReference[]> {
  const records = await cdp.evaluateNodeRecords<{
    attributeValue: string | null;
    link: string | null;
    autoKey: string | null;
    contentsOnly: boolean;
  }>(
    invoke(
      collectFeedCandidateRecordsInPage,
      {
        includeSelectors,
        attribute: attribute ?? null,
        linkSelector: linkSelector ?? null
      },
      [
        findNodes,
        outermostNodes,
        inferContentBlocks,
        collectMatchingNodes,
        collectRepeatedSiblingNodes,
        structuralSignature,
        hasMeaningfulContent,
        fallbackContentNodes,
        preferredLinkForNode,
        automaticKeyForNode
      ]
    ),
    `function() {
      return this.map((entry) => ({
        attributeValue: entry.attributeValue,
        link: entry.link,
        autoKey: entry.autoKey,
        contentsOnly: entry.contentsOnly
      }));
    }`
  );
  return records.map((record) => ({
    backendNodeId: record.backendNodeId,
    ...record.metadata
  }));
}

export async function getPageInfo(
  cdp: CdpSession
): Promise<{ finalUrl: string; title: string }> {
  return cdp.evaluate<{ finalUrl: string; title: string }>(
    "({ finalUrl: location.href, title: document.title || '' })"
  );
}

function invoke<T>(
  fn: (argument: T) => unknown,
  argument: T,
  helpers: Function[] = []
): string {
  const declarations = helpers.map((helper) => helper.toString()).join(";\n");
  return (
    "(() => {" +
    declarations +
    "; return (" +
    fn.toString() +
    ")(" +
    JSON.stringify(argument) +
    "); })()"
  );
}

function validateSelectorsInPage(selectors: string[]): { invalid: string | null } {
  for (const selector of selectors) {
    try {
      document.querySelectorAll(selector);
    } catch {
      return { invalid: selector };
    }
  }
  return { invalid: null };
}

function hasAnySelectorMatchInPage(selectors: string[]): boolean {
  return selectors.some((selector) => document.querySelector(selector) !== null);
}

function waitForDomSettleInPage(settleMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer = window.setTimeout(done, settleMs);
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(done, settleMs);
    });
    function done(): void {
      observer.disconnect();
      resolve();
    }
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    });
  });
}

function extractDocumentInPage(options: {
  includeSelectors: string[];
  excludeSelectors: string[];
}): { html: string; selectionApplied: boolean; matched: number } {
  const roots = outermostNodes(findNodes(document, options.includeSelectors));
  const html = roots
    .map((root) =>
      cloneAndClean(root, options.excludeSelectors, root === document.body)
    )
    .filter((value): value is string => value !== null)
    .join("\n");
  return {
    html,
    selectionApplied: true,
    matched: roots.length
  };
}

function selectDocumentRecordsInPage(options: {
  includeSelectors: string[];
}): Array<{ node: Element; contentsOnly: boolean }> {
  const roots = outermostNodes(findNodes(document, options.includeSelectors));
  return roots.map((node) => ({
    node,
    contentsOnly: node === document.body
  }));
}

function findNodeRecordsInPage(selectors: string[]): Array<{ node: Element }> {
  return findNodes(document, selectors).map((node) => ({ node }));
}

function collectFeedCandidatesInPage(options: {
  includeSelectors: string[];
  excludeSelectors: string[];
  attribute: string | null;
  linkSelector: string | null;
}): FeedCandidate[] {
  const scopes = outermostNodes(findNodes(document, options.includeSelectors));
  return inferContentBlocks(scopes)
    .map<FeedCandidate | null>((node) => {
      const html = cloneAndClean(
        node,
        options.excludeSelectors,
        node === document.body
      );
      if (html === null || html.trim() === "") {
        return null;
      }
      const preferredLink = preferredLinkForNode(node, options.linkSelector);
      return {
        html,
        attributeValue: options.attribute ? node.getAttribute(options.attribute) : null,
        link: preferredLink?.href ?? null,
        autoKey: automaticKeyForNode(node, preferredLink)
      };
    })
    .filter((value): value is FeedCandidate => value !== null);
}

function collectFeedCandidateRecordsInPage(options: {
  includeSelectors: string[];
  attribute: string | null;
  linkSelector: string | null;
}): Array<{
  node: Element;
  attributeValue: string | null;
  link: string | null;
  autoKey: string | null;
  contentsOnly: boolean;
}> {
  const scopes = outermostNodes(findNodes(document, options.includeSelectors));
  return inferContentBlocks(scopes).map((node) => {
    const preferredLink = preferredLinkForNode(node, options.linkSelector);
    return {
      node,
      attributeValue: options.attribute ? node.getAttribute(options.attribute) : null,
      link: preferredLink?.href ?? null,
      autoKey: automaticKeyForNode(node, preferredLink),
      contentsOnly: node === document.body
    };
  });
}

function inferContentBlocks(scopes: Element[]): Element[] {
  const selected = new Set<Element>();
  const itemSelector = [
    "article",
    "li",
    "table",
    "tr",
    '[role="article"]',
    '[role="listitem"]',
    '[role="row"]',
    "[data-post-id]",
    "[data-item-id]",
    "[data-id]",
    "[data-key]"
  ].join(",");
  const textSelector = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "pre",
    "blockquote",
    "figure",
    "figcaption",
    "dt",
    "dd",
    "details",
    "img",
    "video",
    "audio",
    "canvas",
    "a[href]"
  ].join(",");

  for (const scope of scopes) {
    const itemNodes = outermostNodes(
      collectMatchingNodes(scope, itemSelector).filter(hasMeaningfulContent)
    );
    const repeatedNodes = outermostNodes(
      collectRepeatedSiblingNodes(scope).filter(
        (candidate) =>
          !itemNodes.some(
            (item) => item.contains(candidate) || candidate.contains(item)
          )
      )
    );
    const structuralNodes = [...itemNodes, ...repeatedNodes];
    const leafContainerNodes = collectMatchingNodes(
      scope,
      "div,section,main,td,th"
    ).filter(
      (candidate) =>
        hasMeaningfulContent(candidate) &&
        ![...candidate.children].some(hasMeaningfulContent)
    );
    const textNodes = outermostNodes(
      [...collectMatchingNodes(scope, textSelector), ...leafContainerNodes].filter(
        (candidate) =>
          hasMeaningfulContent(candidate) &&
          !structuralNodes.some(
            (container) =>
              container === candidate || container.contains(candidate)
          )
      )
    );
    const nodes = [...structuralNodes, ...textNodes];
    for (const node of nodes.length > 0 ? nodes : fallbackContentNodes(scope)) {
      selected.add(node);
    }
  }

  return [...selected].sort((left, right) => {
    const position = left.compareDocumentPosition(right);
    return position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
  });
}

function collectMatchingNodes(scope: Element, selector: string): Element[] {
  const nodes: Element[] = [];
  if (scope.matches(selector)) {
    nodes.push(scope);
  }
  nodes.push(...scope.querySelectorAll(selector));
  return nodes;
}

function collectRepeatedSiblingNodes(scope: Element): Element[] {
  const repeated = new Set<Element>();
  const parents = [scope, ...scope.querySelectorAll("*")];
  for (const parent of parents) {
    const groups = new Map<string, Element[]>();
    for (const child of parent.children) {
      if (!hasMeaningfulContent(child)) {
        continue;
      }
      const signature = structuralSignature(child);
      const group = groups.get(signature) ?? [];
      group.push(child);
      groups.set(signature, group);
    }
    for (const [signature, group] of groups) {
      const minimum = signature.includes("|") ? 2 : 3;
      if (group.length < minimum) {
        continue;
      }
      for (const child of group) {
        repeated.add(child);
      }
    }
  }
  return [...repeated];
}

function structuralSignature(element: Element): string {
  const role = element.getAttribute("role")?.trim().toLowerCase() ?? "";
  const classes = [...element.classList]
    .filter((value) => value.length <= 80)
    .sort()
    .slice(0, 6)
    .join(".");
  return [element.tagName.toLowerCase(), role, classes]
    .filter(Boolean)
    .join("|");
}

function hasMeaningfulContent(element: Element): boolean {
  const text = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return (
    text.length > 0 ||
    element.matches("img,video,audio,canvas,svg") ||
    element.querySelector("img,video,audio,canvas,svg") !== null
  );
}

function fallbackContentNodes(scope: Element): Element[] {
  let current = scope;
  while (true) {
    const meaningfulChildren = [...current.children].filter(hasMeaningfulContent);
    if (meaningfulChildren.length !== 1) {
      return meaningfulChildren.length > 0 ? meaningfulChildren : [current];
    }
    const child = meaningfulChildren[0]!;
    if (child.matches("article,li,tr,h1,h2,h3,h4,h5,h6,p,pre,blockquote")) {
      return [child];
    }
    current = child;
  }
}

function preferredLinkForNode(
  node: Element,
  linkSelector: string | null
): HTMLAnchorElement | null {
  if (linkSelector) {
    if (node.matches(linkSelector) && node instanceof HTMLAnchorElement) {
      return node;
    }
    return node.querySelector<HTMLAnchorElement>(linkSelector);
  }
  if (node instanceof HTMLAnchorElement && node.href) {
    return node;
  }
  return node.querySelector<HTMLAnchorElement>("a[href]");
}

function automaticKeyForNode(
  node: Element,
  preferredLink: HTMLAnchorElement | null
): string | null {
  return (
    node.getAttribute("data-post-id") ??
    node.getAttribute("data-item-id") ??
    node.getAttribute("data-id") ??
    node.getAttribute("data-key") ??
    preferredLink?.href ??
    null
  );
}

function findNodes(root: ParentNode, selectors: string[]): Element[] {
  const found = new Set<Element>();
  for (const selector of selectors) {
    for (const element of root.querySelectorAll(selector)) {
      found.add(element);
    }
  }
  return [...found].sort((left, right) => {
    const position = left.compareDocumentPosition(right);
    return position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
  });
}

function outermostNodes(nodes: Element[]): Element[] {
  const unique = [...new Set(nodes)];
  const selected = new Set(unique);
  return unique.filter((candidate) => {
    let ancestor = candidate.parentElement;
    while (ancestor) {
      if (selected.has(ancestor)) {
        return false;
      }
      ancestor = ancestor.parentElement;
    }
    return true;
  });
}

function cloneAndClean(
  node: Element,
  excluded: string[],
  contentsOnly = false
): string | null {
  const selectors = ["script", "style", "noscript", "template", ...excluded];
  if (selectors.some((selector) => node.matches(selector))) {
    return null;
  }
  const clone = node.cloneNode(true) as Element;
  for (const selector of selectors) {
    for (const unwanted of clone.querySelectorAll(selector)) {
      unwanted.remove();
    }
  }
  return contentsOnly ? clone.innerHTML : clone.outerHTML;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      reject(new ExtractorError("cancelled", "Job was cancelled", false));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

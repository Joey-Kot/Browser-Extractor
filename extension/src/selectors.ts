import { CdpSession } from "./cdp";
import { collectImageSourcesInPage, resolveImageSource } from "./images";
import { ExtractorError } from "./protocol";

export interface FeedCandidate {
  html: string;
  nodeKey: string;
  nodePosition: number;
  attributeValue: string | null;
  link: string | null;
  autoKey: string | null;
  isContext?: boolean;
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

export async function waitForDomSettle(
  cdp: CdpSession,
  settleMs: number,
  maxWaitMs?: number
): Promise<void> {
  if (settleMs <= 0) {
    return;
  }
  await cdp.evaluate<void>(invoke(waitForDomSettleInPage, {
    settleMs,
    maxWaitMs: maxWaitMs === undefined ? null : Math.max(1, maxWaitMs)
  }));
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
      [findNodes, outermostNodes, resolveImageSource, collectImageSourcesInPage, cloneAndClean]
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
  linkSelector: string | null | undefined,
  preserveDocumentContext = false
): Promise<FeedCandidate[]> {
  return cdp.evaluate<FeedCandidate[]>(
    invoke(collectFeedCandidatesInPage, {
      includeSelectors,
      excludeSelectors,
      attribute: attribute ?? null,
      linkSelector: linkSelector ?? null,
      preserveDocumentContext
    }, [
      findNodes,
      outermostNodes,
      inferContentBlocks,
      selectCaptureBlocks,
      collectMatchingNodes,
      collectRepeatedSiblingNodes,
      structuralSignature,
      hasMeaningfulContent,
      isExcludedContentNode,
      contentNodeKey,
      contentNodePosition,
      fallbackContentNodes,
      preferredLinkForNode,
      automaticKeyForNode,
      resolveImageSource,
      collectImageSourcesInPage,
      cloneAndClean
    ])
  );
}

export async function collectFeedCandidateReferences(
  cdp: CdpSession,
  includeSelectors: string[],
  attribute: string | null | undefined,
  linkSelector: string | null | undefined,
  excludeSelectors: string[] = [],
  preserveDocumentContext = false
): Promise<FeedCandidateReference[]> {
  const records = await cdp.evaluateNodeRecords<{
    attributeValue: string | null;
    link: string | null;
    autoKey: string | null;
    nodeKey: string;
    nodePosition: number;
    contentsOnly: boolean;
    isContext: boolean;
  }>(
    invoke(
      collectFeedCandidateRecordsInPage,
      {
        includeSelectors,
        excludeSelectors,
        attribute: attribute ?? null,
        linkSelector: linkSelector ?? null,
        preserveDocumentContext
      },
      [
        findNodes,
        outermostNodes,
        inferContentBlocks,
        selectCaptureBlocks,
        collectMatchingNodes,
        collectRepeatedSiblingNodes,
        structuralSignature,
        hasMeaningfulContent,
        isExcludedContentNode,
        contentNodeKey,
        contentNodePosition,
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
        nodeKey: entry.nodeKey,
        nodePosition: entry.nodePosition,
        contentsOnly: entry.contentsOnly,
        isContext: entry.isContext
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

function waitForDomSettleInPage(options: { settleMs: number; maxWaitMs: number | null }): Promise<void> {
  return new Promise((resolve) => {
    let timer = window.setTimeout(done, options.settleMs);
    const deadlineTimer = options.maxWaitMs === null
      ? null
      : window.setTimeout(done, options.maxWaitMs);
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(done, options.settleMs);
    });
    function done(): void {
      window.clearTimeout(timer);
      if (deadlineTimer !== null) {
        window.clearTimeout(deadlineTimer);
      }
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
  preserveDocumentContext: boolean;
}): FeedCandidate[] {
  const scopes = outermostNodes(findNodes(document, options.includeSelectors));
  return selectCaptureBlocks(scopes, options.preserveDocumentContext)
    .filter(({ node }) => !isExcludedContentNode(node, scopes, options.excludeSelectors))
    .map<FeedCandidate | null>(({ node, isContext }) => {
      const html = cloneAndClean(
        node,
        options.excludeSelectors,
        node === document.body
      );
      if (html === null || html.trim() === "") {
        return null;
      }
      const element = node instanceof Element ? node : null;
      const preferredLink = element ? preferredLinkForNode(element, options.linkSelector) : null;
      return {
        html,
        nodeKey: contentNodeKey(node),
        nodePosition: contentNodePosition(node),
        attributeValue: options.attribute && element ? element.getAttribute(options.attribute) : null,
        link: preferredLink?.href ?? null,
        autoKey: element ? automaticKeyForNode(element, preferredLink, options.linkSelector !== null) : null,
        isContext
      };
    })
    .filter((value): value is FeedCandidate => value !== null);
}

function collectFeedCandidateRecordsInPage(options: {
  includeSelectors: string[];
  excludeSelectors: string[];
  attribute: string | null;
  linkSelector: string | null;
  preserveDocumentContext: boolean;
}): Array<{
  node: Element | Text;
  attributeValue: string | null;
  link: string | null;
  autoKey: string | null;
  nodeKey: string;
  nodePosition: number;
  contentsOnly: boolean;
  isContext: boolean;
}> {
  const scopes = outermostNodes(findNodes(document, options.includeSelectors));
  return selectCaptureBlocks(scopes, options.preserveDocumentContext)
    .filter(({ node }) => !isExcludedContentNode(node, scopes, options.excludeSelectors))
    .map(({ node, isContext }) => {
      const element = node instanceof Element ? node : null;
      const preferredLink = element ? preferredLinkForNode(element, options.linkSelector) : null;
      return {
        node,
        nodeKey: contentNodeKey(node),
        nodePosition: contentNodePosition(node),
        attributeValue: options.attribute && element ? element.getAttribute(options.attribute) : null,
        link: preferredLink?.href ?? null,
        autoKey: element ? automaticKeyForNode(element, preferredLink, options.linkSelector !== null) : null,
        contentsOnly: node === document.body,
        isContext
      };
    });
}

function isExcludedContentNode(node: Element | Text, scopes: Element[], selectors: string[]): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return selectors.some((selector) => {
    const excluded = element?.closest(selector);
    return excluded != null && scopes.some((scope) => scope.contains(excluded));
  });
}

function contentNodeKey(node: Node): string {
  const holder = globalThis as typeof globalThis & {
    __browserExtractorContentNodes?: { nodes: WeakMap<Node, number>; nextId: number };
  };
  const registry = holder.__browserExtractorContentNodes ??= { nodes: new WeakMap(), nextId: 1 };
  let id = registry.nodes.get(node);
  if (id === undefined) {
    id = registry.nextId++;
    registry.nodes.set(node, id);
  }
  return String(id);
}

function contentNodePosition(node: Element | Text): number {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) return 0;
  const documentScroller = document.scrollingElement;
  let top = element.getBoundingClientRect().top + (documentScroller?.scrollTop ?? window.scrollY);
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor !== documentScroller) top += ancestor.scrollTop;
  }
  return top;
}

function selectCaptureBlocks(
  scopes: Element[],
  preserveDocumentContext: boolean
): Array<{ node: Element | Text; isContext: boolean }> {
  const inferred = inferContentBlocks(scopes);
  if (!preserveDocumentContext) return inferred.map((node) => ({ node, isContext: false }));
  const blocks = new Set(outermostNodes(inferred));
  const ancestors = new Set<Element>();
  for (const block of blocks) {
    for (let parent = block.parentElement; parent; parent = parent.parentElement) ancestors.add(parent);
  }
  const result: Array<{ node: Element | Text; isContext: boolean }> = [];
  function visit(node: Node): void {
    if (node instanceof Element) {
      if (blocks.has(node)) {
        result.push({ node, isContext: false });
      } else if (!ancestors.has(node)) {
        // Preserve whole uncovered subtrees, including inline formatting,
        // frame owners and hosts whose content lives in a Shadow Root.
        result.push({ node, isContext: true });
      } else {
        for (const child of node.childNodes) visit(child);
      }
    } else if (node instanceof Text && node.data.trim()) {
      result.push({ node, isContext: true });
    }
  }
  for (const scope of scopes) visit(scope);
  return result;
}

function inferContentBlocks(scopes: Element[]): Element[] {
  const selected = new Set<Element>();
  const semanticSelector = [
    "article",
    "li",
    "table",
    "tr",
    '[role="article"]',
    '[role="listitem"]',
    '[role="row"]'
  ].join(",");
  const identitySelector = [
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
    const semanticNodes = outermostNodes(
      collectMatchingNodes(scope, semanticSelector).filter(hasMeaningfulContent)
    );
    const repeatedCandidates = outermostNodes(
      collectRepeatedSiblingNodes(scope).filter((candidate) =>
        !semanticNodes.some((node) => node.contains(candidate) || candidate.contains(node))
      )
    );
    const identifiedNodes = outermostNodes(
      collectMatchingNodes(scope, identitySelector).filter((candidate) =>
        hasMeaningfulContent(candidate) &&
        !semanticNodes.some((node) => node.contains(candidate) || candidate.contains(node)) &&
        !repeatedCandidates.some((node) => node !== candidate &&
          (node.contains(candidate) || candidate.contains(node)))
      )
    );
    const itemNodes = [...semanticNodes, ...identifiedNodes];
    const repeatedNodes = outermostNodes(
      repeatedCandidates.filter(
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
  preferredLink: HTMLAnchorElement | null,
  explicitLinkSelector: boolean
): string | null {
  for (const attribute of ["data-post-id", "data-item-id"]) {
    const value = node.getAttribute(attribute)?.trim();
    if (value) {
      return attribute + ":" + value;
    }
  }
  if (explicitLinkSelector) {
    return preferredLink?.href ?? null;
  }
  function ownLink(link: Element | null): string | null {
    if (!(link instanceof HTMLAnchorElement) || !node.contains(link) ||
      !link.getAttribute("href")?.trim() || !["http:", "https:"].includes(link.protocol)) {
      return null;
    }
    const owner = link.closest("article,li,[role='article'],[role='listitem']");
    return owner && owner !== node && node.contains(owner) ? null : link.href;
  }
  if (node instanceof HTMLAnchorElement) {
    return ownLink(node);
  }
  for (const bookmark of node.querySelectorAll("a[rel~='bookmark'][href]")) {
    const link = ownLink(bookmark);
    if (link) return link;
  }
  for (const time of node.querySelectorAll("time")) {
    const link = ownLink(time.closest("a[href]"));
    if (link) return link;
  }
  for (const attribute of ["data-id", "data-key"]) {
    const value = node.getAttribute(attribute)?.trim();
    if (value) return attribute + ":" + value;
  }
  // Author, navigation and action links cannot identify the enclosing content.
  return null;
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

export function outermostNodes(nodes: Element[]): Element[] {
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
  node: Element | Text,
  excluded: string[],
  contentsOnly = false
): string | null {
  if (node instanceof Text) {
    return node.data.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  const selectors = ["script", "style", "noscript", "template", ...excluded];
  if (selectors.some((selector) => node.matches(selector))) {
    return null;
  }
  const sources = collectImageSourcesInPage(node);
  // An inert owner document prevents src updates from initiating image requests.
  const clone = node.ownerDocument.implementation.createHTMLDocument("").importNode(node, true);
  const images = [...clone.querySelectorAll("img")];
  if (clone.localName === "img") {
    images.unshift(clone as HTMLImageElement);
  }
  // Match all exclusions against the original attributes and structure before
  // either image recovery or removals can change later selector matches.
  const unwanted = new Set(selectors.flatMap((selector) => [...clone.querySelectorAll(selector)]));
  for (const element of unwanted) element.remove();
  for (let index = 0; index < images.length; index += 1) {
    const source = sources[index]?.source;
    if (source && (images[index] === clone || clone.contains(images[index]!))) {
      const image = images[index]!;
      image.setAttribute("src", source);
      image.removeAttribute("srcset");
      image.removeAttribute("sizes");
      if (image.parentElement?.localName === "picture") {
        for (const child of image.parentElement.children) {
          if (child.localName === "source") {
            child.removeAttribute("srcset");
            child.removeAttribute("sizes");
          }
        }
      }
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

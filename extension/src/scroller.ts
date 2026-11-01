import { CdpSession } from "./cdp";
import { outermostNodes } from "./selectors";

export interface AutoScrollAdvance {
  discoveredContainers: number;
  advancedContainers: number;
  distancePx: number;
  budgetAvailable: boolean;
}

interface ScrollContainerState {
  distancePx: number;
}

interface AutoScrollRegistry {
  states: WeakMap<Element, ScrollContainerState>;
}

export async function advanceScrollableContainers(
  cdp: CdpSession,
  includeSelectors: string[],
  maxDistancePx: number,
  excludeSelectors: string[] = []
): Promise<AutoScrollAdvance> {
  const helpers = [
    calculateScrollStep,
    outermostNodes,
    getAutoScrollRegistryInPage,
    discoverScrollableContainersInPage,
    isScrollableElementInPage,
    isExcludedContainerInPage,
    isRelatedToScopesInPage
  ]
    .map((helper) => helper.toString())
    .join(";\n");
  const options = JSON.stringify({ includeSelectors, maxDistancePx, excludeSelectors });
  return cdp.evaluate<AutoScrollAdvance>(
    "(() => {" +
      helpers +
      "; return (" +
      advanceScrollableContainersInPage.toString() +
      ")(" +
      options +
      "); })()"
  );
}

export function calculateScrollStep(
  clientHeight: number,
  remainingDistancePx: number
): number {
  const maximumStepPx = 1_500;
  const viewportStep = Math.max(1, Math.floor(clientHeight * 0.8));
  return Math.max(
    1,
    Math.min(maximumStepPx, viewportStep, remainingDistancePx)
  );
}

function advanceScrollableContainersInPage(options: {
  includeSelectors: string[];
  maxDistancePx: number;
  excludeSelectors: string[];
}): AutoScrollAdvance {
  const registry = getAutoScrollRegistryInPage();
  const containers = discoverScrollableContainersInPage(options.includeSelectors, options.excludeSelectors);
  let advancedContainers = 0;
  let distancePx = 0;
  let budgetAvailable = false;

  for (const container of containers) {
    let state = registry.states.get(container);
    if (!state) {
      state = { distancePx: 0 };
      registry.states.set(container, state);
    }
    const remainingDistancePx = options.maxDistancePx - state.distancePx;
    if (remainingDistancePx <= 0) {
      continue;
    }
    budgetAvailable = true;

    const before = container.scrollTop;
    const maximumPosition = Math.max(0, container.scrollHeight - container.clientHeight);
    if (before >= maximumPosition - 1) {
      continue;
    }
    const stepPx = calculateScrollStep(container.clientHeight, remainingDistancePx);
    // CSS smooth scrolling must not hide movement from distance accounting.
    container.scrollTo({ top: Math.min(maximumPosition, before + stepPx), behavior: "instant" });
    const moved = Math.max(0, container.scrollTop - before);
    if (moved <= 0) {
      continue;
    }
    state.distancePx += moved;
    distancePx += moved;
    advancedContainers += 1;
  }

  return {
    discoveredContainers: containers.length,
    advancedContainers,
    distancePx,
    budgetAvailable
  };
}

function getAutoScrollRegistryInPage(): AutoScrollRegistry {
  const holder = globalThis as typeof globalThis & {
    __browserExtractorAutoScrollV4?: AutoScrollRegistry;
  };
  if (!holder.__browserExtractorAutoScrollV4) {
    holder.__browserExtractorAutoScrollV4 = {
      states: new WeakMap<Element, ScrollContainerState>()
    };
  }
  return holder.__browserExtractorAutoScrollV4;
}

function discoverScrollableContainersInPage(includeSelectors: string[], excludeSelectors: string[]): Element[] {
  const scopes = new Set(outermostNodes(includeSelectors.flatMap((selector) =>
    [...document.querySelectorAll(selector)]
  )));

  const containers: Element[] = [];
  const documentScroller = document.scrollingElement;
  if (
    documentScroller &&
    documentScroller.clientHeight > 0 &&
    !isExcludedContainerInPage(documentScroller, excludeSelectors, scopes)
  ) {
    containers.push(documentScroller);
  }

  for (const element of document.querySelectorAll("*")) {
    if (
      element === documentScroller ||
      !isRelatedToScopesInPage(element, scopes) ||
      isExcludedContainerInPage(element, excludeSelectors, scopes) ||
      !isScrollableElementInPage(element)
    ) {
      continue;
    }
    containers.push(element);
  }
  return containers;
}

function isExcludedContainerInPage(element: Element, selectors: string[], scopes: Set<Element>): boolean {
  return selectors.some((selector) => {
    const excluded = element.closest(selector);
    return excluded !== null &&
      ![...scopes].some((scope) => excluded !== scope && excluded.contains(scope));
  });
}

function isRelatedToScopesInPage(
  element: Element,
  scopes: Set<Element>
): boolean {
  for (const scope of scopes) {
    if (scope === element || scope.contains(element) || element.contains(scope)) {
      return true;
    }
  }
  return false;
}

function isScrollableElementInPage(element: Element): boolean {
  if (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return false;
  }
  const style = getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    !["auto", "scroll", "overlay"].includes(style.overflowY)
  ) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return (
    element.clientWidth > 0 && element.clientHeight > 0 &&
    rect.width > 0 && rect.height > 0 &&
    rect.bottom > 0 && rect.right > 0 &&
    rect.top < window.innerHeight && rect.left < window.innerWidth &&
    element.scrollHeight > element.clientHeight + 1
  );
}

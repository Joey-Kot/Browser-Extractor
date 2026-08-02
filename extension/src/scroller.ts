import { CdpSession } from "./cdp";

export interface AutoScrollAdvance {
  discoveredContainers: number;
  advancedContainers: number;
  distancePx: number;
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
  maxDistancePx: number
): Promise<AutoScrollAdvance> {
  const helpers = [
    calculateScrollStep,
    getAutoScrollRegistryInPage,
    discoverScrollableContainersInPage,
    isScrollableElementInPage,
    isRelatedToScopesInPage
  ]
    .map((helper) => helper.toString())
    .join(";\n");
  const options = JSON.stringify({ includeSelectors, maxDistancePx });
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
}): AutoScrollAdvance {
  const registry = getAutoScrollRegistryInPage();
  const containers = discoverScrollableContainersInPage(options.includeSelectors);
  let advancedContainers = 0;
  let distancePx = 0;

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

    const before = container.scrollTop;
    const maximumPosition = Math.max(0, container.scrollHeight - container.clientHeight);
    if (before >= maximumPosition - 1) {
      continue;
    }
    const stepPx = calculateScrollStep(container.clientHeight, remainingDistancePx);
    container.scrollTop = Math.min(maximumPosition, before + stepPx);
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
    distancePx
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

function discoverScrollableContainersInPage(includeSelectors: string[]): Element[] {
  const scopes = new Set<Element>();
  for (const selector of includeSelectors) {
    for (const scope of document.querySelectorAll(selector)) {
      scopes.add(scope);
    }
  }

  const containers: Element[] = [];
  const documentScroller = document.scrollingElement;
  if (
    documentScroller &&
    documentScroller.scrollHeight > documentScroller.clientHeight + 1
  ) {
    containers.push(documentScroller);
  }

  for (const element of document.querySelectorAll("*")) {
    if (
      element === documentScroller ||
      !isRelatedToScopesInPage(element, scopes) ||
      !isScrollableElementInPage(element)
    ) {
      continue;
    }
    containers.push(element);
  }
  return containers;
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
  const minimumSizePx = 80;
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
    rect.width >= minimumSizePx &&
    rect.height >= minimumSizePx &&
    element.scrollHeight > element.clientHeight + 1
  );
}

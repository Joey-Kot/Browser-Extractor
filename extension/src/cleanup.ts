import { CdpSession } from "./cdp";
import { removeJobState } from "./storage";

export interface CleanupState {
  requestId: string;
  cdp: CdpSession | null;
  ownedTabIds: Set<number>;
  abortController: AbortController;
}

export async function cleanupJob(state: CleanupState): Promise<void> {
  state.abortController.abort();
  await state.cdp?.detach();
  const tabs = [...state.ownedTabIds];
  await Promise.allSettled(tabs.map((tabId) => chrome.tabs.remove(tabId)));
  state.ownedTabIds.clear();
  await removeJobState(state.requestId);
}


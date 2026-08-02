const SETTINGS_KEY = "bridgeSettings";
const INSTANCE_KEY = "browserInstanceId";

export interface BridgeSettings {
  bridgeUrl: string;
  extensionToken: string;
}

export const DEFAULT_SETTINGS: BridgeSettings = {
  bridgeUrl: "ws://127.0.0.1:17321/bridge",
  extensionToken: ""
};

export async function getBridgeSettings(): Promise<BridgeSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return {
    ...DEFAULT_SETTINGS,
    ...(stored[SETTINGS_KEY] as Partial<BridgeSettings> | undefined)
  };
}

export async function setBridgeSettings(settings: BridgeSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function getBrowserInstanceId(): Promise<string> {
  const stored = await chrome.storage.local.get(INSTANCE_KEY);
  const existing = stored[INSTANCE_KEY];
  if (typeof existing === "string" && existing.length > 0) {
    return existing;
  }
  const created = "chrome-profile-" + crypto.randomUUID();
  await chrome.storage.local.set({ [INSTANCE_KEY]: created });
  return created;
}

export interface PersistedJobState {
  requestId: string;
  mainTabId: number;
  ownedTabIds: number[];
  status: string;
  createdAt: number;
}

const sessionKey = (requestId: string): string => "job:" + requestId;

export async function persistJobState(state: PersistedJobState): Promise<void> {
  await chrome.storage.session.set({ [sessionKey(state.requestId)]: state });
}

export async function removeJobState(requestId: string): Promise<void> {
  await chrome.storage.session.remove(sessionKey(requestId));
}

export async function listPersistedJobs(): Promise<PersistedJobState[]> {
  const stored = await chrome.storage.session.get(null);
  return Object.entries(stored)
    .filter(([key]) => key.startsWith("job:"))
    .map(([, value]) => value as PersistedJobState);
}


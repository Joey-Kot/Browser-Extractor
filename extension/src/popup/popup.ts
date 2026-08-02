import {
  getBridgeSettings,
  getBrowserInstanceId,
  setBridgeSettings
} from "../storage";

const form = document.querySelector<HTMLFormElement>("#settings-form");
const bridgeUrl = document.querySelector<HTMLInputElement>("#bridge-url");
const extensionToken = document.querySelector<HTMLInputElement>("#extension-token");
const connectionState = document.querySelector<HTMLElement>("#connection-state");
const instanceId = document.querySelector<HTMLElement>("#instance-id");
const extensionVersion = document.querySelector<HTMLElement>("#extension-version");
const message = document.querySelector<HTMLElement>("#message");

if (
  !form ||
  !bridgeUrl ||
  !extensionToken ||
  !connectionState ||
  !instanceId ||
  !extensionVersion ||
  !message
) {
  throw new Error("Popup DOM is incomplete");
}

void Promise.all([
  getBridgeSettings(),
  getBrowserInstanceId(),
  chrome.storage.local.get("bridgeConnectionState")
]).then(([settings, browserInstanceId, stored]) => {
  bridgeUrl.value = settings.bridgeUrl;
  extensionToken.value = settings.extensionToken;
  instanceId.textContent = browserInstanceId;
  extensionVersion.textContent = chrome.runtime.getManifest().version;
  const state = stored.bridgeConnectionState;
  connectionState.textContent =
    state === "connected"
      ? "已连接"
      : state === "connecting"
        ? "正在连接"
        : "未连接";
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void setBridgeSettings({
    bridgeUrl: bridgeUrl.value.trim(),
    extensionToken: extensionToken.value
  }).then(() => {
    message.textContent = "设置已保存，扩展正在重载。";
    setTimeout(() => chrome.runtime.reload(), 250);
  });
});


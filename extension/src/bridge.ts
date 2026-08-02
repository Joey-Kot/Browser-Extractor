import type { BridgeMessage, WelcomePayload } from "./generated/protocol";
import { parseBridgeMessage, PROTOCOL_VERSION } from "./protocol";
import { getBridgeSettings, getBrowserInstanceId } from "./storage";

export type BridgeState = "disconnected" | "connecting" | "connected";
export type BridgeMessageHandler = (message: BridgeMessage) => void | Promise<void>;

export class BridgeClient {
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private messageHandler: BridgeMessageHandler | null = null;
  private stateHandler: ((state: BridgeState) => void) | null = null;
  private state: BridgeState = "disconnected";

  limits: WelcomePayload = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "",
    maxUnackedChunks: 8,
    chunkBytes: 262144,
    pingIntervalSeconds: 20
  };

  onMessage(handler: BridgeMessageHandler): void {
    this.messageHandler = handler;
  }

  onState(handler: (state: BridgeState) => void): void {
    this.stateHandler = handler;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
    this.setState("disconnected");
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(message: BridgeMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Bridge is not connected");
    }
    this.socket.send(JSON.stringify(message));
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.state === "connecting" || this.isConnected()) {
      return;
    }
    this.setState("connecting");
    try {
      const [settings, browserInstanceId] = await Promise.all([
        getBridgeSettings(),
        getBrowserInstanceId()
      ]);
      const url = new URL(settings.bridgeUrl);
      const socket = new WebSocket(url.toString());
      this.socket = socket;

      socket.addEventListener("open", () => {
        this.reconnectAttempt = 0;
        this.send({
          version: PROTOCOL_VERSION,
          type: "hello",
          payload: {
            extensionToken: settings.extensionToken,
            browserInstanceId,
            browserName: "Chrome",
            extensionVersion: chrome.runtime.getManifest().version,
            protocolVersion: PROTOCOL_VERSION
          }
        });
        this.setState("connected");
      });

      socket.addEventListener("message", (event) => {
        void this.handleIncoming(String(event.data));
      });

      socket.addEventListener("close", () => {
        if (this.socket === socket) {
          this.socket = null;
        }
        this.setState("disconnected");
        this.scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        socket.close();
      });
    } catch {
      this.setState("disconnected");
      this.scheduleReconnect();
    }
  }

  private async handleIncoming(data: string): Promise<void> {
    const message = parseBridgeMessage(data);
    if (message.type === "welcome") {
      this.limits = message.payload;
    }
    if (message.type === "ping") {
      this.send({
        version: PROTOCOL_VERSION,
        type: "pong",
        payload: { nonce: message.payload.nonce ?? null }
      });
      return;
    }
    await this.messageHandler?.(message);
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    const delay = Math.min(30000, 500 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    setTimeout(() => void this.connect(), delay);
  }

  private setState(state: BridgeState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.stateHandler?.(state);
    void chrome.storage.local.set({ bridgeConnectionState: state });
  }
}

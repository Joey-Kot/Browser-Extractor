import { BridgeClient } from "./bridge";
import { JobManager } from "./jobs";

const bridge = new BridgeClient();
const jobs = new JobManager(bridge);

bridge.onMessage((message) => jobs.handleMessage(message));
bridge.onState((state) => {
  if (state === "disconnected") {
    void jobs.handleDisconnect();
  }
});

void jobs.initialize().then(() => bridge.start());

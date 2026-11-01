import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserType } from "playwright";
import type { CdpSession } from "../src/cdp";
import type { JobManager } from "../src/jobs";
import type { BridgeClient } from "../src/bridge";
import type { BridgeMessage, ExtractionRequest } from "../src/generated/protocol";
import thread from "../../fixtures/test-site/background-thread.html";

export async function runBackgroundBrowserTests(chromium: BrowserType, driver: string): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "browser-extractor-background-"));
  const extension = join(workspace, "extension");
  await mkdir(extension);
  await writeFile(join(extension, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "Browser Extractor background regression", version: "0.1.0",
    permissions: ["debugger", "tabs", "storage"], background: { service_worker: "worker.js" }
  }));
  await writeFile(join(extension, "worker.js"), driver);
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/thread" ? "text/html" : "text/plain");
    response.end(request.url === "/thread" ? thread : "OK");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  // Launch ordinary Chromium without Playwright's automatic focus emulation or
  // flags disabling background throttling. Headless Shell always reports visible.
  const child = spawn(chromium.executablePath(), [
    "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    "--disable-dev-shm-usage", "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1", "--user-data-dir=" + join(workspace, "profile"),
    "--disable-extensions-except=" + extension, "--load-extension=" + extension,
    "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const exited = once(child, "exit");
  let browser: Browser | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const endpoint = await Promise.race([
      new Promise<string>((resolve, reject) => {
        startupTimer = setTimeout(() => reject(new Error("Background Chromium startup timed out")), 15_000);
        child.stderr.on("data", (chunk) => {
          const endpoint = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
          if (endpoint) resolve(endpoint);
        });
        child.once("error", reject);
      }),
      exited.then(() => { throw new Error("Background Chromium exited during startup"); })
    ]);
    clearTimeout(startupTimer);
    // noDefaults is essential: the default CDP connection would itself fix the
    // hidden-tab behavior before the extension gets a chance to run.
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const context = browser.contexts()[0]!;
    await context.pages()[0]!.goto(origin + "/user");
    const isTestWorker = (worker: { url(): string }) => worker.url().endsWith("/worker.js");
    const worker = context.serviceWorkers().find(isTestWorker) ??
      await context.waitForEvent("serviceworker", isTestWorker);
    const apis = await worker.evaluate(() => ({
      url: location.href, permissions: chrome.runtime.getManifest().permissions,
      debuggerAvailable: typeof chrome.debugger !== "undefined"
    }));
    assert.equal(apis.debuggerAvailable, true, JSON.stringify(apis));
    const visibility = await worker.evaluate(async () => {
      const { CdpSession: Session } = (globalThis as unknown as {
        BrowserExtractorTests: { CdpSession: typeof CdpSession }
      }).BrowserExtractorTests;
      const tab = await chrome.tabs.create({ url: "about:blank", active: false });
      const target = { tabId: tab.id! };
      const readHidden = async () => {
        const result = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
          expression: "document.hidden", returnByValue: true
        }) as { result: { value: boolean } };
        return result.result.value;
      };
      try {
        await chrome.debugger.attach(target, "1.3");
        const before = await readHidden();
        await chrome.debugger.detach(target);
        const cdp = new Session(tab.id!);
        await cdp.attach();
        const during = await readHidden();
        await cdp.detach();
        await chrome.debugger.attach(target, "1.3");
        return { before, during, after: await readHidden() };
      } finally {
        await chrome.debugger.detach(target).catch(() => undefined);
        await chrome.tabs.remove(tab.id!);
      }
    });
    assert.equal(visibility.before, true, "the unactivated control tab must really be hidden");
    assert.equal(visibility.during, false, "production attach makes the page visible without activation");
    assert.equal(visibility.after, true, "detaching restores the original visibility");

    for (const mode of ["document", "feed"] as const) {
      for (const traversal of [false, true]) {
        const request: ExtractionRequest = {
          url: origin + "/thread", mode, waitMs: 0, jobTimeoutMs: 10_000,
          loadTimeoutMs: 1_500, settleMs: 50, visibilityMode: "background",
          includeSelectors: ["main"], excludeSelectors: [],
          traversal: {
            shadowDom: { enabled: traversal, maxDepth: 1 },
            iframes: { enabled: false, maxDepth: 1 }
          },
          scroll: { enabled: true, maxDistancePx: 3_000, settleMs: 100, dedupe: { strategy: "auto" } },
          output: { includeHtml: true }
        };
        const result = await worker.evaluate(async (request) => {
          const { JobManager: Jobs } = (globalThis as unknown as {
            BrowserExtractorTests: { JobManager: typeof JobManager; CdpSession: typeof CdpSession }
          }).BrowserExtractorTests;
          const activeBefore = (await chrome.tabs.query({ active: true }))[0]!.id;
          const activations: number[] = [];
          const onActivated = (event: { tabId: number }) => activations.push(event.tabId);
          chrome.tabs.onActivated.addListener(onActivated);
          const messages: BridgeMessage[] = [];
          let done!: () => void;
          const closed = new Promise<void>((resolve) => { done = resolve; });
          let timeout: ReturnType<typeof setTimeout>;
          const deadline = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("Background job timed out")), request.jobTimeoutMs + 2_000);
          });
          const bridge = {
            limits: { chunkBytes: 262_144, maxUnackedChunks: 8 },
            isConnected: () => true,
            send: (message: BridgeMessage) => {
              messages.push(message);
              const type = message.type === "capture_chunk" ? "chunk_ack"
                : message.type === "capture_end" ? "capture_ack"
                : message.type === "error" ? "error_ack" : null;
              if (type) queueMicrotask(() => void jobs.handleMessage({
                version: 4, type, requestId: message.requestId,
                payload: message.type === "capture_chunk" ? { upToSequence: message.payload.sequence } : {}
              } as BridgeMessage));
              if (message.type === "closed") done();
            }
          } as unknown as BridgeClient;
          const jobs = new Jobs(bridge);
          try {
            await jobs.initialize();
            await jobs.handleMessage({ version: 4, type: "extract", requestId: "background-test", payload: request });
            await Promise.race([closed, deadline]);
            return {
              messages, activations, activeBefore,
              activeAfter: (await chrome.tabs.query({ active: true }))[0]!.id,
              remainingTabs: (await chrome.tabs.query({})).length,
              persistedJobs: Object.keys(await chrome.storage.session.get(null)).filter((key) => key.startsWith("job:"))
            };
          } finally {
            clearTimeout(timeout!);
            chrome.tabs.onActivated.removeListener(onActivated);
          }
        }, request);
        const failure = result.messages.find((message) => message.type === "error");
        assert.equal(failure, undefined, JSON.stringify(failure));
        const html = result.messages.filter((message) => message.type === "capture_chunk")
          .map((message) => message.payload.html).join("");
        assert.ok(html.includes("Main post"), mode + " retains the main post");
        assert.ok(html.includes("reply-one") && html.includes("reply-two"),
          mode + " loads and retains replies without activating its tab");
        assert.ok(html.includes('data-started-hidden="false"'), "the page is visible from its first script");
        assert.ok(html.includes('data-started-focused="true"'), "the page has emulated focus from its first script");
        assert.equal(result.activeAfter, result.activeBefore, "the user's active tab is preserved");
        assert.deepEqual(result.activations, [], "capture never activates its tab");
        assert.equal(result.remainingTabs, 1, "job tabs are closed");
        assert.deepEqual(result.persistedJobs, [], "job storage is cleaned");
      }
    }
    console.log("Background tabs: document/feed load replies with real chrome.debugger, without activation or test focus overrides");
  } finally {
    clearTimeout(startupTimer);
    await browser?.close();
    child.kill();
    await exited;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

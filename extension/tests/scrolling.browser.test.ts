import assert from "node:assert/strict";
import type { Browser, CDPSession } from "playwright";
import { CdpSession } from "../src/cdp";
import { executeCapture, type CaptureRuntime } from "../src/extractor";
import type { ExtractionRequest } from "../src/generated/protocol";
import { advanceScrollableContainers } from "../src/scroller";
import { collectFeedCandidates } from "../src/selectors";
import virtualThread from "../../fixtures/test-site/virtual-thread.html";

export async function runScrollingBrowserTests(browser: Browser): Promise<void> {
  async function fixture(html: string, query = "", delayMs = 0) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 } });
    await context.route("http://content.test/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/batch") {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        await route.fulfill({ contentType: "application/json", body: "{}" });
      } else {
        await route.fulfill({ contentType: "text/html", body: html });
      }
    });
    const page = await context.newPage();
    const transport = await context.newCDPSession(page);
    const pending = new Set<string>();
    await transport.send("Network.enable");
    transport.on("Network.requestWillBeSent", (event) => {
      if (["Fetch", "XHR"].includes(event.type ?? "")) pending.add(event.requestId);
    });
    transport.on("Network.loadingFinished", (event) => pending.delete(event.requestId));
    transport.on("Network.loadingFailed", (event) => pending.delete(event.requestId));
    const cdp = new CdpSession(1);
    cdp.send = (async (method: string, params?: object, sessionId?: string) => {
      assert.equal(sessionId, undefined);
      return transport.send(method as Parameters<CDPSession["send"]>[0], params);
    }) as CdpSession["send"];
    cdp.hasPendingPageRequests = () => pending.size > 0;
    await page.goto("http://content.test/thread" + query, { waitUntil: "load" });
    async function capture(mode: "document" | "feed", overrides: Partial<ExtractionRequest> = {}) {
      const items: string[] = [];
      let document = "";
      const request: ExtractionRequest = {
        url: page.url(), mode, waitMs: 0, jobTimeoutMs: 20_000,
        loadTimeoutMs: 5_000, settleMs: 30, visibilityMode: "background",
        includeSelectors: ["main"], excludeSelectors: ["aside"],
        traversal: { shadowDom: { enabled: true, maxDepth: 1 }, iframes: { enabled: false, maxDepth: 1 } },
        scroll: { enabled: true, maxDistancePx: 5_000, settleMs: 100, dedupe: { strategy: "auto" } },
        output: { includeHtml: true }, ...overrides
      };
      const messages: Array<{ type: string; payload: unknown }> = [];
      await executeCapture({
        requestId: "scroll-test", request, cdp,
        bridge: { send: (message) => messages.push(message) } as CaptureRuntime["bridge"],
        sender: {
          sendItem: async (_key: string, html: string) => { items.push(html); },
          sendDocument: async (html: string) => { document = html; },
          finish: async () => ({})
        } as unknown as CaptureRuntime["sender"],
        signal: new AbortController().signal,
        deadlineAt: Date.now() + request.jobTimeoutMs,
        mimeType: "text/html", mimeTypeUnknown: false, progress: async () => {}
      });
      return { html: mode === "document" ? document : items.join("\n"), messages };
    }
    return { context, page, cdp, capture };
  }

  // Removed nodes, reused slots, anonymous content and both capture modes.
  await Promise.all(["document", "feed"].flatMap((mode) =>
    ["", "?reuse", "?reuse&anonymous", "?reuse&anonymous&generic"].map(async (query) => {
      const test = await fixture(virtualThread, query);
      try {
        const result = await test.capture(mode as "document" | "feed");
        const expected = Array.from({ length: 12 }, (_, index) => String(index));
        const records = await test.page.evaluate((html) => {
          const template = document.createElement("template");
          template.innerHTML = html;
          return [...template.content.querySelectorAll("[data-record]")]
            .map((node) => node.getAttribute("data-record"));
        }, result.html);
        assert.deepEqual(records, expected, mode + " " + query + " retains ordered main post and all replies once");
        assert.equal(await test.page.locator("[data-record='0']").count(), 0, "main post really left the live DOM");
        assert.equal(await test.page.locator("#ignored").evaluate((node) => node.scrollTop), 0);
        assert.ok(!result.html.includes("不应收集或滚动的侧栏"));
        if (mode === "document") assert.ok(result.html.includes("data-extractor-scroll-history"));
      } finally {
        await test.context.close();
      }
    })
  ));
  console.log("Virtualized content: document/feed preserve main post and replies across removal and DOM reuse");

  const snapshot = await fixture(virtualThread);
  try {
    const result = await snapshot.capture("document", {
      scroll: { enabled: false, maxDistancePx: 5000, settleMs: 100, dedupe: { strategy: "auto" } }
    });
    assert.ok(result.html.startsWith("<main"));
    assert.ok(!result.html.includes("data-extractor-scroll-history"));
    assert.equal(await snapshot.page.locator("#viewport").evaluate((node) => node.scrollTop), 0);
  } finally { await snapshot.context.close(); }

  const links = await fixture(`<main>
    <article><a href='/writer'>Writer</a><p>First independent entry</p></article>
    <article><a href='/writer'>Writer</a><p>Second independent entry</p></article>
  </main>`);
  try {
    const candidates = await collectFeedCandidates(links.cdp, ["main"], [], null, null);
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every((candidate) => candidate.autoKey === null));
    const result = await links.capture("feed", { traversal: undefined });
    assert.ok(result.html.includes("First independent entry") && result.html.includes("Second independent entry"));
    const explicit = await collectFeedCandidates(links.cdp, ["main"], [], null, "a[href]");
    assert.equal(explicit[0]!.autoKey, "http://content.test/writer", "explicit link rules remain authoritative");
  } finally { await links.context.close(); }

  await Promise.all([false, true].flatMap((traversal) => [false, true].map(async (identified) => {
    const test = await fixture(`<main>
      <article ${identified ? "data-id='one'" : ""}><h3><a href='/writer'>Writer</a></h3><p>First independent post</p></article>
      <article ${identified ? "data-id='two'" : ""}><h3><a href='/writer'>Writer</a></h3><p>Second independent post</p></article>
    </main>`);
    try {
      const result = await test.capture("feed", {
        traversal: traversal ? {
          shadowDom: { enabled: true, maxDepth: 1 }, iframes: { enabled: false, maxDepth: 1 }
        } : undefined,
        loadTimeoutMs: 500
      });
      assert.equal((result.html.match(/First independent post/g) ?? []).length, 1);
      assert.equal((result.html.match(/Second independent post/g) ?? []).length, 1,
        "a shared author heading must never collapse independent posts");
    } finally { await test.context.close(); }
  })));

  await Promise.all([false, true].map(async (traversal) => {
    const test = await fixture(`<main>Important direct-text introduction &amp; context.
      <span><strong>Formatted context</strong></span>
      <div id='viewport' style='height:200px;overflow:auto'><div style='height:1500px'>
        <article data-post-id='old'><p>Old virtualized item</p></article>
      </div></div>Important direct-text conclusion.
      <context-card></context-card><iframe srcdoc="<p>Frame context</p>"></iframe>
      <aside>Excluded direct text <em>Excluded formatted text</em></aside>
    </main><script>
      document.querySelector('context-card').attachShadow({mode:'closed'}).innerHTML='<p>Shadow context</p>';
      let changed=false; document.querySelector('#viewport').addEventListener('scroll',()=>{
        if(changed)return; changed=true; document.querySelector('article').remove();
        const article=document.createElement('article'); article.dataset.postId='new';
        article.textContent='New virtualized item'; document.querySelector('#viewport > div').append(article);
      });</script>`);
    try {
      const result = await test.capture("document", {
        traversal: traversal ? {
          shadowDom: { enabled: true, maxDepth: 1 }, iframes: { enabled: true, maxDepth: 1 }
        } : undefined,
        loadTimeoutMs: 500
      });
      const expected = ["Important direct-text introduction &amp; context.", "Formatted context",
        "Old virtualized item", "New virtualized item", "Important direct-text conclusion."];
      let previous = -1;
      for (const text of expected) {
        const index = result.html.indexOf(text);
        assert.ok(index > previous, "document context and retained records remain in order: " + text);
        assert.equal(result.html.split(text).length - 1, 1, "context must not be duplicated");
        previous = index;
      }
      assert.ok(result.html.includes("<strong>Formatted context</strong>"));
      assert.ok(!result.html.includes("Excluded direct text") && !result.html.includes("Excluded formatted text"));
      if (traversal) {
        assert.ok(result.html.includes("Shadow context") && result.html.includes("Frame context"),
          "context capture includes otherwise empty Shadow Root hosts and iframe owners");
      }
    } finally { await test.context.close(); }
  }));
  console.log("Review regressions: shared author headings keep distinct posts; document history preserves surrounding text and nested context");

  await Promise.all([false, true].map(async (traversal) => {
    const test = await fixture(`<main style='min-height:1200px'><div style='display:flex'>
      <article><p>Shared initial text</p></article><article><p>Shared initial text</p></article>
    </div></main><script>let updated=false; addEventListener('scroll',()=>{
      if(updated)return;updated=true;
      document.querySelectorAll('article')[1].innerHTML='<p>Updated independent text</p>';
    });</script>`);
    try {
      const result = await test.capture("document", {
        traversal: traversal ? {
          shadowDom: { enabled: true, maxDepth: 1 }, iframes: { enabled: false, maxDepth: 1 }
        } : undefined,
        loadTimeoutMs: 500
      });
      assert.ok(result.html.startsWith("<main"), "updating one identical sibling is not DOM eviction");
      assert.ok(result.html.includes("Shared initial text") && result.html.includes("Updated independent text"));
    } finally { await test.context.close(); }
  }));

  await Promise.all(["document", "feed"].map(async (mode) => {
    const test = await fixture(`<!doctype html><main style='min-height:1300px'>
      <article data-post-id='main'><p>Main post</p></article></main>
      <script>let pending = false; addEventListener('scroll', () => {
        if (!pending && scrollY + innerHeight >= document.documentElement.scrollHeight - 30) {
          pending = true; fetch('/batch').then(() => {
            const node = document.createElement('article'); node.dataset.postId = 'reply';
            node.innerHTML = '<p>Asynchronous reply</p>'; document.querySelector('main').append(node);
          });
        }
      });</script>`, "", 3_300);
    try {
      const result = await test.capture(mode as "document" | "feed", { traversal: undefined });
      assert.ok(result.html.includes("Main post") && result.html.includes("Asynchronous reply"));
      if (mode === "document") assert.ok(result.html.startsWith("<main"), "append-only documents retain the full selected root");
    } finally { await test.context.close(); }
  }));
  console.log("Async loading: pending fetches keep both modes collecting after reaching the bottom");

  const empty = await fixture(`<!doctype html><main style='min-height:1200px'>
    <article><p>Original post</p></article></main><script>
    let changed = false; addEventListener('scroll', () => {
      if (changed) return; changed = true;
      document.querySelector('article').remove();
      setTimeout(() => { const node = document.createElement('article');
        node.innerHTML = '<p>Reply after empty window</p>'; document.querySelector('main').append(node); }, 900);
    });</script>`);
  try {
    const result = await empty.capture("feed", { includeSelectors: ["article"], traversal: undefined });
    assert.ok(result.html.includes("Original post") && result.html.includes("Reply after empty window"));
  } finally { await empty.context.close(); }

  const small = await fixture(`<main><div id='small' style='height:40px;width:120px;overflow:auto;scroll-behavior:smooth'>
    <div style='height:300px'>Small content region</div></div>
    <aside style='height:40px;overflow:auto'><div style='height:300px'>Excluded</div></aside></main>`);
  try {
    const advance = await advanceScrollableContainers(small.cdp, ["main"], 30, ["aside"]);
    assert.equal(advance.distancePx, 30);
    assert.equal(await small.page.locator("#small").evaluate((node) => node.scrollTop), 30);
    assert.equal(await small.page.locator("aside").evaluate((node) => node.scrollTop), 0);
  } finally { await small.context.close(); }

  const innerRoot = await fixture(`<aside style='height:40px;width:120px;overflow:auto'>
    <article id='selected'><div style='height:300px'>Explicit selected content</div></article></aside>`);
  try {
    await advanceScrollableContainers(innerRoot.cdp, ["#selected"], 30, ["aside"]);
    assert.equal(await innerRoot.page.locator("aside").evaluate((node) => node.scrollTop), 30,
      "excluded ancestors outside an explicit content root must not prevent scrolling that root");
  } finally { await innerRoot.context.close(); }

  const overlapping = await fixture(`<main><article>Selected text</article>
    <aside style='height:100px;width:300px;overflow:auto'>
      <div class='extra' style='height:1000px'>Excluded inner root</div>
    </aside></main>`);
  try {
    for (const includes of [["main"], ["main", ".extra"], [".extra", "main", "main"]]) {
      await advanceScrollableContainers(overlapping.cdp, includes, 100, ["aside"]);
      assert.equal(await overlapping.page.locator("aside").evaluate((node) => node.scrollTop), 0,
        "redundant inner roots cannot re-enable excluded scrollers");
      const candidates = await collectFeedCandidates(overlapping.cdp, includes, ["aside"], null, null);
      assert.ok(candidates.every((candidate) => !candidate.html.includes("Excluded inner root")));
    }
  } finally { await overlapping.context.close(); }

  const updating = await fixture(`<main><div id='clock'>0</div><article><p>Static article</p></article></main>
    <script>setInterval(() => { document.querySelector('#clock').textContent = String(Date.now()); }, 20);</script>`);
  try {
    const result = await updating.capture("document", {
      settleMs: 100, loadTimeoutMs: 500, traversal: undefined
    });
    assert.ok(result.html.startsWith("<main"));
    assert.ok(!result.html.includes("data-extractor-scroll-history"), "live text changes are not DOM eviction");
  } finally { await updating.context.close(); }
  console.log("Scroll boundaries: transient empty windows, small/excluded containers and changing DOM are handled");
}

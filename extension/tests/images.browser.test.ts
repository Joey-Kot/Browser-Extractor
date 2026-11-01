import assert from "node:assert/strict";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import type { CdpSession } from "../src/cdp";
import { collectFeedCandidates, extractDocument } from "../src/selectors";
import { TraversalSerializer } from "../src/traversal";

const origin = "http://images.test";
const svg = "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E";

export async function runImageBrowserTests(browser: Browser): Promise<void> {
  const contexts: BrowserContext[] = [];
  const inspection = await browser.newPage();

  async function fixture(markup: string, headers: Record<string, string> = {}) {
    const context = await browser.newContext({ deviceScaleFactor: 1 });
    contexts.push(context);
    const requests: string[] = [];
    await context.route(origin + "/**", async (route) => {
      requests.push(route.request().url());
      await route.fulfill(route.request().resourceType() === "document"
        ? { contentType: "text/html", body: "<!doctype html>" + markup, headers }
        : { status: 404, body: "fixture image" });
    });
    const page = await context.newPage();
    await page.goto(origin + "/article", { waitUntil: "load" });
    const session = await context.newCDPSession(page);
    const commands: string[] = [];
    const adapter = {
      async evaluate(expression: string) {
        const response = await session.send("Runtime.evaluate", {
          expression, awaitPromise: true, returnByValue: true
        });
        if (response.exceptionDetails) {
          throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
        }
        return response.result.value;
      },
      async sendWithTimeout(method: string, params?: object, sessionId?: string) {
        assert.equal(sessionId, undefined, "these fixtures use same-process frames");
        commands.push(method);
        return session.send(method as Parameters<CDPSession["send"]>[0], params);
      },
      async enableFrameTraversal() {}
    };
    const cdp = adapter as unknown as CdpSession;

    async function captureCdp(excludeSelectors: string[] = []) {
      const serializer = new TraversalSerializer(cdp, {
        shadowDom: { enabled: true, maxDepth: 1 },
        iframes: { enabled: true, maxDepth: 1 }
      }, new AbortController().signal, Date.now() + 30_000, 30_000);
      await serializer.initialize();
      const { result } = await session.send("Runtime.evaluate", {
        expression: "document.querySelector('article')"
      });
      const { node } = await session.send("DOM.describeNode", { objectId: result.objectId, depth: 0 });
      await session.send("Runtime.releaseObject", { objectId: result.objectId! });
      const excluded = new Set<number>();
      if (excludeSelectors.length > 0) {
        const { root } = await session.send("DOM.getDocument", { depth: 0 });
        const { nodeIds } = await session.send("DOM.querySelectorAll", {
          nodeId: root.nodeId, selector: excludeSelectors.join(",")
        });
        for (const nodeId of nodeIds) {
          const { node } = await session.send("DOM.describeNode", { nodeId, depth: 0 });
          excluded.add(node.backendNodeId);
        }
      }
      const html = await serializer.serializeBackendNode(node.backendNodeId, excluded);
      assert.deepEqual(serializer.getWarnings(), []);
      return html;
    }
    return { context, page, cdp, adapter, session, commands, requests, captureCdp };
  }

  async function inspect(markup: string) {
    return inspection.evaluate((html) => {
      const template = document.createElement("template");
      template.innerHTML = html;
      return Object.fromEntries([...template.content.querySelectorAll("img")].map((image) => [
        image.id || image.parentElement!.id,
        {
          src: image.getAttribute("src"),
          srcset: image.getAttribute("srcset"),
          sizes: image.getAttribute("sizes"),
          pictureSets: image.parentElement?.localName === "picture"
            ? [...image.parentElement.querySelectorAll("source")].map((source) => source.getAttribute("srcset"))
            : []
        }
      ]));
    }, markup);
  }

  async function captures(test: Awaited<ReturnType<typeof fixture>>, excludes: string[] = []) {
    const normal = await extractDocument(test.cdp, ["article"], excludes);
    const feed = await collectFeedCandidates(test.cdp, ["article"], excludes, null, null);
    assert.ok(feed.length > 0);
    return [normal.html, feed.map((item) => item.html).join("\n"), await test.captureCdp(excludes)];
  }

  try {
    const excluded = await fixture(`<article><p>Retained article text</p>
      <img id='remove-src' src='${svg}' data-src='/remove-src.jpg'>
      <img id='remove-set' src='${svg}' srcset='${svg} 1x' data-src='/remove-set.jpg'>
      <figure><img id='remove-parent' src='${svg}' data-src='/remove-parent.jpg'></figure>
      <img id='keep' src='${svg}' data-src='/keep.jpg'>
    </article>`);
    const original = await excluded.page.locator("article").evaluate((node) => node.outerHTML);
    for (const html of await captures(excluded, [
      "#remove-src[src^='data:']", "#remove-set[srcset]", "figure:has(img[src^='data:'])"
    ])) {
      const images = await inspect(html);
      assert.deepEqual(Object.keys(images), ["keep"]);
      assert.equal(images.keep.src, origin + "/keep.jpg");
      assert.ok(html.includes("Retained article text"));
    }
    assert.equal(await excluded.page.locator("article").evaluate((node) => node.outerHTML), original);
    console.log("Image exclusions: original src/srcset and :has selectors apply before recovery in document, feed and CDP");

    const trusted = await fixture(
      `<article><p>Readable article</p>
        <img id="direct" src="${svg}" data-src="/real.jpg">
        <noscript><img src="/unused.jpg"></noscript>
        <img id="fallback-only" src="${svg}">
        <noscript><img src="/fallback.jpg"></noscript>
        <img id="responsive" src="/fallback.jpg" srcset="/one.jpg 1x, /two.jpg 2x">
      </article>`,
      { "content-security-policy": "require-trusted-types-for 'script'; trusted-types 'none'" }
    );
    for (const html of await captures(trusted)) {
      const images = await inspect(html);
      assert.equal(images.direct.src, origin + "/real.jpg");
      assert.equal(images["fallback-only"].src, svg);
      assert.equal(images.responsive.src, origin + "/one.jpg");
      assert.ok(html.includes("Readable article"));
    }
    console.log("Trusted Types: document, feed and CDP survive optional fallback parsing");

    const reordered = await fixture(
      `<article>
        <picture id="a"><source srcset="/a.jpg"><img src="${svg}"></picture>
        <picture id="b"><source srcset="/b.jpg"><img src="${svg}"></picture>
      </article>`
    );
    const originalSend = reordered.adapter.sendWithTimeout;
    let swapped = false;
    reordered.adapter.sendWithTimeout = async (method, params, sessionId) => {
      if (method === "DOM.resolveNode" && !swapped) {
        swapped = true;
        await reordered.page.evaluate(() => {
          document.querySelector("article")!.prepend(document.querySelector("#b")!);
        });
      }
      return originalSend(method, params, sessionId);
    };
    const reorderedImages = await inspect(await reordered.captureCdp());
    assert.ok(swapped);
    assert.equal(reorderedImages.a.src, origin + "/a.jpg");
    assert.equal(reorderedImages.b.src, origin + "/b.jpg");
    assert.ok(reordered.commands.includes("Runtime.releaseObjectGroup"));
    console.log("CDP: identical image attributes remain associated with captured node identities");

    const formats = await fixture(
      `<article>
        <picture><source type="image/x-unsupported-format" srcset="/unsupported.img">
          <img id="unsupported" src="${svg}" data-src="/real.jpg"></picture>
        <picture><source media="(min-width: 99999px)" data-srcset="/wrong-media.jpg">
          <img id="media" src="${svg}" data-src="/media.jpg"></picture>
        <picture><img id="after" src="${svg}" data-src="/after.jpg">
          <source data-srcset="/after-image.jpg"></picture>
        <picture><source type="image/webp" data-srcset="/supported.webp">
          <img id="supported" src="${svg}"></picture>
      </article>`
    );
    for (const html of await captures(formats)) {
      const images = await inspect(html);
      assert.equal(images.unsupported.src, origin + "/real.jpg");
      assert.equal(images.media.src, origin + "/media.jpg");
      assert.equal(images.after.src, origin + "/after.jpg");
      assert.equal(images.supported.src, origin + "/supported.webp");
    }
    console.log("Picture candidates: unsupported types, unmatched media and later sources are ignored");

    const responsive = await fixture(
      `<article>
        <img id="native" src="${svg}" srcset="${svg} 1x" sizes="100vw" data-src="/real.jpg">
        <picture><source srcset="${svg} 1x" sizes="100vw">
          <img id="picture" src="${svg}" data-src="/picture.jpg"></picture>
        <img id="unresolved" src="${svg}" srcset="${svg} 1x">
        <img id="artwork" src="/artwork.svg">
        <img id="noscript" src="${svg}"><noscript><img src="/noscript.jpg"></noscript>
        <image-card></image-card>
        <iframe srcdoc="<base href='/frame/'><img id='frame' src='${svg}' data-src='real.jpg'>"></iframe>
      </article>
      <script>document.querySelector('image-card').attachShadow({mode:'closed'}).innerHTML =
        '<img id="shadow" src="${svg}" data-src="/shadow.jpg">';</script>`
    );
    const originalDom = await responsive.page.locator("article").evaluate((node) => node.outerHTML);
    const originalRequests = [...responsive.requests];
    const results = await captures(responsive);
    for (const html of results) {
      const images = await inspect(html);
      for (const [id, filename] of [["native", "/real.jpg"], ["picture", "/picture.jpg"]]) {
        assert.equal(images[id].src, origin + filename);
        assert.equal(images[id].srcset, null);
        assert.equal(images[id].sizes, null);
        assert.ok(images[id].pictureSets.every((srcset) => srcset === null));
      }
      assert.equal(images.unresolved.src, svg);
      assert.equal(images.unresolved.srcset, svg + " 1x");
      assert.equal(images.artwork.src, origin + "/artwork.svg");
      assert.equal(images.noscript.src, origin + "/noscript.jpg");
    }
    const nested = await inspect(results[2]!);
    assert.equal(nested.shadow.src, origin + "/shadow.jpg");
    assert.equal(nested.frame.src, origin + "/frame/real.jpg");
    await responsive.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(responsive.requests, originalRequests, "source recovery issues no requests");
    assert.equal(await responsive.page.locator("article").evaluate((node) => node.outerHTML), originalDom);

    for (const html of [results[0]!, results[2]!]) {
      const rendered: Page = await responsive.context.newPage();
      await rendered.route(origin + "/export", (route) => route.fulfill({ contentType: "text/html", body: html }));
      await rendered.goto(origin + "/export", { waitUntil: "load" });
      assert.equal(await rendered.locator("#native").evaluate((image: HTMLImageElement) => image.currentSrc), origin + "/real.jpg");
      assert.equal(await rendered.locator("#picture").evaluate((image: HTMLImageElement) => image.currentSrc), origin + "/picture.jpg");
      await rendered.close();
    }
    console.log("Exports: recovered images render, unresolved SVGs survive, nested roots work, live DOM and requests are unchanged");
  } finally {
    await inspection.close();
    await Promise.all(contexts.map((context) => context.close()));
  }
}

import { build } from "esbuild";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
async function loadSuite(file) {
  const result = await build({
    entryPoints: [new URL("./" + file, import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    loader: { ".html": "text" },
    write: false
  });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
}
try {
  for (const [file, entry] of [
    ["images.browser.test.ts", "runImageBrowserTests"],
    ["scrolling.browser.test.ts", "runScrollingBrowserTests"]
  ]) {
    const suite = await loadSuite(file);
    await suite[entry](browser);
  }
  const driver = await build({
    stdin: {
      contents: 'export { JobManager } from "./src/jobs"; export { CdpSession } from "./src/cdp";',
      resolveDir: new URL("..", import.meta.url).pathname
    },
    bundle: true,
    format: "iife",
    globalName: "BrowserExtractorTests",
    target: "chrome125",
    write: false
  });
  const suite = await loadSuite("background.browser.test.ts");
  await suite.runBackgroundBrowserTests(chromium, driver.outputFiles[0].text);
} catch (error) {
  // Keep data-URL bundle contents out of assertion stack traces.
  console.error(String(error.stack ?? error).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, "browser-tests"));
  process.exitCode = 1;
} finally {
  await browser.close();
}

import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "icons"), { recursive: true });

await build({
  entryPoints: {
    "service-worker": resolve(root, "src/service-worker.ts"),
    popup: resolve(root, "src/popup/popup.ts")
  },
  outdir: dist,
  bundle: true,
  format: "iife",
  target: "chrome125",
  sourcemap: true,
  minify: false
});

await Promise.all([
  cp(resolve(root, "manifest.json"), resolve(dist, "manifest.json")),
  cp(resolve(root, "src/popup/popup.html"), resolve(dist, "popup.html")),
  cp(resolve(root, "src/popup/popup.css"), resolve(dist, "popup.css")),
  cp(resolve(root, "assets/icon-16.png"), resolve(dist, "icons/icon-16.png")),
  cp(resolve(root, "assets/icon-48.png"), resolve(dist, "icons/icon-48.png")),
  cp(resolve(root, "assets/icon-128.png"), resolve(dist, "icons/icon-128.png"))
]);

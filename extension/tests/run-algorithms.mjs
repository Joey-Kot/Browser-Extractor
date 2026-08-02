import { build } from "esbuild";

const result = await build({
  entryPoints: [new URL("./algorithms.test.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false
});

const source = result.outputFiles[0].text;
const url = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
await import(url);


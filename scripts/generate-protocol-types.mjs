#!/usr/bin/env node

import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromExtension = createRequire(resolve(root, "extension/package.json"));
const { compile } = requireFromExtension("json-schema-to-typescript");

const source = resolve(root, "spec/bridge.schema.json");
const destination = resolve(root, "extension/src/generated/protocol.ts");
const normalized = normalizeForGenerator(JSON.parse(await readFile(source, "utf8")));
const schema = {
  $schema: normalized.$schema,
  title: "BridgeMessage",
  description: normalized.description,
  ...normalized.definitions.BridgeMessage,
  definitions: normalized.definitions
};
const generated = await compile(schema, "BridgeMessage", {
  bannerComment:
    "/* eslint-disable */\n/** Generated from spec/bridge.schema.json. Do not edit directly. */",
  cwd: root,
  declareExternallyReferenced: true,
  enableConstEnums: false,
  style: {
    singleQuote: false
  }
});
await writeFile(destination, generated, "utf8");

function normalizeForGenerator(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeForGenerator);
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string"
      ? value.replaceAll("#/$defs/", "#/definitions/")
      : value;
  }
  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$id") {
      continue;
    }
    normalized[key === "$defs" ? "definitions" : key] = normalizeForGenerator(child);
  }
  if (typeof normalized.$schema === "string") {
    normalized.$schema = "http://json-schema.org/draft-07/schema#";
  }
  return normalized;
}

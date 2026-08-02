import { splitUtf8 } from "../src/chunks";
import type { TraversalOptions } from "../src/generated/protocol";
import { calculateScrollStep } from "../src/scroller";
import { IncrementalSha256 } from "../src/sha256";
import {
  assertIncludeSelectorsMatch,
  effectiveIncludeSelectors,
  extractDocument,
  validateSelectors
} from "../src/selectors";
import {
  serializeCdpDomForTest,
  TraversalSerializer,
  type CdpDomNode
} from "../src/traversal";
import type { CdpSession } from "../src/cdp";

const encoder = new TextEncoder();
let nextNodeId = 1;

assertEqual(
  digest([]),
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "empty SHA-256 vector"
);
assertEqual(
  digest([encoder.encode("abc")]),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "abc SHA-256 vector"
);
assertEqual(
  digest([
    encoder.encode("abcdbcdecdef"),
    encoder.encode("defgefghfghighij"),
    encoder.encode("hijkijkljklmklmnlmnomnopnopq")
  ]),
  "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  "incremental SHA-256 vector"
);

const multilingual = "前缀😀汉字🙂suffix".repeat(4096);
const multilingualBytes = encoder.encode(multilingual);
const incremental = new IncrementalSha256();
for (let offset = 0; offset < multilingualBytes.byteLength; offset += 137) {
  incremental.update(multilingualBytes.subarray(offset, offset + 137));
}
const nativeDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", multilingualBytes))]
  .map((value) => value.toString(16).padStart(2, "0"))
  .join("");
assertEqual(incremental.digestHex(), nativeDigest, "native SHA-256 comparison");

const boundaryText = "a".repeat(15) + "😀" + "汉字🙂".repeat(1000);
const pieces = [...splitUtf8(boundaryText, 16)];
assertEqual(pieces.join(""), boundaryText, "UTF-8 chunks reconstruct the source");
if (pieces.length < 2) {
  throw new Error("UTF-8 test did not produce multiple chunks");
}
for (const piece of pieces) {
  if (encoder.encode(piece).byteLength > 16) {
    throw new Error("UTF-8 chunk exceeded the configured byte limit");
  }
}

assertEqual(
  effectiveIncludeSelectors([])[0] ?? "",
  "body",
  "empty content selectors default to body"
);
assertEqual(
  effectiveIncludeSelectors(["article"])[0] ?? "",
  "article",
  "explicit content selectors are preserved"
);
await assertRejectsCode(
  validateSelectors(
    {
      evaluate: async () => ({ invalid: "" })
    } as unknown as CdpSession,
    [""]
  ),
  "selector_invalid",
  "empty selector validation"
);
await assertRejectsCode(
  assertIncludeSelectorsMatch(
    { evaluate: async () => false } as unknown as CdpSession,
    ["article"]
  ),
  "selector_not_found",
  "feed scope mismatch"
);
await assertRejectsCode(
  extractDocument(
    {
      evaluate: async () => ({ html: "", selectionApplied: true, matched: 0 })
    } as unknown as CdpSession,
    ["article"],
    []
  ),
  "selector_not_found",
  "document root mismatch"
);

assertNumber(
  calculateScrollStep(1_000, 60_000),
  800,
  "scroll step keeps viewport overlap"
);
assertNumber(
  calculateScrollStep(3_000, 60_000),
  1_500,
  "scroll step is capped at the internal maximum"
);
assertNumber(
  calculateScrollStep(3_000, 450),
  450,
  "scroll step respects the remaining distance budget"
);

const traversalOptions: TraversalOptions = {
  shadowDom: { enabled: true, maxDepth: 1 },
  iframes: { enabled: true, maxDepth: 1 }
};
const traversed = await serializeCdpDomForTest(
  element("main", {
    children: [
      element("browser-card", {
        children: [textNode("light content")],
        shadowRoots: [
          fragment("open", [
            element("a", {
              attributes: ["href", "/shadow-link"],
              children: [textNode("shadow content")]
            }),
            element("nested-card", {
              shadowRoots: [fragment("closed", [textNode("too deep")])]
            }),
            element("iframe", {
              contentDocument: documentNode("https://shadow-frame.example/", [
                element("html", {
                  children: [
                    element("body", { children: [textNode("iframe inside shadow")] })
                  ]
                })
              ])
            })
          ])
        ]
      }),
      element("closed-card", {
        shadowRoots: [fragment("closed", [textNode("closed shadow content")])]
      }),
      element("video", {
        shadowRoots: [fragment("user-agent", [textNode("browser internals")])]
      }),
      element("iframe", {
        attributes: ["src", "https://frame.example/embed"],
        frameId: "same-process-frame",
        contentDocument: documentNode("https://frame.example/embed", [
          element("html", {
            children: [
              element("body", {
                children: [
                  element("a", {
                    attributes: ["href", "../details"],
                    children: [textNode("frame content")]
                  }),
                  element("a", {
                    attributes: ["href", "#frame-section"],
                    children: [textNode("frame fragment")]
                  }),
                  element("form", {
                    attributes: ["action", ""],
                    children: [textNode("frame form")]
                  }),
                  element("frame-card", {
                    shadowRoots: [fragment("open", [textNode("frame shadow content")])]
                  }),
                  element("iframe", {
                    attributes: ["src", "/nested"],
                    contentDocument: documentNode("https://frame.example/nested", [
                      element("html", {
                        children: [element("body", { children: [textNode("too deep frame")] })]
                      })
                    ])
                  })
                ]
              })
            ]
          })
        ])
      })
    ]
  }),
  traversalOptions
);
assertIncludes(traversed, "data-extractor-shadow-root=\"open\"", "open shadow root");
assertIncludes(traversed, "shadow content", "shadow content");
assertIncludes(traversed, "closed shadow content", "closed shadow root");
assertIncludes(traversed, "iframe inside shadow", "iframe inside Shadow Root");
assertNotIncludes(traversed, "browser internals", "user-agent shadow root");
assertNotIncludes(traversed, "too deep", "shadow depth limit");
assertIncludes(traversed, "data-extractor-frame-depth=\"1\"", "frame wrapper");
assertIncludes(
  traversed,
  "https://frame.example/details",
  "frame-relative URL resolution"
);
assertIncludes(
  traversed,
  'href="https://frame.example/embed#frame-section"',
  "frame-fragment URL resolution"
);
assertIncludes(
  traversed,
  'action="https://frame.example/embed"',
  "empty frame URL resolution"
);
assertIncludes(traversed, "frame shadow content", "Shadow Root inside iframe");
assertNotIncludes(traversed, "too deep frame", "frame depth limit");

const traversalDisabled = await serializeCdpDomForTest(
  element("browser-card", {
    children: [textNode("light only")],
    shadowRoots: [fragment("open", [textNode("hidden shadow")])]
  }),
  {
    shadowDom: { enabled: false, maxDepth: 3 },
    iframes: { enabled: false, maxDepth: 3 }
  }
);
assertIncludes(traversalDisabled, "light only", "light DOM with traversal disabled");
assertNotIncludes(traversalDisabled, "hidden shadow", "disabled shadow traversal");

const excludedTopLevel = element("aside", { children: [textNode("top-level excluded")] });
const nestedShadowElement = element("aside", { children: [textNode("shadow retained")] });
const selectorBoundary = await serializeCdpDomForTest(
  element("main", {
    children: [
      excludedTopLevel,
      element("boundary-card", {
        shadowRoots: [fragment("open", [nestedShadowElement])]
      })
    ]
  }),
  traversalOptions,
  false,
  new Set([excludedTopLevel.backendNodeId, nestedShadowElement.backendNodeId])
);
assertNotIncludes(selectorBoundary, "top-level excluded", "top-level exclusion");
assertIncludes(
  selectorBoundary,
  "shadow retained",
  "user exclusions do not enter Shadow Roots"
);

const excludedBodyRoot = element("body", {
  children: [textNode("excluded body contents")]
});
const excludedBodyContents = await serializeCdpDomForTest(
  excludedBodyRoot,
  traversalOptions,
  true,
  new Set([excludedBodyRoot.backendNodeId])
);
assertEqual(
  excludedBodyContents,
  "",
  "contents-only serialization honors root exclusion"
);

const deepRoot = fragment("closed", [textNode("should not be fetched")]);
const deepRootDescriptor = { ...deepRoot, children: undefined };
const firstRoot = fragment("open", [
  textNode("incrementally fetched shadow"),
  element("nested-incremental-card", {
    shadowRoots: [deepRootDescriptor]
  })
]);
const firstRootDescriptor = { ...firstRoot, children: undefined };
const incrementalHost = element("incremental-card", {
  children: [],
  shadowRoots: [firstRootDescriptor]
});
let incrementalRootFetches = 0;
let deepRootFetches = 0;
const incrementalCdp = {
  sendWithTimeout: async (method: string, params?: object) => {
    if (method === "DOM.enable") {
      return {};
    }
    if (method === "DOM.getDocument") {
      return { root: documentNode("https://top.example/root/page", []) };
    }
    if (method === "DOM.describeNode") {
      const request = params as {
        backendNodeId?: number;
        pierce?: boolean;
      };
      if (request.pierce !== false) {
        throw new Error("incremental traversal must not pierce full subtrees");
      }
      if (request.backendNodeId === incrementalHost.backendNodeId) {
        return { node: incrementalHost };
      }
      if (request.backendNodeId === firstRoot.backendNodeId) {
        incrementalRootFetches += 1;
        return { node: firstRoot };
      }
      if (request.backendNodeId === deepRoot.backendNodeId) {
        deepRootFetches += 1;
        return { node: deepRoot };
      }
    }
    throw new Error("unexpected CDP command: " + method);
  }
} as unknown as CdpSession;
const incrementalSerializer = new TraversalSerializer(
  incrementalCdp,
  {
    shadowDom: { enabled: true, maxDepth: 1 },
    iframes: { enabled: false, maxDepth: 1 }
  },
  new AbortController().signal,
  Date.now() + 30_000,
  30_000
);
await incrementalSerializer.initialize();
const incrementalHtml = await incrementalSerializer.serializeBackendNode(
  incrementalHost.backendNodeId,
  new Set()
);
assertIncludes(
  incrementalHtml,
  "incrementally fetched shadow",
  "on-demand Shadow Root fetch"
);
assertNotIncludes(incrementalHtml, "should not be fetched", "pre-fetch depth limit");
assertNumber(incrementalRootFetches, 1, "first-level Shadow Root fetches");
assertNumber(deepRootFetches, 0, "beyond-limit Shadow Root fetches");

const detachedFrame = element("iframe", {
  attributes: ["src", "https://frame.example/detached"],
  frameId: "detached-frame"
});
const fakeCdp = {
  enableFrameTraversal: async () => undefined,
  waitForFrameSession: async () => {
    throw new Error("frame detached during capture");
  },
  sendWithTimeout: async (method: string) => {
    if (method === "DOM.enable") {
      return {};
    }
    if (method === "DOM.getDocument") {
      return { root: documentNode("https://top.example/root/page", []) };
    }
    if (method === "DOM.describeNode") {
      return { node: detachedFrame };
    }
    throw new Error("unexpected CDP command: " + method);
  }
} as unknown as CdpSession;
const warningSerializer = new TraversalSerializer(
  fakeCdp,
  traversalOptions,
  new AbortController().signal,
  Date.now() + 30_000,
  30_000
);
await warningSerializer.initialize();
const detachedFrameHtml = await warningSerializer.serializeBackendNode(
  detachedFrame.backendNodeId,
  new Set()
);
await warningSerializer.serializeBackendNode(detachedFrame.backendNodeId, new Set());
assertIncludes(detachedFrameHtml, "<iframe", "detached frame owner retained");
assertNumber(warningSerializer.getWarnings().length, 1, "detached frame warning");
assertEqual(
  warningSerializer.getWarnings()[0]?.kind ?? "",
  "iframe",
  "detached frame warning kind"
);

const foreignMarkup = await serializeCdpDomForTest(
  element("svg", {
    children: [element("linearGradient", { attributes: ["id", "paint"] })]
  }),
  traversalOptions
);
assertIncludes(foreignMarkup, "<linearGradient", "foreign-element tag casing");

console.log("extension algorithm tests passed");

function digest(parts: Uint8Array[]): string {
  const hasher = new IncrementalSha256();
  for (const part of parts) {
    hasher.update(part);
  }
  return hasher.digestHex();
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(label + ": expected " + expected + ", received " + actual);
  }
}

function assertNumber(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(label + ": expected " + expected + ", received " + actual);
  }
}

async function assertRejectsCode(
  promise: Promise<unknown>,
  expectedCode: string,
  label: string
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === expectedCode) {
      return;
    }
    throw new Error(
      label + ": expected error code " + expectedCode + ", received " + String(code)
    );
  }
  throw new Error(label + ": expected promise to reject");
}

function element(
  localName: string,
  overrides: Partial<CdpDomNode> = {}
): CdpDomNode {
  const nodeId = nextNodeId++;
  return {
    nodeId,
    backendNodeId: nodeId,
    nodeType: 1,
    nodeName: localName.toUpperCase(),
    localName,
    nodeValue: "",
    ...overrides
  };
}

function textNode(value: string): CdpDomNode {
  const nodeId = nextNodeId++;
  return {
    nodeId,
    backendNodeId: nodeId,
    nodeType: 3,
    nodeName: "#text",
    localName: "",
    nodeValue: value
  };
}

function fragment(
  shadowRootType: "user-agent" | "open" | "closed",
  children: CdpDomNode[]
): CdpDomNode {
  const nodeId = nextNodeId++;
  return {
    nodeId,
    backendNodeId: nodeId,
    nodeType: 11,
    nodeName: "#document-fragment",
    localName: "",
    nodeValue: "",
    shadowRootType,
    children
  };
}

function documentNode(url: string, children: CdpDomNode[]): CdpDomNode {
  const nodeId = nextNodeId++;
  return {
    nodeId,
    backendNodeId: nodeId,
    nodeType: 9,
    nodeName: "#document",
    localName: "",
    nodeValue: "",
    documentURL: url,
    baseURL: url,
    children
  };
}

function assertIncludes(actual: string, expected: string, label: string): void {
  if (!actual.includes(expected)) {
    throw new Error(
      label + ": expected output to include " + expected + ", received " + actual
    );
  }
}

function assertNotIncludes(actual: string, expected: string, label: string): void {
  if (actual.includes(expected)) {
    throw new Error(label + ": expected output not to include " + expected);
  }
}

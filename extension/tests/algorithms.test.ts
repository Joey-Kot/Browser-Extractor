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
import { CdpSession } from "../src/cdp";
import { resolveImageSource, type ImageSourceInput } from "../src/images";

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

const svgPlaceholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
const imageCases: Array<[string, Omit<ImageSourceInput, "baseUrl">, string | null]> = [
  ["lazy relative image", { attributes: { src: svgPlaceholder, "data-src": "../photo.jpg" } }, "https://top.example/photo.jpg"],
  ["lazy original image", { attributes: { src: svgPlaceholder, "data-original": "/original.jpg" } }, "https://top.example/original.jpg"],
  ["lazy srcset", { attributes: { src: svgPlaceholder, "data-srcset": "/small.jpg 400w, /large.jpg 1200w" } }, "https://top.example/large.jpg"],
  ["density srcset", { attributes: { src: svgPlaceholder, srcset: "/one.jpg 1x, /two.jpg 2x" } }, "https://top.example/two.jpg"],
  ["currentSrc precedes srcset", { attributes: { src: "/fallback.jpg", srcset: "/one.jpg 1x, /two.jpg 2x" }, currentSrc: "https://top.example/one.jpg" }, "https://top.example/one.jpg"],
  ["selected picture source", { attributes: { src: svgPlaceholder }, sourceSets: ["/picture.jpg 2x"] }, "https://top.example/picture.jpg"],
  ["placeholder currentSrc falls back", { attributes: { src: svgPlaceholder, "data-lazy-src": "/lazy.jpg" }, currentSrc: svgPlaceholder }, "https://top.example/lazy.jpg"],
  ["data URL commas in srcset", { attributes: { srcset: svgPlaceholder + " 1x, /actual.jpg 2x" } }, "https://top.example/actual.jpg"],
  ["commas inside image URLs", { attributes: { srcset: "/image,a.jpg 1x, /image,b.jpg 2x" } }, "https://top.example/image,b.jpg"],
  ["invalid srcset descriptors", { attributes: { "data-srcset": "/bad.jpg -2x, /also-bad.jpg 3w 2x, /good.jpg 2x" } }, "https://top.example/good.jpg"],
  ["real src is preserved", { attributes: { src: "/photo.jpg", "data-original": "/other.jpg" } }, "https://top.example/photo.jpg"],
  ["SVG artwork is preserved", { attributes: { src: "/artwork.svg", "data-src": "/other.jpg" } }, "https://top.example/artwork.svg"],
  ["inline SVG without fallback is left unchanged", { attributes: { src: svgPlaceholder } }, null],
  ["placeholder without fallback is left unchanged", { attributes: { src: "/placeholder.svg" } }, null],
  ["named placeholder is replaced", { attributes: { src: "/placeholder.svg", "data-src": "/photo.jpg" } }, "https://top.example/photo.jpg"],
  ["noscript fallback", { attributes: { src: svgPlaceholder }, fallbackSrc: "/fallback.jpg" }, "https://top.example/fallback.jpg"],
  ["unsafe and empty sources are ignored", { attributes: { "data-src": "javascript:alert(1)", "data-original": " " } }, null],
  ["boolean lazy marker is ignored", { attributes: { "data-original": "true" } }, null],
  ["fragment source is not an image URL", { attributes: { src: "#" } }, null]
];
for (const [label, input, expected] of imageCases) {
  assertEqual(
    resolveImageSource({ ...input, baseUrl: "https://top.example/root/page" }) ?? "<none>",
    expected ?? "<none>",
    label
  );
}

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

const lazyImage = element("img", {
  attributes: ["src", svgPlaceholder, "data-src", "../photo.jpg", "alt", "lazy photo"]
});
const lazyImageHtml = await serializeCdpDomForTest(lazyImage, traversalOptions);
assertIncludes(lazyImageHtml, 'src="https://top.example/photo.jpg"', "CDP attribute fallback");
assertIncludes(lazyImageHtml, 'alt="lazy photo"', "image alt retained");
assertEqual(lazyImage.attributes?.[1] ?? "", svgPlaceholder, "CDP capture attributes remain unchanged");
const nestedImages = await serializeCdpDomForTest(
  element("main", {
    children: [
      element("image-card", {
        shadowRoots: [fragment("open", [element("img", {
          attributes: ["src", svgPlaceholder, "data-original", "/shadow.jpg"]
        })])]
      }),
      element("iframe", {
        contentDocument: documentNode("https://frame.example/articles/page", [
          element("html", { children: [element("body", { children: [element("img", {
            attributes: ["src", svgPlaceholder, "data-src", "../frame.jpg"]
          })] })] })
        ])
      })
    ]
  }),
  traversalOptions
);
assertIncludes(nestedImages, 'src="https://top.example/shadow.jpg"', "Shadow Root image recovery");
assertIncludes(nestedImages, 'src="https://frame.example/frame.jpg"', "frame image base URL");

const responsiveImage = element("img", {
  attributes: ["src", "/fallback.jpg", "srcset", "/small.jpg 1x, /large.jpg 2x"]
});
let imageSnapshotAttributes = [...responsiveImage.attributes!];
let imageHandleReleases = 0;
const imageCdp = {
  enableFrameTraversal: async () => undefined,
  sendWithTimeout: async (method: string) => {
    if (method === "DOM.enable") return {};
    if (method === "DOM.getDocument") return { root: documentNode("https://top.example/root/page", []) };
    if (method === "DOM.describeNode") return { node: responsiveImage };
    if (method === "DOM.resolveNode") return { object: { objectId: "image-root" } };
    if (method === "Runtime.callFunctionOn") {
      return { result: { value: [{ attributes: imageSnapshotAttributes, source: "https://top.example/small.jpg" }] } };
    }
    if (method === "Runtime.releaseObjectGroup") {
      imageHandleReleases += 1;
      return {};
    }
    throw new Error("unexpected image CDP command: " + method);
  }
} as unknown as CdpSession;
const imageSerializer = new TraversalSerializer(
  imageCdp, traversalOptions, new AbortController().signal, Date.now() + 30_000, 30_000
);
await imageSerializer.initialize();
assertIncludes(
  await imageSerializer.serializeBackendNode(responsiveImage.backendNodeId, new Set()),
  'src="https://top.example/small.jpg"',
  "CDP uses the live selected image rather than the largest candidate"
);
imageSnapshotAttributes = ["src", "/different-node.jpg"];
assertIncludes(
  await imageSerializer.serializeBackendNode(responsiveImage.backendNodeId, new Set()),
  'src="https://top.example/large.jpg"',
  "stale live metadata falls back to captured attributes"
);
assertNumber(imageHandleReleases, 2, "image handles are released");

const pinnedImage = await serializeCdpDomForTest(
  element("picture", {
    children: [
      element("source", { attributes: ["srcset", svgPlaceholder, "sizes", "100vw"] }),
      element("img", {
        attributes: ["src", svgPlaceholder, "srcset", svgPlaceholder, "sizes", "100vw", "data-src", "/real.jpg"]
      })
    ]
  }),
  traversalOptions
);
assertIncludes(pinnedImage, 'src="https://top.example/real.jpg"', "recovered picture source");
assertNotIncludes(pinnedImage, "srcset=", "stale picture and image source sets removed");
assertNotIncludes(pinnedImage, "sizes=", "stale responsive sizes removed");
const unresolvedImage = await serializeCdpDomForTest(
  element("img", { attributes: ["src", svgPlaceholder, "srcset", svgPlaceholder + " 1x"] }),
  traversalOptions
);
assertIncludes(unresolvedImage, "data:image/svg+xml", "unresolved SVG is retained");
assertIncludes(unresolvedImage, "srcset=", "unresolved responsive attributes retained");

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

const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
let debuggerEvent: ((source: { tabId: number; sessionId?: string }, method: string, params: object) => void) | null = null;
Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    debugger: {
      attach: async () => undefined,
      detach: async () => undefined,
      sendCommand: async () => ({}),
      onEvent: {
        addListener: (listener: typeof debuggerEvent) => { debuggerEvent = listener; },
        removeListener: () => { debuggerEvent = null; }
      }
    }
  }
});
try {
  const network = new CdpSession(7);
  await network.attach();
  const emit = (method: string, params: object, source: { tabId: number; sessionId?: string } = { tabId: 7 }) => {
    debuggerEvent!(source, method, params);
  };
  emit("Network.requestWillBeSent", { requestId: "image", type: "Image" });
  emit("Network.requestWillBeSent", { requestId: "child", type: "Fetch" }, { tabId: 7, sessionId: "child" });
  emit("Network.requestWillBeSent", { requestId: "other", type: "Fetch" }, { tabId: 8 });
  assertNumber(Number(network.hasPendingPageRequests()), 0, "unrelated requests do not block scrolling");
  emit("Network.requestWillBeSent", { requestId: "fetch", type: "Fetch" });
  emit("Network.requestWillBeSent", { requestId: "xhr", type: "XHR" });
  emit("Network.loadingFinished", { requestId: "fetch" });
  assertNumber(Number(network.hasPendingPageRequests()), 1, "remaining XHR keeps the page loading");
  emit("Network.loadingFailed", { requestId: "xhr" });
  assertNumber(Number(network.hasPendingPageRequests()), 0, "failed requests are cleared");
  emit("Network.requestWillBeSent", { requestId: "pending", type: "Fetch" });
  await network.detach();
  assertNumber(Number(network.hasPendingPageRequests()), 0, "cleanup clears pending requests");
} finally {
  if (chromeDescriptor) Object.defineProperty(globalThis, "chrome", chromeDescriptor);
  else Reflect.deleteProperty(globalThis, "chrome");
}

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

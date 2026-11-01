# HTTP API

The machine-readable contract is spec/openapi.yaml. All versioned endpoints require:

    Authorization: Bearer API_TOKEN

GET /health is public and only reports process liveness.

## Create

POST /v1/extractions creates a job. Idempotency-Key is optional and limited to 256 bytes. Reusing a key returns the original job instead of creating another browser tab.

waitMs controls only how long the HTTP request waits. jobTimeoutMs is the hard deadline for the whole job. A completed job returns 200; a queued or running job returns 202.

Both modes default `includeSelectors` to `["body"]`; an omitted or empty array is normalized to that value. document mode returns the selected roots once. When scrolling is enabled it also retains blocks before each scroll; if earlier blocks leave the DOM, it merges retained blocks, surrounding text and uncovered subtrees inside `section[data-extractor-scroll-history]`. New blocks are inserted before their next surviving neighbor so conclusions remain after later records. feed mode requires scrolling and streams inferred blocks incrementally. Both modes discover eligible vertical scroll containers related to the same outermost selected roots, skip excluded subtrees, and observe pending asynchronous content before stopping. `scroll.maxDistancePx` defaults to 60000 per container.

## Query and cancel

GET /v1/extractions/{id} returns current state or retained output.

DELETE /v1/extractions/{id} is idempotent. Active tasks receive cancel and retain their browser permit until closed or the cleanup lease expires.

## Selector rules

Selectors run with document.querySelectorAll in Chrome. includeSelectors select outermost unique roots in DOM order. Invalid CSS returns `selector_invalid`; zero initial include matches return `selector_not_found` in both modes, without falling back to body. Matching items may temporarily disappear during virtualized scrolling. excludeSelectors remove matching cloned subtrees and inferred blocks below excluded ancestors within the selected roots. Default clone cleanup removes script, style, noscript and template. Content blocks are inferred from semantic elements, repeated sibling structures, and textual leaves, then deduplicated by stable attributes, semantic permalinks, or HTML hashes.

Selectors always remain in the main document. Enabling `traversal.shadowDom` or `traversal.iframes` only changes serialization after top-level document roots or inferred feed blocks have been selected; it does not run selectors, readiness waits, settling, or scrolling inside nested roots or documents.

Both traversal targets default to disabled. Each has an independent `maxDepth` default of 3. Author open and closed Shadow Roots are included, user-agent roots are ignored, and same-origin/cross-origin iframe bodies are represented by synthetic HTML wrappers. Recoverable iframe failures are returned through the completed job's `warnings` array.

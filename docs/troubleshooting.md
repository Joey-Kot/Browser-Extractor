# Troubleshooting

## API returns browser_unavailable

Build and load extension/dist, save the exact extension token in the popup, and check GET /v1/bridge/status with the API token.

## Extension reports debugger_attach_failed

Another debugger or DevTools session may own the tab, or Chrome policy may block the debugger permission. Close competing debugger sessions and retry.

## A selector works in DevTools but the job fails

Confirm that it targets the main document. Selectors never run inside Shadow Roots or iframe documents, even when traversal is enabled. Use waitForSelector only for top-level readiness, includeSelectors for output boundaries, and `traversal` only to serialize nested descendants after selection. Explicit include selectors are strict: a zero-match result returns `selector_not_found` and is never replaced with `body`.

## iframe content is missing but the job completed

Check the response `warnings` array. A frame that navigates, detaches, times out, or cannot be attached is skipped so the rest of the page can still complete. Confirm Chrome 125 or newer, increase both `loadTimeoutMs` and the overall job deadline when a Frame loads slowly, and verify that the iframe is below a selected top-level root and within `traversal.iframes.maxDepth`.

## Feed stops too early

Increase `scroll.maxDistancePx`, `scroll.settleMs`, or the overall job deadline. The extension automatically discovers eligible vertical containers and does not require a container or item selector. For virtual lists, a stable `dedupe.attribute` or preferred-link selector can improve automatic block deduplication. Content that requires clicking, pagination, expansion, or another interaction is intentionally outside the extractor's scope.

## cleanup_unconfirmed appears

The daemon did not receive closed before cleanup_timeout_ms. Inspect Chrome for a remaining task tab and check extension reconnect logs. The browser slot has already been released by the lease.

## Build fails on protocol types

Run npm ci inside extension, then npm run generate. generated/protocol.ts must not be edited manually.

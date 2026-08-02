# Chrome extension

Development source lives in extension/src. Build output lives in extension/dist and is the directory loaded by Chrome.

Chrome or Chromium 125 or newer is required. Cross-origin out-of-process iframe capture uses the flat child debugger sessions introduced in Chrome 125.

The extension requires debugger, tabs and storage permissions. It creates about:blank first, attaches chrome.debugger, enables the required Page, Runtime and Network domains, then navigates. This prevents early load and response events from being missed.

The popup stores the bridge URL and token in chrome.storage.local. browserInstanceId is generated once per extension installation and is also persistent.

Minimal active job metadata is kept in chrome.storage.session. If the service worker restarts and cannot recover executable state, startup cleanup closes the recorded tabs before sync_state. Active in-memory jobs are independent; the extension does not impose a concurrency limit.

Child tabs whose opener belongs to a job are recorded and closed. cleanupJob is idempotent and is the only path that aborts work, detaches CDP, removes owned tabs and clears session storage.

When iframe traversal is enabled, the root debugger session recursively enables `Target.setAutoAttach` for iframe targets. Selected light DOM is described without piercing; eligible same-process Frame documents and Shadow Roots are then fetched individually, while out-of-process frames are read through child sessions. Child sessions wait for a completed document and are checked for loader changes around capture. Child-frame failures are downgraded to traversal warnings, and detaching the root session releases all related sessions.

All request selectors, waits, settling, and scrolling remain in the top-level document. `includeSelectors` defaults to `body`; explicit selectors must match and never fall back to that default. When scrolling is enabled, the extension discovers the document scroller and eligible internal vertical containers related to those roots, advances all of them with an overlapping viewport-derived step capped at 1500 pixels, and rescans after DOM changes. Feed mode infers semantic, repeated-sibling, and textual content blocks before each pass so virtualized nodes are retained before removal; document mode scrolls first and then takes its single snapshot. Shadow Root and iframe traversal only serializes descendants of the document roots or inferred blocks selected there.

Scrolling is the only page interaction performed. The extension does not click load-more controls, paginate, expand disclosure widgets, submit forms, or otherwise interact with page controls.

background and foreground visibility modes are implemented. auto currently starts in the background and does not yet promote a throttled tab.

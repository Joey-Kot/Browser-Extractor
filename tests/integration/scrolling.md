# Generic scrolling and virtualized content

Run `npm run test:browser` in `extension/` after installing Chromium as described
in `images.md`. The scrolling suite drives the real capture loop in both modes.
It verifies removed DOM nodes, reused slots (with and without record links),
delayed Fetch responses, transient empty windows, excluded and small scrollers,
and continuously changing content. There are no domain-specific selectors.

Review regressions additionally cover author links inside headings, with and
without distinct generic item IDs, in ordinary and CDP feed capture. Scrolling
documents must retain direct introductory/concluding text and uncovered formatted
subtrees around evicted records, keep new records before their conclusion, and
preserve selected frame/Shadow Root context when traversal is enabled. Overlapping
include roots must not re-enable excluded scrollers; an explicitly selected inner
root with its excluded ancestor outside the effective scope remains supported.

The background regression additionally launches full Chromium with an unpacked
test extension and uses the real `JobManager`, `chrome.tabs` and `chrome.debugger`
APIs. It uses a CDP connection with `noDefaults: true` and no flags disabling
background throttling; Playwright's usual focus override and Headless Shell would
hide this failure. An unactivated control tab must report `document.hidden=true`.
For both capture modes, a page whose reply loader requires visibility, focus,
IntersectionObserver and requestAnimationFrame must retain the main post and both
replies without any tab activation. The test also verifies first-script visibility,
restoration after debugger detach, tab cleanup and persisted job cleanup.

For manual regression, extract `background-thread.html` with `--scroll-px 3000`
in each mode, leaving the job tab in the background for the entire capture. Both
results must contain `Main post`, `reply-one` and `reply-two`.

For manual regression, serve `fixtures/test-site/` and extract
`virtual-thread.html` with `--include-tag main --exclude-tag aside --scroll-px 5000`.
Run once in feed mode and once with `--mode document`. Both results must contain
the main post and all 11 replies in order, once each, even though the main post
is no longer in the live DOM when scrolling finishes. Repeat with `?reuse` and
`?reuse&anonymous` to exercise DOM node reuse, and with `?reuse&anonymous&generic`
for plain repeated divs without article markup. The excluded sidebar must remain
unscrolled and absent from the result.

A scrolling document with evicted blocks uses `section[data-extractor-scroll-history]`
to hold its merged content blocks. An append-only page still returns the full
selected-root snapshot, and document mode without `--scroll-px` takes one snapshot.
At the current bottom, the default minimum observation window is 2500 ms,
extended for larger settle values and capped by `loadTimeoutMs`. Pending top-session
Fetch/XHR requests can extend it up to that timeout. The job deadline and each
container's distance budget continue to bound capture.

# Image source recovery

The browser regression suite covers Trusted Types, CDP node reordering, picture
type/media filtering, rendered exports, and absence of live-page mutations or new
image requests. In `extension/`, install the locked dependencies, install Chromium
with `npx playwright install chromium`, then run
`npm run test:browser`. `npm test` runs the browser-independent algorithm tests.

The suite also checks exclusions using original `src`, `srcset` and `:has(...)`
selectors before image recovery, in document, feed and CDP capture, while ensuring
remaining image sources still resolve correctly and live markup stays unchanged.

1. Serve `fixtures/test-site/` locally and open `lazy-images.html`. The image files
   may return 404: this regression concerns the selected URLs, not image downloads.
2. Extract with `--mode document --include-tag '#images' --exclude-tag aside`.
   Check the exported HTML and Markdown: `lazy` uses `/photos/lazy.jpg`, `original`
   uses `/image-assets/original.jpg`, and `lazy-srcset` uses
   `/image-assets/large.jpg`, all resolved against the fixture origin.
3. Check `responsive` and `picture` against the live elements' `currentSrc`.
   The exported `src` must match the browser's selection, even if it selected a
   smaller candidate or the request failed. `noscript-fallback` must use
   `/image-assets/noscript.jpg` before `noscript` is removed.
4. Repeat with `--shadow-dom 1 --iframes 1`. Check that the closed Shadow Root's
   lazy image uses `/image-assets/shadow.jpg` and the frame's image uses
   `/frame-assets/frame.jpg`. Their responsive images must also match `currentSrc`.
5. Repeat in feed mode. Each emitted image must use the same address rules.
6. Verify that `artwork` keeps its SVG URL, `unresolved` and `unsafe` retain their
   inline SVG, and the excluded image is absent. Capture must not change live image
   attributes or issue requests for recovered lazy-image addresses. No additional
   image loading, scrolling, or readiness wait is enabled by source recovery.
7. Inspect the recovered images' exported markup. Their `srcset` and `sizes`, and
   their containing picture's source sets, must no longer override the selected
   URL. Images without a reliable alternative must retain their original markup.

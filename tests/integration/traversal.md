# Shadow DOM and iframe traversal

1. Map two different sites such as `top.test` and `frame.test` to `127.0.0.1`,
   then serve `fixtures/test-site/` on `top.test:18080` and again on
   `frame.test:18081`. Different ports on the same host are only cross-origin;
   different sites are required to force Chrome's OOPIF path under default Site
   Isolation.
2. Extract `http://top.test:18080/shadow-dom.html` with both traversal
   options disabled. Confirm that the result contains the custom-element hosts
   but not their shadow content.
3. Repeat with `shadowDom.enabled=true` and `maxDepth=1`. Confirm that open and
   closed first-level author roots are represented by
   `data-extractor-shadow-root`, nested shadow content is absent, and no
   user-agent shadow tree is emitted.
4. Repeat with `shadowDom.maxDepth=2`. Confirm that nested shadow content is
   present.
5. Extract
   `http://top.test:18080/iframe-host.html?frameOrigin=http://frame.test:18081`
   with `iframes.enabled=true`. Confirm that both same-origin and cross-origin
   frame bodies are represented by `data-extractor-frame-url` wrappers. Use
   `chrome://process-internals` to confirm that the cross-site frame is an
   out-of-process iframe rather than relying only on the different origin.
6. Confirm that `Frame-relative link` and `Frame-local fragment link` resolve
   against each Frame URL rather than against the top-level host URL.
7. Navigate or remove the cross-origin iframe during capture. Confirm that the
   job completes, returns a traversal warning, and debugger/tab cleanup still
   reaches `closed`.
8. Cancel a traversal job while an OOPIF is attaching. Confirm that all child
   debugger sessions are released and no owned tab remains open.

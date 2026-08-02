# Architecture

The daemon is the only component exposed to callers. It validates and stores jobs, owns the bounded queue and browser semaphore, and sends a typed extraction command to one connected extension. The extension uses the current Chrome profile, so authenticated site state never leaves Chrome.

~~~mermaid
flowchart LR
    Caller -->|HTTP| API
    API --> Scheduler
    Scheduler -->|extract / cancel| Bridge
    subgraph ExtensionSide["Chrome extension"]
        JobRunner["Job runner"] --> CaptureLoop["Auto-scroll discovery<br/>content-block inference + dedupe"]
    end
    Bridge <-->|WebSocket| JobRunner
    CaptureLoop <-->|chrome.debugger / live DOM| Chrome
    CaptureLoop -->|capture chunks| Bridge
    Bridge --> Assembler
    Assembler --> Normalizer
    Normalizer --> HTMD
    HTMD --> ResultStore
~~~

Browser permits are acquired before dispatch and normally released only after closed. Once capture_end is verified, conversion and tab cleanup run in parallel. A cleanup lease changes cleanupStatus to cleanup_unconfirmed and releases the permit if closed is lost.

Capture bytes are written to a temporary file while received. The daemon checks strict sequence order, byte totals and SHA-256 before assembling document or feed Capture HTML. In feed mode the extension automatically discovers related vertical scroll containers, captures inferred content blocks before each overlapping scroll step, and streams each deduplicated block once. The global inflight counter prevents concurrent captures from exceeding the configured pressure envelope.

Optional nested-content traversal runs after document roots are selected or feed content blocks are inferred in the main document. The extension captures selected light DOM without piercing, fetches eligible Shadow Roots and same-process Frame documents on demand, and recursively attaches to OOPIF child targets for cross-origin frames. Depth limits are applied before nested CDP requests. It inserts deterministic synthetic wrappers into the selected HTML and resolves frame-relative URLs before sending chunks. A nested-content failure records a warning and does not abort the parent capture.

The bridge keeps a weak reference to the scheduler, avoiding an Arc ownership cycle. Jobs keep their own state lock, capture assembler lock, notification primitive and optional owned semaphore permit.

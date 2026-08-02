# Cleanup matrix

Run document and feed jobs through success, selector failure, load timeout, API cancellation and extension reload. For every case:

- debugger sessions are detached;
- main and child tabs are closed;
- chrome.storage.session contains no completed job;
- closed is emitted at most once per extension execution;
- the daemon browser semaphore returns to its configured capacity.


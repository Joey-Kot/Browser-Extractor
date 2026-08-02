# Concurrent jobs

1. Start the daemon with max_concurrency=10 and load the extension.
2. Serve fixtures/test-site locally.
3. Submit 20 document jobs with waitMs=0.
4. Verify bridge/status never reports more than 10 activeBrowserJobs.
5. Verify every result requestId maps to its submitted URL and no tabs remain.


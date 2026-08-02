# Extension restart

1. Start a long infinite-feed job.
2. Reload the extension from chrome://extensions while it is collecting.
3. Verify startup reads chrome.storage.session and closes recorded task tabs.
4. Verify sync_state causes the daemon job to fail and release its permit.
5. Verify a new job succeeds after reconnect.


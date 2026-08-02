# WebSocket disconnect

1. Start several feed jobs.
2. Stop the daemon bridge listener or reload the daemon.
3. Verify extension jobs enter cleanup and their tabs close.
4. Verify the daemon releases permits after closed or cleanup_timeout_ms.
5. Verify reconnect sends sync_state and orphan jobs are cancelled.


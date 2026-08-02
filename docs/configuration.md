# Configuration

The full example is config.example.toml. Command-line values override file values.

Important groups:

- server: HTTP listen address, API token and CORS switch;
- bridge: WebSocket listen address, extension token, optional fixed browser instance and heartbeat interval;
- executor: browser concurrency, conversion concurrency, queue size, maximum hard timeout and cleanup lease;
- capture: chunk size, single-result limit, global inflight limit and extension ACK window;
- jobs: result TTL and maximum completed records;
- conversion: renderer name.

Supported overrides:

    extractor-server --config extractor.toml
    extractor-server --listen 127.0.0.1:17320
    extractor-server --bridge-listen 127.0.0.1:17321
    extractor-server --max-concurrency 10
    extractor-server --max-conversion-concurrency 4

EXTRACTOR_API_TOKEN and EXTRACTOR_EXTENSION_TOKEN are supported environment variables.

`server.allow_cors` defaults to `true` so browser applications can call the loopback API. Set it to `false` when cross-origin access is unnecessary, especially when binding outside `127.0.0.1`.

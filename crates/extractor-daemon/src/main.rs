use anyhow::{Context, Result};
use clap::Parser;
use extractor_daemon::{
    api, bridge,
    config::{Cli, Config},
    AppState,
};
use tokio::{net::TcpListener, sync::watch};
use tower_http::trace::TraceLayer;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("extractor_daemon=info,tower_http=info")),
        )
        .with_target(false)
        .compact()
        .init();

    let cli = Cli::parse();
    let (config, generated_tokens) = Config::load(&cli)?;
    if let Some(token) = generated_tokens.api_token {
        warn!(api_token = %token, "generated ephemeral API token");
    }
    if let Some(token) = generated_tokens.extension_token {
        warn!(extension_token = %token, "generated ephemeral extension token");
    }

    let state = AppState::new(config);
    state.scheduler.clone().start();

    let api_address = state.config.server.listen;
    let bridge_address = state.config.bridge.listen;
    let api_listener = TcpListener::bind(api_address)
        .await
        .with_context(|| format!("无法监听 API 地址 {api_address}"))?;
    let bridge_listener = TcpListener::bind(bridge_address)
        .await
        .with_context(|| format!("无法监听 bridge 地址 {bridge_address}"))?;

    let api_router = api::router(state.clone()).layer(TraceLayer::new_for_http());
    let bridge_router =
        bridge::session::router(state.bridge.clone()).layer(TraceLayer::new_for_http());

    info!(address = %api_address, "HTTP API listening");
    info!(address = %bridge_address, "extension bridge listening");

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let signal_tx = shutdown_tx.clone();
    tokio::spawn(async move {
        shutdown_signal().await;
        let _ = signal_tx.send(true);
    });

    let api_shutdown = wait_for_shutdown(shutdown_rx.clone());
    let bridge_shutdown = wait_for_shutdown(shutdown_rx);
    let api_server = async move {
        axum::serve(api_listener, api_router)
            .with_graceful_shutdown(api_shutdown)
            .await
    };
    let bridge_server = async move {
        axum::serve(bridge_listener, bridge_router)
            .with_graceful_shutdown(bridge_shutdown)
            .await
    };

    tokio::try_join!(api_server, bridge_server)?;
    Ok(())
}

async fn wait_for_shutdown(mut receiver: watch::Receiver<bool>) {
    if *receiver.borrow() {
        return;
    }
    let _ = receiver.changed().await;
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    info!("shutdown signal received");
}

use std::{
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use clap::Parser;
use rand::{distr::Alphanumeric, RngExt};
use serde::{Deserialize, Serialize};

#[derive(Debug, Parser)]
#[command(
    name = "extractor-server",
    version,
    about = "Browser Extractor server for real-browser extraction"
)]
pub struct Cli {
    #[arg(long)]
    pub config: Option<PathBuf>,
    #[arg(long)]
    pub listen: Option<SocketAddr>,
    #[arg(long)]
    pub bridge_listen: Option<SocketAddr>,
    #[arg(long, env = "EXTRACTOR_API_TOKEN")]
    pub api_token: Option<String>,
    #[arg(long, env = "EXTRACTOR_EXTENSION_TOKEN")]
    pub extension_token: Option<String>,
    #[arg(long)]
    pub max_concurrency: Option<usize>,
    #[arg(long)]
    pub max_conversion_concurrency: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub server: ServerConfig,
    pub bridge: BridgeConfig,
    pub executor: ExecutorConfig,
    pub capture: CaptureConfig,
    pub jobs: JobsConfig,
    pub conversion: ConversionConfig,
}

impl Config {
    pub fn load(cli: &Cli) -> Result<(Self, GeneratedTokens)> {
        let mut config = if let Some(path) = cli.config.as_deref() {
            Self::from_file(path)?
        } else {
            Self::default()
        };

        if let Some(value) = cli.listen {
            config.server.listen = value;
        }
        if let Some(value) = cli.bridge_listen {
            config.bridge.listen = value;
        }
        if let Some(value) = cli.api_token.as_ref() {
            config.server.api_token.clone_from(value);
        }
        if let Some(value) = cli.extension_token.as_ref() {
            config.bridge.extension_token.clone_from(value);
        }
        if let Some(value) = cli.max_concurrency {
            config.executor.max_concurrency = value.max(1);
        }
        if let Some(value) = cli.max_conversion_concurrency {
            config.executor.max_conversion_concurrency = value.max(1);
        }

        config.executor.max_concurrency = config.executor.max_concurrency.max(1);
        config.executor.max_conversion_concurrency =
            config.executor.max_conversion_concurrency.max(1);
        config.executor.max_queue_size = config.executor.max_queue_size.max(1);
        config.executor.job_timeout_ms = config.executor.job_timeout_ms.max(1);
        config.executor.cleanup_timeout_ms = config.executor.cleanup_timeout_ms.max(1);
        config.capture.chunk_bytes = config.capture.chunk_bytes.max(1_024);
        config.capture.max_result_bytes = config.capture.max_result_bytes.max(1_024);
        config.capture.max_total_inflight_bytes = config
            .capture
            .max_total_inflight_bytes
            .max(config.capture.max_result_bytes);
        config.capture.max_unacked_chunks = config.capture.max_unacked_chunks.max(1);
        config.jobs.result_ttl_seconds = config.jobs.result_ttl_seconds.max(1);
        config.jobs.max_completed_jobs = config.jobs.max_completed_jobs.max(1);

        let mut generated = GeneratedTokens::default();
        if config.server.api_token.is_empty() {
            config.server.api_token = random_token();
            generated.api_token = Some(config.server.api_token.clone());
        }
        if config.bridge.extension_token.is_empty() {
            config.bridge.extension_token = random_token();
            generated.extension_token = Some(config.bridge.extension_token.clone());
        }

        Ok((config, generated))
    }

    fn from_file(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("无法读取配置文件 {}", path.display()))?;
        toml::from_str(&raw).with_context(|| format!("配置文件格式错误 {}", path.display()))
    }
}

fn random_token() -> String {
    rand::rng()
        .sample_iter(Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

#[derive(Debug, Default)]
pub struct GeneratedTokens {
    pub api_token: Option<String>,
    pub extension_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub listen: SocketAddr,
    pub api_token: String,
    pub allow_cors: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            listen: "127.0.0.1:17320".parse().expect("valid default address"),
            api_token: String::new(),
            allow_cors: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BridgeConfig {
    pub listen: SocketAddr,
    pub extension_token: String,
    pub browser_instance_id: String,
    pub ping_interval_seconds: u64,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            listen: "127.0.0.1:17321".parse().expect("valid default address"),
            extension_token: String::new(),
            browser_instance_id: String::new(),
            ping_interval_seconds: 20,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ExecutorConfig {
    pub max_concurrency: usize,
    pub max_conversion_concurrency: usize,
    pub max_queue_size: usize,
    pub job_timeout_ms: u64,
    pub cleanup_timeout_ms: u64,
}

impl Default for ExecutorConfig {
    fn default() -> Self {
        Self {
            max_concurrency: 10,
            max_conversion_concurrency: 4,
            max_queue_size: 1_000,
            job_timeout_ms: 120_000,
            cleanup_timeout_ms: 10_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CaptureConfig {
    pub chunk_bytes: usize,
    pub max_result_bytes: u64,
    pub max_total_inflight_bytes: u64,
    pub max_unacked_chunks: usize,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            chunk_bytes: 262_144,
            max_result_bytes: 33_554_432,
            max_total_inflight_bytes: 268_435_456,
            max_unacked_chunks: 8,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct JobsConfig {
    pub result_ttl_seconds: u64,
    pub max_completed_jobs: usize,
}

impl Default for JobsConfig {
    fn default() -> Self {
        Self {
            result_ttl_seconds: 600,
            max_completed_jobs: 1_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ConversionConfig {
    pub renderer: String,
}

impl Default for ConversionConfig {
    fn default() -> Self {
        Self {
            renderer: "htmd".to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;

    use super::Cli;

    #[test]
    fn help_uses_the_server_program_name() {
        let mut command = Cli::command();
        let help = command.render_long_help().to_string();

        assert!(help.contains("Browser Extractor server for real-browser extraction"));
        assert!(help.contains("Usage: extractor-server [OPTIONS]"));
    }
}

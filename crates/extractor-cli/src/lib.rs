mod args;
mod client;
mod error;
mod model;
mod output;
mod selectors;

use std::{env, path::PathBuf, time::Duration};

use url::Url;

pub use args::Cli;
pub use error::CliError;

use client::ExtractorClient;

const DEFAULT_BASE_URL: &str = "http://127.0.0.1:17320";

#[derive(Debug, Clone)]
pub struct Environment {
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

impl Environment {
    pub fn from_process() -> Self {
        Self {
            base_url: env::var("EXTRACTOR_BASE_URL").ok(),
            api_key: env::var("EXTRACTOR_API_KEY").ok(),
        }
    }

    fn resolve(self) -> Result<ResolvedEnvironment, CliError> {
        let api_key = self
            .api_key
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| CliError::usage("EXTRACTOR_API_KEY is required"))?;

        let raw_base_url = self
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_BASE_URL);
        let mut base_url = Url::parse(raw_base_url)
            .map_err(|error| CliError::usage(format!("EXTRACTOR_BASE_URL is invalid: {error}")))?;
        if !matches!(base_url.scheme(), "http" | "https") {
            return Err(CliError::usage("EXTRACTOR_BASE_URL must use http or https"));
        }
        if base_url.query().is_some() || base_url.fragment().is_some() {
            return Err(CliError::usage(
                "EXTRACTOR_BASE_URL must not contain a query string or fragment",
            ));
        }
        if !base_url.path().ends_with('/') {
            let path = format!("{}/", base_url.path());
            base_url.set_path(&path);
        }

        Ok(ResolvedEnvironment { base_url, api_key })
    }
}

#[derive(Debug)]
struct ResolvedEnvironment {
    base_url: Url,
    api_key: String,
}

pub async fn execute(cli: Cli) -> Result<PathBuf, CliError> {
    execute_with_environment(cli, Environment::from_process()).await
}

pub async fn execute_with_environment(
    cli: Cli,
    environment: Environment,
) -> Result<PathBuf, CliError> {
    let resolved = cli.resolve()?;
    let output_path = output::output_path(&resolved.output, &resolved.output_directory)?;
    let environment = environment.resolve()?;
    output::ensure_available(&output_path)?;

    let client = ExtractorClient::new(
        environment.base_url,
        environment.api_key,
        Duration::from_secs(resolved.timeout_seconds),
        resolved.verify_ssl,
    )?;
    let extraction = client.extract(&resolved.request).await?;
    let rendered = output::render(&extraction)?;
    output::write_atomic(&output_path, &rendered)?;

    Ok(output_path)
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    use axum::{
        extract::{Path, State},
        http::{header::AUTHORIZATION, HeaderMap, StatusCode},
        routing::{get, post},
        Json, Router,
    };
    use clap::Parser;
    use serde_json::{json, Value};
    use tokio::net::TcpListener;
    use url::Url;
    use uuid::Uuid;

    use crate::{client::ExtractorClient, output, Environment};

    use super::Cli;

    #[derive(Clone)]
    struct MockState {
        requests: Arc<Mutex<Vec<Value>>>,
        polls: Arc<Mutex<usize>>,
        job_id: Uuid,
    }

    async fn create_job(
        State(state): State<MockState>,
        headers: HeaderMap,
        Json(request): Json<Value>,
    ) -> (StatusCode, Json<Value>) {
        assert_eq!(
            headers.get(AUTHORIZATION).unwrap(),
            "Bearer integration-key"
        );
        state.requests.lock().unwrap().push(request);
        (
            StatusCode::ACCEPTED,
            Json(json!({
                "id": state.job_id,
                "status": "collecting",
                "cleanupStatus": "not_started",
                "requestedUrl": "https://example.com",
                "stats": {"elapsedMs": 1, "scrollRounds": 0, "matchedItems": 0, "htmlBytes": 0}
            })),
        )
    }

    async fn get_job(
        State(state): State<MockState>,
        Path(id): Path<Uuid>,
        headers: HeaderMap,
    ) -> Json<Value> {
        assert_eq!(id, state.job_id);
        assert_eq!(
            headers.get(AUTHORIZATION).unwrap(),
            "Bearer integration-key"
        );
        *state.polls.lock().unwrap() += 1;
        Json(json!({
            "id": state.job_id,
            "status": "completed",
            "cleanupStatus": "closed",
            "requestedUrl": "https://example.com",
            "finalUrl": "https://example.com/final",
            "title": "Example: page",
            "markdown": "# Extracted\n\nBody",
            "stats": {"elapsedMs": 10, "scrollRounds": 1, "matchedItems": 1, "htmlBytes": 100}
        }))
    }

    async fn reject_job() -> (StatusCode, Json<Value>) {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "code": "selector_invalid",
                    "message": "invalid selector",
                    "retryable": false
                }
            })),
        )
    }

    #[tokio::test]
    async fn client_submits_polls_and_returns_completed_output() {
        let state = MockState {
            requests: Arc::new(Mutex::new(Vec::new())),
            polls: Arc::new(Mutex::new(0)),
            job_id: Uuid::new_v4(),
        };
        let app = Router::new()
            .route("/v1/extractions", post(create_job))
            .route("/v1/extractions/{id}", get(get_job))
            .with_state(state.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let cli = Cli::try_parse_from([
            "scrape",
            "--url",
            "https://example.com",
            "--output",
            "page",
            "--include-tag",
            "article",
            "--include-tag",
            "nav",
            "--exclude-tag",
            "nav",
            "--exclude-tag",
            ".custom",
        ])
        .unwrap();
        let resolved = cli.resolve().unwrap();
        let base_url = Url::parse(&format!("http://{address}/")).unwrap();
        let client = ExtractorClient::new(
            base_url,
            "integration-key".to_owned(),
            Duration::from_secs(5),
            true,
        )
        .unwrap()
        .with_poll_interval(Duration::ZERO);

        let extraction = client.extract(&resolved.request).await.unwrap();
        let rendered = output::render(&extraction).unwrap();
        assert!(rendered.starts_with(
            "---\nname: \"Example: page\"\nurl: \"https://example.com/final\"\n---\n\n"
        ));
        assert_eq!(*state.polls.lock().unwrap(), 1);

        let requests = state.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["mode"], "feed");
        assert_eq!(requests[0]["scroll"], json!({"enabled": true}));
        assert_eq!(requests[0]["includeSelectors"], json!(["article", "nav"]));
        assert!(!requests[0]["excludeSelectors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|selector| selector == "nav"));

        server.abort();
    }

    #[tokio::test]
    async fn api_failure_does_not_create_the_output_file() {
        let app = Router::new().route("/v1/extractions", post(reject_job));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let directory = tempfile::tempdir().unwrap();
        let cli = Cli::try_parse_from([
            "scrape",
            "--url",
            "https://example.com",
            "--output",
            "failed-page",
            "--path",
            directory.path().to_str().unwrap(),
        ])
        .unwrap();

        let error = super::execute_with_environment(
            cli,
            Environment {
                base_url: Some(format!("http://{address}")),
                api_key: Some("integration-key".to_owned()),
            },
        )
        .await
        .unwrap_err();

        assert_eq!(error.exit_code(), 1);
        assert!(error.to_string().contains("selector_invalid"));
        assert!(!directory.path().join("failed-page.md").exists());
        server.abort();
    }

    #[test]
    fn environment_requires_api_key_and_normalizes_base_url() {
        let missing = Environment {
            base_url: None,
            api_key: None,
        }
        .resolve()
        .unwrap_err();
        assert_eq!(missing.exit_code(), 2);

        let resolved = Environment {
            base_url: Some("https://localhost:17320/base".to_owned()),
            api_key: Some(" key ".to_owned()),
        }
        .resolve()
        .unwrap();
        assert_eq!(resolved.base_url.as_str(), "https://localhost:17320/base/");
        assert_eq!(resolved.api_key, "key");
    }
}

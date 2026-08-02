use std::time::Duration;

use reqwest::{Response, StatusCode};
use url::Url;

use crate::{
    error::CliError,
    model::{ErrorEnvelope, ExtractionRequest, ExtractionResponse, JobStatus},
};

const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(500);

pub(crate) struct ExtractorClient {
    base_url: Url,
    api_key: String,
    http: reqwest::Client,
    poll_interval: Duration,
}

impl ExtractorClient {
    pub fn new(
        base_url: Url,
        api_key: String,
        timeout: Duration,
        verify_ssl: bool,
    ) -> Result<Self, CliError> {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .danger_accept_invalid_certs(!verify_ssl)
            .no_proxy()
            .user_agent(concat!("browser-extractor/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| {
                CliError::runtime(format!("failed to initialize HTTP client: {error}"))
            })?;

        Ok(Self {
            base_url,
            api_key,
            http,
            poll_interval: DEFAULT_POLL_INTERVAL,
        })
    }

    #[cfg(test)]
    pub fn with_poll_interval(mut self, interval: Duration) -> Self {
        self.poll_interval = interval;
        self
    }

    pub async fn extract(
        &self,
        request: &ExtractionRequest,
    ) -> Result<ExtractionResponse, CliError> {
        let endpoint = self.endpoint("v1/extractions")?;
        let mut extraction = self
            .parse_response(
                self.http
                    .post(endpoint)
                    .bearer_auth(&self.api_key)
                    .json(request)
                    .send()
                    .await
                    .map_err(|error| request_error("submit extraction", error))?,
            )
            .await?;

        while !extraction.status.is_terminal() {
            tokio::time::sleep(self.poll_interval).await;
            let endpoint = self.endpoint(&format!("v1/extractions/{}", extraction.id))?;
            extraction = self
                .parse_response(
                    self.http
                        .get(endpoint)
                        .bearer_auth(&self.api_key)
                        .send()
                        .await
                        .map_err(|error| request_error("poll extraction", error))?,
                )
                .await?;
        }

        if extraction.status == JobStatus::Completed {
            Ok(extraction)
        } else {
            let reason = extraction.error.as_ref().map_or_else(
                || format!("extraction ended with status {:?}", extraction.status),
                |error| format!("{}: {}", error.code, error.message),
            );
            Err(CliError::runtime(reason))
        }
    }

    async fn parse_response(&self, response: Response) -> Result<ExtractionResponse, CliError> {
        let status = response.status();
        let body = response.bytes().await.map_err(|error| {
            CliError::runtime(format!("failed to read API response body: {error}"))
        })?;

        if !status.is_success() {
            if let Ok(envelope) = serde_json::from_slice::<ErrorEnvelope>(&body) {
                return Err(CliError::runtime(format!(
                    "API returned {} ({}): {}",
                    status.as_u16(),
                    envelope.error.code,
                    envelope.error.message
                )));
            }
            let reason = String::from_utf8_lossy(&body);
            let reason = reason.trim();
            return Err(CliError::runtime(if reason.is_empty() {
                format!("API returned HTTP {}", status.as_u16())
            } else {
                format!("API returned HTTP {}: {reason}", status.as_u16())
            }));
        }

        if status != StatusCode::OK && status != StatusCode::ACCEPTED {
            return Err(CliError::runtime(format!(
                "API returned unexpected success status {}",
                status.as_u16()
            )));
        }

        serde_json::from_slice(&body)
            .map_err(|error| CliError::runtime(format!("API response is invalid JSON: {error}")))
    }

    fn endpoint(&self, path: &str) -> Result<Url, CliError> {
        self.base_url.join(path).map_err(|error| {
            CliError::usage(format!(
                "EXTRACTOR_BASE_URL cannot be joined with API path: {error}"
            ))
        })
    }
}

fn request_error(action: &str, error: reqwest::Error) -> CliError {
    if error.is_timeout() {
        CliError::runtime(format!("failed to {action}: request timed out"))
    } else {
        CliError::runtime(format!("failed to {action}: {error}"))
    }
}

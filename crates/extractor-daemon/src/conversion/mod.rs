pub mod htmd_renderer;
pub mod normalizer;

use std::sync::Arc;

use scraper::Html;
use tokio::sync::Semaphore;
use url::Url;

use crate::{
    capture::CaptureOutput,
    config::Config,
    model::errors::{ErrorCode, ErrorDetail},
};

use self::{
    htmd_renderer::{HtmdRenderer, MarkdownRenderer},
    normalizer::HtmlNormalizer,
};

#[derive(Debug, Clone)]
pub struct ConversionResult {
    pub markdown: String,
    pub normalized_html: String,
}

pub struct ConversionService {
    semaphore: Arc<Semaphore>,
}

impl ConversionService {
    pub fn new(config: Arc<Config>) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(config.executor.max_conversion_concurrency)),
        }
    }

    pub async fn convert(&self, capture: CaptureOutput) -> Result<ConversionResult, ErrorDetail> {
        let permit = self.semaphore.clone().acquire_owned().await.map_err(|_| {
            ErrorDetail::new(ErrorCode::ConversionFailed, "转换执行器已经关闭", true)
        })?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            convert_sync(capture)
        })
        .await
        .map_err(|error| {
            ErrorDetail::new(
                ErrorCode::ConversionFailed,
                format!("转换任务异常结束: {error}"),
                true,
            )
        })?
    }
}

fn convert_sync(capture: CaptureOutput) -> Result<ConversionResult, ErrorDetail> {
    let mime = capture
        .metadata
        .mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();

    if mime == "text/plain" {
        let text = plain_text(&capture.html);
        return Ok(ConversionResult {
            markdown: text.trim().to_owned(),
            normalized_html: capture.html,
        });
    }

    if mime == "application/json" || mime.ends_with("+json") {
        let text = plain_text(&capture.html);
        let formatted = serde_json::from_str::<serde_json::Value>(&text)
            .and_then(|value| serde_json::to_string_pretty(&value))
            .unwrap_or(text);
        let markdown = formatted
            .lines()
            .map(|line| format!("    {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        return Ok(ConversionResult {
            markdown,
            normalized_html: capture.html,
        });
    }

    if !matches!(mime.as_str(), "text/html" | "application/xhtml+xml" | "")
        && !capture.metadata.mime_type_unknown
    {
        return Err(ErrorDetail::new(
            ErrorCode::UnsupportedContentType,
            format!("不支持的内容类型: {}", capture.metadata.mime_type),
            false,
        ));
    }

    let base_url = Url::parse(&capture.metadata.final_url).map_err(|error| {
        ErrorDetail::new(
            ErrorCode::ConversionFailed,
            format!("最终 URL 无效: {error}"),
            false,
        )
    })?;
    let normalizer = HtmlNormalizer::new();
    let normalized = normalizer.normalize(&capture.html, &base_url)?;
    let markdown = HtmdRenderer.render(&normalized)?;
    Ok(ConversionResult {
        markdown,
        normalized_html: normalized,
    })
}

fn plain_text(html: &str) -> String {
    Html::parse_document(html)
        .root_element()
        .text()
        .collect::<Vec<_>>()
        .join(" ")
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidUrl,
    UnsupportedScheme,
    Unauthorized,
    BrowserUnavailable,
    InstanceConflict,
    QueueFull,
    ProtocolError,
    DebuggerAttachFailed,
    TabCreateFailed,
    TabClosed,
    NavigationFailed,
    LoadTimeout,
    JobTimeout,
    SelectorInvalid,
    SelectorNotFound,
    UnsupportedContentType,
    ExtractionFailed,
    CaptureBackpressure,
    ResultTooLarge,
    ConversionFailed,
    Cancelled,
    CleanupUnconfirmed,
    InternalError,
    ResultExpired,
    NotFound,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetail {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
}

impl ErrorDetail {
    pub fn new(code: ErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }
}

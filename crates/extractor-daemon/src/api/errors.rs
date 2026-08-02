use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

use crate::model::{
    api::ErrorResponse,
    errors::{ErrorCode, ErrorDetail},
};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub detail: ErrorDetail,
}

impl ApiError {
    pub fn new(status: StatusCode, detail: ErrorDetail) -> Self {
        Self { status, detail }
    }

    pub fn from_detail(detail: ErrorDetail) -> Self {
        let status = match detail.code {
            ErrorCode::Unauthorized => StatusCode::UNAUTHORIZED,
            ErrorCode::QueueFull => StatusCode::TOO_MANY_REQUESTS,
            ErrorCode::BrowserUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::NotFound | ErrorCode::ResultExpired => StatusCode::NOT_FOUND,
            ErrorCode::InternalError => StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCode::InvalidUrl
            | ErrorCode::UnsupportedScheme
            | ErrorCode::SelectorInvalid
            | ErrorCode::ProtocolError => StatusCode::BAD_REQUEST,
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        };
        Self { status, detail }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(ErrorResponse { error: self.detail })).into_response()
    }
}

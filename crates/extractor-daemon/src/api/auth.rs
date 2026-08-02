use axum::{
    extract::{Request, State},
    http::{header::AUTHORIZATION, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};

use crate::{
    model::{
        api::ErrorResponse,
        errors::{ErrorCode, ErrorDetail},
    },
    AppState,
};

pub async fn require_bearer(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let expected = format!("Bearer {}", state.config.server.api_token);
    let authorized = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| constant_time_eq(value.as_bytes(), expected.as_bytes()))
        .unwrap_or(false);

    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: ErrorDetail::new(
                    ErrorCode::Unauthorized,
                    "缺少或提供了无效的 Bearer token",
                    false,
                ),
            }),
        )
            .into_response();
    }
    next.run(request).await
}

pub(crate) fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

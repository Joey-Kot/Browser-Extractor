use std::time::Duration;

use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        HeaderMap, HeaderName, Method, StatusCode,
    },
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use tower_http::cors::{Any, CorsLayer};
use uuid::Uuid;

use crate::{
    api::{auth::require_bearer, errors::ApiError},
    model::{
        api::{BridgeStatusResponse, ExtractionRequest, HealthResponse},
        errors::{ErrorCode, ErrorDetail},
    },
    AppState,
};

pub fn router(state: AppState) -> Router {
    let allow_cors = state.config.server.allow_cors;
    let protected = Router::new()
        .route("/v1/extractions", post(create_extraction))
        .route(
            "/v1/extractions/{id}",
            get(get_extraction).delete(delete_extraction),
        )
        .route("/v1/bridge/status", get(bridge_status))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_bearer,
        ));

    let router = Router::new()
        .route("/health", get(health))
        .merge(protected)
        .with_state(state);

    if allow_cors {
        router.layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET, Method::POST, Method::DELETE])
                .allow_headers([
                    AUTHORIZATION,
                    CONTENT_TYPE,
                    HeaderName::from_static("idempotency-key"),
                ]),
        )
    } else {
        router
    }
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn create_extraction(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<ExtractionRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(request) = payload.map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ErrorDetail::new(
                ErrorCode::ProtocolError,
                format!("请求 JSON 无效: {}", error.body_text()),
                false,
            ),
        )
    })?;
    request.validate().map_err(ApiError::from_detail)?;

    let idempotency_key = headers
        .get("idempotency-key")
        .map(|value| value.to_str())
        .transpose()
        .map_err(|_| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                ErrorDetail::new(
                    ErrorCode::ProtocolError,
                    "Idempotency-Key 不是有效文本",
                    false,
                ),
            )
        })?;
    if idempotency_key.map(str::len).unwrap_or_default() > 256 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ErrorDetail::new(
                ErrorCode::ProtocolError,
                "Idempotency-Key 不能超过 256 字节",
                false,
            ),
        ));
    }

    let wait_ms = request
        .wait_ms
        .min(request.job_timeout_ms)
        .min(state.config.executor.job_timeout_ms);
    let (job, _) = state
        .scheduler
        .enqueue(request, idempotency_key)
        .await
        .map_err(ApiError::from_detail)?;

    if wait_ms > 0 {
        job.wait_done(Duration::from_millis(wait_ms)).await;
    }
    let snapshot = job.snapshot().await;
    let status = if job.is_api_done().await {
        StatusCode::OK
    } else {
        StatusCode::ACCEPTED
    };
    Ok((status, Json(snapshot.view())).into_response())
}

async fn get_extraction(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<crate::model::api::ExtractionView>, ApiError> {
    let job = state.jobs.get(&id).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            ErrorDetail::new(ErrorCode::NotFound, "任务不存在或结果已经过期", false),
        )
    })?;
    Ok(Json(job.snapshot().await.view()))
}

async fn delete_extraction(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<crate::model::api::ExtractionView>, ApiError> {
    let job = state.scheduler.cancel(id).await.ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            ErrorDetail::new(ErrorCode::NotFound, "任务不存在或结果已经过期", false),
        )
    })?;
    Ok(Json(job.snapshot().await.view()))
}

async fn bridge_status(State(state): State<AppState>) -> Json<BridgeStatusResponse> {
    let metadata = state.bridge.metadata().await;
    Json(BridgeStatusResponse {
        extension_connected: metadata.is_some(),
        browser_instance_id: metadata
            .as_ref()
            .map(|value| value.browser_instance_id.clone()),
        extension_version: metadata.map(|value| value.extension_version),
        active_browser_jobs: state.jobs.active_browser_count().await,
        queued_jobs: state.jobs.queued_count().await,
        max_concurrency: state.config.executor.max_concurrency,
        inflight_bytes: state.scheduler.inflight_bytes(),
    })
}

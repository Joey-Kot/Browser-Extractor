use axum::{
    body::Body,
    http::{
        header::{
            ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_ORIGIN,
            ACCESS_CONTROL_REQUEST_HEADERS, ACCESS_CONTROL_REQUEST_METHOD, ORIGIN,
        },
        Method, Request, StatusCode,
    },
};
use extractor_daemon::{api, config::Config, AppState};
use tower::ServiceExt;

#[tokio::test]
async fn health_is_public() {
    let state = AppState::new(test_config());
    let response = api::router(state)
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn protected_route_requires_bearer_token() {
    let state = AppState::new(test_config());
    let response = api::router(state)
        .oneshot(
            Request::builder()
                .uri("/v1/bridge/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn invalid_scheme_is_rejected_before_scheduling() {
    let state = AppState::new(test_config());
    let response = api::router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/extractions")
                .header("authorization", "Bearer test-api-token")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"url":"file:///etc/passwd"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn unknown_request_fields_are_rejected() {
    for body in [
        r#"{"url":"https://example.com","jobTimoutMs":1000}"#,
        r#"{"url":"https://example.com","requireSelectorMatch":true}"#,
        r#"{"url":"https://example.com","scroll":{"enabled":false,"unknown":true}}"#,
        r#"{"url":"https://example.com","traversal":{"iframes":{"enabled":true,"unknown":1}}}"#,
    ] {
        let state = AppState::new(test_config());
        let response = api::router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/extractions")
                    .header("authorization", "Bearer test-api-token")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn cors_preflight_is_allowed_by_default() {
    let config = test_config();
    assert!(config.server.allow_cors);

    let state = AppState::new(config);
    let response = api::router(state)
        .oneshot(
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/v1/extractions")
                .header(ORIGIN, "https://client.example")
                .header(ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(
                    ACCESS_CONTROL_REQUEST_HEADERS,
                    "authorization,content-type,idempotency-key",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    let allowed_headers = response.headers()[ACCESS_CONTROL_ALLOW_HEADERS]
        .to_str()
        .unwrap();
    assert!(allowed_headers.contains("authorization"));
    assert!(allowed_headers.contains("content-type"));
    assert!(allowed_headers.contains("idempotency-key"));
}

#[tokio::test]
async fn cors_can_be_disabled() {
    let mut config = test_config();
    config.server.allow_cors = false;

    let state = AppState::new(config);
    let response = api::router(state)
        .oneshot(
            Request::builder()
                .uri("/health")
                .header(ORIGIN, "https://client.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(ACCESS_CONTROL_ALLOW_ORIGIN));
}

fn test_config() -> Config {
    let mut config = Config::default();
    config.server.api_token = "test-api-token".into();
    config.bridge.extension_token = "test-extension-token".into();
    config
}

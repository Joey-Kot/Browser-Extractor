use std::sync::Arc;

use extractor_daemon::{
    jobs::JobRecord,
    model::api::{CleanupStatus, ExtractionRequest, JobStatus},
    model::capture::{CaptureMetadata, CaptureType},
    model::errors::{ErrorCode, ErrorDetail},
};
use tokio::sync::Semaphore;

#[tokio::test]
async fn queued_cancellation_finishes_without_cleanup_lease() {
    let request: ExtractionRequest =
        serde_json::from_str(r#"{"url":"https://example.com"}"#).unwrap();
    let job = JobRecord::new(request);
    job.mark_cancelled(false).await;
    let snapshot = job.snapshot().await;
    assert_eq!(snapshot.status, JobStatus::Cancelled);
    assert_eq!(snapshot.cleanup_status, CleanupStatus::Closed);
    assert!(job.is_api_done().await);
}

#[tokio::test]
async fn browser_permit_is_held_until_explicit_release() {
    let request: ExtractionRequest =
        serde_json::from_str(r#"{"url":"https://example.com"}"#).unwrap();
    let job = JobRecord::new(request);
    let semaphore = Arc::new(Semaphore::new(1));
    let permit = semaphore.clone().acquire_owned().await.unwrap();
    job.set_permit(permit).await;
    assert_eq!(semaphore.available_permits(), 0);
    job.release_permit().await;
    assert_eq!(semaphore.available_permits(), 1);
}

#[tokio::test]
async fn late_capture_and_conversion_do_not_resurrect_cancelled_job() {
    let request: ExtractionRequest =
        serde_json::from_str(r#"{"url":"https://example.com"}"#).unwrap();
    let job = JobRecord::new(request);
    let metadata = CaptureMetadata {
        capture_type: CaptureType::Document,
        selection_applied: true,
        final_url: "https://example.com".into(),
        title: "Example".into(),
        mime_type: "text/html".into(),
        mime_type_unknown: false,
    };

    job.mark_cancelled(true).await;
    assert!(
        !job.mark_capture_complete(&metadata, 10, 0, 0, Vec::new())
            .await
    );
    job.finish_conversion("ignored".into(), None).await;
    job.mark_closed().await;

    let snapshot = job.snapshot().await;
    assert_eq!(snapshot.status, JobStatus::Cancelled);
    assert!(snapshot.markdown.is_none());
    assert!(job.is_api_done().await);

    let second_request: ExtractionRequest =
        serde_json::from_str(r#"{"url":"https://example.com"}"#).unwrap();
    let second = JobRecord::new(second_request);
    assert!(
        second
            .mark_capture_complete(&metadata, 10, 0, 0, Vec::new())
            .await
    );
    second.mark_cancelled(true).await;
    second.finish_conversion("ignored".into(), None).await;
    second.mark_closed().await;
    assert_eq!(second.snapshot().await.status, JobStatus::Cancelled);
    assert!(second.is_api_done().await);
}

#[tokio::test]
async fn late_failure_does_not_mutate_terminal_job() {
    let request: ExtractionRequest =
        serde_json::from_str(r#"{"url":"https://example.com"}"#).unwrap();
    let job = JobRecord::new(request);
    job.mark_cancelled(false).await;
    job.mark_failed(
        ErrorDetail::new(ErrorCode::ConversionFailed, "late failure", true),
        false,
    )
    .await;

    let snapshot = job.snapshot().await;
    assert_eq!(snapshot.status, JobStatus::Cancelled);
    assert_eq!(snapshot.error.unwrap().code, ErrorCode::Cancelled);
}

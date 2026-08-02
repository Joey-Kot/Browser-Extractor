use std::sync::Arc;

use extractor_daemon::{
    capture::CaptureOutput,
    config::Config,
    conversion::ConversionService,
    model::capture::{CaptureMetadata, CaptureType},
};

#[tokio::test]
async fn selected_document_is_normalized_and_rendered() {
    let service = ConversionService::new(Arc::new(Config::default()));
    let output = CaptureOutput {
        metadata: CaptureMetadata {
            capture_type: CaptureType::Document,
            selection_applied: true,
            final_url: "https://example.com/base/page".into(),
            title: "Example".into(),
            mime_type: "text/html".into(),
            mime_type_unknown: false,
        },
        html: r#"<main><h1>Title</h1><a href="../next">Next</a><script>bad()</script></main>"#
            .into(),
        raw_bytes: 90,
        chunks: 1,
        scroll_rounds: 0,
        matched_items: 0,
        warnings: Vec::new(),
    };
    let result = service.convert(output).await.unwrap();
    assert!(result.markdown.contains("# Title"));
    assert!(result.markdown.contains("https://example.com/next"));
    assert!(!result.markdown.contains("bad()"));
}

#[tokio::test]
async fn html_tables_are_rendered_as_markdown_tables() {
    let service = ConversionService::new(Arc::new(Config::default()));
    let html = r#"
        <table>
          <thead><tr><th>Name</th><th>Score</th></tr></thead>
          <tbody>
            <tr><td>Alice</td><td>95</td></tr>
            <tr><td>Bob</td><td>88</td></tr>
          </tbody>
        </table>
    "#;
    let output = CaptureOutput {
        metadata: CaptureMetadata {
            capture_type: CaptureType::Document,
            selection_applied: false,
            final_url: "https://example.com/page".into(),
            title: "Example".into(),
            mime_type: "text/html".into(),
            mime_type_unknown: false,
        },
        html: html.into(),
        raw_bytes: html.len() as u64,
        chunks: 1,
        scroll_rounds: 0,
        matched_items: 0,
        warnings: Vec::new(),
    };

    let result = service.convert(output).await.unwrap();
    let lines = result.markdown.lines().collect::<Vec<_>>();
    assert!(lines
        .iter()
        .any(|line| line.starts_with("| Name") && line.contains("| Score")));
    assert!(lines.iter().any(|line| line.contains("---")));
    assert!(lines
        .iter()
        .any(|line| line.starts_with("| Alice") && line.contains("| 95")));
}

#[tokio::test]
async fn document_conversion_does_not_apply_implicit_content_filtering() {
    let service = ConversionService::new(Arc::new(Config::default()));
    let html = r#"
        <body>
          <nav><a href="/home">Global navigation</a></nav>
          <article><h1>Article</h1><p>Article body.</p></article>
          <aside>Related links</aside>
        </body>
    "#;
    let output = CaptureOutput {
        metadata: CaptureMetadata {
            capture_type: CaptureType::Document,
            selection_applied: false,
            final_url: "https://example.com/page".into(),
            title: "Example".into(),
            mime_type: "text/html".into(),
            mime_type_unknown: false,
        },
        html: html.into(),
        raw_bytes: html.len() as u64,
        chunks: 1,
        scroll_rounds: 0,
        matched_items: 0,
        warnings: Vec::new(),
    };

    let result = service.convert(output).await.unwrap();
    assert!(result.markdown.contains("Global navigation"));
    assert!(result.markdown.contains("Article body."));
    assert!(result.markdown.contains("Related links"));
}

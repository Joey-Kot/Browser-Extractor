use std::path::PathBuf;

use clap::Parser;
use url::Url;

use crate::{
    error::CliError,
    model::{
        ExtractionMode, ExtractionRequest, ScrollOptions, TraversalOptions, TraversalTargetOptions,
    },
    selectors::resolve_selectors,
};

const AFTER_HELP: &str = r#"CSS selector options:
  --include-tag and --exclude-tag may be repeated.
  Each occurrence accepts one complete CSS selector. Values are trimmed and
  deduplicated; commas remain part of CSS and JSON arrays are not parsed.

  Quote each selector with single quotes in Bash and PowerShell:
    --include-tag 'article' --include-tag '.article'
    --exclude-tag '.content' --exclude-tag '.ad'

  Supported CSS includes type, class, ID, and attribute selectors:
    'xxx' '.xxx' '#xxx' 'xxx[xxx*="xxx"]'
    '[xxx*="xxx"]' '[xxx^="xxx"]' '[xxx$="xxx"]'

  Plural aliases: --include-tags, --exclude-tags.

Environment:
  EXTRACTOR_BASE_URL  Browser Extractor server API base URL.
                      Optional. Default: http://127.0.0.1:17320

  EXTRACTOR_API_KEY   Browser Extractor server API key.
                      Required. Sent as: Authorization: Bearer <key>

Example:
  EXTRACTOR_BASE_URL=http://127.0.0.1:17320 \
  EXTRACTOR_API_KEY=your-api-key \
  scrape --url https://example.com --output example \
    --include-tag 'article'"#;

#[derive(Debug, Clone, Parser)]
#[command(
    name = "scrape",
    about = "Extract a webpage through a running Browser Extractor server",
    disable_version_flag = true,
    after_help = AFTER_HELP
)]
pub struct Cli {
    /// Target HTTP or HTTPS URL.
    #[arg(long, value_name = "URL")]
    pub url: String,

    /// Output file name. A .md suffix is added when omitted.
    #[arg(long, value_name = "NAME")]
    pub output: String,

    /// Output directory. Supports relative and absolute paths.
    #[arg(long, value_name = "PATH", default_value = ".")]
    pub path: PathBuf,

    /// Extraction mode.
    #[arg(long, value_enum, default_value_t = ExtractionMode::Feed)]
    pub mode: ExtractionMode,

    /// CSS selector to include. Repeat this option for multiple selectors.
    #[arg(
        long = "include-tag",
        visible_alias = "include-tags",
        value_name = "SELECTOR"
    )]
    pub include_tags: Vec<String>,

    /// Additional CSS selector to exclude. Repeat this option for multiple selectors.
    #[arg(
        long = "exclude-tag",
        visible_alias = "exclude-tags",
        value_name = "SELECTOR"
    )]
    pub exclude_tags: Vec<String>,

    /// Clear the built-in exclude selector list while keeping --exclude-tag values.
    #[arg(long)]
    pub empty_tags: bool,

    /// Maximum scroll distance per automatically detected container, in pixels.
    #[arg(long = "scroll-px", value_name = "PIXELS")]
    pub max_scroll_px: Option<u32>,

    /// Timeout for each CLI HTTP request, in seconds.
    #[arg(long, value_name = "SECONDS", default_value_t = 120)]
    pub timeout: u64,

    /// Server-side extraction job timeout, in seconds.
    #[arg(long, value_name = "SECONDS")]
    pub scrape_timeout: Option<u64>,

    /// Enable Shadow DOM traversal with the given maximum depth.
    #[arg(long, value_name = "DEPTH")]
    pub shadow_dom: Option<u32>,

    /// Enable iframe traversal with the given maximum depth.
    #[arg(long, value_name = "DEPTH")]
    pub iframes: Option<u32>,

    /// Verify the TLS certificate of EXTRACTOR_BASE_URL. Default: false.
    #[arg(long)]
    pub verify_ssl: bool,
}

impl Cli {
    pub(crate) fn resolve(&self) -> Result<ResolvedCli, CliError> {
        validate_positive(self.timeout, "--timeout")?;
        if let Some(timeout) = self.scrape_timeout {
            validate_positive(timeout, "--scrape-timeout")?;
        }
        if let Some(depth) = self.shadow_dom {
            validate_positive(depth, "--shadow-dom")?;
        }
        if let Some(depth) = self.iframes {
            validate_positive(depth, "--iframes")?;
        }
        if let Some(distance) = self.max_scroll_px {
            validate_positive(distance, "--scroll-px")?;
        }

        let url = Url::parse(self.url.trim())
            .map_err(|error| CliError::usage(format!("--url is invalid: {error}")))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(CliError::usage("--url must use http or https"));
        }

        let selectors = resolve_selectors(&self.include_tags, &self.exclude_tags, self.empty_tags);
        let scrolling = self.mode == ExtractionMode::Feed || self.max_scroll_px.is_some();
        let scroll = scrolling.then_some(ScrollOptions {
            enabled: true,
            max_distance_px: self.max_scroll_px,
        });

        let traversal =
            (self.shadow_dom.is_some() || self.iframes.is_some()).then(|| TraversalOptions {
                shadow_dom: self.shadow_dom.map(|max_depth| TraversalTargetOptions {
                    enabled: true,
                    max_depth,
                }),
                iframes: self.iframes.map(|max_depth| TraversalTargetOptions {
                    enabled: true,
                    max_depth,
                }),
            });

        let job_timeout_ms = self
            .scrape_timeout
            .map(|seconds| {
                seconds.checked_mul(1_000).ok_or_else(|| {
                    CliError::usage("--scrape-timeout is too large to convert to milliseconds")
                })
            })
            .transpose()?;

        Ok(ResolvedCli {
            request: ExtractionRequest {
                url: url.into(),
                mode: self.mode,
                wait_ms: 0,
                job_timeout_ms,
                include_selectors: (!selectors.include.is_empty()).then_some(selectors.include),
                exclude_selectors: selectors.exclude,
                traversal,
                scroll,
            },
            output: self.output.clone(),
            output_directory: self.path.clone(),
            timeout_seconds: self.timeout,
            verify_ssl: self.verify_ssl,
        })
    }
}

fn validate_positive<T>(value: T, option: &str) -> Result<(), CliError>
where
    T: PartialEq + Default,
{
    if value == T::default() {
        Err(CliError::usage(format!("{option} must be greater than 0")))
    } else {
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct ResolvedCli {
    pub request: ExtractionRequest,
    pub output: String,
    pub output_directory: PathBuf,
    pub timeout_seconds: u64,
    pub verify_ssl: bool,
}

#[cfg(test)]
mod tests {
    use clap::{CommandFactory, Parser};
    use serde_json::json;

    use super::Cli;

    fn request_json(arguments: &[&str]) -> serde_json::Value {
        let cli = Cli::try_parse_from(
            ["scrape", "--url", "https://example.com", "--output", "page"]
                .into_iter()
                .chain(arguments.iter().copied()),
        )
        .unwrap();
        serde_json::to_value(cli.resolve().unwrap().request).unwrap()
    }

    #[test]
    fn help_explains_repeatable_selector_options_and_shell_quoting() {
        let mut command = Cli::command();
        let help = command.render_long_help().to_string();

        for expected in [
            "Usage: scrape",
            "Extract a webpage through a running Browser Extractor server",
            "CSS selector options:",
            "--include-tag and --exclude-tag may be repeated.",
            "Each occurrence accepts one complete CSS selector.",
            "Quote each selector with single quotes in Bash and PowerShell:",
            "'[xxx*=\"xxx\"]' '[xxx^=\"xxx\"]' '[xxx$=\"xxx\"]'",
            "Plural aliases: --include-tags, --exclude-tags.",
            "Browser Extractor server API base URL.",
            "Browser Extractor server API key.",
            "Maximum scroll distance per automatically detected container",
            "scrape --url https://example.com --output example",
        ] {
            assert!(help.contains(expected), "missing help text: {expected}");
        }
        assert!(!help.contains("browser-extractor"));
        assert!(!help.contains("--scroll-tag"));
    }

    #[test]
    fn default_mode_is_feed_and_enables_default_scroll() {
        let request = request_json(&[]);
        assert_eq!(request["mode"], "feed");
        assert_eq!(request["waitMs"], 0);
        assert_eq!(request["scroll"], json!({ "enabled": true }));
        assert!(request.get("includeSelectors").is_none());
    }

    #[test]
    fn document_mode_only_scrolls_when_a_scroll_option_is_present() {
        let without_scroll = request_json(&["--mode", "document"]);
        assert!(without_scroll.get("scroll").is_none());

        let with_scroll = request_json(&["--mode", "document", "--scroll-px", "900"]);
        assert_eq!(
            with_scroll["scroll"],
            json!({
                "enabled": true,
                "maxDistancePx": 900
            })
        );
    }

    #[test]
    fn maps_traversal_depths_and_scrape_timeout() {
        let request = request_json(&[
            "--shadow-dom",
            "4",
            "--iframes",
            "2",
            "--scrape-timeout",
            "180",
        ]);
        assert_eq!(request["jobTimeoutMs"], 180_000);
        assert_eq!(
            request["traversal"],
            json!({
                "shadowDom": { "enabled": true, "maxDepth": 4 },
                "iframes": { "enabled": true, "maxDepth": 2 }
            })
        );
    }

    #[test]
    fn generated_requests_match_the_daemon_contract() {
        for arguments in [
            Vec::<&str>::new(),
            vec!["--mode", "document"],
            vec!["--mode", "document", "--scroll-px", "900"],
            vec!["--shadow-dom", "4", "--iframes", "2"],
            vec!["--include-tag", "article", "--empty-tags"],
        ] {
            let request = request_json(&arguments);
            let request =
                serde_json::from_value::<extractor_daemon::model::api::ExtractionRequest>(request)
                    .unwrap();
            request.validate().unwrap();
        }
    }

    #[test]
    fn repeated_selector_options_preserve_complete_css_selectors() {
        let request = request_json(&[
            "--include-tag",
            "xxx",
            "--include-tag",
            ".xxx",
            "--include-tag",
            "#xxx",
            "--include-tag",
            r#"xxx[xxx*="xxx"]"#,
            "--include-tag",
            r#"[xxx*="xxx"]"#,
            "--include-tag",
            r#"[xxx^="xxx"]"#,
            "--include-tag",
            r#"[xxx$="xxx"]"#,
            "--exclude-tag",
            ".content",
            "--exclude-tag",
            ".ad",
            "--empty-tags",
        ]);

        assert_eq!(
            request["includeSelectors"],
            json!([
                "xxx",
                ".xxx",
                "#xxx",
                r#"xxx[xxx*="xxx"]"#,
                r#"[xxx*="xxx"]"#,
                r#"[xxx^="xxx"]"#,
                r#"[xxx$="xxx"]"#,
            ])
        );
        assert_eq!(request["excludeSelectors"], json!([".content", ".ad"]));
        assert_eq!(request["scroll"], json!({ "enabled": true }));
    }

    #[test]
    fn plural_aliases_are_repeatable_and_use_the_same_semantics() {
        let request = request_json(&[
            "--include-tags",
            "article:has(h1, h2)",
            "--include-tags",
            ".article,.content",
            "--exclude-tags",
            ".ad",
            "--empty-tags",
        ]);

        assert_eq!(
            request["includeSelectors"],
            json!(["article:has(h1, h2)", ".article,.content"])
        );
        assert_eq!(request["excludeSelectors"], json!([".ad"]));
    }

    #[test]
    fn selector_combinations_follow_include_exclude_and_builtin_priority() {
        struct Case<'a> {
            arguments: &'a [&'a str],
            include: Option<serde_json::Value>,
            contains_builtin_nav: bool,
            contains_explicit_custom: bool,
        }

        let cases = [
            Case {
                arguments: &[],
                include: None,
                contains_builtin_nav: true,
                contains_explicit_custom: false,
            },
            Case {
                arguments: &["--include-tag", "article"],
                include: Some(json!(["article"])),
                contains_builtin_nav: true,
                contains_explicit_custom: false,
            },
            Case {
                arguments: &["--exclude-tag", ".custom"],
                include: None,
                contains_builtin_nav: true,
                contains_explicit_custom: true,
            },
            Case {
                arguments: &["--empty-tags"],
                include: None,
                contains_builtin_nav: false,
                contains_explicit_custom: false,
            },
            Case {
                arguments: &["--include-tag", "article", "--exclude-tag", ".custom"],
                include: Some(json!(["article"])),
                contains_builtin_nav: true,
                contains_explicit_custom: true,
            },
            Case {
                arguments: &["--include-tag", "article", "--empty-tags"],
                include: Some(json!(["article"])),
                contains_builtin_nav: false,
                contains_explicit_custom: false,
            },
            Case {
                arguments: &["--exclude-tag", ".custom", "--empty-tags"],
                include: None,
                contains_builtin_nav: false,
                contains_explicit_custom: true,
            },
            Case {
                arguments: &[
                    "--include-tag",
                    "article",
                    "--exclude-tag",
                    ".custom",
                    "--empty-tags",
                ],
                include: Some(json!(["article"])),
                contains_builtin_nav: false,
                contains_explicit_custom: true,
            },
        ];

        for case in cases {
            let request = request_json(case.arguments);
            assert_eq!(request.get("includeSelectors").cloned(), case.include);
            let exclude = request["excludeSelectors"].as_array().unwrap();
            assert_eq!(
                exclude.iter().any(|selector| selector == "nav"),
                case.contains_builtin_nav
            );
            assert_eq!(
                exclude.iter().any(|selector| selector == ".custom"),
                case.contains_explicit_custom
            );
        }

        let include_wins = request_json(&[
            "--include-tag",
            "nav",
            "--include-tag",
            ".custom",
            "--exclude-tag",
            "nav",
            "--exclude-tag",
            ".custom",
        ]);
        let exclude = include_wins["excludeSelectors"].as_array().unwrap();
        assert!(!exclude.iter().any(|selector| selector == "nav"));
        assert!(!exclude.iter().any(|selector| selector == ".custom"));
    }

    #[test]
    fn rejects_zero_values_and_removed_scroll_selector_option() {
        let cli = Cli::try_parse_from([
            "scrape",
            "--url",
            "https://example.com",
            "--output",
            "page",
            "--timeout",
            "0",
        ])
        .unwrap();
        assert!(cli.resolve().unwrap_err().to_string().contains("--timeout"));

        let cli = Cli::try_parse_from([
            "scrape",
            "--url",
            "https://example.com",
            "--output",
            "page",
            "--scroll-px",
            "0",
        ])
        .unwrap();
        assert!(cli
            .resolve()
            .unwrap_err()
            .to_string()
            .contains("--scroll-px"));

        for removed in ["--scroll-tag", "--scroll-tags"] {
            assert!(Cli::try_parse_from([
                "scrape",
                "--url",
                "https://example.com",
                "--output",
                "page",
                removed,
                "article",
            ])
            .is_err());
        }
    }
}

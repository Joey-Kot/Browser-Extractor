use scraper::{Html, Node};
use url::Url;

use crate::model::errors::{ErrorCode, ErrorDetail};

const REMOVED_ELEMENTS: &[&str] = &["script", "style", "noscript", "template"];
const URL_ATTRIBUTES: &[&str] = &["href", "src", "poster", "action", "formaction"];

#[derive(Default)]
pub struct HtmlNormalizer;

impl HtmlNormalizer {
    pub fn new() -> Self {
        Self
    }

    pub fn normalize(&self, html: &str, base_url: &Url) -> Result<String, ErrorDetail> {
        let mut document = Html::parse_document(html);
        let removed = document
            .tree
            .nodes()
            .filter_map(|node| {
                let element = node.value().as_element()?;
                REMOVED_ELEMENTS
                    .contains(&element.name())
                    .then_some(node.id())
            })
            .collect::<Vec<_>>();

        for id in removed {
            if let Some(mut node) = document.tree.get_mut(id) {
                node.detach();
            }
        }

        let element_ids = document
            .tree
            .nodes()
            .filter(|node| node.value().is_element())
            .map(|node| node.id())
            .collect::<Vec<_>>();
        for id in element_ids {
            let Some(mut node) = document.tree.get_mut(id) else {
                continue;
            };
            let Node::Element(element) = node.value() else {
                continue;
            };
            element
                .attrs
                .retain(|(name, _)| !name.local.as_ref().to_ascii_lowercase().starts_with("on"));
            for (name, value) in &mut element.attrs {
                if URL_ATTRIBUTES.contains(&name.local.as_ref()) {
                    *value = normalize_url(value.as_ref(), base_url).into();
                }
            }
        }

        let rewritten = document.html();
        if rewritten.len() > 128 * 1024 * 1024 {
            return Err(ErrorDetail::new(
                ErrorCode::ConversionFailed,
                "规范化后的 HTML 过大",
                false,
            ));
        }

        Ok(rewritten)
    }
}

fn normalize_url(value: &str, base_url: &Url) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return trimmed.to_owned();
    }

    if let Ok(url) = Url::parse(trimmed) {
        return normalize_parsed_url(url, trimmed);
    }

    base_url
        .join(trimmed)
        .map(|url| normalize_parsed_url(url, trimmed))
        .unwrap_or_else(|_| trimmed.to_owned())
}

fn normalize_parsed_url(url: Url, original: &str) -> String {
    match url.scheme() {
        "javascript" | "vbscript" => "#".to_owned(),
        "data" | "mailto" | "tel" => original.to_owned(),
        _ => url.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_scripts_and_absolutizes_links() {
        let input = r#"<main onclick="bad()"><a href="/post">Post</a><script>x()</script></main>"#;
        let output = HtmlNormalizer::new()
            .normalize(input, &Url::parse("https://example.com/base").unwrap())
            .unwrap();
        assert!(!output.contains("onclick"));
        assert!(!output.contains("<script"));
        assert!(output.contains("https://example.com/post"));
    }

    #[test]
    fn rewrites_unquoted_links_and_blocks_mixed_case_javascript() {
        let input =
            r#"<main><a href=/next>Next</a><a href='JaVaScRiPt&#58;alert(1)'>Bad</a></main>"#;
        let output = HtmlNormalizer::new()
            .normalize(input, &Url::parse("https://example.com/base").unwrap())
            .unwrap();
        assert!(output.contains("href=\"https://example.com/next\""));
        assert!(output.contains("href=\"#\""));
        assert!(!output.to_ascii_lowercase().contains("javascript:"));
    }
}

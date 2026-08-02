use std::collections::HashSet;

pub(crate) fn normalize_selectors(selectors: &[String]) -> Vec<String> {
    stable_unique(selectors.to_vec())
}

pub(crate) fn resolve_selectors(
    include_raw: &[String],
    exclude_raw: &[String],
    empty_tags: bool,
) -> ResolvedSelectors {
    let include = normalize_selectors(include_raw);
    let explicit_exclude = normalize_selectors(exclude_raw);

    let mut exclude = if empty_tags {
        Vec::new()
    } else {
        default_exclude_selectors()
            .iter()
            .map(|selector| (*selector).to_owned())
            .collect()
    };
    exclude.extend(explicit_exclude);
    exclude = stable_unique(exclude);

    let included: HashSet<&str> = include.iter().map(String::as_str).collect();
    exclude.retain(|selector| !included.contains(selector.as_str()));

    ResolvedSelectors { include, exclude }
}

fn stable_unique(selectors: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::with_capacity(selectors.len());

    for selector in selectors {
        let selector = selector.trim();
        if selector.is_empty() || !seen.insert(selector.to_owned()) {
            continue;
        }
        result.push(selector.to_owned());
    }

    result
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ResolvedSelectors {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
}

pub(crate) fn default_exclude_selectors() -> &'static [&'static str] {
    &[
        "script",
        "style",
        "noscript",
        "form",
        "input",
        "button",
        "select",
        "textarea",
        "nav",
        ".nav",
        ".navbar",
        ".navigation",
        ".menu",
        ".menubar",
        "header",
        "footer",
        "aside",
        r#"[class*="logo"]"#,
        r#"[class*="brand"]"#,
        r#"[id*="logo"]"#,
        r#"img[alt*="logo"]"#,
        r#"img[src*="logo"]"#,
        r#"[id*="brand"]"#,
        r#"[class^="category--"]"#,
        r#"[id^="category--"]"#,
        r#"[class$="--category"]"#,
        r#"[id$="--category"]"#,
        r#"[class^="skip"]"#,
        r#"[class*="accessib"]"#,
        ".sr-only",
        ".visually-hidden",
        r#"[class*="-ad-"]"#,
        r#"[class*="_ad_"]"#,
        r#"[class$="-ad"]"#,
        r#"[class$="_ad"]"#,
        r#"[class^="ad-"]"#,
        r#"[class^="ad_"]"#,
        r#"[class*="advert"]"#,
        ".sidebar",
        "#sidebar",
        r#"[class*="sidebar"]"#,
        r#"[class*="sider"]"#,
        r#"[class^="menu-"]"#,
        r#"[class^="menu_"]"#,
        r#"[class$="_module"]"#,
        r#"[class$="-module"]"#,
        r#"[class*="breadcrumb"]"#,
        r#"[class*="pagination"]"#,
        r#"[class*="relate"]"#,
        r#"[class*="recommend"]"#,
        r#"[class*="trending"]"#,
        r#"[class^="header-"]"#,
        r#"[class$="-header"]"#,
        r#"[class^="header_"]"#,
        r#"[class$="_header"]"#,
        r#"[class*="footer"]"#,
        r#"[class$="-offset"]"#,
        r#"[class*="-offset-"]"#,
        r#"[class$="_offset"]"#,
        r#"[class*="_offset_"]"#,
    ]
}

#[cfg(test)]
mod tests {
    use super::{default_exclude_selectors, normalize_selectors, resolve_selectors};

    fn selectors(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn normalizes_complete_selectors_without_splitting_css_syntax() {
        assert_eq!(
            normalize_selectors(&selectors(&[
                " article ",
                ".content",
                "article",
                "article:has(h1, h2)",
                r#"[class="header"]"#,
            ])),
            [
                "article",
                ".content",
                "article:has(h1, h2)",
                r#"[class="header"]"#,
            ]
        );
    }

    #[test]
    fn include_overrides_explicit_and_builtin_excludes() {
        let resolved = resolve_selectors(
            &selectors(&["article", "nav"]),
            &selectors(&["article", ".advert", "nav"]),
            false,
        );

        assert_eq!(resolved.include, ["article", "nav"]);
        assert!(!resolved
            .exclude
            .iter()
            .any(|selector| selector == "article"));
        assert!(!resolved.exclude.iter().any(|selector| selector == "nav"));
        assert!(resolved
            .exclude
            .iter()
            .any(|selector| selector == ".advert"));
    }

    #[test]
    fn empty_tags_only_clears_builtin_excludes() {
        let resolved = resolve_selectors(&[], &selectors(&["nav", ".custom"]), true);
        assert!(resolved.include.is_empty());
        assert_eq!(resolved.exclude, ["nav", ".custom"]);
    }

    #[test]
    fn explicit_excludes_are_appended_and_deduplicated() {
        let resolved = resolve_selectors(&[], &selectors(&["nav", ".custom", "nav"]), false);
        assert_eq!(
            resolved
                .exclude
                .iter()
                .filter(|selector| selector.as_str() == "nav")
                .count(),
            1
        );
        assert_eq!(resolved.exclude.last().map(String::as_str), Some(".custom"));
        assert_eq!(
            &resolved.exclude[..default_exclude_selectors().len()],
            default_exclude_selectors()
        );
    }
}

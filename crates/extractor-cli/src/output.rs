use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use tempfile::Builder;

use crate::{error::CliError, model::ExtractionResponse};

pub(crate) fn output_path(output: &str, directory: &Path) -> Result<PathBuf, CliError> {
    let output = output.trim();
    if output.is_empty() {
        return Err(CliError::usage("--output must not be empty"));
    }

    let name = Path::new(output)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && *value != "." && *value != "..")
        .ok_or_else(|| CliError::usage("--output must be a valid file name"))?;
    let name = if name.to_ascii_lowercase().ends_with(".md") {
        name.to_owned()
    } else {
        format!("{name}.md")
    };

    Ok(directory.join(name))
}

pub(crate) fn ensure_available(path: &Path) -> Result<(), CliError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(CliError::runtime(format!(
            "output file already exists: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CliError::runtime(format!(
            "failed to inspect output file {}: {error}",
            path.display()
        ))),
    }
}

pub(crate) fn render(extraction: &ExtractionResponse) -> Result<String, CliError> {
    let final_url = extraction
        .final_url
        .as_deref()
        .ok_or_else(|| CliError::runtime("completed extraction response is missing finalUrl"))?;
    let markdown = extraction
        .markdown
        .as_deref()
        .ok_or_else(|| CliError::runtime("completed extraction response is missing markdown"))?;
    let title = extraction.title.as_deref().unwrap_or_default();

    let title = serde_json::to_string(title)
        .map_err(|error| CliError::runtime(format!("failed to encode page title: {error}")))?;
    let final_url = serde_json::to_string(final_url)
        .map_err(|error| CliError::runtime(format!("failed to encode final URL: {error}")))?;

    let mut result = format!("---\nname: {title}\nurl: {final_url}\n---\n\n{markdown}");
    if !result.ends_with('\n') {
        result.push('\n');
    }
    Ok(result)
}

pub(crate) fn write_atomic(path: &Path, content: &str) -> Result<(), CliError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| {
        CliError::runtime(format!(
            "failed to create output directory {}: {error}",
            parent.display()
        ))
    })?;

    let mut temporary = Builder::new()
        .prefix(".browser-extractor-")
        .tempfile_in(parent)
        .map_err(|error| {
            CliError::runtime(format!(
                "failed to create temporary output file in {}: {error}",
                parent.display()
            ))
        })?;
    temporary.write_all(content.as_bytes()).map_err(|error| {
        CliError::runtime(format!(
            "failed to write output file {}: {error}",
            path.display()
        ))
    })?;
    temporary.as_file_mut().sync_all().map_err(|error| {
        CliError::runtime(format!(
            "failed to flush output file {}: {error}",
            path.display()
        ))
    })?;

    temporary.persist_noclobber(path).map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            CliError::runtime(format!("output file already exists: {}", path.display()))
        } else {
            CliError::runtime(format!(
                "failed to publish output file {}: {}",
                path.display(),
                error.error
            ))
        }
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use crate::model::{ExtractionResponse, JobStatus};

    use super::{ensure_available, output_path, render, write_atomic};

    fn completed_response(title: Option<&str>, markdown: &str) -> ExtractionResponse {
        ExtractionResponse {
            id: Uuid::nil(),
            status: JobStatus::Completed,
            final_url: Some("https://example.com/final?x=1&y=2".to_owned()),
            title: title.map(str::to_owned),
            markdown: Some(markdown.to_owned()),
            error: None,
        }
    }

    #[test]
    fn renders_yaml_safe_front_matter_and_markdown() {
        let rendered = render(&completed_response(Some("Title: \"quoted\""), "# Body")).unwrap();
        assert_eq!(
            rendered,
            "---\nname: \"Title: \\\"quoted\\\"\"\nurl: \"https://example.com/final?x=1&y=2\"\n---\n\n# Body\n"
        );
    }

    #[test]
    fn uses_an_empty_yaml_string_when_title_is_missing() {
        let rendered = render(&completed_response(None, "body\n")).unwrap();
        assert!(rendered.starts_with("---\nname: \"\"\n"));
    }

    #[test]
    fn appends_markdown_suffix_and_never_overwrites() {
        let directory = tempfile::tempdir().unwrap();
        let path = output_path("nested/page", directory.path()).unwrap();
        assert_eq!(path, directory.path().join("page.md"));

        ensure_available(&path).unwrap();
        write_atomic(&path, "complete").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "complete");
        assert!(ensure_available(&path).is_err());
        assert!(write_atomic(&path, "replacement").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "complete");
    }
}

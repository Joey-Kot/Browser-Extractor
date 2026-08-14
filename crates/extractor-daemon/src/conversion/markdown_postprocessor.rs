pub(super) fn postprocess_markdown(markdown: &str) -> String {
    let mut result = String::with_capacity(markdown.len());
    let mut previous_line_was_blank = false;

    for line in markdown.split_inclusive('\n') {
        let (content, line_ending) = match line.strip_suffix('\n') {
            Some(line) => match line.strip_suffix('\r') {
                Some(content) => (content, "\r\n"),
                None => (line, "\n"),
            },
            None => (line, ""),
        };
        let is_blank = content.bytes().all(|byte| matches!(byte, b' ' | b'\t'));

        if is_blank {
            if previous_line_was_blank {
                continue;
            }
            previous_line_was_blank = true;
            result.push_str(line_ending);
        } else {
            previous_line_was_blank = false;
            result.push_str(content);
            result.push_str(line_ending);
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::postprocess_markdown;

    #[test]
    fn normalizes_whitespace_only_lines_and_collapses_blank_lines() {
        let markdown = "first\n   \n\t\n\nsecond\n";

        assert_eq!(postprocess_markdown(markdown), "first\n\nsecond\n");
    }

    #[test]
    fn preserves_spaces_on_non_blank_lines() {
        let markdown = "  first  \n\nsecond  \n";

        assert_eq!(postprocess_markdown(markdown), markdown);
    }

    #[test]
    fn preserves_crlf_line_endings() {
        let markdown = "first\r\n \t\r\n\r\nsecond\r\n";

        assert_eq!(postprocess_markdown(markdown), "first\r\n\r\nsecond\r\n");
    }
}

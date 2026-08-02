use crate::model::errors::{ErrorCode, ErrorDetail};

pub trait MarkdownRenderer {
    fn render(&self, html: &str) -> Result<String, ErrorDetail>;
}

pub struct HtmdRenderer;

impl MarkdownRenderer for HtmdRenderer {
    fn render(&self, html: &str) -> Result<String, ErrorDetail> {
        htmd::convert(html).map_err(|error| {
            ErrorDetail::new(
                ErrorCode::ConversionFailed,
                format!("htmd 转换失败: {error}"),
                false,
            )
        })
    }
}

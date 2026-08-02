use std::io::{Read, Seek, SeekFrom, Write};

use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

use crate::model::{
    capture::{CaptureChunk, CaptureEnd, CaptureMetadata, CaptureType, ChunkKind},
    errors::{ErrorCode, ErrorDetail},
};

struct Piece {
    offset: u64,
    length: usize,
    kind: ChunkKind,
    key: Option<String>,
}

pub struct CaptureAssembler {
    metadata: CaptureMetadata,
    file: NamedTempFile,
    pieces: Vec<Piece>,
    next_sequence: u64,
    total_bytes: u64,
    hasher: Sha256,
    max_result_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct CaptureOutput {
    pub metadata: CaptureMetadata,
    pub html: String,
    pub raw_bytes: u64,
    pub chunks: u64,
    pub scroll_rounds: u32,
    pub matched_items: u32,
    pub warnings: Vec<crate::model::capture::TraversalWarning>,
}

impl CaptureAssembler {
    pub fn new(metadata: CaptureMetadata, max_result_bytes: u64) -> Result<Self, ErrorDetail> {
        let file = NamedTempFile::new().map_err(|error| {
            ErrorDetail::new(
                ErrorCode::InternalError,
                format!("无法创建抓取临时文件: {error}"),
                true,
            )
        })?;

        Ok(Self {
            metadata,
            file,
            pieces: Vec::new(),
            next_sequence: 0,
            total_bytes: 0,
            hasher: Sha256::new(),
            max_result_bytes,
        })
    }

    pub fn push(&mut self, chunk: CaptureChunk) -> Result<u64, ErrorDetail> {
        if chunk.sequence != self.next_sequence {
            return Err(ErrorDetail::new(
                ErrorCode::ProtocolError,
                format!(
                    "内容块序号错误，期望 {}，收到 {}",
                    self.next_sequence, chunk.sequence
                ),
                false,
            ));
        }

        let bytes = chunk.html.as_bytes();
        let next_total = self
            .total_bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| {
                ErrorDetail::new(ErrorCode::ResultTooLarge, "抓取结果大小溢出", false)
            })?;
        if next_total > self.max_result_bytes {
            return Err(ErrorDetail::new(
                ErrorCode::ResultTooLarge,
                "抓取结果超过单任务大小限制",
                false,
            ));
        }

        let offset = self.total_bytes;
        self.file.write_all(bytes).map_err(|error| {
            ErrorDetail::new(
                ErrorCode::InternalError,
                format!("写入抓取临时文件失败: {error}"),
                true,
            )
        })?;
        self.hasher.update(bytes);
        self.pieces.push(Piece {
            offset,
            length: bytes.len(),
            kind: chunk.kind,
            key: chunk.key,
        });
        self.total_bytes = next_total;
        self.next_sequence += 1;
        Ok(self.total_bytes)
    }

    pub fn total_bytes(&self) -> u64 {
        self.total_bytes
    }

    pub fn finish(mut self, end: CaptureEnd) -> Result<CaptureOutput, ErrorDetail> {
        if end.chunks != self.next_sequence {
            return Err(ErrorDetail::new(
                ErrorCode::ProtocolError,
                format!(
                    "内容块数量不一致，期望 {}，收到 {}",
                    self.next_sequence, end.chunks
                ),
                false,
            ));
        }
        if end.total_bytes != self.total_bytes {
            return Err(ErrorDetail::new(
                ErrorCode::ProtocolError,
                format!(
                    "内容字节数不一致，期望 {}，收到 {}",
                    self.total_bytes, end.total_bytes
                ),
                false,
            ));
        }

        let checksum = hex::encode(self.hasher.clone().finalize());
        if !checksum.eq_ignore_ascii_case(&end.checksum) {
            return Err(ErrorDetail::new(
                ErrorCode::ProtocolError,
                "内容校验和不一致",
                false,
            ));
        }

        self.file.as_file_mut().flush().map_err(io_error)?;
        self.file
            .as_file_mut()
            .seek(SeekFrom::Start(0))
            .map_err(io_error)?;
        let mut raw = String::with_capacity(self.total_bytes as usize);
        self.file
            .as_file_mut()
            .read_to_string(&mut raw)
            .map_err(|error| {
                ErrorDetail::new(
                    ErrorCode::ProtocolError,
                    format!("抓取结果不是有效 UTF-8: {error}"),
                    false,
                )
            })?;

        let html = self.assemble_html(&raw)?;
        Ok(CaptureOutput {
            metadata: self.metadata,
            html,
            raw_bytes: self.total_bytes,
            chunks: self.next_sequence,
            scroll_rounds: end.scroll_rounds,
            matched_items: end.matched_items,
            warnings: end.warnings,
        })
    }

    fn assemble_html(&self, raw: &str) -> Result<String, ErrorDetail> {
        match self.metadata.capture_type {
            CaptureType::Document if !self.metadata.selection_applied => Ok(raw.to_owned()),
            CaptureType::Document => {
                let title = escape_html(&self.metadata.title);
                Ok(format!(
                    "<!doctype html><html><head><title>{title}</title></head><body><main data-capture-type=\"document\">{raw}</main></body></html>"
                ))
            }
            CaptureType::Feed => {
                let mut items: Vec<(String, String)> = Vec::new();
                for piece in &self.pieces {
                    if piece.kind != ChunkKind::Item {
                        return Err(ErrorDetail::new(
                            ErrorCode::ProtocolError,
                            "feed 抓取只能包含 item 内容块",
                            false,
                        ));
                    }
                    let start = piece.offset as usize;
                    let end = start + piece.length;
                    let item_part = raw.get(start..end).ok_or_else(|| {
                        ErrorDetail::new(
                            ErrorCode::ProtocolError,
                            "内容块边界不是有效 UTF-8 边界",
                            false,
                        )
                    })?;
                    let key = piece.key.clone().unwrap_or_default();
                    if let Some((last_key, last_html)) = items.last_mut()
                        && *last_key == key
                    {
                        last_html.push_str(item_part);
                        continue;
                    }
                    items.push((key, item_part.to_owned()));
                }

                let mut body = String::new();
                for (key, item) in items {
                    let key = escape_html(&key);
                    body.push_str("<article data-capture-key=\"");
                    body.push_str(&key);
                    body.push_str("\">");
                    body.push_str(&item);
                    body.push_str("</article>\n");
                }
                let title = escape_html(&self.metadata.title);
                Ok(format!(
                    "<!doctype html><html><head><title>{title}</title></head><body><main data-capture-type=\"feed\">{body}</main></body></html>"
                ))
            }
        }
    }
}

fn io_error(error: std::io::Error) -> ErrorDetail {
    ErrorDetail::new(
        ErrorCode::InternalError,
        format!("读取抓取临时文件失败: {error}"),
        true,
    )
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    #[test]
    fn assembles_feed_items() {
        let metadata = CaptureMetadata {
            capture_type: CaptureType::Feed,
            selection_applied: true,
            final_url: "https://example.com/feed".into(),
            title: "Feed".into(),
            mime_type: "text/html".into(),
            mime_type_unknown: false,
        };
        let mut assembler = CaptureAssembler::new(metadata, 1024).unwrap();
        let html = "<p>one</p>";
        assembler
            .push(CaptureChunk {
                sequence: 0,
                kind: ChunkKind::Item,
                key: Some("1".into()),
                html: html.into(),
            })
            .unwrap();
        let checksum = hex::encode(Sha256::digest(html.as_bytes()));
        let output = assembler
            .finish(CaptureEnd {
                chunks: 1,
                total_bytes: html.len() as u64,
                checksum,
                scroll_rounds: 1,
                matched_items: 1,
                warnings: vec![crate::model::capture::TraversalWarning {
                    kind: crate::model::capture::TraversalWarningKind::Iframe,
                    message: "frame detached".into(),
                    url: Some("https://frame.example/".into()),
                    depth: 1,
                }],
            })
            .unwrap();
        assert!(output.html.contains("data-capture-key=\"1\""));
        assert_eq!(output.warnings.len(), 1);
    }

    #[test]
    fn joins_adjacent_chunks_for_one_feed_item() {
        let metadata = CaptureMetadata {
            capture_type: CaptureType::Feed,
            selection_applied: true,
            final_url: "https://example.com/feed".into(),
            title: "Feed".into(),
            mime_type: "text/html".into(),
            mime_type_unknown: false,
        };
        let mut assembler = CaptureAssembler::new(metadata, 1024).unwrap();
        for (sequence, html) in ["<p>one", " two</p>"].into_iter().enumerate() {
            assembler
                .push(CaptureChunk {
                    sequence: sequence as u64,
                    kind: ChunkKind::Item,
                    key: Some("same".into()),
                    html: html.into(),
                })
                .unwrap();
        }
        let raw = "<p>one two</p>";
        let output = assembler
            .finish(CaptureEnd {
                chunks: 2,
                total_bytes: raw.len() as u64,
                checksum: hex::encode(Sha256::digest(raw.as_bytes())),
                scroll_rounds: 1,
                matched_items: 1,
                warnings: Vec::new(),
            })
            .unwrap();
        assert_eq!(output.html.matches("data-capture-key").count(), 1);
        assert!(output.html.contains(raw));
    }
}

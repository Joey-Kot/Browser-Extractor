use crate::model::errors::{ErrorCode, ErrorDetail};

pub fn validate_chunk_window(
    sequence: u64,
    acknowledged: Option<u64>,
    max_unacked: usize,
) -> Result<(), ErrorDetail> {
    let first_unacked = acknowledged.map(|value| value + 1).unwrap_or(0);
    let unacked = sequence.saturating_sub(first_unacked) as usize + 1;
    if unacked > max_unacked {
        return Err(ErrorDetail::new(
            ErrorCode::ProtocolError,
            "扩展超过未确认内容块窗口",
            false,
        ));
    }
    Ok(())
}

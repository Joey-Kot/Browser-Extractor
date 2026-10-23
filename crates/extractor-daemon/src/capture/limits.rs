use std::sync::atomic::{AtomicU64, Ordering};

use crate::model::errors::{ErrorCode, ErrorDetail};

pub fn reserve_inflight(counter: &AtomicU64, bytes: u64, limit: u64) -> Result<(), ErrorDetail> {
    let mut current = counter.load(Ordering::Relaxed);
    loop {
        let Some(next) = current.checked_add(bytes) else {
            return Err(ErrorDetail::new(
                ErrorCode::CaptureBackpressure,
                "全局在途内容大小溢出",
                true,
            ));
        };
        if next > limit {
            return Err(ErrorDetail::new(
                ErrorCode::CaptureBackpressure,
                "全局在途内容超过限制",
                true,
            ));
        }
        match counter.compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Relaxed) {
            Ok(_) => return Ok(()),
            Err(actual) => current = actual,
        }
    }
}

pub fn release_inflight(counter: &AtomicU64, bytes: u64) {
    let _ = counter.try_update(Ordering::AcqRel, Ordering::Relaxed, |current| {
        Some(current.saturating_sub(bytes))
    });
}

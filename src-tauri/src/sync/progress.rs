//! 独立进度事件：传输持有引擎锁时不再查询 SyncService 状态，避免锁重入。
use readerx_sync::{SyncProgress, SyncReport};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

const EVENT: &str = "readerx-sync-progress";

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressSnapshot {
    #[serde(flatten)]
    pub transfer: SyncProgress,
    pub batch: usize,
    pub sequence: u64,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct ProgressState {
    current: Mutex<Option<ProgressSnapshot>>,
}

impl ProgressState {
    pub fn snapshot(&self) -> Option<ProgressSnapshot> {
        self.current
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn publish<R: tauri::Runtime>(&self, app: &AppHandle<R>, mut next: ProgressSnapshot) {
        {
            let mut current = self.current.lock().unwrap_or_else(|p| p.into_inner());
            next.sequence = current.as_ref().map_or(1, |old| old.sequence + 1);
            *current = Some(next.clone());
        }
        if let Err(error) = app.emit(EVENT, &next) {
            log::debug!("同步进度事件发送失败：{error}");
        }
    }

    pub fn phase<R: tauri::Runtime>(&self, app: &AppHandle<R>, phase: &str, error: Option<String>) {
        if let Some(mut current) = self.snapshot() {
            current.transfer.phase = phase.to_string();
            current.error = error;
            self.publish(app, current);
        }
    }
}

/// 连续多批的结果累加，续传标志以最后一批为准。
pub fn accumulate(total: &mut SyncReport, next: SyncReport) {
    total.peer_device = next.peer_device;
    total.peer_name = next.peer_name;
    total.peer_addr = next.peer_addr;
    total.pulled += next.pulled;
    total.pushed += next.pushed;
    total.duplicates += next.duplicates;
    total.deferred += next.deferred;
    total.rejected += next.rejected;
    total.conflicts += next.conflicts;
    total.rounds += next.rounds;
    total.content_pushed += next.content_pushed;
    total.content_pulled += next.content_pulled;
    total.assets_pushed += next.assets_pushed;
    total.assets_pulled += next.assets_pulled;
    total.bytes += next.bytes;
    total.more_content = next.more_content;
    total.more_assets = next.more_assets;
    total.peer_knowledge = next.peer_knowledge;
    total.finished_at_ms = next.finished_at_ms;
}

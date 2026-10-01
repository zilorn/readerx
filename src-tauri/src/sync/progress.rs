//! 独立进度事件：传输持有引擎锁时不再查询 SyncService 状态，避免锁重入。
use readerx_sync::SyncProgress;
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

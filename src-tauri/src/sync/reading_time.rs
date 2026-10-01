//! 不可变累计快照：按来源与统计项取最大值，不对收到的值再次相加。
//! 快照身份含累计值，旧备份重发与乱序到达都不会让较新值回退。
use crate::reading_time::{self, Contribution};
use readerx_sync::{
    net::{lock_engine, SharedEngine},
    SyncError,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use tauri::AppHandle;

fn snapshot_id(source: &str, metric: &str, key: &str, milliseconds: u64) -> String {
    let bytes = serde_json::to_vec(&(source, metric, key, milliseconds)).expect("基础类型可序列化");
    format!("rt-{:x}", Sha256::digest(bytes))
}

pub(super) fn publish<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
) -> Result<(), SyncError> {
    let parts = reading_time::contributions(app).map_err(SyncError::Io)?;
    let mut guard = lock_engine(engine);
    for (source, part) in parts {
        for (metric, values) in [("day", part.days), ("book", part.books)] {
            for (key, milliseconds) in values {
                let id = snapshot_id(&source, metric, &key, milliseconds);
                if guard.entity(&id).is_none() {
                    guard.create_entity(
                        "reading_time",
                        Some(id),
                        [
                            ("source", json!(source)),
                            ("metric", json!(metric)),
                            ("key", json!(key)),
                            ("milliseconds", json!(milliseconds)),
                        ],
                    )?;
                }
            }
        }
    }
    guard.flush()
}

pub(super) fn apply<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
) -> Result<bool, SyncError> {
    let mut parts: BTreeMap<String, Contribution> = BTreeMap::new();
    {
        let guard = lock_engine(engine);
        for entity in guard.entities_of_kind("reading_time", false) {
            let (Some(source), Some(metric), Some(key), Some(value)) = (
                entity
                    .field("source")
                    .and_then(|v| v.as_str().map(str::to_owned)),
                entity
                    .field("metric")
                    .and_then(|v| v.as_str().map(str::to_owned)),
                entity
                    .field("key")
                    .and_then(|v| v.as_str().map(str::to_owned)),
                entity.field("milliseconds").and_then(|v| v.as_u64()),
            ) else {
                continue;
            };
            if source.parse::<readerx_sync::Ulid>().is_err()
                || snapshot_id(&source, &metric, &key, value) != entity.id
            {
                continue;
            }
            let part = parts.entry(source).or_default();
            let values = match metric.as_str() {
                "day" => &mut part.days,
                "book" => &mut part.books,
                _ => continue,
            };
            let current = values.entry(key).or_default();
            *current = (*current).max(value);
        }
    }
    reading_time::apply(app, parts).map_err(SyncError::Io)
}

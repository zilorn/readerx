//! 阅读时长独立保存；旧安装没有此文件时从零开始，不改动进度数据。
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, sync::Mutex};
use tauri::AppHandle;

static LOCK: Mutex<()> = Mutex::new(());
const KEY: &str = "readerx.readingTime";

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingTime {
    #[serde(default = "version")]
    schema_version: u32,
    #[serde(default)]
    days: BTreeMap<String, u64>,
    #[serde(default)]
    books: BTreeMap<String, u64>,
}
fn version() -> u32 {
    1
}

fn load(app: &AppHandle) -> Result<ReadingTime, String> {
    let value = crate::storage::read_state(app, KEY)?;
    let stats: ReadingTime = match value {
        Some(value) => {
            serde_json::from_value(value).map_err(|e| format!("读取阅读时长失败: {e}"))?
        }
        None => ReadingTime {
            schema_version: 1,
            ..Default::default()
        },
    };
    if stats.schema_version != 1 {
        return Err("不支持的阅读时长数据版本".into());
    }
    Ok(stats)
}

fn add(
    stats: &mut ReadingTime,
    book_id: String,
    day: String,
    milliseconds: u64,
) -> Result<(), String> {
    let parts: Vec<_> = day.split('-').collect();
    let valid_day = parts.len() == 3
        && parts[0].len() == 4
        && parts[1].len() == 2
        && parts[2].len() == 2
        && parts.iter().all(|p| p.bytes().all(|c| c.is_ascii_digit()))
        && parts[1].parse::<u32>().is_ok_and(|m| (1..=12).contains(&m))
        && parts[2].parse::<u32>().is_ok_and(|d| (1..=31).contains(&d));
    if !crate::storage::valid_component(&book_id) || !valid_day || milliseconds > 60_000 {
        return Err("无效的阅读时长记录".into());
    }
    let daily = stats.days.entry(day).or_default();
    *daily = daily.saturating_add(milliseconds);
    let book = stats.books.entry(book_id).or_default();
    *book = book.saturating_add(milliseconds);
    Ok(())
}

#[tauri::command]
pub fn readerx_reading_time_get(app: AppHandle) -> Result<ReadingTime, String> {
    let _guard = LOCK.lock().map_err(|_| "阅读时长锁不可用")?;
    load(&app)
}

#[tauri::command]
pub fn readerx_reading_time_add(
    app: AppHandle,
    book_id: String,
    day: String,
    milliseconds: u64,
) -> Result<ReadingTime, String> {
    let _guard = LOCK.lock().map_err(|_| "阅读时长锁不可用")?;
    let mut stats = load(&app)?;
    add(&mut stats, book_id, day, milliseconds)?;
    let dir = crate::storage::state_dir(&app)?;
    let temporary = dir.join(format!("{KEY}.tmp"));
    let target = dir.join(format!("{KEY}.json"));
    let bytes = serde_json::to_vec(&stats).map_err(|e| format!("序列化阅读时长失败: {e}"))?;
    fs::write(&temporary, bytes).map_err(|e| format!("保存阅读时长失败: {e}"))?;
    fs::rename(temporary, target).map_err(|e| format!("保存阅读时长失败: {e}"))?;
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accumulates_days_and_books_without_changing_invalid_records() {
        let mut stats = ReadingTime {
            schema_version: 1,
            ..Default::default()
        };
        add(&mut stats, "book-a".into(), "2026-10-01".into(), 15_000).unwrap();
        add(&mut stats, "book-a".into(), "2026-10-02".into(), 5_000).unwrap();
        add(&mut stats, "book-b".into(), "2026-10-02".into(), 10_000).unwrap();
        assert_eq!(stats.days["2026-10-02"], 15_000);
        assert_eq!(stats.books["book-a"], 20_000);
        assert!(add(&mut stats, "book-a".into(), "2026-99-01".into(), 100).is_err());
        assert!(add(&mut stats, "../a".into(), "2026-10-01".into(), 100).is_err());
        assert!(add(&mut stats, "book-a".into(), "2026-10-01".into(), 60_001).is_err());
        assert_eq!(stats.days["2026-10-01"], 15_000);
    }
}

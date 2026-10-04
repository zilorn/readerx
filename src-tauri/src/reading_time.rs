//! 阅读时长：按本机独立来源累计，同步取每个来源的最大值再求和。
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, sync::Mutex};
use tauri::AppHandle;

static LOCK: Mutex<()> = Mutex::new(());
const KEY: &str = "readerx.readingTime";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Contribution {
    #[serde(default)]
    pub days: BTreeMap<String, u64>,
    #[serde(default)]
    pub books: BTreeMap<String, u64>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingTime {
    #[serde(default = "legacy_version")]
    schema_version: u32,
    #[serde(default)]
    days: BTreeMap<String, u64>,
    #[serde(default)]
    books: BTreeMap<String, u64>,
    #[serde(default)]
    contributions: BTreeMap<String, Contribution>,
}
fn legacy_version() -> u32 {
    1
}

/// 前端使用本机书籍 id；持久化与同步仍使用跨设备 uid。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingTimeView {
    schema_version: u32,
    days: BTreeMap<String, u64>,
    books: BTreeMap<String, u64>,
}

fn local_book_totals(
    books: BTreeMap<String, u64>,
    local_ids: &BTreeMap<String, String>,
) -> BTreeMap<String, u64> {
    let mut totals: BTreeMap<String, u64> = BTreeMap::new();
    for (uid, value) in books {
        // 本机不存在的书保留 uid，让统计页继续显示已移出书库。
        let id = local_ids.get(&uid).cloned().unwrap_or(uid);
        let total = totals.entry(id).or_default();
        *total = total.saturating_add(value);
    }
    totals
}

fn view<R: tauri::Runtime>(
    app: &AppHandle<R>,
    stats: ReadingTime,
) -> Result<ReadingTimeView, String> {
    let local_ids = crate::book_store::list_sync_meta(app)?
        .into_iter()
        .map(|meta| (crate::sync::bridge::book_uid_of(app, &meta), meta.id))
        .collect();
    Ok(ReadingTimeView {
        schema_version: stats.schema_version,
        days: stats.days,
        books: local_book_totals(stats.books, &local_ids),
    })
}

impl ReadingTime {
    fn summarize(&mut self) {
        self.days.clear();
        self.books.clear();
        for part in self.contributions.values() {
            for (key, value) in &part.days {
                let total = self.days.entry(key.clone()).or_default();
                *total = total.saturating_add(*value);
            }
            for (key, value) in &part.books {
                let total = self.books.entry(key.clone()).or_default();
                *total = total.saturating_add(*value);
            }
        }
    }

    fn merge(&mut self, incoming: BTreeMap<String, Contribution>) -> bool {
        let mut changed = false;
        for (source, part) in incoming {
            let local = self.contributions.entry(source).or_default();
            changed |= merge_max(&mut local.days, part.days);
            changed |= merge_max(&mut local.books, part.books);
        }
        if changed {
            self.summarize();
        }
        changed
    }
}

fn merge_max(local: &mut BTreeMap<String, u64>, incoming: BTreeMap<String, u64>) -> bool {
    let mut changed = false;
    for (key, value) in incoming {
        let current = local.entry(key).or_default();
        if value > *current {
            *current = value;
            changed = true;
        }
    }
    changed
}

fn save<R: tauri::Runtime>(app: &AppHandle<R>, stats: &ReadingTime) -> Result<(), String> {
    let dir = crate::storage::state_dir(app)?;
    let temporary = dir.join(format!("{KEY}.tmp"));
    let _temporary = crate::temporary_file::TemporaryFile(temporary.clone());
    let bytes = serde_json::to_vec(stats).map_err(|e| format!("序列化阅读时长失败: {e}"))?;
    fs::write(&temporary, bytes).map_err(|e| format!("保存阅读时长失败: {e}"))?;
    fs::rename(temporary, dir.join(format!("{KEY}.json")))
        .map_err(|e| format!("保存阅读时长失败: {e}"))
}

fn load<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<ReadingTime, String> {
    let Some(value) = crate::storage::read_state(app, KEY)? else {
        return Ok(ReadingTime {
            schema_version: 2,
            ..Default::default()
        });
    };
    let mut stats: ReadingTime =
        serde_json::from_value(value).map_err(|e| format!("读取阅读时长失败: {e}"))?;
    match stats.schema_version {
        1 => {
            // 迁移来源只生成一次并落盘；与未来本机新增时间分开，备份恢复也不会重复累加。
            let mut books: BTreeMap<String, u64> = BTreeMap::new();
            for (id, value) in &stats.books {
                let total = books
                    .entry(crate::sync::bridge::local_uid(app, id))
                    .or_default();
                *total = total.saturating_add(*value);
            }
            stats.contributions.insert(
                readerx_sync::new_id(),
                Contribution {
                    days: stats.days.clone(),
                    books,
                },
            );
            stats.schema_version = 2;
            stats.summarize();
            save(app, &stats)?;
        }
        2 => stats.summarize(),
        _ => return Err("不支持的阅读时长数据版本".into()),
    }
    Ok(stats)
}

// 本机累计来源不在 state/ 中，也不随备份或同步传输；恢复到另一台设备后新增时间另记。
fn local_source<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let root = crate::storage::data_root(app)?;
    crate::storage::ensure_dir(&root)?;
    let path = root.join("reading-time-origin");
    match fs::read_to_string(&path) {
        Ok(value) if value.parse::<readerx_sync::Ulid>().is_ok() => Ok(value),
        Ok(_) => Err("阅读时长设备标识无效".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let value = readerx_sync::new_id();
            fs::write(path, &value).map_err(|e| format!("保存阅读时长设备标识失败: {e}"))?;
            Ok(value)
        }
        Err(error) => Err(format!("读取阅读时长设备标识失败: {error}")),
    }
}

pub(crate) fn contributions<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<BTreeMap<String, Contribution>, String> {
    let _guard = LOCK.lock().map_err(|_| "阅读时长锁不可用")?;
    Ok(load(app)?.contributions)
}

pub(crate) fn apply<R: tauri::Runtime>(
    app: &AppHandle<R>,
    incoming: BTreeMap<String, Contribution>,
) -> Result<bool, String> {
    let _guard = LOCK.lock().map_err(|_| "阅读时长锁不可用")?;
    let mut stats = load(app)?;
    let changed = stats.merge(incoming);
    if changed {
        save(app, &stats)?;
    }
    Ok(changed)
}

fn add(
    stats: &mut ReadingTime,
    source: String,
    book_uid: String,
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
    if !crate::storage::valid_component(&book_uid) || !valid_day || milliseconds > 60_000 {
        return Err("无效的阅读时长记录".into());
    }
    let part = stats.contributions.entry(source).or_default();
    let daily = part.days.entry(day).or_default();
    *daily = daily.saturating_add(milliseconds);
    let book = part.books.entry(book_uid).or_default();
    *book = book.saturating_add(milliseconds);
    stats.summarize();
    Ok(())
}

#[tauri::command]
pub async fn readerx_reading_time_get(app: AppHandle) -> Result<ReadingTimeView, String> {
    crate::commands::blocking("读取阅读时长", move || {
        crate::sync::service_hook(&app).refresh_reading_time()?;
        let _guard = LOCK.lock().map_err(|_| "阅读时长锁不可用")?;
        view(&app, load(&app)?)
    })
    .await
}

#[tauri::command]
pub async fn readerx_reading_time_add(
    app: AppHandle,
    book_id: String,
    day: String,
    milliseconds: u64,
) -> Result<ReadingTimeView, String> {
    crate::commands::blocking("保存阅读时长", move || {
        let stats = {
            let _guard = LOCK.lock().map_err(|_| "阅读时长锁不可用")?;
            if !crate::storage::valid_component(&book_id) {
                return Err("无效的书籍标识".into());
            }
            let mut stats = load(&app)?;
            let uid = crate::sync::bridge::local_uid(&app, &book_id);
            add(&mut stats, local_source(&app)?, uid, day, milliseconds)?;
            save(&app, &stats)?;
            stats
        };
        // 必须先释放时长锁，再进引擎，避免与同步落地的锁顺序相反。
        crate::sync::service_hook(&app).on_reading_time_changed();
        view(&app, stats)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn view_resolves_present_books_and_preserves_removed_books() {
        let books = BTreeMap::from([
            ("uid-present".into(), 15_000),
            ("uid-removed".into(), 5_000),
        ]);
        let local_ids = BTreeMap::from([("uid-present".into(), "local-book".into())]);
        let totals = local_book_totals(books.clone(), &local_ids);
        assert_eq!(totals["local-book"], 15_000);
        assert_eq!(totals["uid-removed"], 5_000);
        assert!(!totals.contains_key("uid-present"));
        assert_eq!(totals.values().sum::<u64>(), books.values().sum::<u64>());
        // 书库加载前后及删除后都重新按当前本机清单解析，不改写存储键。
        assert_eq!(local_book_totals(books.clone(), &BTreeMap::new()), books);
    }

    #[test]
    fn offline_devices_merge_idempotently_and_preserve_newer_local_time() {
        let mut a = ReadingTime {
            schema_version: 2,
            ..Default::default()
        };
        let mut b = ReadingTime {
            schema_version: 2,
            ..Default::default()
        };
        add(
            &mut a,
            "a".into(),
            "book".into(),
            "2026-10-01".into(),
            15_000,
        )
        .unwrap();
        add(
            &mut b,
            "b".into(),
            "book".into(),
            "2026-10-01".into(),
            10_000,
        )
        .unwrap();
        let old = a.contributions.clone();
        assert!(a.merge(b.contributions.clone()));
        assert!(b.merge(a.contributions.clone()));
        assert_eq!(a.days["2026-10-01"], 25_000);
        assert_eq!(a.books, b.books);
        assert!(!a.merge(b.contributions.clone()));
        add(
            &mut a,
            "a".into(),
            "book".into(),
            "2026-10-02".into(),
            5_000,
        )
        .unwrap();
        assert!(!a.merge(old));
        assert_eq!(a.days["2026-10-02"], 5_000);
        assert!(add(&mut a, "a".into(), "book".into(), "2026-99-01".into(), 100).is_err());
        assert!(add(
            &mut a,
            "a".into(),
            "book".into(),
            "2026-10-01".into(),
            60_001
        )
        .is_err());
    }
}

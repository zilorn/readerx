//! SQLite-backed collections and the legacy shelf API's view of books.detail.progress.
//! All entry points share the library lock; callbacks never re-enter storage or sync.
use super::{library_transaction, sqlite, BookDetail};
use rusqlite::{params, Connection};
use serde_json::{Map, Value};
use std::{fs, path::Path};

pub(crate) const KEYS: [&str; 5] = [
    "readerx.groups",
    "readerx.sourceGroups",
    "readerx.textReplacements",
    "readerx.chapterRules",
    "readerx.shelf",
];
pub(crate) fn handles(key: &str) -> bool {
    KEYS.contains(&key)
}
fn sql(e: rusqlite::Error) -> String {
    format!("数据状态数据库操作失败: {e}")
}
fn table(key: &str) -> Result<&'static str, String> {
    match key {
        "readerx.groups" | "readerx.sourceGroups" => Ok("groups"),
        "readerx.textReplacements" | "readerx.chapterRules" => Ok("rules"),
        _ => Err("未知的数据状态类型".into()),
    }
}
pub(super) fn read(db: &Connection, key: &str) -> Result<Option<Value>, String> {
    if key == "readerx.shelf" {
        let mut out = Map::new();
        let mut query = db
            .prepare("SELECT id,detail FROM books ORDER BY id")
            .map_err(sql)?;
        let rows = query
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(sql)?;
        for row in rows {
            let (id, raw) = row.map_err(sql)?;
            let detail: BookDetail = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            if let Some(progress) = detail.progress {
                validate_progress(&progress)?;
                out.insert(id, progress);
            }
        }
        return Ok(Some(Value::Object(out)));
    }
    let table = table(key)?;
    let present: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM collections WHERE key=?1)",
            [key],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if !present {
        return Ok(None);
    }
    let mut query = db
        .prepare(&format!(
            "SELECT record FROM {table} WHERE key=?1 ORDER BY position"
        ))
        .map_err(sql)?;
    let rows = query
        .query_map([key], |r| r.get::<_, String>(0))
        .map_err(sql)?;
    let values: Result<Vec<Value>, String> = rows
        .map(|row| {
            let value: Value =
                serde_json::from_str(&row.map_err(sql)?).map_err(|e| e.to_string())?;
            if !value.is_object() {
                return Err("分组或规则记录格式错误".into());
            }
            Ok(value)
        })
        .collect();
    Ok(Some(Value::Array(values?)))
}
fn validate_progress(value: &Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("书架进度格式错误".into());
    }
    Ok(())
}
// Caller owns an SQL transaction; removing a book naturally removes its progress.
fn write(db: &Connection, root: &Path, key: &str, value: Option<&Value>) -> Result<(), String> {
    if key == "readerx.shelf" {
        let empty = Map::new();
        let entries = match value {
            Some(value) => value.as_object().ok_or("书架状态格式错误")?,
            None => &empty,
        };
        for (id, progress) in entries {
            sqlite::valid_id(id)?;
            validate_progress(progress)?;
            if sqlite::detail(db, id)?.is_none() {
                sqlite::reject_pending_migration(root, id)?;
            }
        }
        let ids = {
            let mut q = db.prepare("SELECT id FROM books").map_err(sql)?;
            let rows = q.query_map([], |r| r.get::<_, String>(0)).map_err(sql)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(sql)?
        };
        for id in ids {
            let mut detail = sqlite::detail(db, &id)?.ok_or("书籍元信息缺失")?;
            let progress = entries.get(&id).map(|entry| {
                let mut entry = entry.clone();
                entry["bookId"] = Value::String(id.clone());
                entry
            });
            if detail.progress != progress {
                detail.progress = progress;
                sqlite::save_detail(db, &detail)?;
            }
        }
        return Ok(());
    }
    let table = table(key)?;
    let items = value
        .map(|v| v.as_array().ok_or("分组或规则列表格式错误"))
        .transpose()?;
    if items.is_some_and(|items| items.iter().any(|v| !v.is_object())) {
        return Err("分组或规则记录格式错误".into());
    }
    db.execute("DELETE FROM collections WHERE key=?1", [key])
        .map_err(sql)?;
    if let Some(items) = items {
        db.execute("INSERT INTO collections(key) VALUES(?1)", [key])
            .map_err(sql)?;
        for (position, item) in items.iter().enumerate() {
            db.execute(
                &format!("INSERT INTO {table}(key,position,record) VALUES(?1,?2,?3)"),
                params![key, position as i64, item.to_string()],
            )
            .map_err(sql)?;
        }
    }
    Ok(())
}
/// Commit each legacy state and its receipt together, then archive the original.
/// A failed archive is retried without replaying a stale snapshot over newer edits.
pub(super) fn migrate(db: &mut Connection, root: &Path) -> Result<(), String> {
    for key in KEYS {
        let path = root.join("state").join(format!("{key}.json"));
        if !path.is_file() {
            continue;
        }
        let done: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM migrated_states WHERE key=?1)",
                [key],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if !done {
            let value: Value = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let tx = db.transaction().map_err(sql)?;
            // Existing database collections win on retry/upgrade; shelf adds only missing entries.
            if key == "readerx.shelf" {
                let current = read(&tx, key)?.unwrap_or_else(|| serde_json::json!({}));
                let mut merged = value.as_object().ok_or("旧书架状态格式错误")?.clone();
                merged.extend(current.as_object().ok_or("书架状态格式错误")?.clone());
                write(&tx, root, key, Some(&Value::Object(merged)))?;
            } else if read(&tx, key)?.is_none() {
                write(&tx, root, key, Some(&value))?;
            }
            tx.execute("INSERT INTO migrated_states(key) VALUES(?1)", [key])
                .map_err(sql)?;
            tx.commit().map_err(sql)?;
        }
        let backup = path.with_extension("json.migrated");
        if backup.exists() {
            return Err("旧状态备份已存在，原文件已保留".into());
        }
        fs::rename(&path, backup).map_err(|e| format!("归档旧状态失败: {e}"))?;
    }
    Ok(())
}
pub(crate) fn read_at(root: &Path, key: &str) -> Result<Option<Value>, String> {
    let _lock = library_transaction();
    let mut db = sqlite::open(root)?;
    migrate(&mut db, root)?;
    read(&db, key)
}
pub(crate) fn update_at(
    root: &Path,
    key: &str,
    update: impl FnOnce(&mut Option<Value>) -> Result<(), String>,
) -> Result<bool, String> {
    let _lock = library_transaction();
    let mut db = sqlite::open(root)?;
    migrate(&mut db, root)?;
    let tx = db.transaction().map_err(sql)?;
    let current = read(&tx, key)?;
    let mut next = current.clone();
    update(&mut next)?;
    if current == next {
        return Ok(false);
    }
    write(&tx, root, key, next.as_ref())?;
    tx.commit().map_err(sql)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn setup() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("readerx-state-{}", readerx_sync::new_id()));
        let db = sqlite::open(&root).unwrap();
        for id in ["b1", "b2"] {
            sqlite::save_detail(
                &db,
                &serde_json::from_value(json!({"id":id,"title":"书"})).unwrap(),
            )
            .unwrap();
        }
        fs::create_dir_all(root.join("state")).unwrap();
        root
    }
    fn set(root: &Path, key: &str, value: Value) {
        update_at(root, key, |state| {
            *state = Some(value);
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn legacy_collections_and_progress_migrate_into_sqlite_and_do_not_replay() {
        let root = setup();
        for key in &KEYS[..4] {
            fs::write(
                root.join(format!("state/{key}.json")),
                json!([{"id":"old","unknown":42}]).to_string(),
            )
            .unwrap();
        }
        let path = root.join("state/readerx.shelf.json");
        fs::write(
            &path,
            json!({"b1":{"bookId":"b1","chapter":3,"charOffset":42}}).to_string(),
        )
        .unwrap();
        // Archive failure occurs after the migration transaction has committed.
        fs::create_dir(path.with_extension("json.migrated")).unwrap();
        assert!(read_at(&root, "readerx.shelf").is_err());
        let db = sqlite::open(&root).unwrap();
        let mut detail = sqlite::detail(&db, "b1").unwrap().unwrap();
        detail.progress.as_mut().unwrap()["chapter"] = json!(8);
        sqlite::save_detail(&db, &detail).unwrap();
        drop(db);
        fs::remove_dir(path.with_extension("json.migrated")).unwrap();
        assert_eq!(
            read_at(&root, "readerx.shelf").unwrap().unwrap()["b1"]["chapter"],
            8
        );
        for key in &KEYS[..4] {
            assert!(!root.join(format!("state/{key}.json")).exists());
            assert_eq!(read_at(&root, key).unwrap().unwrap()[0]["unknown"], 42);
        }
        let db = sqlite::open(&root).unwrap();
        assert_eq!(
            sqlite::detail(&db, "b1")
                .unwrap()
                .unwrap()
                .progress
                .unwrap()["chapter"],
            8
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn malformed_legacy_state_and_failed_sql_write_keep_previous_data() {
        let root = setup();
        let path = root.join("state/readerx.groups.json");
        fs::write(&path, "broken").unwrap();
        assert!(read_at(&root, "readerx.groups").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "broken");
        fs::remove_file(path).unwrap();
        set(&root, "readerx.groups", json!([{"id":"old"}]));
        let db = sqlite::open(&root).unwrap();
        db.execute_batch("CREATE TRIGGER fail_group BEFORE INSERT ON groups WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT,'injected'); END").unwrap();
        assert!(update_at(&root, "readerx.groups", |v| {
            *v = Some(json!([{"id":"new"},{"id":"bad"}]));
            Ok(())
        })
        .is_err());
        assert_eq!(
            read_at(&root, "readerx.groups").unwrap().unwrap(),
            json!([{"id":"old"}])
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn shelf_ensure_update_reset_metadata_save_and_delete_share_book_rows() {
        let root = setup();
        set(
            &root,
            "readerx.shelf",
            json!({"b1":{"chapter":5,"updatedAt":100}}),
        );
        update_at(&root, "readerx.shelf", |state| {
            crate::storage::patch_shelf(
                state,
                json!({"b1":{"chapter":0},"b2":{"chapter":2}})
                    .as_object()
                    .unwrap(),
                "ensure",
            )?;
            Ok(())
        })
        .unwrap();
        let shelf = read_at(&root, "readerx.shelf").unwrap().unwrap();
        assert_eq!(shelf["b1"]["chapter"], 5);
        assert_eq!(shelf["b2"]["chapter"], 2);
        let db = sqlite::open(&root).unwrap();
        let book = sqlite::get(&db, "b1").unwrap().unwrap();
        sqlite::put(&db, &book).unwrap();
        assert_eq!(
            sqlite::detail(&db, "b1")
                .unwrap()
                .unwrap()
                .progress
                .unwrap()["chapter"],
            5
        );
        sqlite::delete(&db, "b2").unwrap();
        drop(db);
        update_at(&root, "readerx.shelf", |state| {
            crate::storage::patch_shelf(state, &Map::new(), "reset")?;
            Ok(())
        })
        .unwrap();
        let shelf = read_at(&root, "readerx.shelf").unwrap().unwrap();
        assert_eq!(shelf["b1"]["chapter"], 0);
        assert!(shelf.get("b2").is_none());
        assert!(!root.join("state/readerx.shelf.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn identity_migration_keeps_progress() {
        let root = setup();
        set(&root, "readerx.shelf", json!({"b1":{"chapter":7}}));
        set(
            &root,
            "readerx.textReplacements",
            json!([{"id":"r1","bookId":"b1"}]),
        );
        super::super::rename_id_at(&root, "b1", "b-0123456789abcdef").unwrap();
        let shelf = read_at(&root, "readerx.shelf").unwrap().unwrap();
        assert_eq!(shelf["b-0123456789abcdef"]["chapter"], 7);
        assert_eq!(shelf["b-0123456789abcdef"]["bookId"], "b-0123456789abcdef");
        assert!(shelf.get("b1").is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn database_v1_upgrade_and_snapshot_include_collections_and_progress() {
        let root = setup();
        let db = sqlite::open(&root).unwrap();
        db.execute_batch("DROP TABLE groups; DROP TABLE rules; DROP TABLE collections; DROP TABLE migrated_states; PRAGMA user_version=1;").unwrap();
        let old_snapshot = sqlite::snapshot(&db, &root).unwrap();
        assert_eq!(old_snapshot.ids().unwrap(), vec!["b1", "b2"]);
        assert!(old_snapshot.state_keys().unwrap().is_empty());
        drop(old_snapshot);
        drop(db);
        set(&root, "readerx.groups", json!([{"id":"g1"}]));
        set(
            &root,
            "readerx.chapterRules",
            json!([{"id":"r1","pattern":"^第"}]),
        );
        set(&root, "readerx.shelf", json!({"b1":{"chapter":4}}));
        let db = sqlite::open(&root).unwrap();
        let snapshot = sqlite::snapshot(&db, &root).unwrap();
        set(&root, "readerx.shelf", json!({"b1":{"chapter":9}}));
        assert_eq!(
            snapshot.read_state("readerx.shelf").unwrap().unwrap()["b1"]["chapter"],
            4
        );
        assert_eq!(
            snapshot.read_state("readerx.groups").unwrap().unwrap()[0]["id"],
            "g1"
        );
        assert_eq!(
            snapshot
                .read_state("readerx.chapterRules")
                .unwrap()
                .unwrap()[0]["pattern"],
            "^第"
        );
        drop(snapshot);
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }
}

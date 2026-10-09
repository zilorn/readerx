//! Test-only JSON view of persisted SQLite rows, while legacy fixtures remain real files.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn location(path: &Path) -> Option<(PathBuf, String, String)> {
    let file = path.file_name()?.to_str()?.to_string();
    if !matches!(
        file.as_str(),
        "bookdetail.json" | "content.json" | "bookmarks.json" | "annotations.json"
    ) {
        return None;
    }
    let dir = path.parent()?;
    let books = dir.parent()?;
    if books.file_name()?.to_str()? != "books" {
        return None;
    }
    Some((
        books.parent()?.join("books.sqlite3"),
        dir.file_name()?.to_str()?.into(),
        file,
    ))
}
fn connection(path: &Path) -> Option<(Connection, String, String)> {
    let (path, id, file) = location(path)?;
    if !path.is_file() {
        return None;
    }
    let db = Connection::open(path).unwrap();
    db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    let present: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM books WHERE id=?1)",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    if present {
        Some((db, id, file))
    } else {
        None
    }
}
fn state_location(path: &Path) -> Option<(Connection, String)> {
    let state = path.parent()?;
    if state.file_name()?.to_str()? != "state" || path.is_file() {
        return None;
    }
    let key = path.file_stem()?.to_str()?;
    if !matches!(
        key,
        "readerx.groups"
            | "readerx.sourceGroups"
            | "readerx.chapterRules"
            | "readerx.textReplacements"
            | "readerx.shelf"
    ) {
        return None;
    }
    let db = state.parent()?.join("books.sqlite3");
    if !db.is_file() {
        return None;
    }
    let db = Connection::open(db).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    Some((db, key.into()))
}
fn state_read(db: &Connection, key: &str) -> Value {
    if key == "readerx.shelf" {
        let mut out = serde_json::Map::new();
        let mut q = db.prepare("SELECT id,detail FROM books").unwrap();
        for row in q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
        {
            let (id, raw) = row.unwrap();
            let detail: Value = serde_json::from_str(&raw).unwrap();
            if let Some(progress) = detail.get("progress") {
                out.insert(id, progress.clone());
            }
        }
        return Value::Object(out);
    }
    let table = if key.ends_with("groups") || key.ends_with("sourceGroups") {
        "groups"
    } else {
        "rules"
    };
    let mut q = db
        .prepare(&format!(
            "SELECT record FROM {table} WHERE key=?1 ORDER BY position"
        ))
        .unwrap();
    Value::Array(
        q.query_map([key], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| serde_json::from_str(&r.unwrap()).unwrap())
            .collect(),
    )
}
fn state_write(db: &mut Connection, key: &str, value: &Value) {
    let tx = db.transaction().unwrap();
    if key == "readerx.shelf" {
        let details: Vec<(String, String)> = {
            let mut q = tx.prepare("SELECT id,detail FROM books").unwrap();
            let rows = q.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
            rows.map(Result::unwrap).collect()
        };
        for (id, raw) in details {
            let mut detail: Value = serde_json::from_str(&raw).unwrap();
            detail.as_object_mut().unwrap().remove("progress");
            if let Some(progress) = value.get(&id) {
                detail["progress"] = progress.clone();
            }
            tx.execute(
                "UPDATE books SET detail=?1 WHERE id=?2",
                params![detail.to_string(), id],
            )
            .unwrap();
        }
    } else {
        let table = if key.ends_with("groups") || key.ends_with("sourceGroups") {
            "groups"
        } else {
            "rules"
        };
        tx.execute("DELETE FROM collections WHERE key=?1", [key])
            .unwrap();
        tx.execute("INSERT INTO collections(key) VALUES(?1)", [key])
            .unwrap();
        for (p, item) in value.as_array().unwrap().iter().enumerate() {
            tx.execute(
                &format!("INSERT INTO {table}(key,position,record) VALUES(?1,?2,?3)"),
                params![key, p as i64, item.to_string()],
            )
            .unwrap();
        }
    }
    tx.commit().unwrap();
}
pub fn read(path: &Path) -> Value {
    if let Some((db, key)) = state_location(path) {
        return state_read(&db, &key);
    }
    let Some((db, id, file)) = connection(path) else {
        return serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    };
    if file == "bookdetail.json" {
        let text: String = db
            .query_row("SELECT detail FROM books WHERE id=?1", [&id], |r| r.get(0))
            .unwrap();
        return serde_json::from_str(&text).unwrap();
    }
    if file == "content.json" {
        let mut query = db
            .prepare("SELECT chapter FROM chapters WHERE book_id=?1 ORDER BY position")
            .unwrap();
        let rows = query.query_map([&id], |r| r.get::<_, String>(0)).unwrap();
        let chapters: Vec<Value> = rows
            .map(|r| serde_json::from_str(&r.unwrap()).unwrap())
            .collect();
        return json!({"schemaVersion":1,"chapters":chapters});
    }
    let table = if file == "bookmarks.json" {
        "bookmarks"
    } else {
        "annotations"
    };
    let text: Option<String> = db
        .query_row(
            &format!("SELECT records FROM {table} WHERE book_id=?1"),
            [&id],
            |r| r.get(0),
        )
        .optional()
        .unwrap();
    json!({"schemaVersion":1,(table):text.map(|s|serde_json::from_str::<Value>(&s).unwrap()).unwrap_or(json!([]))})
}
pub fn write(path: &Path, value: &Value) {
    if let Some((mut db, key)) = state_location(path) {
        state_write(&mut db, &key, value);
        return;
    }
    let Some((mut db, id, file)) = connection(path) else {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
        return;
    };
    let tx = db.transaction().unwrap();
    if file == "bookdetail.json" {
        tx.execute(
            "UPDATE books SET detail=?1 WHERE id=?2",
            params![value.to_string(), id],
        )
        .unwrap();
    } else if file == "content.json" {
        tx.execute("DELETE FROM chapters WHERE book_id=?1", [&id])
            .unwrap();
        for (p, c) in value["chapters"].as_array().unwrap().iter().enumerate() {
            let paragraphs: Vec<String> =
                serde_json::from_value(c.get("paragraphs").cloned().unwrap_or(json!([]))).unwrap();
            let blocks = c.get("blocks").filter(|v| !v.is_null());
            let chars: usize = match blocks.and_then(Value::as_array).filter(|b| !b.is_empty()) {
                Some(blocks) => blocks
                    .iter()
                    .filter(|b| matches!(b["kind"].as_str(), Some("p" | "h")))
                    .map(|b| {
                        b["text"]
                            .as_str()
                            .unwrap_or_default()
                            .encode_utf16()
                            .count()
                    })
                    .sum(),
                None => paragraphs.iter().map(|s| s.encode_utf16().count()).sum(),
            };
            let cid = c["cid"].as_str().unwrap_or_default();
            let head = json!({"cid":cid,"title":c["title"],"url":c["url"],"chars":chars});
            let hash = if paragraphs.iter().any(|p| !p.trim().is_empty()) || blocks.is_some() {
                readerx_sync::content::body_fingerprint(&paragraphs, blocks)
            } else {
                String::new()
            };
            let digest = json!({"cid":cid,"hash":hash});
            let mut assets: Vec<String> = Vec::new();
            for b in blocks.and_then(Value::as_array).into_iter().flatten() {
                if let Some(s) = b["local"].as_str() {
                    assets.push(s.into());
                }
                for image in b["imgs"].as_array().into_iter().flatten() {
                    if let Some(s) = image["local"].as_str() {
                        assets.push(s.into());
                    }
                }
            }
            tx.execute("INSERT INTO chapters(book_id,position,cid,chapter,head,digest,assets) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![id,p as i64,cid,c.to_string(),head.to_string(),digest.to_string(),json!(assets).to_string()]).unwrap();
        }
    } else {
        let table = if file == "bookmarks.json" {
            "bookmarks"
        } else {
            "annotations"
        };
        tx.execute(&format!("INSERT INTO {table}(book_id,records) VALUES(?1,?2) ON CONFLICT(book_id) DO UPDATE SET records=excluded.records"),
            params![id,value[table].to_string()]).unwrap();
    }
    tx.commit().unwrap();
}

pub fn ids(root: &Path) -> Vec<String> {
    let path = root.join("books.sqlite3");
    if !path.is_file() {
        return Vec::new();
    }
    let db = Connection::open(path).unwrap();
    let mut query = db.prepare("SELECT id FROM books ORDER BY id").unwrap();
    query
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

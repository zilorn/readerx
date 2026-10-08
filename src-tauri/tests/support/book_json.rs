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
pub fn read(path: &Path) -> Value {
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

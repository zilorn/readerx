//! 将旧本机书籍 ID 迁移为已有同步 ID。待办先落盘，每一步均可重跑。
use super::{bridge, identity};
use crate::{book_store, storage};
use serde_json::Value;
use std::{collections::BTreeMap, fs, path::Path};
use tauri::AppHandle;

const JOURNAL: &str = "readerx.bookIdMigration";

pub(crate) fn canonical_id(id: &str) -> bool {
    id.len() == 18 && id.starts_with("b-") && id[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn id_for_book(book: &crate::models::LocalBook) -> String {
    if canonical_id(&book.id) {
        return book.id.clone();
    }
    let source = book
        .book_source_id
        .as_deref()
        .and_then(|id| readerx_source::store::get_source(id).ok().flatten());
    identity::book_uid(&identity::BookKey {
        source_url: source.as_ref().map(|s| s.book_source_url.as_str()),
        book_url: book.book_url.as_deref(),
        file_name: &book.file_name,
        size: book.size,
    })
}

/// 启动时、界面及同步线程可访问书库之前完成。失败保留待办并停止启动。
#[doc(hidden)]
pub fn migrate<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let root = storage::data_root(app)?;
    let journal = root.join("state").join(format!("{JOURNAL}.json"));
    if journal.is_file() {
        let plan: BTreeMap<String, String> = serde_json::from_value(read(&journal)?)
            .map_err(|e| format!("读取书籍 ID 迁移待办失败: {e}"))?;
        apply(&root, &plan)?;
        fs::remove_file(&journal).map_err(|e| e.to_string())?;
    }
    let books = book_store::list_sync_meta(app)?;
    let mut plan = BTreeMap::new();
    let mut targets = BTreeMap::new();
    for book in books {
        if !book_store::contains_at(app, None, &book.id)? {
            log::warn!("书籍尚未迁入数据库，保留旧 ID 等待重试 id={}", book.id);
            continue;
        }
        let uid = bridge::book_uid_of(app, &book);
        if targets.insert(uid.clone(), book.id.clone()).is_some() {
            return Err("书库存在重复同步身份，请先处理重复书籍；原数据已保留".into());
        }
        if uid != book.id {
            plan.insert(book.id, uid);
        }
    }
    if plan.is_empty() {
        return Ok(());
    }
    // 必须在任何修改之前验证，不能用远端身份覆盖无关本地目录。
    for new in plan.values() {
        if book_store::contains_at(app, None, new)?
            || root
                .join("books")
                .join(new)
                .join("bookdetail.json")
                .is_file()
            || root.join("books").join(format!("{new}.json")).is_file()
        {
            return Err("书籍 ID 迁移目录冲突或旧布局未迁移完成；原数据已保留".into());
        }
    }
    atomic_write(
        &journal,
        &serde_json::to_value(&plan).map_err(|e| e.to_string())?,
    )?;
    apply(&root, &plan)?;
    fs::remove_file(journal).map_err(|e| e.to_string())?;
    log::info!("书籍 ID 迁移完成 books={}", plan.len());
    Ok(())
}

fn apply(root: &Path, plan: &BTreeMap<String, String>) -> Result<(), String> {
    for (old, new) in plan {
        if !storage::valid_component(old) || !canonical_id(new) {
            return Err("书籍 ID 迁移待办包含非法 ID".into());
        }
        if root.join("books.sqlite3").is_file() {
            book_store::rename_id_at(root, old, new)?;
        } else {
            // Pure legacy fixture / interrupted pre-SQLite migration.
            let from = root.join("books").join(old);
            let to = root.join("books").join(new);
            if from.exists() && to.exists() {
                return Err("书籍 ID 迁移目标已存在".into());
            }
            let dir = if from.exists() { &from } else { &to };
            let detail = dir.join("bookdetail.json");
            let mut value = read(&detail)?;
            value["id"] = Value::String(new.clone());
            atomic_write(&detail, &value)?;
            let bookmarks = dir.join("bookmarks.json");
            if bookmarks.is_file() {
                let mut value = read(&bookmarks)?;
                replace_refs(&mut value, plan);
                atomic_write(&bookmarks, &value)?;
            }
            if from.exists() {
                fs::rename(from, to).map_err(|e| e.to_string())?;
            }
        }
        // 图片文件名是正文引用的一部分，原样保留；听书缓存按书籍目录搬迁。
        let cache = root.join("tts-audio").join(old);
        let target = root.join("tts-audio").join(new);
        if cache.exists() {
            if target.exists() {
                return Err("书籍 ID 迁移听书缓存目标已存在".into());
            }
            fs::rename(cache, target).map_err(|e| e.to_string())?;
        }
    }
    for key in [
        "readerx.shelf",
        "readerx.textReplacements",
        "readerx.bookmarks",
        "readerx.readingTime",
    ] {
        let path = root.join("state").join(format!("{key}.json"));
        let in_db = root.join("books.sqlite3").is_file() && crate::book_store::state::handles(key);
        let mut value = if in_db {
            let Some(value) = crate::book_store::state::read_at(root, key)? else {
                continue;
            };
            value
        } else {
            if !path.is_file() {
                continue;
            }
            read(&path)?
        };
        replace_refs(&mut value, plan);
        if key == "readerx.shelf" || key == "readerx.bookmarks" {
            replace_keys(&mut value, plan)?;
        }
        if key == "readerx.readingTime" {
            // v1 按本机 ID 存储，v2 的贡献值已按 uid 存储。
            if let Some(books) = value.get_mut("books") {
                replace_keys(books, plan)?;
            }
        }
        if in_db {
            crate::book_store::state::update_at(root, key, |state| {
                *state = Some(value);
                Ok(())
            })?;
        } else {
            atomic_write(&path, &value)?;
        }
    }
    Ok(())
}

fn replace_refs(value: &mut Value, plan: &BTreeMap<String, String>) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if key == "bookId" {
                    if let Some(new) = value.as_str().and_then(|id| plan.get(id)) {
                        *value = Value::String(new.clone());
                    }
                } else {
                    replace_refs(value, plan);
                }
            }
        }
        Value::Array(items) => {
            for value in items {
                replace_refs(value, plan);
            }
        }
        _ => {}
    }
}

fn replace_keys(value: &mut Value, plan: &BTreeMap<String, String>) -> Result<(), String> {
    if let Some(object) = value.as_object_mut() {
        for (old, new) in plan {
            if object.contains_key(old) && object.contains_key(new) {
                return Err("书籍 ID 迁移状态键冲突，原状态已保留".into());
            }
            if let Some(entry) = object.remove(old) {
                object.insert(new.clone(), entry);
            }
        }
    }
    Ok(())
}

fn read(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(&fs::read(path).map_err(|e| format!("读取迁移数据失败: {e}"))?)
        .map_err(|e| format!("解析迁移数据失败: {e}"))
}
fn atomic_write(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension("id-migration.tmp");
    let _temporary = crate::temporary_file::TemporaryFile(temporary.clone());
    let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, value).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(temporary, path).map_err(|e| format!("保存迁移数据失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn existing_id_survives_metadata_changes_and_missing_source() {
        let book: crate::models::LocalBook = serde_json::from_value(json!({
            "id":"b-0123456789abcdef", "title":"新书名", "author":"作者", "format":"online",
            "fileName":"新文件名", "size":123, "importedAt":1, "hue":1,
            "splitDesc":"", "chapters":[], "bookSourceId":"missing", "bookUrl":"https://changed.example/book"
        })).unwrap();
        assert_eq!(id_for_book(&book), book.id);
    }

    #[test]
    fn interrupted_migration_resumes_after_directory_rename() {
        let root =
            std::env::temp_dir().join(format!("readerx-id-resume-{}", readerx_sync::new_id()));
        let uid = "b-0123456789abcdef";
        let dir = root.join("books").join(uid);
        atomic_write(&dir.join("bookdetail.json"), &json!({"id":uid})).unwrap();
        atomic_write(
            &dir.join("bookmarks.json"),
            &json!({"bookmarks":[{"id":"bm", "bookId":"old"}]}),
        )
        .unwrap();
        atomic_write(
            &root.join("state/readerx.shelf.json"),
            &json!({"old":{"bookId":"old", "chapter":8}}),
        )
        .unwrap();
        let plan = BTreeMap::from([("old".into(), uid.into())]);
        apply(&root, &plan).unwrap();
        apply(&root, &plan).unwrap();
        assert_eq!(
            read(&root.join("state/readerx.shelf.json")).unwrap(),
            json!({uid:{"bookId":uid,"chapter":8}})
        );
        assert_eq!(
            read(&dir.join("bookmarks.json")).unwrap()["bookmarks"][0]["bookId"],
            uid
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_or_colliding_ids_do_not_overwrite_books() {
        let root =
            std::env::temp_dir().join(format!("readerx-id-collision-{}", readerx_sync::new_id()));
        let uid = "b-0123456789abcdef";
        for id in ["old", uid] {
            atomic_write(
                &root.join("books").join(id).join("bookdetail.json"),
                &json!({"id":id}),
            )
            .unwrap();
        }
        assert!(apply(&root, &BTreeMap::from([("old".into(), uid.into())])).is_err());
        assert!(apply(&root, &BTreeMap::from([("../old".into(), uid.into())])).is_err());
        assert_eq!(
            read(&root.join("books/old/bookdetail.json")).unwrap()["id"],
            "old"
        );
        fs::remove_dir_all(root).unwrap();
    }
}

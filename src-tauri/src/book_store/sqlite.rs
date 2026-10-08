//! SQLite implementation. Callers hold the book-store lock; no sync-engine calls here.
use super::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::io::Write;

pub(super) const DATABASE: &str = "books.sqlite3";
const DATABASE_VERSION: i64 = 1;

fn sql(error: rusqlite::Error) -> String {
    format!("书库数据库操作失败: {error}")
}
fn encode<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("序列化书籍数据失败: {e}"))
}
fn decode<T: DeserializeOwned>(value: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|e| format!("解析书籍数据失败: {e}"))
}
pub(super) fn valid_id(id: &str) -> Result<(), String> {
    if crate::storage::valid_component(id) {
        Ok(())
    } else {
        Err("非法的书籍 id".into())
    }
}

pub(super) fn connect(root: &Path) -> Result<Connection, String> {
    crate::storage::ensure_dir(root)?;
    let mut db = Connection::open(root.join(DATABASE)).map_err(sql)?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(sql)?;
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")
        .map_err(sql)?;
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql)?;
    if version > DATABASE_VERSION {
        return Err("书库数据库格式版本不受支持".into());
    }
    if version == 0 {
        let tx = db.transaction().map_err(sql)?;
        tx.execute_batch(
            "CREATE TABLE books (id TEXT PRIMARY KEY, detail TEXT NOT NULL);
             CREATE TABLE chapters (
                book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE ON UPDATE CASCADE,
                position INTEGER NOT NULL, cid TEXT NOT NULL,
                chapter TEXT NOT NULL, head TEXT NOT NULL, digest TEXT NOT NULL, assets TEXT NOT NULL,
                PRIMARY KEY(book_id, position));
             CREATE INDEX chapters_by_cid ON chapters(book_id, cid);
             CREATE TABLE bookmarks (book_id TEXT PRIMARY KEY REFERENCES books(id)
                ON DELETE CASCADE ON UPDATE CASCADE, records TEXT NOT NULL);
             CREATE TABLE annotations (book_id TEXT PRIMARY KEY REFERENCES books(id)
                ON DELETE CASCADE ON UPDATE CASCADE, records TEXT NOT NULL);
             CREATE TABLE migrated_books (id TEXT PRIMARY KEY);
             PRAGMA user_version=1;"
        ).map_err(sql)?;
        tx.commit().map_err(sql)?;
    }
    Ok(db)
}

pub(super) fn open(root: &Path) -> Result<Connection, String> {
    // Complete pre-SQLite file journals before importing their metadata snapshots.
    for journal in [
        "migrations/readerx.sourceSaveMigration.json",
        "migrations/readerx.sourceIdMigration.json",
        "migrations/readerx.dataIdMigration.json",
    ] {
        readerx_source::id_migration::FilePlan::resume(root, journal)?;
    }
    let mut db = connect(root)?;
    migrate(&mut db, root)?;
    Ok(db)
}

/// One transaction per book includes records and a durable migration receipt.
/// Receipts prevent a crash during file cleanup from replaying stale JSON over later edits.
fn migrate(db: &mut Connection, root: &Path) -> Result<(), String> {
    let books = root.join("books");
    let global = root.join("state/readerx.bookmarks.json");
    let old_marks: Result<HashMap<String, Vec<Value>>, String> = if global.is_file() {
        read_json_file(&global, "旧书签")
    } else {
        Ok(HashMap::new())
    };
    let mut pending = old_marks.is_err();
    if books.is_dir() {
        for entry in fs::read_dir(&books).map_err(|e| format!("读取旧书库失败: {e}"))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if !kind.is_file() && !kind.is_dir() {
                continue;
            }
            let path = entry.path();
            let id = if kind.is_dir() {
                let id = entry.file_name().to_string_lossy().into_owned();
                if !path.join(BOOKDETAIL_FILE).is_file() {
                    let receipt: bool = db
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM migrated_books WHERE id=?1)",
                            [&id],
                            |r| r.get(0),
                        )
                        .map_err(sql)?;
                    if !receipt {
                        continue;
                    }
                }
                id
            } else {
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                path.file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            };
            let result = (|| {
                valid_id(&id)?;
                let migrated: bool = db
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM migrated_books WHERE id=?1)",
                        [&id],
                        |r| r.get(0),
                    )
                    .map_err(sql)?;
                if !migrated {
                    // Do not hide a failed upgrade under a newly-created empty book.
                    if detail(db, &id)?.is_some() {
                        return Err("旧书籍与数据库书籍冲突，原文件已保留".into());
                    }
                    let split = books.join(&id);
                    let is_split = split.join(BOOKDETAIL_FILE).is_file();
                    let mut book = if is_split {
                        let content = split.join(CONTENT_FILE);
                        if content.is_file()
                            && fs::metadata(&content).map_err(|e| e.to_string())?.len()
                                >= crate::book_images::STREAM_MIGRATE_MIN_BYTES
                            && crate::book_images::file_has_data_image(&content)
                        {
                            crate::book_images::migrate_book_file(
                                &root.join("images"),
                                &id,
                                &content,
                            )?;
                        }
                        read_book_from_dir(&split)?.ok_or("旧书籍元信息缺失")?
                    } else {
                        if fs::metadata(&path).map_err(|e| e.to_string())?.len()
                            >= crate::book_images::STREAM_MIGRATE_MIN_BYTES
                            && crate::book_images::file_has_data_image(&path)
                        {
                            crate::book_images::migrate_book_file(
                                &root.join("images"),
                                &id,
                                &path,
                            )?;
                        }
                        read_json_file::<LocalBook>(&path, "旧书籍")?
                    };
                    if is_split {
                        let detail: BookDetail =
                            read_json_file(&split.join(BOOKDETAIL_FILE), "旧书籍元信息")?;
                        if detail.schema_version != SCHEMA_VERSION {
                            return Err("旧书籍格式版本不受支持".into());
                        }
                        if split.join(CONTENT_FILE).is_file() {
                            let content: BookContent =
                                read_json_file(&split.join(CONTENT_FILE), "旧书籍正文")?;
                            if content.schema_version != SCHEMA_VERSION {
                                return Err("旧书籍正文格式版本不受支持".into());
                            }
                        }
                    }
                    if book.id != id {
                        return Err("旧书籍 ID 与路径不一致，原文件已保留".into());
                    }
                    let dir = books.join(&id);
                    let marks = if dir.join(BOOKMARKS_FILE).is_file() {
                        read_bookmarks_file(&dir.join(BOOKMARKS_FILE))?
                    } else {
                        old_marks
                            .as_ref()
                            .map_err(Clone::clone)?
                            .get(&id)
                            .cloned()
                            .unwrap_or_default()
                    };
                    let notes = read_annotations_file(&dir.join(ANNOTATIONS_FILE))?;
                    crate::book_images::migrate_book(&root.join("images"), &mut book);
                    let tx = db.transaction().map_err(sql)?;
                    put(&tx, &book)?;
                    put_records(&tx, "bookmarks", &id, &marks)?;
                    put_records(&tx, "annotations", &id, &notes)?;
                    tx.execute("INSERT INTO migrated_books(id) VALUES(?1)", [&id])
                        .map_err(sql)?;
                    tx.commit().map_err(sql)?;
                    log::info!("书籍已迁移到 SQLite id={id}");
                }
                // Only book data files are archived. Unknown files / images / caches stay outside SQLite.
                for name in [
                    BOOKDETAIL_FILE,
                    CONTENT_FILE,
                    BOOKMARKS_FILE,
                    ANNOTATIONS_FILE,
                    DIGEST_FILE,
                ] {
                    let file = books.join(&id).join(name);
                    if file.is_file() {
                        archive_legacy(&file)?;
                    }
                }
                let flat = books.join(format!("{id}.json"));
                if flat.is_file() {
                    archive_legacy(&flat)?;
                }
                Ok::<_, String>(())
            })();
            if let Err(error) = result {
                pending = true;
                log::warn!(
                    "书籍 SQLite 迁移未完成 id={id}：{}",
                    readerx_log::redact::urls_in_text(&error)
                );
            }
        }
    }
    // Previously split books may already be in the database when only the global file remains.
    if let Ok(marks) = &old_marks {
        for (id, records) in marks {
            if valid_id(id).is_err() {
                log::warn!("旧全库书签中有非法书籍 ID，已跳过");
                continue;
            }
            if records.is_empty() {
                continue;
            }
            if detail(db, id)?.is_some() {
                db.execute(
                    "INSERT OR IGNORE INTO bookmarks(book_id, records) VALUES(?1, ?2)",
                    params![id, encode(records)?],
                )
                .map_err(sql)?;
            } else if books.join(id).join(BOOKDETAIL_FILE).is_file()
                || books.join(format!("{id}.json")).is_file()
            {
                pending = true;
            }
        }
    }
    if global.is_file() && !pending {
        archive_legacy(&global)?;
    }
    Ok(())
}
fn archive_legacy(path: &Path) -> Result<(), String> {
    let backup = path.with_extension("json.migrated");
    // A pre-existing backup must never be overwritten by a later import or interrupted upgrade.
    if backup.exists() {
        return Err("旧书籍备份已存在，保留待处理文件".into());
    }
    fs::rename(path, backup).map_err(|e| format!("归档旧书籍文件失败: {e}"))
}

pub(super) fn detail(db: &Connection, id: &str) -> Result<Option<BookDetail>, String> {
    valid_id(id)?;
    db.query_row("SELECT detail FROM books WHERE id=?1", [id], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .map_err(sql)?
    .map(|s| decode(&s))
    .transpose()
}
pub(super) fn details(db: &Connection) -> Result<Vec<BookDetail>, String> {
    strings(db, "SELECT detail FROM books ORDER BY id", [])?
        .iter()
        .map(|s| decode(s))
        .collect()
}
fn strings<P: rusqlite::Params>(
    db: &Connection,
    query: &str,
    params: P,
) -> Result<Vec<String>, String> {
    let mut statement = db.prepare(query).map_err(sql)?;
    let rows = statement
        .query_map(params, |r| r.get::<_, String>(0))
        .map_err(sql)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sql)
}
pub(super) fn chapters(db: &Connection, id: &str) -> Result<Vec<LocalBookChapter>, String> {
    valid_id(id)?;
    strings(
        db,
        "SELECT chapter FROM chapters WHERE book_id=?1 ORDER BY position",
        [id],
    )?
    .iter()
    .map(|s| decode(s))
    .collect()
}
pub(super) fn get(db: &Connection, id: &str) -> Result<Option<LocalBook>, String> {
    detail(db, id)?
        .map(|d| Ok(d.into_book(chapters(db, id)?)))
        .transpose()
}
pub(super) fn save_detail(db: &Connection, detail: &BookDetail) -> Result<(), String> {
    valid_id(&detail.id)?;
    db.execute("INSERT INTO books(id,detail) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET detail=excluded.detail",
        params![detail.id, encode(detail)?]).map_err(sql)?;
    Ok(())
}
fn head(chapter: &LocalBookChapter) -> Result<ChapterHead, String> {
    Ok(scan_chapter_head(
        serde_json::from_value(serde_json::to_value(chapter).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?,
    ))
}
pub(super) fn save_chapter(
    db: &Connection,
    id: &str,
    position: usize,
    chapter: &LocalBookChapter,
) -> Result<(), String> {
    db.execute("INSERT INTO chapters(book_id,position,cid,chapter,head,digest,assets) VALUES(?1,?2,?3,?4,?5,?6,?7)
        ON CONFLICT(book_id,position) DO UPDATE SET cid=excluded.cid,chapter=excluded.chapter,head=excluded.head,digest=excluded.digest,assets=excluded.assets",
        params![id, position as i64, chapter.cid, encode(chapter)?, encode(&head(chapter)?)?, encode(&chapter_digest(chapter))?, encode(&chapter_asset_locals(chapter))?]).map_err(sql)?;
    Ok(())
}
pub(super) fn put(db: &Connection, book: &LocalBook) -> Result<(), String> {
    save_detail(db, &BookDetail::from_book(book))?;
    db.execute("DELETE FROM chapters WHERE book_id=?1", [&book.id])
        .map_err(sql)?;
    for (position, chapter) in book.chapters.iter().enumerate() {
        save_chapter(db, &book.id, position, chapter)?;
    }
    Ok(())
}
pub(super) fn records(db: &Connection, table: &str, id: &str) -> Result<Vec<Value>, String> {
    valid_id(id)?;
    let query = match table {
        "bookmarks" => "SELECT records FROM bookmarks WHERE book_id=?1",
        "annotations" => "SELECT records FROM annotations WHERE book_id=?1",
        _ => return Err("未知的书籍记录类型".into()),
    };
    match db
        .query_row(query, [id], |r| r.get::<_, String>(0))
        .optional()
        .map_err(sql)?
    {
        Some(s) => decode(&s),
        None => Ok(Vec::new()),
    }
}
pub(super) fn put_records(
    db: &Connection,
    table: &str,
    id: &str,
    records: &[Value],
) -> Result<(), String> {
    valid_id(id)?;
    let query = match table {
        "bookmarks" => "INSERT INTO bookmarks(book_id,records) VALUES(?1,?2) ON CONFLICT(book_id) DO UPDATE SET records=excluded.records",
        "annotations" => "INSERT INTO annotations(book_id,records) VALUES(?1,?2) ON CONFLICT(book_id) DO UPDATE SET records=excluded.records",
        _ => return Err("未知的书籍记录类型".into()),
    };
    db.execute(query, params![id, encode(&records)?])
        .map_err(sql)?;
    Ok(())
}

pub(super) fn metas(db: &Connection) -> Result<Vec<BookMeta>, String> {
    // One indexed join reads only metadata and precomputed chapter heads, never chapter bodies.
    let mut statement = db.prepare("SELECT b.detail,c.head FROM books b LEFT JOIN chapters c ON c.book_id=b.id ORDER BY b.id,c.position").map_err(sql)?;
    let mut rows = statement.query([]).map_err(sql)?;
    let mut out: Vec<BookMeta> = Vec::new();
    while let Some(row) = rows.next().map_err(sql)? {
        let detail: BookDetail = decode(&row.get::<_, String>(0).map_err(sql)?)?;
        if out.last().is_none_or(|last| last.id != detail.id) {
            out.push(detail.into_meta(Vec::new()));
        }
        if let Some(s) = row.get::<_, Option<String>>(1).map_err(sql)? {
            out.last_mut().unwrap().chapters.push(decode(&s)?);
        }
    }
    Ok(out)
}
pub(super) fn refs(db: &Connection, id: &str) -> Result<Vec<ChapterRef>, String> {
    valid_id(id)?;
    strings(
        db,
        "SELECT head FROM chapters WHERE book_id=?1 ORDER BY position",
        [id],
    )?
    .iter()
    .map(|s| {
        let head: ChapterHead = decode(s)?;
        Ok(ChapterRef {
            cid: head.cid,
            title: head.title,
            url: head.url,
        })
    })
    .collect()
}
pub(super) fn digests(db: &Connection, id: &str) -> Result<Vec<ChapterDigest>, String> {
    valid_id(id)?;
    let all: Vec<ChapterDigest> = strings(
        db,
        "SELECT digest FROM chapters WHERE book_id=?1 ORDER BY position",
        [id],
    )?
    .iter()
    .map(|s| decode(s))
    .collect::<Result<_, _>>()?;
    Ok(all.into_iter().filter(|d| !d.hash.is_empty()).collect())
}
pub(super) fn assets(db: &Connection, id: &str) -> Result<Vec<(String, String)>, String> {
    valid_id(id)?;
    let mut out = Vec::new();
    for s in strings(
        db,
        "SELECT assets FROM chapters WHERE book_id=?1 ORDER BY position",
        [id],
    )? {
        for local in decode::<Vec<String>>(&s)? {
            if let Some(name) = crate::book_images::asset_name(&local) {
                out.push((name, local));
            }
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}
pub(super) fn picked(
    db: &Connection,
    id: &str,
    cids: &[String],
) -> Result<Vec<(usize, LocalBookChapter)>, String> {
    valid_id(id)?;
    let mut statement = db
        .prepare(
            "SELECT position,chapter FROM chapters WHERE book_id=?1 AND cid=?2 ORDER BY position",
        )
        .map_err(sql)?;
    let mut out = Vec::new();
    for cid in cids.iter().collect::<HashSet<_>>() {
        let rows = statement
            .query_map(params![id, cid], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(sql)?;
        for row in rows {
            let (p, s) = row.map_err(sql)?;
            out.push((p as usize, decode(&s)?));
        }
    }
    out.sort_by_key(|(p, _)| *p);
    Ok(out)
}
pub(super) fn patch(
    db: &mut Connection,
    root: &Path,
    id: &str,
    updates: &[BookChapterPatch],
) -> Result<(), String> {
    require_book(db, root, id)?;
    let tx = db.transaction().map_err(sql)?;
    let mut changed = Vec::new();
    for update in updates {
        if update.chapter.cid.is_empty() {
            return Err("章节补丁缺少 cid".into());
        }
        let mut matches = picked(&tx, id, &[update.chapter.cid.clone()])?;
        if matches.len() != 1 {
            return Err("章节目录已变化或 cid 重复，无法定位补丁".into());
        }
        let (p, mut chapter) = matches.remove(0);
        chapter.paragraphs = update.chapter.paragraphs.clone();
        chapter.blocks = update.chapter.blocks.clone();
        crate::book_images::migrate_chapters(
            &root.join("images"),
            id,
            std::slice::from_mut(&mut chapter),
        );
        changed.push((p, chapter));
    }
    for (p, chapter) in changed {
        save_chapter(&tx, id, p, &chapter)?;
    }
    tx.commit().map_err(sql)
}
pub(super) fn require_book(db: &Connection, root: &Path, id: &str) -> Result<(), String> {
    if detail(db, id)?.is_some() {
        return Ok(());
    }
    if root.join("books").join(id).join(BOOKDETAIL_FILE).is_file()
        || root.join("books").join(format!("{id}.json")).is_file()
    {
        Err("书籍数据迁移失败，请查看应用日志".into())
    } else {
        Err("书籍不存在".into())
    }
}
pub(super) fn commit(db: rusqlite::Transaction<'_>) -> Result<(), String> {
    db.commit().map_err(sql)
}
pub(super) fn transaction(db: &mut Connection) -> Result<rusqlite::Transaction<'_>, String> {
    db.transaction().map_err(sql)
}
pub(super) fn delete(db: &Connection, id: &str) -> Result<(), String> {
    valid_id(id)?;
    db.execute("DELETE FROM books WHERE id=?1", [id])
        .map_err(sql)?;
    Ok(())
}

/// Archives stay JSON based and version-compatible. Stream chapters one row at a time.
pub(super) fn export(
    db: &Connection,
    zip: &mut zip::ZipWriter<fs::File>,
    report: &mut dyn FnMut(&str, u64, u64),
) -> Result<u64, String> {
    let details = details(db)?;
    let total = details.len() as u64;
    report("books", 0, total);
    for (index, d) in details.iter().enumerate() {
        let prefix = format!("books/{}/", d.id);
        zip.start_file(
            format!("{prefix}{BOOKDETAIL_FILE}"),
            crate::data_transfer::archive::text_options(None),
        )
        .map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut *zip, d).map_err(|e| e.to_string())?;
        zip.start_file(
            format!("{prefix}{CONTENT_FILE}"),
            crate::data_transfer::archive::text_options(None),
        )
        .map_err(|e| e.to_string())?;
        zip.write_all(b"{\"schemaVersion\":1,\"chapters\":[")
            .map_err(|e| e.to_string())?;
        let mut statement = db
            .prepare("SELECT chapter FROM chapters WHERE book_id=?1 ORDER BY position")
            .map_err(sql)?;
        let rows = statement
            .query_map([&d.id], |r| r.get::<_, String>(0))
            .map_err(sql)?;
        for (i, row) in rows.enumerate() {
            if i > 0 {
                zip.write_all(b",").map_err(|e| e.to_string())?;
            }
            zip.write_all(row.map_err(sql)?.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        zip.write_all(b"]}").map_err(|e| e.to_string())?;
        for (file, table, field) in [
            (BOOKMARKS_FILE, "bookmarks", "bookmarks"),
            (ANNOTATIONS_FILE, "annotations", "annotations"),
        ] {
            zip.start_file(
                format!("{prefix}{file}"),
                crate::data_transfer::archive::text_options(None),
            )
            .map_err(|e| e.to_string())?;
            let value = serde_json::json!({"schemaVersion":1,(field):records(db, table, &d.id)?});
            serde_json::to_writer(&mut *zip, &value).map_err(|e| e.to_string())?;
        }
        report("books", index as u64 + 1, total);
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("readerx-sqlite-{name}-{}", readerx_sync::new_id()));
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn book(id: &str) -> LocalBook {
        serde_json::from_value(json!({"id":id,"title":"测试书","author":"作者","format":"epub",
            "fileName":"book.epub","size":123,"importedAt":4,"hue":7,"splitDesc":"分章",
            "tags":["科幻"],"sourceTags":["标签"],"intro":"简介","bookSourceId":"源",
            "bookUrl":"https://example.com/book","groupId":"组","source":"webdav","cover":"data:image/png;base64,AAAA",
            "chapters":[{"cid":"c1","title":"标题","url":"https://example.com/c1","paragraphs":["原文😀"]},
                        {"cid":"c2","title":"第二章","paragraphs":["保留正文"]}]})).unwrap()
    }
    fn legacy(root: &Path, book: &LocalBook) {
        let dir = root.join("books").join(&book.id);
        fs::create_dir_all(&dir).unwrap();
        write_json_atomic(
            &dir.join(BOOKDETAIL_FILE),
            &BookDetail::from_book(book),
            "夹具",
        )
        .unwrap();
        write_json_atomic(
            &dir.join(CONTENT_FILE),
            &BookContent {
                schema_version: 1,
                chapters: book.chapters.clone(),
            },
            "夹具",
        )
        .unwrap();
    }
    #[test]
    fn sqlite_round_trip_preserves_fields_records_and_derived_data() {
        let root = root("roundtrip");
        let mut db = open(&root).unwrap();
        let book = book("b1");
        let tx = transaction(&mut db).unwrap();
        put(&tx, &book).unwrap();
        commit(tx).unwrap();
        let records = vec![json!({"id":"mark","unknown":{"color":"red"}})];
        put_records(&db, "bookmarks", "b1", &records).unwrap();
        put_records(&db, "annotations", "b1", &records).unwrap();
        assert_eq!(
            serde_json::to_value(get(&db, "b1").unwrap().unwrap()).unwrap(),
            serde_json::to_value(&book).unwrap()
        );
        assert_eq!(metas(&db).unwrap()[0].chapters[0].chars, 4);
        assert_eq!(records, super::records(&db, "bookmarks", "b1").unwrap());
        assert_eq!(
            digests(&db, "b1").unwrap()[0].hash,
            chapter_digest(&book.chapters[0]).hash
        );
        drop(db);
        assert!(!root.join("books").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn chapter_patch_is_incremental_and_batch_failure_rolls_back() {
        let root = root("patch");
        let mut db = open(&root).unwrap();
        put(&db, &book("b1")).unwrap();
        let before: String = db
            .query_row(
                "SELECT chapter FROM chapters WHERE book_id='b1' AND cid='c2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let mut changed = book("b1").chapters.remove(0);
        changed.title = "过期标题".into();
        changed.paragraphs = vec!["新正文".into()];
        let update = BookChapterPatch {
            index: 1,
            chapter: changed,
        };
        let mut invalid = update.clone();
        invalid.chapter.cid = "missing".into();
        assert!(patch(&mut db, &root, "b1", &[update.clone(), invalid]).is_err());
        assert_eq!(
            get(&db, "b1").unwrap().unwrap().chapters[0].paragraphs,
            vec!["原文😀"]
        );
        patch(&mut db, &root, "b1", &[update]).unwrap();
        let after: String = db
            .query_row(
                "SELECT chapter FROM chapters WHERE book_id='b1' AND cid='c2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(get(&db, "b1").unwrap().unwrap().chapters[0].title, "标题");
        assert_eq!(picked(&db, "b1", &["c1".into()]).unwrap().len(), 1);
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn migration_keeps_failures_and_retries_without_affecting_other_books() {
        let root = root("migrate");
        legacy(&root, &book("good"));
        legacy(&root, &book("bad"));
        let bad = root.join("books/bad/annotations.json");
        fs::write(&bad, "broken").unwrap();
        let db = open(&root).unwrap();
        assert!(detail(&db, "good").unwrap().is_some());
        assert!(detail(&db, "bad").unwrap().is_none());
        assert!(root.join("books/good/bookdetail.json.migrated").is_file());
        assert!(root.join("books/bad/bookdetail.json").is_file());
        assert!(require_book(&db, &root, "bad").is_err());
        fs::write(&bad, r#"{"schemaVersion":1,"annotations":[]}"#).unwrap();
        drop(db);
        let db = open(&root).unwrap();
        assert!(detail(&db, "bad").unwrap().is_some());
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interrupted_cleanup_never_replays_json_over_new_database_edits() {
        let root = root("receipt");
        legacy(&root, &book("b1"));
        // A filesystem obstacle causes cleanup to stop after the committed transaction.
        let obstacle = root.join("books/b1/bookdetail.json.migrated");
        fs::create_dir(&obstacle).unwrap();
        let db = open(&root).unwrap();
        let mut detail = detail(&db, "b1").unwrap().unwrap();
        detail.title = "数据库新书名".into();
        save_detail(&db, &detail).unwrap();
        drop(db);
        fs::remove_dir(&obstacle).unwrap();
        let db = open(&root).unwrap();
        assert_eq!(
            super::detail(&db, "b1").unwrap().unwrap().title,
            "数据库新书名"
        );
        assert!(!root.join("books/b1/bookdetail.json").exists());
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn old_flat_books_global_bookmarks_and_excluded_files_survive_upgrade() {
        let root = root("flat");
        fs::create_dir_all(root.join("books")).unwrap();
        fs::create_dir_all(root.join("state")).unwrap();
        fs::write(
            root.join("books/b1.json"),
            serde_json::to_vec(&book("b1")).unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("state/readerx.bookmarks.json"),
            json!({"b1":[{"id":"mark","bookId":"b1"}]}).to_string(),
        )
        .unwrap();
        for name in [
            "state/preferences.json",
            "book_sources/s1.json",
            "source_sessions/s1.json",
            "images/image.png",
            "tts-audio/b1/audio.mp3",
            "books/other.json.tmp",
        ] {
            let path = root.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"unchanged").unwrap();
        }
        let db = open(&root).unwrap();
        assert_eq!(records(&db, "bookmarks", "b1").unwrap()[0]["id"], "mark");
        assert!(root.join("books/b1.json.migrated").is_file());
        assert!(root.join("state/readerx.bookmarks.json.migrated").is_file());
        for name in [
            "state/preferences.json",
            "book_sources/s1.json",
            "source_sessions/s1.json",
            "images/image.png",
            "tts-audio/b1/audio.mp3",
            "books/other.json.tmp",
        ] {
            assert_eq!(fs::read(root.join(name)).unwrap(), b"unchanged");
        }
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn deletion_cascades_and_data_roots_are_isolated() {
        let first = root("first");
        let second = root("second");
        let db = open(&first).unwrap();
        let peer = open(&second).unwrap();
        put(&db, &book("b1")).unwrap();
        put_records(&db, "bookmarks", "b1", &[json!({"id":"m"})]).unwrap();
        put_records(&db, "annotations", "b1", &[json!({"id":"n"})]).unwrap();
        assert!(detail(&peer, "b1").unwrap().is_none());
        delete(&db, "b1").unwrap();
        for table in ["chapters", "bookmarks", "annotations"] {
            let count: i64 = db
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0);
        }
        drop(db);
        drop(peer);
        fs::remove_dir_all(first).unwrap();
        fs::remove_dir_all(second).unwrap();
    }
    #[test]
    fn failed_sql_write_leaves_metadata_body_and_fingerprint_together() {
        let root = root("rollback");
        let mut db = open(&root).unwrap();
        put(&db, &book("b1")).unwrap();
        db.execute_batch("CREATE TRIGGER fail_second BEFORE INSERT ON chapters WHEN NEW.cid='c2' BEGIN SELECT RAISE(ABORT,'injected'); END").unwrap();
        let before = serde_json::to_value(get(&db, "b1").unwrap()).unwrap();
        let hashes = digests(&db, "b1").unwrap();
        {
            let tx = transaction(&mut db).unwrap();
            let mut changed = book("b1");
            changed.title = "失败的更改".into();
            changed.chapters[0].paragraphs = vec!["未提交".into()];
            assert!(put(&tx, &changed).is_err());
        }
        assert_eq!(
            before,
            serde_json::to_value(get(&db, "b1").unwrap()).unwrap()
        );
        assert_eq!(hashes[0].hash, digests(&db, "b1").unwrap()[0].hash);
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn export_uses_portable_json_and_omits_database_bytes() {
        let root = root("export");
        let db = open(&root).unwrap();
        let original = book("b1");
        put(&db, &original).unwrap();
        let file = fs::File::create(root.join("backup.zip")).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        assert_eq!(export(&db, &mut zip, &mut |_, _, _| {}).unwrap(), 1);
        drop(zip.finish().unwrap());
        let file = fs::File::open(root.join("backup.zip")).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert!(archive.by_name(DATABASE).is_err());
        let detail: BookDetail =
            serde_json::from_reader(archive.by_name("books/b1/bookdetail.json").unwrap()).unwrap();
        let content: BookContent =
            serde_json::from_reader(archive.by_name("books/b1/content.json").unwrap()).unwrap();
        assert_eq!(
            serde_json::to_value(detail.into_book(content.chapters)).unwrap(),
            serde_json::to_value(original).unwrap()
        );
        let records: Value =
            serde_json::from_reader(archive.by_name("books/b1/annotations.json").unwrap()).unwrap();
        assert_eq!(records["annotations"], json!([]));
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn sqlite_identity_migration_is_idempotent_and_updates_bookmark_references() {
        let root = root("ids");
        let db = open(&root).unwrap();
        put(&db, &book("old")).unwrap();
        put_records(
            &db,
            "bookmarks",
            "old",
            &[json!({"id":"mark","bookId":"old"})],
        )
        .unwrap();
        let hash = digests(&db, "old").unwrap()[0].hash.clone();
        drop(db);
        let new = "b-0123456789abcdef";
        super::super::rename_id_at(&root, "old", new).unwrap();
        super::super::rename_id_at(&root, "old", new).unwrap();
        let db = open(&root).unwrap();
        assert!(detail(&db, "old").unwrap().is_none());
        assert_eq!(records(&db, "bookmarks", new).unwrap()[0]["bookId"], new);
        assert_eq!(digests(&db, new).unwrap()[0].hash, hash);
        put(&db, &book("collision")).unwrap();
        drop(db);
        assert!(super::super::rename_id_at(&root, "collision", new).is_err());
        let db = open(&root).unwrap();
        assert!(detail(&db, "collision").unwrap().is_some());
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn sqlite_metadata_reference_remaps_do_not_touch_chapter_bodies() {
        let root = root("refs");
        let db = open(&root).unwrap();
        put(&db, &book("b1")).unwrap();
        let hash = digests(&db, "b1").unwrap()[0].hash.clone();
        drop(db);
        super::super::remap_metadata_at(
            &root,
            "groupId",
            &std::collections::BTreeMap::from([("组".into(), "g-new".into())]),
        )
        .unwrap();
        super::super::remap_metadata_at(
            &root,
            "bookSourceId",
            &std::collections::BTreeMap::from([("源".into(), "s-new".into())]),
        )
        .unwrap();
        let db = open(&root).unwrap();
        let d = detail(&db, "b1").unwrap().unwrap();
        assert_eq!(d.group_id.as_deref(), Some("g-new"));
        assert_eq!(d.book_source_id.as_deref(), Some("s-new"));
        assert_eq!(digests(&db, "b1").unwrap()[0].hash, hash);
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bad_legacy_metadata_defers_identity_migration_without_hiding_healthy_books() {
        let root = root("bad-detail-ids");
        let db = open(&root).unwrap();
        put(&db, &book("healthy")).unwrap();
        let bad = root.join("books/bad/bookdetail.json");
        fs::create_dir_all(bad.parent().unwrap()).unwrap();
        fs::write(&bad, b"{broken").unwrap();
        readerx_source::id_migration::write(
            &root.join("state/readerx.groups.json"),
            &json!([{"id":"组","name":"旧分组"}]),
        )
        .unwrap();
        crate::sync::data_ids::migrate(&root).unwrap();
        assert_eq!(fs::read(&bad).unwrap(), b"{broken");
        assert_eq!(
            detail(&db, "healthy").unwrap().unwrap().group_id.as_deref(),
            Some("组")
        );
        fs::remove_file(bad).unwrap();
        crate::sync::data_ids::migrate(&root).unwrap();
        assert_eq!(
            detail(&db, "healthy").unwrap().unwrap().group_id.as_deref(),
            Some(crate::sync::identity::group_uid("旧分组").as_str())
        );
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_save_and_interrupted_alias_journal_update_sqlite_references() {
        let root = root("source-save");
        let db = open(&root).unwrap();
        let mut original = book("b1");
        original.book_source_id = Some("old-source".into());
        put(&db, &original).unwrap();
        let source = serde_json::from_value(json!({"schemaVersion":1,"id":"s-0123456789abcdef",
            "name":"书源","bookSourceUrl":"https://example.com","js":""}))
        .unwrap();
        crate::sync::data_ids::save_source(&root, &source, "old-source").unwrap();
        assert_eq!(
            detail(&db, "b1")
                .unwrap()
                .unwrap()
                .book_source_id
                .as_deref(),
            Some("s-0123456789abcdef")
        );
        // Simulate a restart after source files changed but before DB reference updates.
        let mut d = detail(&db, "b1").unwrap().unwrap();
        d.book_source_id = Some("interrupted".into());
        save_detail(&db, &d).unwrap();
        readerx_source::id_migration::write(
            &root.join("migrations/readerx.sqliteSourceRefs.json"),
            &json!({"interrupted":"s-0123456789abcdef"}),
        )
        .unwrap();
        crate::sync::data_ids::migrate_sources(&root, &Default::default()).unwrap();
        assert_eq!(
            detail(&db, "b1")
                .unwrap()
                .unwrap()
                .book_source_id
                .as_deref(),
            Some("s-0123456789abcdef")
        );
        assert!(!root
            .join("migrations/readerx.sqliteSourceRefs.json")
            .exists());
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }
}

//! Source-linked local cache; revision leases reject late responses after edits/reloads.
use super::*;

pub(in crate::book_store) fn translation_book(db: &Connection, id: &str) -> Result<Value, String> {
    valid_id(id)?;
    let state: Option<String> = db.query_row("SELECT state FROM translation_books WHERE book_id=?1", [id], |r| r.get(0)).optional().map_err(sql)?;
    state.map(|v| decode(&v)).unwrap_or_else(|| Ok(serde_json::json!({"overrides": {}, "terms": []})))
}
pub(in crate::book_store) fn put_translation_book(db: &Connection, id: &str, state: &Value) -> Result<(), String> {
    valid_id(id)?;
    if detail(db, id)?.is_none() { return Err("书籍不存在".into()); }
    if !state.get("overrides").is_some_and(Value::is_object) || !state.get("terms").is_some_and(Value::is_array) { return Err("翻译配置无效".into()); }
    let encoded = encode(state)?;
    if encoded.len() > 128 * 1024 { return Err("翻译配置过大".into()); }
    db.execute("INSERT INTO translation_books(book_id,state) VALUES(?1,?2) ON CONFLICT(book_id) DO UPDATE SET state=excluded.state", params![id, encoded]).map_err(sql)?;
    Ok(())
}
fn revision(db: &Connection, id: &str, cid: &str) -> Result<String, String> {
    let digest: Option<String> = db.query_row("SELECT digest FROM chapters WHERE book_id=?1 AND cid=?2", params![id,cid], |r|r.get(0)).optional().map_err(sql)?;
    let digest = digest.ok_or("章节不存在")?;
    let epoch: i64 = db.query_row("SELECT epoch FROM translation_epochs WHERE book_id=?1 AND cid=?2", params![id,cid], |r|r.get(0)).optional().map_err(sql)?.unwrap_or(0);
    Ok(format!("{epoch}:{digest}"))
}

fn chapter(db: &Connection, id: &str, cid: &str) -> Result<Option<LocalBookChapter>, String> {
    let value: Option<String> = db.query_row(
        "SELECT chapter FROM chapters WHERE book_id=?1 AND cid=?2",
        params![id, cid], |row| row.get(0),
    ).optional().map_err(sql)?;
    value.map(|value| decode(&value)).transpose()
}

struct Sources<'a> {
    paragraphs: std::collections::HashSet<&'a str>,
    units: Vec<&'a str>,
}
impl<'a> Sources<'a> {
    fn new(chapter: &'a LocalBookChapter) -> Self {
        let mut paragraphs = std::collections::HashSet::new();
        let mut units = Vec::new();
        if let Some(blocks) = chapter.blocks.as_ref().filter(|blocks| !blocks.is_empty()) {
            for block in blocks {
                if block.kind == "p" || block.kind == "h" {
                    let text = block.text.as_deref().unwrap_or("");
                    units.push(text);
                    if block.kind == "p" { paragraphs.insert(text); }
                }
            }
        } else {
            for text in &chapter.paragraphs {
                paragraphs.insert(text.as_str());
                units.push(text.as_str());
            }
        }
        Self { paragraphs, units }
    }
    fn contains(&self, source: &str, kind: &str) -> bool {
        if source.is_empty() { return false; }
        match kind {
            "paragraph" => self.paragraphs.contains(source),
            // 自定义选区使用无分隔镜像；原生选区可能插入一个或两个块间换行。
            "selection" => self.units.iter().any(|unit| unit.contains(source))
                || ["", "\n", "\n\n"].iter().any(|separator| self.units.join(separator).contains(source)),
            _ => false,
        }
    }
}

pub(in crate::book_store) fn translation_cache(db: &Connection, id: &str, cid: &str) -> Result<Value, String> {
    valid_id(id)?;
    let rev = revision(db, id, cid)?;
    let mut query = db.prepare("SELECT key,text FROM translations WHERE book_id=?1 AND cid=?2").map_err(sql)?;
    let rows = query.query_map(params![id,cid], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(sql)?;
    let mut entries = serde_json::Map::new();
    for row in rows { let (key,text) = row.map_err(sql)?; entries.insert(key, Value::String(text)); }
    Ok(serde_json::json!({"revision":rev,"entries":entries}))
}
pub(in crate::book_store) fn put_translation_cache(db: &mut Connection, id: &str, cid: &str, expected: &str, entries: &serde_json::Map<String,Value>) -> Result<bool, String> {
    valid_id(id)?;
    if entries.len() > 15 { return Err("翻译批次超过 15 段".into()); }
    let tx = db.transaction().map_err(sql)?;
    if revision(&tx,id,cid)? != expected { return Ok(false); }
    let chapter = chapter(&tx, id, cid)?.ok_or("章节不存在")?;
    let sources = Sources::new(&chapter);
    for (key, entry) in entries {
        let text = entry.get("text").and_then(Value::as_str).ok_or("译文无效")?;
        let source = entry.get("source").and_then(Value::as_str).ok_or("译文原文无效")?;
        let kind = entry.get("kind").and_then(Value::as_str).ok_or("译文原文类型无效")?;
        if key.len() != 64 || !key.bytes().all(|c|c.is_ascii_hexdigit()) || text.is_empty() || text.len() > 512 * 1024 || source.len() > 1024 * 1024 || !matches!(kind, "paragraph" | "selection") {
            return Err("译文无效".into());
        }
        if !sources.contains(source, kind) { return Ok(false); }
        tx.execute("INSERT INTO translations(book_id,cid,key,source,kind,text) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(book_id,cid,key) DO UPDATE SET source=excluded.source,kind=excluded.kind,text=excluded.text", params![id,cid,key,source,kind,text]).map_err(sql)?;
    }
    tx.commit().map_err(sql)?;
    Ok(true)
}

/// 与正文更新共用事务。只删除不再匹配原文的译文；重取开始时仅推进租约。
pub(in crate::book_store) fn invalidate_translations(db: &Connection, id: &str, cid: &str) -> Result<(), String> {
    valid_id(id)?;
    if let Some(chapter) = chapter(db, id, cid)? {
        let sources = Sources::new(&chapter);
        let mut query = db.prepare("SELECT key,source,kind FROM translations WHERE book_id=?1 AND cid=?2").map_err(sql)?;
        let rows = query.query_map(params![id,cid], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).map_err(sql)?;
        let mut removed = Vec::new();
        for row in rows {
            let (key, source, kind) = row.map_err(sql)?;
            if !sources.contains(&source, &kind) { removed.push(key); }
        }
        drop(query);
        for key in removed {
            db.execute("DELETE FROM translations WHERE book_id=?1 AND cid=?2 AND key=?3", params![id,cid,key]).map_err(sql)?;
        }
    } else {
        db.execute("DELETE FROM translations WHERE book_id=?1 AND cid=?2", params![id,cid]).map_err(sql)?;
    }
    db.execute("INSERT INTO translation_epochs(book_id,cid,epoch) VALUES(?1,?2,1) ON CONFLICT(book_id,cid) DO UPDATE SET epoch=epoch+1",params![id,cid]).map_err(sql)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (std::path::PathBuf, Connection) {
        let root = std::env::temp_dir().join(format!("readerx-translation-{}", readerx_sync::new_id()));
        let db = connect(&root).unwrap();
        db.execute("INSERT INTO books VALUES('b','{\"id\":\"b\"}')", []).unwrap();
        (root, db)
    }
    fn ch(cid: &str, paragraphs: &[&str]) -> LocalBookChapter {
        serde_json::from_value(json!({"cid":cid,"title":"Chapter","paragraphs":paragraphs})).unwrap()
    }
    fn entry(key: char, source: &str, kind: &str) -> (String, Value) {
        (key.to_string().repeat(64), json!({"source":source,"kind":kind,"text":format!("译:{source}")}))
    }
    fn write(db: &mut Connection, cid: &str, rows: Vec<(String, Value)>) -> String {
        let rev = revision(db, "b", cid).unwrap();
        assert!(put_translation_cache(db, "b", cid, &rev, &rows.into_iter().collect()).unwrap());
        rev
    }
    fn keys(db: &Connection, cid: &str) -> Vec<String> {
        translation_cache(db, "b", cid).unwrap()["entries"].as_object().unwrap().keys().cloned().collect()
    }
    #[test]
    fn edits_delete_only_changed_sources_and_reject_late_responses() {
        let (root, mut db) = fixture();
        save_chapter(&db, "b", 0, &ch("c", &["Original word", "Keep this"])).unwrap();
        let old = write(&mut db, "c", vec![entry('a', "Original word", "paragraph"), entry('b', "Keep this", "paragraph"), entry('c', "Keep this", "paragraph"), entry('d', "word", "selection")]);
        let updated = ch("c", &["Keep this", "Original word extended", "Inserted"]);
        {
            let tx = db.transaction().unwrap();
            save_chapter(&tx, "b", 0, &updated).unwrap();
            // 未提交的正文更新及译文删除一起回滚。
        }
        assert_eq!(keys(&db, "c").len(), 4);
        let tx = db.transaction().unwrap();
        save_chapter(&tx, "b", 0, &updated).unwrap();
        tx.commit().unwrap();
        assert_eq!(keys(&db, "c"), vec!["b".repeat(64), "c".repeat(64), "d".repeat(64)]);
        assert!(!put_translation_cache(&mut db, "b", "c", &old, &vec![entry('a', "Original word", "paragraph")].into_iter().collect()).unwrap());
        save_chapter(&db, "b", 0, &ch("c", &["Inserted", "Keep this", "Keep this"])).unwrap();
        assert_eq!(keys(&db, "c"), vec!["b".repeat(64), "c".repeat(64)]);
        let source: String = db.query_row("SELECT source FROM translations LIMIT 1", [], |row| row.get(0)).unwrap();
        assert_eq!(source, "Keep this");
        drop(db); std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn reload_keeps_cache_but_rejects_old_leases_and_invalid_sources() {
        let (root, mut db) = fixture();
        save_chapter(&db, "b", 0, &ch("c", &["Source"])).unwrap();
        let old = write(&mut db, "c", vec![entry('a', "Source", "paragraph")]);
        invalidate_translations(&db, "b", "c").unwrap();
        assert_eq!(keys(&db, "c"), vec!["a".repeat(64)]);
        assert!(!put_translation_cache(&mut db, "b", "c", &old, &vec![entry('b', "Source", "paragraph")].into_iter().collect()).unwrap());
        let rev = revision(&db, "b", "c").unwrap();
        assert!(!put_translation_cache(&mut db, "b", "c", &rev, &vec![entry('b', "Source", "paragraph"), entry('c', "Missing", "paragraph")].into_iter().collect()).unwrap());
        assert_eq!(keys(&db, "c"), vec!["a".repeat(64)], "invalid batch rolls back all writes");
        save_chapter(&db, "b", 0, &ch("c", &["Source"])).unwrap();
        assert_eq!(keys(&db, "c").len(), 1, "same-text reload preserves cache");
        db.execute("DELETE FROM books WHERE id='b'", []).unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM translations", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        drop(db); std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn structured_blocks_and_cross_paragraph_selections_use_actual_text() {
        let (root, mut db) = fixture();
        let mut chapter = ch("c", &["Stale fallback"]);
        chapter.blocks = Some(serde_json::from_value(json!([
            {"kind":"p","text":"First"}, {"kind":"img","src":"first.png"},
            {"kind":"h","text":"Heading"}, {"kind":"p","text":"Last"}
        ])).unwrap());
        save_chapter(&db, "b", 0, &chapter).unwrap();
        write(&mut db, "c", vec![entry('a', "First", "paragraph"), entry('b', "First\n\nHeading\n\nLast", "selection")]);
        chapter.blocks.as_mut().unwrap()[1].src = Some("downloaded.png".into());
        save_chapter(&db, "b", 0, &chapter).unwrap();
        assert_eq!(keys(&db, "c").len(), 2, "image-only updates preserve translations");
        chapter.blocks.as_mut().unwrap()[3].text = Some("Changed".into());
        save_chapter(&db, "b", 0, &chapter).unwrap();
        assert_eq!(keys(&db, "c"), vec!["a".repeat(64)]);
        let rev = revision(&db, "b", "c").unwrap();
        assert!(!put_translation_cache(&mut db, "b", "c", &rev, &vec![entry('c', "Stale fallback", "paragraph")].into_iter().collect()).unwrap());
        drop(db); std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn chapter_reorder_preserves_sources_and_removal_deletes_only_removed_chapter() {
        let (root, mut db) = fixture();
        let a = ch("a", &["First"]);
        let b = ch("b", &["Second"]);
        save_chapter(&db, "b", 0, &a).unwrap();
        save_chapter(&db, "b", 1, &b).unwrap();
        write(&mut db, "a", vec![entry('a', "First", "paragraph")]);
        write(&mut db, "b", vec![entry('b', "Second", "paragraph")]);
        // put() 的目录保存路径；正文、翻译清理必须同事务完成。
        let mut book: LocalBook = serde_json::from_value(json!({
            "id":"b","title":"Book","author":"Test","format":"txt","fileName":"b.txt", "size":1,
            "importedAt":0,"hue":0,"splitDesc":"","chapters":[b,a]
        })).unwrap();
        let tx = db.transaction().unwrap();
        put(&tx, &book).unwrap();
        tx.commit().unwrap();
        assert_eq!(keys(&db, "a").len(), 1);
        assert_eq!(keys(&db, "b").len(), 1);
        book.chapters.truncate(1);
        let tx = db.transaction().unwrap();
        put(&tx, &book).unwrap();
        tx.commit().unwrap();
        assert_eq!(keys(&db, "b").len(), 1);
        assert_eq!(db.query_row("SELECT count(*) FROM translations WHERE cid='a'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        drop(db); std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn v3_migration_rebuilds_untraceable_cache_and_preserves_book_state() {
        let (root, db) = fixture();
        save_chapter(&db, "b", 0, &ch("c", &["Source"])).unwrap();
        db.execute("INSERT INTO translation_books VALUES('b',?1)", ["{\"overrides\":{},\"terms\":[]}"]).unwrap();
        db.execute_batch("DROP TABLE translations;
            CREATE TABLE translations(book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE ON UPDATE CASCADE,
                cid TEXT NOT NULL,key TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(book_id,cid,key));
            INSERT INTO translations VALUES('b','c','legacy','cached'); PRAGMA user_version=3;").unwrap();
        drop(db);
        let db = connect(&root).unwrap();
        assert_eq!(db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)).unwrap(), 4);
        assert!(keys(&db, "c").is_empty());
        assert_eq!(chapter(&db, "b", "c").unwrap().unwrap().paragraphs, vec!["Source"]);
        assert_eq!(translation_book(&db, "b").unwrap(), json!({"overrides":{},"terms":[]}));
        drop(db); std::fs::remove_dir_all(root).unwrap();
    }
}

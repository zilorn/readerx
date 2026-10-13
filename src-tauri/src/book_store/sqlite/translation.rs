//! Local cache; chapter revision leases reject late responses after edits/reloads.
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
    for (key,text) in entries {
        let text = text.as_str().ok_or("译文无效")?;
        if key.len() != 64 || !key.bytes().all(|c|c.is_ascii_hexdigit()) || text.is_empty() || text.len() > 512 * 1024 { return Err("译文无效".into()); }
        tx.execute("INSERT INTO translations(book_id,cid,key,text) VALUES(?1,?2,?3,?4) ON CONFLICT(book_id,cid,key) DO UPDATE SET text=excluded.text", params![id,cid,key,text]).map_err(sql)?;
    }
    tx.commit().map_err(sql)?;
    Ok(true)
}
pub(in crate::book_store) fn invalidate_translations(db: &Connection, id: &str, cid: &str) -> Result<(), String> {
    db.execute("DELETE FROM translations WHERE book_id=?1 AND cid=?2",params![id,cid]).map_err(sql)?;
    db.execute("INSERT INTO translation_epochs(book_id,cid,epoch) VALUES(?1,?2,1) ON CONFLICT(book_id,cid) DO UPDATE SET epoch=epoch+1",params![id,cid]).map_err(sql)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leases_invalidation_and_cascade() {
        let root = std::env::temp_dir().join(format!("readerx-translation-{}", readerx_sync::new_id()));
        let mut db = connect(&root).unwrap();
        db.execute("INSERT INTO books VALUES('b','{}')", []).unwrap();
        db.execute("INSERT INTO chapters VALUES('b',0,'c','{}','{}','original','[]')",[]).unwrap();
        let rev = revision(&db,"b","c").unwrap();
        let mut entries = serde_json::Map::new();
        entries.insert("a".repeat(64), Value::String("译文".into()));
        assert!(put_translation_cache(&mut db,"b","c",&rev,&entries).unwrap());
        invalidate_translations(&db,"b","c").unwrap();
        assert!(!put_translation_cache(&mut db,"b","c",&rev,&entries).unwrap());
        assert!(translation_cache(&db,"b","c").unwrap()["entries"].as_object().unwrap().is_empty());
        let rev = revision(&db,"b","c").unwrap();
        assert!(put_translation_cache(&mut db,"b","c",&rev,&entries).unwrap());
        db.execute("UPDATE chapters SET digest='edited'",[]).unwrap();
        assert!(!put_translation_cache(&mut db,"b","c",&rev,&entries).unwrap());
        db.execute("DELETE FROM books WHERE id='b'",[]).unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM translations",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        drop(db); std::fs::remove_dir_all(root).unwrap();
    }
}

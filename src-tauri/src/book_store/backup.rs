//! SQLite backup snapshots and read-only archive validation.
use super::*;

/// A self-contained, read-only backup. Close the connection before removing its file.
pub(crate) struct BackupDatabase {
    db: Connection,
    temporary: crate::temporary_file::TemporaryFile,
}
impl BackupDatabase {
    pub(crate) fn open(temporary: crate::temporary_file::TemporaryFile) -> Result<Self, String> {
        let db =
            Connection::open_with_flags(&temporary.0, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(sql)?;
        db.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")
            .map_err(sql)?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(sql)?;
        if version != DATABASE_VERSION {
            return Err("备份书库数据库格式版本不受支持".into());
        }
        let integrity: String = db
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(sql)?;
        if integrity != "ok" {
            return Err("备份书库数据库已损坏".into());
        }
        // Only ordinary application tables are queried, never archive-supplied views/triggers.
        for table in ["books", "chapters", "bookmarks", "annotations"] {
            let ordinary: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_list WHERE schema='main' AND name=?1 AND type='table')",
                [table], |r| r.get(0)).map_err(sql)?;
            if !ordinary {
                return Err("备份书库数据库缺少有效数据表".into());
            }
        }
        let foreign_key_error = db
            .prepare("PRAGMA foreign_key_check")
            .map_err(sql)?
            .exists([])
            .map_err(sql)?;
        if foreign_key_error {
            return Err("备份书库数据库引用无效".into());
        }
        let backup = Self { db, temporary };
        // Validate every payload before import can mutate local data, without loading the library.
        for id in backup.ids()? {
            valid_id(&id)?;
            let d = detail(&backup.db, &id)?.ok_or("备份缺少书籍元信息")?;
            if d.id != id || d.schema_version != 1 {
                return Err("备份书籍元信息无效".into());
            }
            let mut query = backup
                .db
                .prepare("SELECT chapter FROM chapters WHERE book_id=?1")
                .map_err(sql)?;
            let rows = query
                .query_map([&id], |r| r.get::<_, String>(0))
                .map_err(sql)?;
            for row in rows {
                let _: LocalBookChapter = decode(&row.map_err(sql)?)?;
            }
            records(&backup.db, "bookmarks", &id)?;
            for paragraph in records(&backup.db, "annotations", &id)? {
                let notes = paragraph
                    .get("notes")
                    .and_then(Value::as_array)
                    .ok_or("备份注释列表无效")?;
                for note in notes {
                    if note.get("id").and_then(Value::as_str).is_none() {
                        return Err("备份注释身份无效".into());
                    }
                }
            }
        }
        Ok(backup)
    }
    #[cfg(test)]
    pub(super) fn path(&self) -> &Path {
        &self.temporary.0
    }
    pub(crate) fn ids(&self) -> Result<Vec<String>, String> {
        let mut query = self
            .db
            .prepare("SELECT id FROM books ORDER BY id")
            .map_err(sql)?;
        let rows = query
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(sql)?;
        rows.map(|r| r.map_err(sql)).collect()
    }
    /// Adapt a single book to the existing restore pipeline; these are not ZIP entries.
    pub(crate) fn read(&self, id: &str, file: &str) -> Result<Option<Vec<u8>>, String> {
        let value = match file {
            BOOKDETAIL_FILE => detail(&self.db, id)?
                .map(|d| serde_json::to_value(d).map_err(|e| e.to_string()))
                .transpose()?,
            CONTENT_FILE => Some(
                serde_json::to_value(BookContent {
                    schema_version: 1,
                    chapters: chapters(&self.db, id)?,
                })
                .map_err(|e| e.to_string())?,
            ),
            BOOKMARKS_FILE => Some(
                serde_json::json!({"schemaVersion":1,"bookmarks":records(&self.db,"bookmarks",id)?}),
            ),
            ANNOTATIONS_FILE => Some(
                serde_json::json!({"schemaVersion":1,"annotations":records(&self.db,"annotations",id)?}),
            ),
            _ => None,
        };
        value
            .map(|v| serde_json::to_vec(&v).map_err(|e| e.to_string()))
            .transpose()
    }
    pub(crate) fn write_zip(
        &self,
        zip: &mut zip::ZipWriter<fs::File>,
        report: &mut dyn FnMut(&str, u64, u64),
    ) -> Result<(), String> {
        let total = self.ids()?.len() as u64;
        report("books", 0, total);
        zip.start_file(
            DATABASE,
            crate::data_transfer::archive::text_options(Some(&self.temporary.0)),
        )
        .map_err(|e| e.to_string())?;
        let mut file = fs::File::open(&self.temporary.0).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, zip).map_err(|e| e.to_string())?;
        report("books", total, total);
        Ok(())
    }
}

/// VACUUM INTO includes committed WAL pages and produces a compact consistent snapshot.
pub(crate) fn snapshot(db: &Connection, root: &Path) -> Result<BackupDatabase, String> {
    let dir = root.join("books");
    crate::storage::ensure_dir(&dir)?;
    let temporary = crate::temporary_file::TemporaryFile(
        dir.join(format!(".backup-{}.tmp", readerx_sync::new_id())),
    );
    drop(
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary.0)
            .map_err(|e| e.to_string())?,
    );
    db.execute(
        "VACUUM INTO ?1",
        [temporary.0.to_str().ok_or("备份临时路径无效")?],
    )
    .map_err(sql)?;
    BackupDatabase::open(temporary)
}

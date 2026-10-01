//! 文件迁移先持久化完整待办；重跑只重复写相同内容，最后才删除旧文件。
use crate::{identity::source_id, models::BookSource, store::valid_component};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

#[derive(Default, Serialize, Deserialize)]
pub struct FilePlan {
    pub writes: BTreeMap<PathBuf, Value>,
    pub deletes: Vec<PathBuf>,
}

pub fn read(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

pub fn write(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension("id-migration.tmp");
    let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, value).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

impl FilePlan {
    pub fn commit(&self, root: &Path, journal: &str) -> Result<(), String> {
        if self.writes.is_empty() && self.deletes.is_empty() {
            return Ok(());
        }
        write(
            &root.join(journal),
            &serde_json::to_value(self).map_err(|e| e.to_string())?,
        )?;
        Self::resume(root, journal)
    }
    pub fn resume(root: &Path, journal: &str) -> Result<(), String> {
        let path = root.join(journal);
        if !path.exists() {
            return Ok(());
        }
        let plan: Self = serde_json::from_value(read(&path)?).map_err(|e| e.to_string())?;
        for relative in plan.writes.keys().chain(plan.deletes.iter()) {
            if relative.as_os_str().is_empty()
                || relative
                    .components()
                    .any(|c| !matches!(c, std::path::Component::Normal(_)))
            {
                return Err("ID 迁移待办包含非法路径".into());
            }
        }
        for (relative, value) in plan.writes {
            write(&root.join(relative), &value)?;
        }
        for relative in plan.deletes {
            let old = root.join(relative);
            if old.exists() {
                fs::remove_file(old).map_err(|e| e.to_string())?;
            }
        }
        fs::remove_file(path).map_err(|e| e.to_string())
    }
}

pub fn json_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .map(|entry| entry.map(|e| e.path()).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()
        .map(|paths| {
            paths
                .into_iter()
                .filter(|p| p.is_file() && p.extension().is_some_and(|e| e == "json"))
                .collect()
        })
}

/// 两种书籍布局都只读取元信息；未知字段原样保存。
pub fn details(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = json_files(&root.join("books"))?;
    if root.join("books").exists() {
        for entry in fs::read_dir(root.join("books")).map_err(|e| e.to_string())? {
            let path = entry
                .map_err(|e| e.to_string())?
                .path()
                .join("bookdetail.json");
            if path.is_file() {
                paths.push(path);
            }
        }
    }
    Ok(paths)
}

/// aliases 用于合并旧备份：归档旧 ID 对应本机已有稳定书源。
pub fn migrate(root: &Path, aliases: &BTreeMap<String, String>) -> Result<(), String> {
    const JOURNAL: &str = "migrations/readerx.sourceIdMigration.json";
    FilePlan::resume(root, "migrations/readerx.sourceSaveMigration.json")?;
    FilePlan::resume(root, JOURNAL)?;
    let mut plan = FilePlan::default();
    let mut remap = aliases.clone();
    let mut targets = BTreeMap::new();
    for path in json_files(&root.join("book_sources"))? {
        let mut value = read(&path)?;
        let source: BookSource =
            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        if !valid_component(&source.id) {
            return Err("书源 ID 非法，原数据已保留".into());
        }
        let new = if source.id.len() == 18
            && source.id.starts_with("s-")
            && source.id[2..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            source.id.clone()
        } else {
            source_id(&source.book_source_url)
        };
        let target = PathBuf::from("book_sources").join(format!("{new}.json"));
        if let Some(previous) = targets.insert(new.clone(), value.clone()) {
            // 同地址重复文件不能自动丢弃不同规则。
            let mut previous = previous;
            previous["id"] = Value::Null;
            let mut current = value.clone();
            current["id"] = Value::Null;
            if previous != current {
                return Err("书源存在重复身份且内容不同，原数据已保留".into());
            }
        }
        remap.insert(source.id.clone(), new.clone());
        value["id"] = Value::String(new.clone());
        if path != root.join(&target) {
            plan.writes.insert(target, value);
            plan.deletes.push(
                path.strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_owned(),
            );
        }
    }
    for path in details(root)? {
        let mut value = read(&path)?;
        if let Some(new) = value
            .get("bookSourceId")
            .and_then(Value::as_str)
            .and_then(|id| remap.get(id))
        {
            if value["bookSourceId"] != *new {
                value["bookSourceId"] = Value::String(new.clone());
                plan.writes
                    .insert(path.strip_prefix(root).unwrap().to_owned(), value);
            }
        }
    }
    for (old, new) in remap.iter().filter(|(old, new)| old != new) {
        if !valid_component(old) || !valid_component(new) {
            return Err("书源 ID 迁移引用非法".into());
        }
        for directory in ["source_sessions", "profiles"] {
            let from = PathBuf::from(directory).join(format!("{old}.json"));
            let to = PathBuf::from(directory).join(format!("{new}.json"));
            if root.join(&from).exists() {
                let value = read(&root.join(&from))?;
                if root.join(&to).exists() && read(&root.join(&to))? != value {
                    return Err("书源 ID 迁移登录态冲突，原数据已保留".into());
                }
                if plan
                    .writes
                    .get(&to)
                    .is_some_and(|existing| existing != &value)
                {
                    return Err("书源 ID 迁移登录态冲突，原数据已保留".into());
                }
                plan.writes.insert(to, value);
                plan.deletes.push(from);
            }
        }
    }
    let changed = plan.writes.len();
    plan.commit(root, JOURNAL)?;
    if changed > 0 {
        log::info!("书源 ID 迁移完成 files={changed}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn migrates_detail_session_and_resumes_without_losing_unknown_fields() {
        let root = std::env::temp_dir().join(format!(
            "readerx-source-id-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let source = json!({"schemaVersion":1,"id":"old","name":"源","bookSourceUrl":"https://example.com","js":""});
        write(&root.join("book_sources/old.json"), &source).unwrap();
        write(
            &root.join("books/book/bookdetail.json"),
            &json!({"id":"book","bookSourceId":"old","extra":42}),
        )
        .unwrap();
        write(
            &root.join("source_sessions/old.json"),
            &json!({"cookie":"secret","storage":{"version":1}}),
        )
        .unwrap();
        migrate(&root, &BTreeMap::new()).unwrap();
        migrate(&root, &BTreeMap::new()).unwrap();
        let id = source_id("https://example.com");
        assert_eq!(
            read(&root.join("books/book/bookdetail.json")).unwrap(),
            json!({"id":"book","bookSourceId":id,"extra":42})
        );
        assert!(root.join(format!("source_sessions/{id}.json")).exists());
        assert!(!root.join("book_sources/old.json").exists());
        let plan = FilePlan {
            writes: BTreeMap::from([(PathBuf::from("state/test.json"), json!({"ok":true}))]),
            deletes: vec![PathBuf::from("source_sessions/old.json")],
        };
        write(
            &root.join("state/test-migration.json"),
            &serde_json::to_value(plan).unwrap(),
        )
        .unwrap();
        FilePlan::resume(&root, "state/test-migration.json").unwrap();
        assert_eq!(
            read(&root.join("state/test.json")).unwrap(),
            json!({"ok":true})
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn conflicting_login_states_leave_all_original_files_intact() {
        let root = std::env::temp_dir().join(format!(
            "readerx-source-conflict-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let id = source_id("https://example.com");
        write(
            &root.join("book_sources/old.json"),
            &json!({"id":"old","name":"源","bookSourceUrl":"https://example.com","js":""}),
        )
        .unwrap();
        write(
            &root.join("source_sessions/old.json"),
            &json!({"cookie":"old"}),
        )
        .unwrap();
        write(
            &root.join(format!("source_sessions/{id}.json")),
            &json!({"cookie":"existing"}),
        )
        .unwrap();
        assert!(migrate(&root, &BTreeMap::new()).is_err());
        assert!(root.join("book_sources/old.json").is_file());
        assert!(!root.join(format!("book_sources/{id}.json")).exists());
        assert_eq!(
            read(&root.join("source_sessions/old.json")).unwrap()["cookie"],
            "old"
        );
        assert_eq!(
            read(&root.join(format!("source_sessions/{id}.json"))).unwrap()["cookie"],
            "existing"
        );
        fs::remove_dir_all(root).unwrap();
    }
}

/// 保存书源时一次性迁移旧 ID 的文件与引用，避免新旧源文件同时参与身份扫描。
pub fn save_source(root: &Path, source: &BookSource, old_id: &str) -> Result<(), String> {
    const JOURNAL: &str = "migrations/readerx.sourceSaveMigration.json";
    FilePlan::resume(root, JOURNAL)?;
    if !valid_component(old_id) || !valid_component(&source.id) {
        return Err("书源 ID 非法".into());
    }
    let mut plan = FilePlan::default();
    plan.writes.insert(
        PathBuf::from(format!("book_sources/{}.json", source.id)),
        serde_json::to_value(source).map_err(|e| e.to_string())?,
    );
    if old_id != source.id {
        plan.deletes
            .push(PathBuf::from(format!("book_sources/{old_id}.json")));
        for path in details(root)? {
            let mut value = read(&path)?;
            if value.get("bookSourceId").and_then(Value::as_str) == Some(old_id) {
                value["bookSourceId"] = Value::String(source.id.clone());
                plan.writes
                    .insert(path.strip_prefix(root).unwrap().to_owned(), value);
            }
        }
        for directory in ["source_sessions", "profiles"] {
            let from = PathBuf::from(format!("{directory}/{old_id}.json"));
            let to = PathBuf::from(format!("{directory}/{}.json", source.id));
            if root.join(&from).exists() {
                let value = read(&root.join(&from))?;
                if root.join(&to).exists() && read(&root.join(&to))? != value {
                    return Err("书源 ID 迁移登录态冲突，原数据已保留".into());
                }
                plan.writes.insert(to, value);
                plan.deletes.push(from);
            }
        }
    }
    plan.commit(root, JOURNAL)
}

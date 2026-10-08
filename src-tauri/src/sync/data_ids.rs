//! 分组、规则及其引用统一 ID；书籍 ID 迁移完成后执行。
use super::identity;
use readerx_source::id_migration::{self, FilePlan};
use serde_json::Value;
use std::{collections::BTreeMap, path::Path};

pub fn migrate(root: &Path) -> Result<(), String> {
    const JOURNAL: &str = "migrations/readerx.dataIdMigration.json";
    FilePlan::resume(root, JOURNAL)?;
    if unreadable_book_details(root)? {
        // Keep the original groups/sources until their references can be remapped on retry.
        return Ok(());
    }
    migrate_sources(root, &BTreeMap::new())?;
    let mut plan = FilePlan::default();
    let mut groups = BTreeMap::new();
    let mut source_groups = BTreeMap::new();
    for (key, prefix, uid_of, remap) in [
        (
            "readerx.groups",
            "g-",
            identity::group_uid as fn(&str) -> String,
            &mut groups,
        ),
        (
            "readerx.sourceGroups",
            "sg-",
            identity::source_group_uid as fn(&str) -> String,
            &mut source_groups,
        ),
    ] {
        let relative = std::path::PathBuf::from(format!("state/{key}.json"));
        if !root.join(&relative).exists() {
            continue;
        }
        let mut value = id_migration::read(&root.join(&relative))?;
        for item in value.as_array_mut().into_iter().flatten() {
            let old = text(item, "id");
            if old == "__hidden__" {
                continue;
            }
            let new = identity::entity_id(&old, prefix, uid_of(&text(item, "name")));
            remap.insert(old, new.clone());
            item["id"] = Value::String(new);
        }
        plan.writes.insert(relative, value);
    }
    for path in id_migration::details(root)? {
        let mut value = id_migration::read(&path)?;
        replace_group(&mut value, &groups);
        plan.writes
            .insert(path.strip_prefix(root).unwrap().to_owned(), value);
    }
    for path in id_migration::json_files(&root.join("book_sources"))? {
        let mut value = id_migration::read(&path)?;
        replace_group(&mut value, &source_groups);
        plan.writes
            .insert(path.strip_prefix(root).unwrap().to_owned(), value);
    }
    for (key, prefix) in [
        ("readerx.textReplacements", "tr-"),
        ("readerx.chapterRules", "cr-"),
    ] {
        let relative = std::path::PathBuf::from(format!("state/{key}.json"));
        if !root.join(&relative).exists() {
            continue;
        }
        let mut value = id_migration::read(&root.join(&relative))?;
        for item in value.as_array_mut().into_iter().flatten() {
            if item.get("builtin").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let fallback = if prefix == "tr-" {
                let scope = if text(item, "scope") == "book" {
                    "book"
                } else {
                    "global"
                };
                let book_id = if scope == "book" {
                    text(item, "bookId")
                } else {
                    String::new()
                };
                identity::text_replace_uid(
                    scope,
                    &book_id,
                    &text(item, "find"),
                    &text(item, "replace"),
                    item.get("regex").and_then(Value::as_bool).unwrap_or(false),
                )
            } else {
                identity::chapter_rule_uid(&text(item, "name"), &text(item, "pattern"))
            };
            item["id"] = Value::String(fallback);
        }
        plan.writes.insert(relative, value);
    }
    // 相同旧身份收敛为同一个 ID：保留第一项，避免重复出现在界面。
    for value in plan.writes.values_mut() {
        if let Some(items) = value.as_array_mut() {
            let mut seen = std::collections::BTreeSet::new();
            items.retain(|item| seen.insert(text(item, "id")));
        }
    }
    plan.writes
        .retain(|path, value| id_migration::read(&root.join(path)).ok().as_ref() != Some(value));
    let changed = plan.writes.len();
    // Apply DB references before the file plan: failed file writes leave the old groups
    // available for deriving the same mapping on retry.
    crate::book_store::remap_metadata_at(root, "groupId", &groups)?;
    plan.commit(root, JOURNAL)?;
    if changed > 0 {
        log::info!("同步数据 ID 迁移完成 files={changed}");
    }
    Ok(())
}
/// Journal aliases before source files can be renamed by the source crate.
/// A crash between source migration and DB updates must not lose the old ID mapping.
pub(crate) fn migrate_sources(
    root: &Path,
    aliases: &BTreeMap<String, String>,
) -> Result<(), String> {
    let journal = root.join("migrations/readerx.sqliteSourceRefs.json");
    let mut remap: BTreeMap<String, String> = if journal.is_file() {
        serde_json::from_value(id_migration::read(&journal)?).map_err(|e| e.to_string())?
    } else {
        BTreeMap::new()
    };
    remap.extend(aliases.clone());
    for path in id_migration::json_files(&root.join("book_sources"))? {
        let value = id_migration::read(&path)?;
        let old = text(&value, "id");
        remap.entry(old.clone()).or_insert_with(|| {
            identity::entity_id(
                &old,
                "s-",
                identity::source_uid(&text(&value, "bookSourceUrl")),
            )
        });
    }
    if !remap.is_empty() {
        id_migration::write(
            &journal,
            &serde_json::to_value(&remap).map_err(|e| e.to_string())?,
        )?;
    }
    if unreadable_book_details(root)? {
        return Ok(());
    }
    id_migration::migrate(root, &remap)?;
    crate::book_store::remap_metadata_at(root, "bookSourceId", &remap)?;
    if journal.is_file() {
        std::fs::remove_file(journal).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn unreadable_book_details(root: &Path) -> Result<bool, String> {
    let mut pending = false;
    for path in id_migration::details(root)? {
        if id_migration::read(&path).is_err() {
            log::warn!("旧书籍元信息无法读取，保留身份迁移待办，稍后重试");
            pending = true;
        }
    }
    Ok(pending)
}

/// The shared source crate still owns file writes; the App maintains SQLite references.
pub(crate) fn save_source(
    root: &Path,
    source: &readerx_source::models::BookSource,
    old: &str,
) -> Result<(), String> {
    if !readerx_source::store::valid_component(old)
        || !readerx_source::store::valid_component(&source.id)
    {
        return Err("书源 ID 非法".into());
    }
    let journal = root.join("migrations/readerx.sqliteSourceRefs.json");
    let mut remap: BTreeMap<String, String> = if journal.is_file() {
        serde_json::from_value(id_migration::read(&journal)?).map_err(|e| e.to_string())?
    } else {
        BTreeMap::new()
    };
    remap.insert(old.to_string(), source.id.clone());
    id_migration::write(
        &journal,
        &serde_json::to_value(&remap).map_err(|e| e.to_string())?,
    )?;
    id_migration::save_source(root, source, old)?;
    crate::book_store::remap_metadata_at(root, "bookSourceId", &remap)?;
    std::fs::remove_file(journal).map_err(|e| e.to_string())
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
fn replace_group(value: &mut Value, remap: &BTreeMap<String, String>) {
    if let Some(new) = value
        .get("groupId")
        .and_then(Value::as_str)
        .and_then(|id| remap.get(id))
    {
        value["groupId"] = Value::String(new.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn all_references_follow_migrated_ids_and_edits_keep_them() {
        let root =
            std::env::temp_dir().join(format!("readerx-data-ids-{}", readerx_sync::new_id()));
        let seed = [
            (
                "state/readerx.groups.json",
                json!([{"id":"old-group","name":"科幻","createdAt":1}]),
            ),
            (
                "state/readerx.sourceGroups.json",
                json!([{"id":"old-source-group","name":"网站","createdAt":2}]),
            ),
            (
                "state/readerx.textReplacements.json",
                json!([{"id":"old-rule","scope":"book","bookId":"b-0123456789abcdef","find":"甲","replace":"乙","regex":false,"createdAt":3}]),
            ),
            (
                "state/readerx.chapterRules.json",
                json!([{"id":"old-chapter-rule","name":"章节","pattern":"^第","createdAt":4}]),
            ),
            (
                "books/b-0123456789abcdef/bookdetail.json",
                json!({"id":"b-0123456789abcdef","groupId":"old-group","bookSourceId":"old-source","unknown":42}),
            ),
            (
                "book_sources/old-source.json",
                json!({"id":"old-source","name":"源","bookSourceUrl":"https://example.com","groupId":"old-source-group","js":""}),
            ),
        ];
        for (path, value) in seed {
            id_migration::write(&root.join(path), &value).unwrap();
        }
        migrate(&root).unwrap();
        migrate(&root).unwrap();
        let detail =
            id_migration::read(&root.join("books/b-0123456789abcdef/bookdetail.json")).unwrap();
        assert_eq!(detail["groupId"], identity::group_uid("科幻"));
        assert_eq!(
            detail["bookSourceId"],
            identity::source_uid("https://example.com")
        );
        assert_eq!(detail["unknown"], 42);
        let source = id_migration::read(&root.join(format!(
            "book_sources/{}.json",
            identity::source_uid("https://example.com")
        )))
        .unwrap();
        assert_eq!(source["groupId"], identity::source_group_uid("网站"));
        let rule = id_migration::read(&root.join("state/readerx.textReplacements.json")).unwrap();
        assert_eq!(
            rule[0]["id"],
            identity::text_replace_uid("book", "b-0123456789abcdef", "甲", "乙", false)
        );
        let path = root.join("state/readerx.groups.json");
        let mut renamed = id_migration::read(&path).unwrap();
        renamed[0]["name"] = json!("新名字");
        id_migration::write(&path, &renamed).unwrap();
        migrate(&root).unwrap();
        assert_eq!(id_migration::read(&path).unwrap(), renamed);
        std::fs::remove_dir_all(root).unwrap();
    }
}

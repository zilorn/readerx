//! 合并规则（导入的「合并」语义）：输入两份 JSON，输出要落盘的那一份。
//!
//! 状态 API 同时适配 SQLite 与旧 JSON：`readerx.shelf` 是全库阅读进度的逻辑视图，
//! `readerx.groups` / `readerx.textReplacements` 装着全部分组与替换规则 —— 整份覆盖
//! 会把本机那份数据抹掉。因此按**身份**取并集：
//!
//! | 状态 key | 身份 | 并发 / 重复时 |
//! | --- | --- | --- |
//! | `readerx.shelf` | 书籍 id | `updatedAt` 较新的一方胜出（与同步的进度口径一致） |
//! | `readerx.groups` / `readerx.sourceGroups` | 分组名 | 本机已有同名分组则不动（书 / 书源的归属按名字对上） |
//! | `readerx.textReplacements` | 规则内容（作用域 + 书 + 查找 + 替换 + 是否正则） | 同一条规则只留一份 |
//! | `readerx.chapterRules` | 规则名 + 正则 | 同上 |
//! | `readerx.webdavServers` | 服务器地址 | 本机已有同地址配置则不动 |
//! | 其余（偏好类） | —— | 本机有就保持本机（主题 / 字号不该被别人的备份改掉） |
//!
//! 身份口径直接复用同步的 `identity` 模块（见 `src/sync/identity.rs`）：导入与同步
//! 对「这是不是同一本书 / 同一条规则」必须给出同一个答案，否则两台设备会各算各的。

use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

pub(super) const SHELF_KEY: &str = "readerx.shelf";
pub(super) const GROUPS_KEY: &str = "readerx.groups";
pub(super) const SOURCE_GROUPS_KEY: &str = "readerx.sourceGroups";
pub(super) const TEXT_REPLACES_KEY: &str = "readerx.textReplacements";
pub(super) const CHAPTER_RULES_KEY: &str = "readerx.chapterRules";
pub(super) const WEBDAV_SERVERS_KEY: &str = "readerx.webdavServers";

/// 内容类状态：覆盖恢复时归档里没有它们，就要把本机那份清掉 ——
/// 「备份里没有分组」也是一条事实，留着本机的分组就不叫恢复了。
pub(super) const CONTENT_KEYS: [&str; 5] = [
    SHELF_KEY,
    GROUPS_KEY,
    SOURCE_GROUPS_KEY,
    TEXT_REPLACES_KEY,
    CHAPTER_RULES_KEY,
];

/// 归档 id → 本机 id 的换算表。
///
/// 同一本书在两台设备上的本机 id 不同（`local-<时间>-<随机>`），导入时要先按跨设备身份
/// 把归档里的 id 翻成本机的 id，进度、书签、按书生效的替换规则才能落到正确的书上。
#[derive(Debug, Default, Clone)]
pub(super) struct Remap {
    /// 归档书籍 id → 本机书籍 id
    pub books: HashMap<String, String>,
    /// 本机书籍 id → 书籍 uid（算规则身份用）
    pub book_uids: HashMap<String, String>,
    /// 归档书籍 id → 书籍 uid
    pub archive_book_uids: HashMap<String, String>,
    /// 归档书架分组 id → 本机分组 id
    pub groups: HashMap<String, String>,
    /// 归档书源分组 id → 本机书源分组 id
    pub source_groups: HashMap<String, String>,
}

impl Remap {
    /// 归档书籍 id → 本机书籍 id（换算表里没有就按原样用：同机恢复时两边 id 相同）
    pub(super) fn book(&self, archive_id: &str) -> String {
        self.books
            .get(archive_id)
            .cloned()
            .unwrap_or_else(|| archive_id.to_string())
    }
}

/// 合并一个状态文件（`local` 为 `None` 表示本机还没有这个文件）。
pub(super) fn merge_state(
    key: &str,
    local: Option<&Value>,
    incoming: &Value,
    remap: &Remap,
) -> Value {
    match key {
        SHELF_KEY => merge_shelf(local, incoming, remap),
        GROUPS_KEY => merge_groups(local, incoming, &remap.groups),
        SOURCE_GROUPS_KEY => merge_groups(local, incoming, &remap.source_groups),
        TEXT_REPLACES_KEY => merge_text_replaces(local, incoming, remap),
        CHAPTER_RULES_KEY => merge_chapter_rules(local, incoming),
        WEBDAV_SERVERS_KEY => merge_by_key(local, incoming, server_key),
        // 偏好类：本机有就保持本机（导入别人的备份不该改掉自己的主题 / 字号）
        _ => match local {
            Some(local) => local.clone(),
            None => incoming.clone(),
        },
    }
}

/// 阅读进度：按书籍 id 取并集，同一本书取 `updatedAt` 较新的那份。
///
/// 本机没有、归档里有的条目**照单收下**（归档里的书导进来后，进度就该跟着出现）；
/// 归档里没有的本机条目原样保留。
fn merge_shelf(local: Option<&Value>, incoming: &Value, remap: &Remap) -> Value {
    let mut out: Map<String, Value> = local
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (archive_id, entry) in incoming.as_object().into_iter().flatten() {
        if !entry.is_object() {
            continue;
        }
        let local_id = remap.book(archive_id);
        if local_id.is_empty() {
            continue;
        }
        let mut entry = entry.clone();
        if let Some(entry) = entry.as_object_mut() {
            entry.insert("bookId".to_string(), Value::String(local_id.clone()));
        }
        let updated = entry.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
        match out.get(&local_id) {
            None => {
                out.insert(local_id, entry);
            }
            Some(existing) => {
                let current = existing
                    .get("updatedAt")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if updated > current {
                    out.insert(local_id, entry);
                }
            }
        }
    }
    Value::Object(out)
}

/// 分组：按名字取并集。本机已有同名分组时保留本机那份（id 不同，归档里引用它的地方
/// 已经在 [`Remap`] 里翻成了本机 id）。
fn merge_groups(local: Option<&Value>, incoming: &Value, remap: &HashMap<String, String>) -> Value {
    let mut out: Vec<Value> = items(local).to_vec();
    let mut seen: HashSet<String> = out.iter().filter_map(group_name).collect();
    for group in items(Some(incoming)) {
        let Some(name) = group_name(group) else {
            continue;
        };
        if !seen.insert(name) {
            continue;
        }
        let archive_id = group.get("id").and_then(Value::as_str).unwrap_or_default();
        let local_id = remap.get(archive_id).cloned().unwrap_or_default();
        if local_id.is_empty() || out.iter().any(|g| group_id(g) == Some(local_id.as_str())) {
            continue;
        }
        let mut group = group.clone();
        if let Some(object) = group.as_object_mut() {
            object.insert("id".to_string(), Value::String(local_id));
        }
        out.push(group);
    }
    Value::Array(out)
}

/// 文本替换规则：按规则内容取并集；归档规则的书籍归属翻成本机书 id。
fn merge_text_replaces(local: Option<&Value>, incoming: &Value, remap: &Remap) -> Value {
    let mut out: Vec<Value> = items(local).to_vec();
    let mut seen: HashSet<String> = out
        .iter()
        .map(|rule| replace_rule_uid(rule, &remap.book_uids))
        .collect();
    for rule in items(Some(incoming)) {
        let uid = replace_rule_uid(rule, &remap.archive_book_uids);
        if !seen.insert(uid) {
            continue;
        }
        let mut rule = rule.clone();
        if let Some(object) = rule.as_object_mut() {
            let archive_book = object
                .get("bookId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if !archive_book.is_empty() {
                object.insert(
                    "bookId".to_string(),
                    Value::String(remap.book(&archive_book)),
                );
            }
        }
        out.push(rule);
    }
    Value::Array(out)
}

/// 分章规则：名称 + 正则即身份（与同步口径一致）
fn merge_chapter_rules(local: Option<&Value>, incoming: &Value) -> Value {
    let mut out: Vec<Value> = items(local).to_vec();
    let mut seen: HashSet<String> = out.iter().map(chapter_rule_uid).collect();
    for rule in items(Some(incoming)) {
        if !seen.insert(chapter_rule_uid(rule)) {
            continue;
        }
        out.push(rule.clone());
    }
    Value::Array(out)
}

/// 通用「按某个字段取并集」：本机已有同一个键就保留本机那条
fn merge_by_key(
    local: Option<&Value>,
    incoming: &Value,
    key_of: fn(&Value) -> Option<String>,
) -> Value {
    let mut out: Vec<Value> = items(local).to_vec();
    let mut seen: HashSet<String> = out.iter().filter_map(key_of).collect();
    for item in items(Some(incoming)) {
        let Some(key) = key_of(item) else {
            continue;
        };
        if !seen.insert(key) {
            continue;
        }
        out.push(item.clone());
    }
    Value::Array(out)
}

/// 规则身份：与 `sync::identity::text_replace_uid` 同一口径（作用域 + 书 uid + 五元组）
fn replace_rule_uid(rule: &Value, book_uids: &HashMap<String, String>) -> String {
    let scope = rule
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("global");
    let book_id = rule.get("bookId").and_then(Value::as_str).unwrap_or("");
    let book_uid = book_uids
        .get(book_id)
        .cloned()
        .unwrap_or_else(|| book_id.to_string());
    let find = rule.get("find").and_then(Value::as_str).unwrap_or("");
    let replace = rule.get("replace").and_then(Value::as_str).unwrap_or("");
    let regex = rule.get("regex").and_then(Value::as_bool).unwrap_or(false);
    let scope_key = if scope == "book" { scope } else { "global" };
    let book_key = if scope_key == "book" {
        book_uid.as_str()
    } else {
        ""
    };
    crate::sync::identity::text_replace_uid(scope_key, book_key, find, replace, regex)
}

fn chapter_rule_uid(rule: &Value) -> String {
    let name = rule.get("name").and_then(Value::as_str).unwrap_or("");
    let pattern = rule.get("pattern").and_then(Value::as_str).unwrap_or("");
    if name.is_empty() && pattern.is_empty() {
        // 连名字和正则都没有的条目只能按 id 去重（畸形数据，不猜）
        return format!(
            "cr-id:{}",
            rule.get("id").and_then(Value::as_str).unwrap_or("")
        );
    }
    crate::sync::identity::chapter_rule_uid(name, pattern)
}

/// WebDAV 服务器身份：地址（大小写与末尾斜杠归一，与书源地址同口径）
fn server_key(server: &Value) -> Option<String> {
    let url = server.get("url").and_then(Value::as_str)?.trim();
    if url.is_empty() {
        return None;
    }
    Some(url.trim_end_matches('/').to_lowercase())
}

fn group_name(group: &Value) -> Option<String> {
    let name = group.get("name").and_then(Value::as_str)?.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn group_id(group: &Value) -> Option<&str> {
    group.get("id").and_then(Value::as_str)
}

fn items(value: Option<&Value>) -> &[Value] {
    value
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn remap() -> Remap {
        let mut remap = Remap::default();
        remap
            .books
            .insert("local-a".to_string(), "local-a".to_string());
        remap
            .books
            .insert("local-b".to_string(), "local-c".to_string());
        remap
            .book_uids
            .insert("local-a".to_string(), "b-aaa".to_string());
        remap
            .book_uids
            .insert("local-c".to_string(), "b-bbb".to_string());
        remap
            .archive_book_uids
            .insert("local-a".to_string(), "b-aaa".to_string());
        remap
            .archive_book_uids
            .insert("local-b".to_string(), "b-bbb".to_string());
        remap
    }

    #[test]
    fn shelf_keeps_the_newer_progress_per_book() {
        let local = json!({
            "local-a": { "bookId": "local-a", "chapter": 1, "updatedAt": 500 },
            "local-only": { "bookId": "local-only", "chapter": 9, "updatedAt": 1 }
        });
        let incoming = json!({
            "local-a": { "bookId": "local-a", "chapter": 4, "updatedAt": 900 },
            "local-b": { "bookId": "local-b", "chapter": 2, "updatedAt": 100 }
        });
        let merged = merge_shelf(Some(&local), &incoming, &remap());
        // 归档更新 → 用归档
        assert_eq!(merged["local-a"]["chapter"], 4);
        // 归档里的书在本机换了 id → 进度跟着换
        assert_eq!(merged["local-c"]["chapter"], 2);
        assert_eq!(merged["local-c"]["bookId"], "local-c");
        // 本机多出来的条目保留
        assert_eq!(merged["local-only"]["chapter"], 9);
    }

    #[test]
    fn shelf_keeps_local_when_it_is_newer() {
        let local = json!({ "local-a": { "bookId": "local-a", "chapter": 8, "updatedAt": 900 } });
        let incoming =
            json!({ "local-a": { "bookId": "local-a", "chapter": 1, "updatedAt": 100 } });
        let merged = merge_shelf(Some(&local), &incoming, &Remap::default());
        assert_eq!(merged["local-a"]["chapter"], 8);
    }

    #[test]
    fn groups_merge_by_name_and_keep_local_ids() {
        let mut remap = Remap::default();
        remap.groups.insert("g-old".into(), "g-local".into());
        remap.groups.insert("g-new".into(), "g-fresh".into());
        let local = json!([{ "id": "g-local", "name": "科幻", "createdAt": 1 }]);
        let incoming = json!([
            { "id": "g-old", "name": "科幻", "createdAt": 2 },
            { "id": "g-new", "name": "历史", "createdAt": 3 }
        ]);
        let merged = merge_groups(Some(&local), &incoming, &remap.groups);
        let list = merged.as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["id"], "g-local");
        assert_eq!(list[0]["createdAt"], 1, "本机同名分组不被归档覆盖");
        assert_eq!(list[1]["id"], "g-fresh");
        assert_eq!(list[1]["name"], "历史");
    }

    #[test]
    fn text_replace_rules_dedupe_by_content_and_remap_the_book() {
        let local = json!([{
            "id": "tr-1", "scope": "book", "bookId": "local-a",
            "find": "的", "replace": "之", "regex": false, "createdAt": 1
        }]);
        let incoming = json!([
            // 与本机同一条（书 uid 相同，尽管本机 id 相同）→ 丢掉
            { "id": "tr-9", "scope": "book", "bookId": "local-a",
              "find": "的", "replace": "之", "regex": false, "createdAt": 5 },
            // 另一本书（归档 id 不同 → 落到本机 id 上）
            { "id": "tr-2", "scope": "book", "bookId": "local-b",
              "find": "他", "replace": "她", "regex": false, "createdAt": 2 },
            // 全局规则
            { "id": "tr-3", "scope": "global", "bookId": "",
              "find": "嗯", "replace": "", "regex": false, "createdAt": 3 }
        ]);
        let merged = merge_text_replaces(Some(&local), &incoming, &remap());
        let list = merged.as_array().unwrap();
        assert_eq!(list.len(), 3, "{merged}");
        assert_eq!(list[1]["bookId"], "local-c");
        assert_eq!(list[2]["scope"], "global");
    }

    #[test]
    fn chapter_rules_and_servers_dedupe_without_touching_the_local_copy() {
        let local = json!([{ "id": "cr-1", "name": "卷首", "pattern": "^卷", "builtin": false }]);
        let incoming = json!([
            { "id": "cr-9", "name": "卷首", "pattern": "^卷", "builtin": false },
            { "id": "cr-2", "name": "尾声", "pattern": "^尾声", "builtin": false }
        ]);
        let merged = merge_chapter_rules(Some(&local), &incoming);
        assert_eq!(merged.as_array().unwrap().len(), 2);
        assert_eq!(merged[0]["id"], "cr-1");

        let local =
            json!([{ "id": "dav-1", "url": "https://dav.example.com/dav", "password": "本机" }]);
        let incoming = json!([
            { "id": "dav-9", "url": "https://DAV.example.com/dav/", "password": "归档" },
            { "id": "dav-2", "url": "https://other.example.com", "password": "归档" }
        ]);
        let merged = merge_by_key(Some(&local), &incoming, server_key);
        let list = merged.as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["password"], "本机");
        assert_eq!(list[1]["url"], "https://other.example.com");
    }

    #[test]
    fn preference_keys_keep_the_local_value_but_fill_missing_ones() {
        let local = json!("dark");
        let incoming = json!("light");
        assert_eq!(
            merge_state("readerx.theme", Some(&local), &incoming, &Remap::default()),
            local
        );
        assert_eq!(
            merge_state("readerx.theme", None, &incoming, &Remap::default()),
            incoming
        );
    }
}

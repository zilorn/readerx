//! 导入的**规划**阶段：认出「这是哪本书 / 哪个分组」，决定每一条数据落到哪里。
//!
//! 与 `import.rs` 的分工：这里只读归档与本机现状、算换算表，不写任何本地文件；
//! 写盘与「先写后删」的顺序在 `import.rs`。分成两个文件是因为两件事的失败模式完全不同 ——
//! 规划错了是「书认错、分组串了」，写盘错了是「文件写坏 / 删多了」。

use super::archive::{self, ArchiveScan};
use super::merge::{self, Remap};
use super::ImportMode;
use super::{BOOKS_DIR, SOURCES_DIR, STATE_DIR};
use crate::book_store::{self, BookSyncMeta};
use crate::models::BookSource;
use crate::storage;
use crate::sync::identity::{self, BookKey};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use tauri::AppHandle;
use zip::ZipArchive;

/// 归档里的一本书
pub(super) struct ArchiveBook {
    pub(super) id: String,
    /// 跨设备身份（只在合并模式下算）
    pub(super) uid: String,
    pub(super) entries: Vec<String>,
}

/// 归档里的一个书源
pub(super) struct ArchiveSource {
    /// 归档里的书源 id
    pub(super) id: String,
    /// 书源地址（跨设备身份）
    pub(super) url: String,
    pub(super) group_id: Option<String>,
    pub(super) source: BookSource,
}

/// 本机已有的一本书
pub(super) struct LocalBook {
    pub(super) id: String,
    pub(super) uid: String,
}

/// 一本书的落位方式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BookAction {
    /// 本机没有 → 新增
    Add,
    /// 同一个本机 id 已存在 → 覆盖
    Update,
    /// 本机已有同一本书（身份相同、本机 id 不同）→ 不重复导入，只并书签
    Skip,
}

pub(super) struct BookPlan {
    pub(super) archive_id: String,
    pub(super) local_id: String,
    pub(super) action: BookAction,
    pub(super) entries: Vec<String>,
}

/// 本机书籍 id 与身份（读数据库元信息，不碰正文）
pub(super) fn local_books<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<Vec<LocalBook>, String> {
    let metas = book_store::list_sync_meta(app)?;
    // 书源地址只读一次：书籍身份要用它，逐本去列书源会变成 O(书 × 源)
    let urls = local_source_urls();
    let mut out = Vec::with_capacity(metas.len());
    for meta in metas {
        let uid = book_uid(&meta, &urls);
        out.push(LocalBook {
            id: meta.id.clone(),
            uid,
        });
    }
    Ok(out)
}

/// 本机书源的地址表（书身份要用它：在线书按「书源地址 + 书籍地址」认人）
fn local_source_urls() -> HashMap<String, String> {
    let mut urls = HashMap::new();
    for source in readerx_source::store::list_sources().unwrap_or_default() {
        urls.insert(source.id.clone(), source.book_source_url.clone());
    }
    urls
}

/// 书籍身份：与 `readerx_sync::bridge` 同一口径，只是书源地址的来源由调用方给
/// （归档里的书要用**归档自己的**书源地址，否则跨设备对不上）
fn book_uid(meta: &BookSyncMeta, source_urls: &HashMap<String, String>) -> String {
    if crate::sync::book_ids::canonical_id(&meta.id) {
        return meta.id.clone();
    }
    let source_url = meta
        .book_source_id
        .as_deref()
        .and_then(|id| source_urls.get(id))
        .map(String::as_str);
    identity::book_uid(&BookKey {
        source_url,
        book_url: meta.book_url.as_deref(),
        file_name: &meta.file_name,
        size: meta.size,
    })
}

pub(super) fn read_archive_sources(
    zip: &mut ZipArchive<File>,
    scan: &ArchiveScan,
) -> Result<Vec<ArchiveSource>, String> {
    let mut out = Vec::new();
    for id in &scan.sources {
        let name = format!("{SOURCES_DIR}/{id}.json");
        let Some(value) = archive::read_entry_json(zip, &name)? else {
            continue;
        };
        match serde_json::from_value::<BookSource>(value) {
            Ok(source) => out.push(ArchiveSource {
                id: id.clone(),
                url: source.book_source_url.clone(),
                group_id: source.group_id.clone(),
                source,
            }),
            Err(error) => log::warn!("备份里的书源无法解析，已跳过（{error}）"),
        }
    }
    Ok(out)
}

pub(super) fn read_archive_books(
    zip: &mut ZipArchive<File>,
    books: Option<&crate::book_store::BackupDatabase>,
    scan: &ArchiveScan,
    sources: &[ArchiveSource],
    mode: ImportMode,
) -> Result<Vec<ArchiveBook>, String> {
    // 书籍身份按**归档自己的**书源地址算：书源 id 在每台设备上各不相同，用本机的
    // 同名 id 去查会查错源，甚至查不到。归档里没有这个书源（源已删）时才退回本机。
    let mut source_urls: HashMap<String, String> = sources
        .iter()
        .map(|source| (source.id.clone(), source.url.clone()))
        .collect();
    for (id, url) in local_source_urls() {
        source_urls.entry(id).or_insert(url);
    }
    let mut out = Vec::with_capacity(scan.books.len());
    for id in &scan.books {
        let prefix = format!("{BOOKS_DIR}/{id}/");
        let entries: Vec<String> = scan
            .entries
            .iter()
            .filter(|name| name.starts_with(&prefix))
            .cloned()
            .collect();
        let uid = if mode == ImportMode::Merge {
            match archive::read_book_entry(zip, books, &format!("{prefix}bookdetail.json"))? {
                Some(bytes) => book_uid(
                    &meta_from_detail(&serde_json::from_slice(&bytes).map_err(|e| e.to_string())?),
                    &source_urls,
                ),
                None => String::new(),
            }
        } else {
            String::new()
        };
        out.push(ArchiveBook {
            id: id.clone(),
            uid,
            entries,
        });
    }
    Ok(out)
}

/// 归档的 `bookdetail.json` → 可同步元信息（只认要用的字段，缺字段按默认值）
fn meta_from_detail(value: &Value) -> BookSyncMeta {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let optional = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(|text| text.to_string())
    };
    let list = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|text| text.to_string())
                    .collect()
            })
            .unwrap_or_default()
    };
    BookSyncMeta {
        id: text("id"),
        title: text("title"),
        author: text("author"),
        intro: optional("intro"),
        format: text("format"),
        file_name: text("fileName"),
        size: value.get("size").and_then(Value::as_u64).unwrap_or(0),
        split_desc: text("splitDesc"),
        source: optional("source"),
        book_source_id: optional("bookSourceId"),
        book_url: optional("bookUrl"),
        tags: list("tags"),
        source_tags: list("sourceTags"),
        group_id: optional("groupId"),
    }
}

/// 决定一本归档书怎么落
pub(super) fn plan_book(book: &ArchiveBook, local: &[LocalBook], mode: ImportMode) -> BookPlan {
    let by_id = local.iter().find(|item| item.id == book.id);
    let action = match mode {
        // 覆盖恢复：本机那份最终会被删掉重建，所以只看 id（其它书一律删）
        ImportMode::Replace => match by_id {
            Some(_) => BookAction::Update,
            None => BookAction::Add,
        },
        ImportMode::Merge => match by_id {
            Some(_) => BookAction::Update,
            None => {
                let same = local
                    .iter()
                    .find(|item| !book.uid.is_empty() && item.uid == book.uid);
                match same {
                    Some(_) => BookAction::Skip,
                    None => BookAction::Add,
                }
            }
        },
    };
    let local_id = match (action, by_id) {
        (BookAction::Skip, _) => local
            .iter()
            .find(|item| !book.uid.is_empty() && item.uid == book.uid)
            .map(|item| item.id.clone())
            .unwrap_or_else(|| book.id.clone()),
        _ => book.id.clone(),
    };
    BookPlan {
        archive_id: book.id.clone(),
        local_id,
        action,
        entries: book.entries.clone(),
    }
}

/// 分组与书籍 id 的换算表（合并模式）。
///
/// 分组以**名字**为身份（与同步一致）：本机已有同名分组就用本机 id，否则给归档里的
/// 分组分配一个新的本机 id —— 直接沿用归档 id 在有同名不同 id 的分组时会指向错的组。
pub(super) fn plan_remap<R: tauri::Runtime>(
    app: &AppHandle<R>,
    mode: ImportMode,
    local_books: &[LocalBook],
    archive_books: &[ArchiveBook],
    zip: &mut ZipArchive<File>,
    scan: &ArchiveScan,
) -> Result<Remap, String> {
    let mut remap = Remap::default();
    for book in archive_books {
        remap
            .archive_book_uids
            .insert(book.id.clone(), book.uid.clone());
    }
    for book in local_books {
        remap.book_uids.insert(book.id.clone(), book.uid.clone());
    }
    if mode == ImportMode::Replace {
        // 覆盖恢复：id 原样保留（归档的分组清单会整份写回去），也不必算身份
        return Ok(remap);
    }

    let local_groups = state_array(app, merge::GROUPS_KEY);
    let local_source_groups = state_array(app, merge::SOURCE_GROUPS_KEY);
    let archive_groups = read_archive_groups(zip, scan, merge::GROUPS_KEY)?;
    let archive_source_groups = read_archive_groups(zip, scan, merge::SOURCE_GROUPS_KEY)?;
    let mut seq = 0u64;
    remap.groups = map_groups(&local_groups, &archive_groups, "grp", &mut seq);
    remap.source_groups = map_groups(&local_source_groups, &archive_source_groups, "sg", &mut seq);

    // 书籍 id：本机已有同一本书 → 归档里的进度 / 书签 / 规则都落到本机那个 id 上
    for book in archive_books {
        let local_id = local_books
            .iter()
            .find(|item| item.id == book.id)
            .or_else(|| {
                local_books
                    .iter()
                    .find(|item| !book.uid.is_empty() && item.uid == book.uid)
            })
            .map(|item| item.id.clone())
            .unwrap_or_else(|| book.id.clone());
        remap.books.insert(book.id.clone(), local_id);
    }
    Ok(remap)
}

fn read_archive_groups(
    zip: &mut ZipArchive<File>,
    scan: &ArchiveScan,
    key: &str,
) -> Result<Vec<Value>, String> {
    if !scan.state_keys.iter().any(|item| item == key) {
        return Ok(Vec::new());
    }
    let Some(value) = archive::read_entry_json(zip, &format!("{STATE_DIR}/{key}.json"))? else {
        return Ok(Vec::new());
    };
    Ok(value.as_array().cloned().unwrap_or_default())
}

fn state_array<R: tauri::Runtime>(app: &AppHandle<R>, key: &str) -> Vec<Value> {
    storage::read_state(app, key)
        .ok()
        .flatten()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

/// 归档分组 id → 本机分组 id。
///
/// 本机已有同名分组 → 用本机 id（书 / 书源的归属按名字对上）；否则**沿用归档 id**
/// （空设备恢复时 id 保持不变，备份里的引用原样成立），只有归档 id 在本机已被另一个
/// 分组占用时才另起一个新 id。
fn map_groups(
    local: &[Value],
    archive: &[Value],
    prefix: &str,
    seq: &mut u64,
) -> HashMap<String, String> {
    let mut used: HashSet<String> = local
        .iter()
        .filter_map(group_id)
        .map(str::to_string)
        .collect();
    let mut map = HashMap::new();
    for group in archive {
        let (Some(archive_id), Some(name)) = (group_id(group), group_name(group)) else {
            continue;
        };
        if let Some(existing) = local.iter().find(|item| group_name(item) == Some(name)) {
            if let Some(id) = group_id(existing) {
                map.insert(archive_id.to_string(), id.to_string());
                continue;
            }
        }
        let mut fresh = archive_id.to_string();
        while used.contains(&fresh) {
            *seq += 1;
            fresh = format!("{prefix}-{:x}-{}", super::now_ms(), *seq);
        }
        used.insert(fresh.clone());
        map.insert(archive_id.to_string(), fresh);
    }
    map
}

fn group_id(group: &Value) -> Option<&str> {
    group
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

fn group_name(group: &Value) -> Option<&str> {
    group
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plan_of(archive_id: &str, uid: &str, local: &[LocalBook], mode: ImportMode) -> BookPlan {
        let book = ArchiveBook {
            id: archive_id.to_string(),
            uid: uid.to_string(),
            entries: Vec::new(),
        };
        plan_book(&book, local, mode)
    }

    #[test]
    fn merge_matches_the_same_book_by_identity_when_ids_differ() {
        let local = vec![LocalBook {
            id: "local-1".to_string(),
            uid: "b-aaa".to_string(),
        }];
        let plan = plan_of("local-9", "b-aaa", &local, ImportMode::Merge);
        assert_eq!(plan.action, BookAction::Skip);
        assert_eq!(plan.local_id, "local-1", "书签要并进本机那本");
    }

    #[test]
    fn merge_overwrites_the_same_local_id() {
        let local = vec![LocalBook {
            id: "local-1".to_string(),
            uid: "b-aaa".to_string(),
        }];
        let plan = plan_of("local-1", "b-bbb", &local, ImportMode::Merge);
        assert_eq!(plan.action, BookAction::Update);
        assert_eq!(plan.local_id, "local-1");
    }

    #[test]
    fn merge_adds_unknown_books() {
        let plan = plan_of("local-7", "b-ccc", &[], ImportMode::Merge);
        assert_eq!(plan.action, BookAction::Add);
        assert_eq!(plan.local_id, "local-7");
    }

    #[test]
    fn replace_ignores_identity_and_only_looks_at_ids() {
        let local = vec![LocalBook {
            id: "local-1".to_string(),
            uid: "b-aaa".to_string(),
        }];
        // 身份相同但 id 不同：覆盖模式照样当新书写（本机那本随后会被删掉）
        assert_eq!(
            plan_of("local-9", "b-aaa", &local, ImportMode::Replace).action,
            BookAction::Add
        );
        assert_eq!(
            plan_of("local-1", "b-aaa", &local, ImportMode::Replace).action,
            BookAction::Update
        );
    }

    #[test]
    fn group_mapping_reuses_local_ids_by_name_and_allocates_fresh_ones() {
        // 本机已有同名分组（id 不同）→ 用本机 id；本机没有的同名冲突 → 沿用归档 id
        let local = vec![
            json!({ "id": "grp-1", "name": "科幻" }),
            json!({ "id": "grp-conflict", "name": "历史" }),
        ];
        let archive = vec![
            json!({ "id": "grp-a", "name": "科幻" }),
            json!({ "id": "grp-conflict", "name": "历史" }),
            json!({ "id": "grp-c", "name": "传记" }),
        ];
        let mut seq = 0;
        let map = map_groups(&local, &archive, "grp", &mut seq);
        assert_eq!(map["grp-a"], "grp-1");
        assert_eq!(
            map["grp-conflict"], "grp-conflict",
            "同名分组指向本机那个（id 相同）"
        );
        assert_eq!(map["grp-c"], "grp-c", "空设备 / 不冲突时沿用归档 id");
    }

    #[test]
    fn group_mapping_allocates_a_fresh_id_on_a_real_collision() {
        // 本机占用着同名 id，但名字不同：不能把归档的分组塞进同一个 id
        let local = vec![json!({ "id": "grp-a", "name": "别的分组" })];
        let archive = vec![json!({ "id": "grp-a", "name": "科幻" })];
        let mut seq = 0;
        let map = map_groups(&local, &archive, "grp", &mut seq);
        let fresh = &map["grp-a"];
        assert_ne!(fresh, "grp-a");
        assert!(fresh.starts_with("grp-"), "{fresh}");
    }

    #[test]
    fn meta_from_detail_reads_the_fields_identity_needs() {
        let value = json!({
            "id": "local-1", "title": "三体", "author": "刘慈欣", "format": "epub",
            "fileName": "三体.epub", "size": 1024, "bookSourceId": "src-1",
            "bookUrl": "https://example.com/book/1", "tags": ["科幻"], "groupId": null
        });
        let meta = meta_from_detail(&value);
        assert_eq!(meta.file_name, "三体.epub");
        assert_eq!(meta.size, 1024);
        assert_eq!(meta.book_source_id.as_deref(), Some("src-1"));
        assert_eq!(meta.tags, vec!["科幻".to_string()]);
    }

    #[test]
    fn identity_uses_the_source_url_of_the_side_that_owns_the_book() {
        let mut urls = HashMap::new();
        urls.insert("src-1".to_string(), "https://a.example.com".to_string());
        let meta = meta_from_detail(&json!({
            "fileName": "三体.epub", "size": 10, "bookSourceId": "src-1",
            "bookUrl": "https://a.example.com/book/1"
        }));
        let uid = book_uid(&meta, &urls);
        // 两边书源地址一致（哪怕本机 id 不同）→ 同一个身份
        let mut other = HashMap::new();
        other.insert("src-9".to_string(), "https://a.example.com".to_string());
        let mut meta2 = meta.clone();
        meta2.book_source_id = Some("src-9".to_string());
        assert_eq!(uid, book_uid(&meta2, &other));
    }
}

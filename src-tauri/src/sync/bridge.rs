//! 本地数据 ↔ 同步引擎实体的桥接。
//!
//! App 的本地数据（`books/<id>/`、`state/readerx.*.json`、`book_sources/`）与同步引擎
//! 的实体是两套表示，这个模块负责**双向搬运**，并且是唯一搬运的地方：
//!
//! ```text
//! 本地写入（导入 / 改元信息 / 翻页 / 加书签 / 改分组 / 改书源）
//!   → publish_*：把本地当前值发布成操作（只写与引擎不同的字段，值没变不产生操作）
//!
//! 一次同步结束（远端操作已并进引擎）
//!   → materialize：把合并结果写回本地文件，返回「哪些数据变了」供前端重载缓存
//! ```
//!
//! **为什么不让本地与同步各写一份**：两份数据一旦分叉就再也说不清哪份对。这里的方向
//! 始终是单向的：本地文件是给界面读的物化视图，引擎里的实体才是同步的真相。
//!
//! 三个容易踩的坑，都在这里处理掉：
//!
//! - **反复发布不出操作**：每次启动都对账一遍本地与引擎，所以比较必须逐字段做，
//!   值相同就一条操作都不写（否则每启动一次就灌进一屏无意义的操作日志）。
//! - **待裁决的字段不再自动改写**：字段进了冲突队列后，本地再发布同一个字段会把
//!   对端那一次写入顶掉（用户还没裁决就被「自动解决」了），因此发布时跳过冲突字段。
//! - **字段名口径**：引擎里所有 `book_id` 字段装的都是**书实体 id（uid）**，
//!   不是本地书籍 id（本地 id 每台设备各自生成，见 [`super::identity`]）。

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use tauri::AppHandle;

use readerx_sync::net::{lock_engine, SharedEngine};
use readerx_sync::{Entity, SyncEngine, SyncError};

use crate::book_store::{self, BookSyncMeta};
use crate::models::BookSource;
use crate::storage;

use super::identity::{self, BookKey};

/// 阅读进度所在的偏好 key（前端 `store.ts` 的 `SHELF_KEY`，两边必须一致）
const SHELF_KEY: &str = "readerx.shelf";
/// 书架分组所在的偏好 key（前端 `groups.ts` 的 `GROUPS_KEY`）
const GROUPS_KEY: &str = "readerx.groups";
/// 文本替换规则所在的偏好 key（前端 `textReplacements.ts` 的 `STORAGE_KEY`）
const TEXT_REPLACES_KEY: &str = "readerx.textReplacements";
/// 分章规则所在的偏好 key（前端 `chapterRules.ts` 的 `RULES_KEY`）
const CHAPTER_RULES_KEY: &str = "readerx.chapterRules";

/// 发布时机：引擎里已经有这本书时，以谁为准。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublishMode {
    /// 导入 / 启动对账：**以引擎为准**落地回本地。
    ///
    /// 对端可能改过书名、打过标签，本地重新导入同一个文件不该把这些改动抹掉。
    Imported,
    /// 本地编辑（改名 / 换分组 / 改标签）：**以本地为准**发布出去。
    Edited,
}

/// 一次落地涉及了哪些本地数据（前端据此重载对应缓存）。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedChanges {
    /// 书籍元信息有变化 → 重新拉书库元数据
    pub books: bool,
    /// 阅读进度有变化 → 重新读回进度
    pub progress: bool,
    /// 分组有变化 → 重新读回分组
    pub groups: bool,
    /// 书源有变化 → 重新拉书源列表
    pub sources: bool,
    /// 书签有变化的本机书 id → 只重载这几本
    pub bookmarks: Vec<String>,
    /// 文本替换规则有变化 → 重新读回规则清单
    pub text_replaces: bool,
    /// 分章规则有变化 → 重新读回规则清单
    pub chapter_rules: bool,
    /// 本次落地删掉的本机书 id（对端删了它们）
    pub deleted_books: Vec<String>,
}

impl AppliedChanges {
    pub fn is_empty(&self) -> bool {
        !self.books
            && !self.progress
            && !self.groups
            && !self.sources
            && !self.text_replaces
            && !self.chapter_rules
            && self.bookmarks.is_empty()
            && self.deleted_books.is_empty()
    }
}

// ---------------------------------------------------------------------------
// 书身份索引：书实体 id（uid） ↔ 本机书籍 id
// ---------------------------------------------------------------------------

/// uid ↔ 本机书籍 id 的双向索引。
///
/// 每次落地都要把「哪个实体」翻译成「哪本书」，而重算 uid 要读一遍全部书籍元信息；
/// 索引在服务启动时建一次，之后跟着本地写入增量维护。
#[derive(Debug, Default)]
pub struct BookIndex {
    by_uid: BTreeMap<String, String>,
    by_id: BTreeMap<String, String>,
    built: bool,
}

impl BookIndex {
    /// 扫描本地书库重建索引（只读元信息，不读正文）。
    pub(crate) fn rebuild<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<BookIndex, String> {
        let mut index = BookIndex { built: true, ..BookIndex::default() };
        for meta in book_store::list_sync_meta(app)? {
            let uid = book_uid_of(app, &meta);
            index.insert(&meta.id, &uid);
        }
        log::debug!("同步书身份索引已重建 书籍={}", index.by_id.len());
        Ok(index)
    }

    pub(crate) fn insert(&mut self, local_id: &str, uid: &str) {
        self.by_uid.insert(uid.to_string(), local_id.to_string());
        self.by_id.insert(local_id.to_string(), uid.to_string());
    }

    pub(crate) fn remove(&mut self, local_id: &str) {
        if let Some(uid) = self.by_id.remove(local_id) {
            self.by_uid.remove(&uid);
        }
    }

    /// 本机 id → uid；索引里没有就地补一条（书是刚导入的）。
    pub(crate) fn uid_for<R: tauri::Runtime>(
        &mut self,
        app: &AppHandle<R>,
        local_id: &str,
    ) -> String {
        if let Some(uid) = self.by_id.get(local_id) {
            return uid.clone();
        }
        let uid = book_uid_of_id(app, local_id);
        self.insert(local_id, &uid);
        uid
    }

    /// uid → 本机 id；索引还没建过就建一次再找（懒加载：没人用同步就不付这次扫描）。
    fn resolve<R: tauri::Runtime>(
        &mut self,
        app: &AppHandle<R>,
        uid: &str,
    ) -> Result<Option<String>, String> {
        if let Some(id) = self.by_uid.get(uid) {
            return Ok(Some(id.clone()));
        }
        if self.built {
            return Ok(None);
        }
        *self = BookIndex::rebuild(app)?;
        Ok(self.by_uid.get(uid).cloned())
    }

    pub(crate) fn len(&self) -> usize {
        self.by_id.len()
    }

    /// 索引里已知的本机书籍 uid（索引还没建过就先扫一遍本地书库）。
    ///
    /// 发布「按书生效」的规则时要用它判断「这本书本机到底有没有」：本机没有的书，
    /// 它那些规则是从对端同步来的，本地清单里自然看不到，不能当成用户删掉了。
    pub(crate) fn local_uids<R: tauri::Runtime>(
        &mut self,
        app: &AppHandle<R>,
    ) -> Result<std::collections::BTreeSet<String>, String> {
        if !self.built {
            *self = BookIndex::rebuild(app)?;
        }
        Ok(self.by_uid.keys().cloned().collect())
    }
}

/// 书籍的跨设备身份：在线书按「书源地址 + 书籍地址」，导入书按「文件名 + 字节数」。
pub(crate) fn book_uid_of<R: tauri::Runtime>(_app: &AppHandle<R>, meta: &BookSyncMeta) -> String {
    let source_url = meta
        .book_source_id
        .as_deref()
        .and_then(book_source_url);
    identity::book_uid(&BookKey {
        source_url: source_url.as_deref(),
        book_url: meta.book_url.as_deref(),
        file_name: &meta.file_name,
        size: meta.size,
    })
}

/// 查一本书的来源书源地址（在线书身份用）。书源已被删除时返回 None。
fn book_source_url(book_source_id: &str) -> Option<String> {
    readerx_source::store::get_source(book_source_id)
        .ok()
        .flatten()
        .map(|source| source.book_source_url)
}

/// 按本机书籍 id 直接算 uid（书已被删除 / 元信息读不到时的兜底路径）。
fn book_uid_of_id<R: tauri::Runtime>(app: &AppHandle<R>, book_id: &str) -> String {
    match book_store::get_sync_meta(app, book_id) {
        Ok(Some(meta)) => book_uid_of(app, &meta),
        // 元信息读不出来（文件已删）：用本机 id 兜底。它不会和别的设备对齐，
        // 但能保证「删除 / 重置」这类操作至少在本机引擎里是一致的。
        _ => identity::book_uid(&BookKey { file_name: book_id, ..BookKey::default() }),
    }
}

/// [`book_uid_of_id`] 的对外版本：本地写入钩子维护书身份索引时用。
pub(crate) fn local_uid<R: tauri::Runtime>(app: &AppHandle<R>, book_id: &str) -> String {
    book_uid_of_id(app, book_id)
}

/// 本机侧的事实：分组归属与书源地址（发布书籍元信息时要把本机 id 翻译成跨设备身份）。
#[derive(Debug, Default)]
struct LocalFacts {
    /// 本机分组 id → 同步分组 id
    groups: HashMap<String, String>,
    /// 本机书源 id → 书源地址（在线书身份用）
    source_urls: HashMap<String, String>,
}

impl LocalFacts {
    fn load<R: tauri::Runtime>(app: &AppHandle<R>) -> LocalFacts {
        let mut facts = LocalFacts::default();
        if let Ok(Some(groups)) = storage::read_state(app, GROUPS_KEY) {
            for group in groups.as_array().map(Vec::as_slice).unwrap_or_default() {
                let (Some(id), Some(name)) = (
                    group.get("id").and_then(Value::as_str),
                    group.get("name").and_then(Value::as_str),
                ) else {
                    continue;
                };
                facts.groups.insert(id.to_string(), identity::group_uid(name));
            }
        }
        facts
    }

    fn group_sync_id(&self, local_group_id: Option<&str>) -> Option<String> {
        local_group_id.and_then(|id| self.groups.get(id).cloned())
    }

    /// 书源地址（按需查一次并缓存：只有在线书才算得到身份）。
    fn source_url(&mut self, book_source_id: Option<&str>) -> Option<String> {
        let id = book_source_id?;
        if let Some(url) = self.source_urls.get(id) {
            return Some(url.clone());
        }
        let url = book_source_url(id)?;
        self.source_urls.insert(id.to_string(), url.clone());
        Some(url)
    }
}

// ---------------------------------------------------------------------------
// 本地 → 引擎
// ---------------------------------------------------------------------------

/// 发布一本书的元信息。
pub fn publish_book<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    book_id: &str,
    mode: PublishMode,
) -> Result<(), SyncError> {
    let Some(meta) = book_store::get_sync_meta(app, book_id).map_err(SyncError::Io)? else {
        return Ok(());
    };
    let mut facts = LocalFacts::load(app);
    let mut guard = lock_engine(engine);
    publish_book_locked(app, &mut guard, &mut facts, &meta, mode)
}

/// 发布一本书（调用方已持有引擎锁）。
fn publish_book_locked<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &mut SyncEngine,
    facts: &mut LocalFacts,
    meta: &BookSyncMeta,
    mode: PublishMode,
) -> Result<(), SyncError> {
    let uid = book_uid_of_parts(facts, meta);
    if engine.entity(&uid).is_none() {
        let fields = book_values(facts, meta);
        engine.create_entity("book", Some(uid), fields)?;
        return Ok(());
    }

    if mode == PublishMode::Imported {
        // 以引擎为准：对端可能已经改过这本书（改名 / 打标签 / 换分组），
        // 本地重新导入同一个文件时把这些改动落地回来，而不是用导入值覆盖掉
        let (deleted, fields) = match engine.entity(&uid) {
            Some(entity) if entity.is_deleted() => (true, None),
            Some(entity) => (false, Some(book_snapshot_fields(entity))),
            None => return Ok(()),
        };
        if deleted {
            // 这本书在别处被删过，用户又在本机导入了一次：视为有意恢复
            engine.restore_entity(&uid)?;
            let wanted = book_values(facts, meta);
            publish_fields(engine, &uid, &wanted)?;
            log::info!("书籍在同步里曾标记为删除，本次导入使它在群组内恢复 book={}", meta.id);
            return Ok(());
        }
        if let Some(fields) = fields {
            apply_book_fields(app, &meta.id, &fields).map_err(SyncError::Io)?;
        }
        return Ok(());
    }

    let wanted = book_values(facts, meta);
    publish_fields(engine, &uid, &wanted)?;
    Ok(())
}

/// 删除一本书：书实体进墓碑（书签按级联规则一起删），并删掉它的进度实体。
///
/// **必须在本地删文件之前调用**：定位书身份要读 `bookdetail.json`。
pub fn publish_book_delete<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    book_id: &str,
) -> Result<(), SyncError> {
    let Some(meta) = book_store::get_sync_meta(app, book_id).map_err(SyncError::Io)? else {
        return Ok(());
    };
    let mut facts = LocalFacts::load(app);
    let uid = book_uid_of_parts(&mut facts, &meta);
    let mut guard = lock_engine(engine);
    if guard.entity(&uid).is_some() {
        guard.delete_entity(&uid, Some("在本机删除".to_string()))?;
    }
    let progress = identity::progress_uid(&uid);
    if guard.entity(&progress).is_some() {
        guard.delete_entity(&progress, Some("书籍已删除".to_string()))?;
    }
    log::info!("书籍删除已记入同步 book={book_id}");
    Ok(())
}

/// 发布一本书的阅读进度（`readerx.shelf` 里的单条记录）。
pub fn publish_progress<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    index: &mut BookIndex,
    book_id: &str,
    entry: &Value,
) -> Result<(), SyncError> {
    let uid = index.uid_for(app, book_id);
    let id = identity::progress_uid(&uid);
    let values = progress_values(entry);
    let mut guard = lock_engine(engine);
    if guard.entity(&id).is_none() {
        let mut fields = values;
        fields.insert("book_id".to_string(), json!(uid));
        guard.create_entity("reading_progress", Some(id), fields)?;
        return Ok(());
    }
    publish_fields(&mut guard, &id, &values)?;
    Ok(())
}

/// 发布一本书的书签（前端覆盖式写整表，这里换算成增 / 改 / 删）。
pub fn publish_bookmarks<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    index: &mut BookIndex,
    book_id: &str,
    bookmarks: &[Value],
) -> Result<(), SyncError> {
    let uid = index.uid_for(app, book_id);
    let mut guard = lock_engine(engine);

    let mut local_ids: Vec<String> = Vec::new();
    for value in bookmarks {
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            continue;
        };
        local_ids.push(id.to_string());
        let values = bookmark_values(value, &uid);
        if guard.entity(id).is_none() {
            guard.create_entity("bookmark", Some(id.to_string()), values)?;
        } else {
            publish_fields(&mut guard, id, &values)?;
        }
    }

    // 引擎里有、本地这次没有的书签 = 用户删掉的
    let stale: Vec<String> = guard
        .entities_of_kind("bookmark", false)
        .into_iter()
        .filter(|entity| book_ref_of(entity) == uid)
        .map(|entity| entity.id.clone())
        .filter(|id| !local_ids.iter().any(|local| local == id))
        .collect();
    for id in stale {
        guard.delete_entity(&id, Some("书签已删除".to_string()))?;
    }
    Ok(())
}

/// 发布分组清单（`readerx.groups` 的整个数组）。
pub fn publish_groups<R: tauri::Runtime>(
    _app: &AppHandle<R>,
    engine: &SharedEngine,
    groups: &Value,
) -> Result<(), SyncError> {
    let mut guard = lock_engine(engine);
    let mut live: Vec<String> = Vec::new();
    for group in groups.as_array().map(Vec::as_slice).unwrap_or_default() {
        let Some(name) = group.get("name").and_then(Value::as_str) else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let uid = identity::group_uid(name);
        live.push(uid.clone());
        if guard.entity(&uid).is_none() {
            guard.create_entity("group", Some(uid), [("name", json!(name))])?;
        } else {
            publish_value(&mut guard, &uid, "name", json!(name))?;
        }
    }
    // 已经不在本地清单里的分组 → 墓碑
    let stale: Vec<String> = guard
        .entities_of_kind("group", false)
        .into_iter()
        .map(|entity| entity.id.clone())
        .filter(|id| !live.iter().any(|uid| uid == id))
        .collect();
    for id in stale {
        guard.delete_entity(&id, Some("分组已删除".to_string()))?;
    }
    Ok(())
}

/// 发布一份书源（整份 JSON；`id` 与 `groupId` 是本机的，不进同步载荷）。
pub fn publish_source<R: tauri::Runtime>(
    _app: &AppHandle<R>,
    engine: &SharedEngine,
    source: &BookSource,
) -> Result<(), SyncError> {
    let uid = identity::source_uid(&source.book_source_url);
    let payload = source_payload(source);
    let mut guard = lock_engine(engine);
    if guard.entity(&uid).is_none() {
        guard.create_entity(
            "book_source",
            Some(uid),
            [
                ("name", json!(source.name)),
                ("url", json!(source.book_source_url)),
                ("json", payload),
            ],
        )?;
        return Ok(());
    }
    publish_value(&mut guard, &uid, "name", json!(source.name))?;
    publish_multi(&mut guard, &uid, "json", payload)?;
    Ok(())
}

/// 删除一份书源（按地址定位实体）。
pub fn publish_source_delete<R: tauri::Runtime>(
    _app: &AppHandle<R>,
    engine: &SharedEngine,
    book_source_url: &str,
) -> Result<(), SyncError> {
    let uid = identity::source_uid(book_source_url);
    let mut guard = lock_engine(engine);
    if guard.entity(&uid).is_some() {
        guard.delete_entity(&uid, Some("书源已删除".to_string()))?;
    }
    Ok(())
}

/// 发布文本替换规则（`readerx.textReplacements` 的整个数组）。
///
/// 规则 id 由**规则内容**派生（见 [`identity::text_replace_uid`]）：两台设备各自添加
/// 同一条规则会收敛成同一条；改规则内容等于删旧建新。按书生效的规则把本机书 id
/// 翻译成书实体 id，因此规则跟着书走、不跟着设备走。
pub fn publish_text_replaces<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    index: &mut BookIndex,
    rules: &Value,
) -> Result<(), SyncError> {
    let local_uids = index.local_uids(app).map_err(SyncError::Io)?;
    let mut guard = lock_engine(engine);
    let mut live: Vec<String> = Vec::new();
    for rule in rules.as_array().map(Vec::as_slice).unwrap_or_default() {
        let Some(find) = rule.get("find").and_then(Value::as_str) else {
            continue;
        };
        let scope = match rule.get("scope").and_then(Value::as_str) {
            Some("book") => "book",
            _ => "global",
        };
        let replace = rule.get("replace").and_then(Value::as_str).unwrap_or_default();
        let regex = rule.get("regex").and_then(Value::as_bool).unwrap_or(false);
        let book_uid = match scope {
            "book" => match rule.get("bookId").and_then(Value::as_str) {
                Some(book_id) if !book_id.is_empty() => index.uid_for(app, book_id),
                // 没有书 id 的「按书规则」无处生效：当成全局规则发布会改变它的语义，
                // 直接跳过（保持本地现状，不写出一条语义错误的实体）
                _ => continue,
            },
            _ => String::new(),
        };
        let uid = identity::text_replace_uid(scope, &book_uid, find, replace, regex);
        live.push(uid.clone());
        let values = text_replace_values(scope, &book_uid, find, replace, regex, rule);
        if guard.entity(&uid).is_none() {
            guard.create_entity("text_replace", Some(uid), values)?;
        } else {
            publish_fields(&mut guard, &uid, &values)?;
        }
    }

    // 引擎里有、本地清单里没有的规则：只把**能确定是本机删掉的那部分**入墓碑 ——
    // 指向本机没有的书的规则是从对端同步来的（本机还没导入那本书），删了它就等于
    // 用一次本地发布抹掉对端的规则。
    let stale: Vec<String> = guard
        .entities_of_kind("text_replace", false)
        .into_iter()
        .filter(|entity| !live.iter().any(|uid| uid == &entity.id))
        .filter(|entity| {
            let book = book_ref_of(entity);
            book.is_empty() || local_uids.contains(&book)
        })
        .map(|entity| entity.id.clone())
        .collect();
    for id in stale {
        guard.delete_entity(&id, Some("文本替换规则已删除".to_string()))?;
    }
    Ok(())
}

/// 发布分章规则（`readerx.chapterRules` 里的用户自定义规则）。
///
/// 内置规则是代码常量、不在状态文件里，因此这里只发布自定义规则；
/// 规则身份 = 名称 + 正则（见 [`identity::chapter_rule_uid`]）。
pub fn publish_chapter_rules<R: tauri::Runtime>(
    _app: &AppHandle<R>,
    engine: &SharedEngine,
    rules: &Value,
) -> Result<(), SyncError> {
    let mut guard = lock_engine(engine);
    let mut live: Vec<String> = Vec::new();
    for rule in rules.as_array().map(Vec::as_slice).unwrap_or_default() {
        let (Some(name), Some(pattern)) = (
            rule.get("name").and_then(Value::as_str),
            rule.get("pattern").and_then(Value::as_str),
        ) else {
            continue;
        };
        if name.trim().is_empty() || pattern.trim().is_empty() {
            continue;
        }
        let uid = identity::chapter_rule_uid(name, pattern);
        live.push(uid.clone());
        let created_at = rule.get("createdAt").and_then(Value::as_i64).unwrap_or(0);
        let values = chapter_rule_values(name, pattern, created_at);
        if guard.entity(&uid).is_none() {
            guard.create_entity("chapter_rule", Some(uid), values)?;
        } else {
            publish_fields(&mut guard, &uid, &values)?;
        }
    }
    let stale: Vec<String> = guard
        .entities_of_kind("chapter_rule", false)
        .into_iter()
        .map(|entity| entity.id.clone())
        .filter(|id| !live.iter().any(|uid| uid == id))
        .collect();
    for id in stale {
        guard.delete_entity(&id, Some("分章规则已删除".to_string()))?;
    }
    Ok(())
}

/// 启动对账：本地有、引擎里没有的记录补进去。
///
/// 覆盖三种情况：首次启用同步（引擎是空的）、引擎数据被清过、上次运行到这里就退出了。
/// 已经在引擎里的记录**不会被本地值覆盖**，而是以引擎为准落地回本地。
pub fn reconcile<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    index: &mut BookIndex,
) -> Result<(), SyncError> {
    *index = BookIndex::rebuild(app).map_err(SyncError::Io)?;
    let books = book_store::list_sync_meta(app).map_err(SyncError::Io)?;
    let mut facts = LocalFacts::load(app);

    for meta in &books {
        let mut guard = lock_engine(engine);
        publish_book_locked(app, &mut guard, &mut facts, meta, PublishMode::Imported)?;
    }

    // 阅读进度（`readerx.shelf` 是 Record<本机书 id, 进度>）
    if let Ok(Some(shelf)) = storage::read_state(app, SHELF_KEY) {
        for (book_id, entry) in shelf.as_object().into_iter().flatten() {
            publish_progress(app, engine, index, book_id, entry)?;
        }
    }

    // 书签：只有读得出来且非空的才发布（读失败不能当成「没有书签」）
    for meta in &books {
        let Ok(bookmarks) = book_store::get_bookmarks(app, &meta.id) else {
            continue;
        };
        if !bookmarks.is_empty() {
            publish_bookmarks(app, engine, index, &meta.id, &bookmarks)?;
        }
    }

    // 分组与书源
    if let Ok(Some(groups)) = storage::read_state(app, GROUPS_KEY) {
        publish_groups(app, engine, &groups)?;
    }
    // 规则类数据（文本替换 / 分章规则）
    if let Ok(Some(rules)) = storage::read_state(app, TEXT_REPLACES_KEY) {
        publish_text_replaces(app, engine, index, &rules)?;
    }
    if let Ok(Some(rules)) = storage::read_state(app, CHAPTER_RULES_KEY) {
        publish_chapter_rules(app, engine, &rules)?;
    }
    if let Ok(sources) = readerx_source::store::list_sources() {
        for source in &sources {
            publish_source(app, engine, source)?;
        }
    }
    lock_engine(engine).flush()?;
    log::info!("本地数据已完成同步对账 书籍={}", index.len());
    Ok(())
}

// ---------------------------------------------------------------------------
// 引擎 → 本地
// ---------------------------------------------------------------------------

/// 把 `from` 之后**远端**操作的合并结果写回本地文件。
///
/// `from` 是上次落地到的操作下标（`SyncSettings::materialized_ops`）：本地自己的操作
/// 早就写进本地文件了，只看远端来的那些。
pub fn materialize<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    from: usize,
    index: &mut BookIndex,
) -> Result<AppliedChanges, SyncError> {
    let snapshots = collect_snapshots(engine, from, &[])?;
    apply_snapshots(app, engine, index, snapshots)
}

/// 落地**指定实体**的当前状态（不看操作来源）。
///
/// 给「冲突裁决」用：裁决（比如采用对端那一份）写的是一次**本地**写入，
/// 按操作来源过滤的常规落地会跳过它，本地文件就会停在旧值上。
pub fn materialize_entities<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    index: &mut BookIndex,
    ids: &[String],
) -> Result<AppliedChanges, SyncError> {
    let snapshots = collect_snapshots(engine, usize::MAX, ids)?;
    apply_snapshots(app, engine, index, snapshots)
}

/// 把一批实体快照写回本地文件（顺序：分组 → 书 → 进度 → 书签 → 书源）。
fn apply_snapshots<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    index: &mut BookIndex,
    snapshots: Vec<Snapshot>,
) -> Result<AppliedChanges, SyncError> {
    let mut changes = AppliedChanges::default();
    if snapshots.is_empty() {
        return Ok(changes);
    }

    // 分组排在最前：书要按本机分组 id 落归属
    if apply_groups(app, &snapshots).map_err(SyncError::Io)? {
        changes.groups = true;
    }
    for snapshot in &snapshots {
        if let Snapshot::Book { uid, deleted, fields } = snapshot {
            match apply_book(app, index, uid, *deleted, fields.as_deref()) {
                Ok(Some(local_id)) => {
                    changes.books = true;
                    if *deleted {
                        changes.deleted_books.push(local_id);
                    }
                }
                Ok(None) => {}
                Err(error) => log::warn!("同步落地单本书失败（{uid}）：{error}"),
            }
        }
    }
    // 书落到本机后补一次「按书生效」的文本替换规则：对端可能先同步来规则，
    // 那时候本书还没导入（规则无处可落），书一到就得把它们落到本地清单里。
    if changes.books {
        if apply_text_replaces(app, engine, index).map_err(SyncError::Io)? {
            changes.text_replaces = true;
        }
    }
    for snapshot in &snapshots {
        if let Snapshot::Progress { book_uid, deleted, entry } = snapshot {
            if apply_progress(app, index, book_uid, *deleted, entry.as_ref())
                .map_err(SyncError::Io)?
            {
                changes.progress = true;
            }
        }
    }
    let mut bookmark_books: Vec<String> = Vec::new();
    for snapshot in &snapshots {
        if let Snapshot::Bookmark { book_uid, .. } = snapshot {
            if let Some(local_id) = index.resolve(app, book_uid).map_err(SyncError::Io)? {
                if !bookmark_books.contains(&local_id) {
                    bookmark_books.push(local_id);
                }
            }
        }
    }
    if !bookmark_books.is_empty() {
        for local_id in &bookmark_books {
            let uid = index.uid_for(app, local_id);
            if apply_bookmarks(app, engine, local_id, &uid).map_err(SyncError::Io)? {
                changes.bookmarks.push(local_id.clone());
            }
        }
    }
    let sources = if snapshots.iter().any(|s| matches!(s, Snapshot::Source { .. })) {
        readerx_source::store::list_sources().unwrap_or_default()
    } else {
        Vec::new()
    };
    for snapshot in &snapshots {
        if let Snapshot::Source { uid, deleted, payload } = snapshot {
            if apply_source(&sources, uid, *deleted, payload.as_ref()).map_err(SyncError::Io)? {
                changes.sources = true;
            }
        }
    }
    // 规则类数据：整表重写（引擎实体是真相，本地状态文件是给界面读的物化视图）
    if snapshots.iter().any(|s| matches!(s, Snapshot::TextReplace)) {
        if apply_text_replaces(app, engine, index).map_err(SyncError::Io)? {
            changes.text_replaces = true;
        }
    }
    if snapshots.iter().any(|s| matches!(s, Snapshot::ChapterRule)) {
        if apply_chapter_rules(app, engine).map_err(SyncError::Io)? {
            changes.chapter_rules = true;
        }
    }
    Ok(changes)
}

/// 落地单本书的元信息（`PublishMode::Imported` 的「以引擎为准」路径）。
fn apply_book_fields<R: tauri::Runtime>(
    app: &AppHandle<R>,
    local_id: &str,
    fields: &BookEntityFields,
) -> Result<bool, String> {
    let want = BookSyncMeta {
        id: local_id.to_string(),
        title: fields.title.clone(),
        author: fields.author.clone(),
        intro: fields.intro.clone(),
        format: fields.format.clone(),
        file_name: fields.file_name.clone(),
        size: fields.size,
        split_desc: fields.split_desc.clone(),
        source: fields.source.clone(),
        book_url: fields.book_url.clone(),
        tags: fields.tags.clone(),
        source_tags: fields.source_tags.clone(),
        group_id: local_group_id(app, fields.group.as_deref())?,
        book_source_id: book_store::get_sync_meta(app, local_id)?.and_then(|m| m.book_source_id),
    };
    book_store::apply_sync_meta(app, local_id, &want)
}

/// 一次落地要处理哪些实体：`from` 之后远端操作碰过的那些，外加 `extra` 里点名的。
fn collect_snapshots(
    engine: &SharedEngine,
    from: usize,
    extra: &[String],
) -> Result<Vec<Snapshot>, SyncError> {
    let guard = lock_engine(engine);
    let device = guard.device_id().to_string();
    let ops = guard.ops();
    let start = from.min(ops.len());
    let mut touched: BTreeMap<String, String> = BTreeMap::new();
    for op in &ops[start..] {
        if op.origin == device {
            continue;
        }
        touched.insert(op.entity_id.clone(), op.kind.clone());
    }
    for id in extra {
        if let Some(entity) = guard.entity(id) {
            touched.entry(id.clone()).or_insert_with(|| entity.kind.clone());
        }
    }

    let mut snapshots = Vec::new();
    for (id, kind) in touched {
        let Some(entity) = guard.entity(&id) else {
            continue;
        };
        let deleted = guard.is_effectively_deleted(entity);
        match kind.as_str() {
            "book" => snapshots.push(Snapshot::Book {
                uid: id,
                deleted,
                fields: (!deleted).then(|| Box::new(book_snapshot_fields(entity))),
            }),
            "reading_progress" => snapshots.push(Snapshot::Progress {
                book_uid: book_ref_of(entity),
                deleted,
                entry: (!deleted).then(|| progress_snapshot(entity)),
            }),
            // 书签的增删都按「整本书签表」重写，删除标记不需要单独处理
            "bookmark" => snapshots.push(Snapshot::Bookmark {
                book_uid: book_ref_of(entity),
            }),
            "group" => snapshots.push(Snapshot::Group {
                deleted,
                name: entity
                    .field("name")
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default(),
            }),
            "book_source" => snapshots.push(Snapshot::Source {
                uid: id,
                deleted,
                payload: (!deleted).then(|| entity.field("json")).flatten(),
            }),
            // 规则类数据：一条规则变没变不改变落地动作 —— 每次都由引擎实体**整表重写**
            // 本地清单（规则条数少，重建比逐条对账更好推理，也不会漏掉删除）
            "text_replace" => snapshots.push(Snapshot::TextReplace),
            "chapter_rule" => snapshots.push(Snapshot::ChapterRule),
            _ => {}
        }
    }
    Ok(snapshots)
}

#[derive(Debug)]
enum Snapshot {
    Book {
        uid: String,
        deleted: bool,
        /// 装箱：这个变体比其它变体大一个数量级，放进枚举里会把每个快照都撑大
        fields: Option<Box<BookEntityFields>>,
    },
    Progress {
        /// 书实体 id（uid）
        book_uid: String,
        deleted: bool,
        entry: Option<Value>,
    },
    Bookmark {
        /// 书实体 id（uid）
        book_uid: String,
    },
    Group {
        deleted: bool,
        name: String,
    },
    Source {
        uid: String,
        deleted: bool,
        payload: Option<Value>,
    },
    /// 文本替换规则有变化（落地时整表重写本地清单）
    TextReplace,
    /// 分章规则有变化（同上）
    ChapterRule,
}

/// 引擎里书籍实体的字段快照（只看同步关心的那些）。
#[derive(Debug, Clone, Default)]
struct BookEntityFields {
    title: String,
    author: String,
    intro: Option<String>,
    tags: Vec<String>,
    group: Option<String>,
    format: String,
    file_name: String,
    size: u64,
    source: Option<String>,
    book_url: Option<String>,
    source_tags: Vec<String>,
    split_desc: String,
}

fn book_snapshot_fields(entity: &Entity) -> BookEntityFields {
    let text =
        |field: &str| entity.field(field).and_then(|v| v.as_str().map(str::to_string));
    let list = |field: &str| match entity.field(field) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };
    BookEntityFields {
        title: text("title").unwrap_or_default(),
        author: text("author").unwrap_or_default(),
        intro: text("intro"),
        tags: list("tags"),
        group: text("group"),
        format: text("format").unwrap_or_default(),
        file_name: text("file_name").unwrap_or_default(),
        size: entity.field("size").and_then(|v| v.as_u64()).unwrap_or(0),
        source: text("source"),
        book_url: text("book_url"),
        source_tags: list("source_tags"),
        split_desc: text("split_desc").unwrap_or_default(),
    }
}

fn progress_snapshot(entity: &Entity) -> Value {
    let mut out = serde_json::Map::new();
    for (field, key) in [
        ("chapter", "chapter"),
        ("chapter_cid", "chapterCid"),
        ("char_offset", "charOffset"),
        ("context", "context"),
        ("updated_at", "updatedAt"),
    ] {
        if let Some(value) = entity.field(field) {
            if !value.is_null() {
                out.insert(key.to_string(), value);
            }
        }
    }
    Value::Object(out)
}

/// 实体上指向书的字段（进度与书签都叫 `book_id`，装的是书实体 id）。
fn book_ref_of(entity: &Entity) -> String {
    entity
        .field("book_id")
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 落地实现
// ---------------------------------------------------------------------------

/// 落地一本书：本机没有这个文件就跳过（元信息留在引擎里，等它被导入 / 下载到本机）；
/// 对端删了它且本机有文件时按同步结果删除本机书（返回 Some(本机 id) 表示改动了）。
fn apply_book<R: tauri::Runtime>(
    app: &AppHandle<R>,
    index: &mut BookIndex,
    uid: &str,
    deleted: bool,
    fields: Option<&BookEntityFields>,
) -> Result<Option<String>, String> {
    let Some(local_id) = index.resolve(app, uid)? else {
        return Ok(None);
    };
    if deleted {
        book_store::delete_book(app, &local_id)?;
        index.remove(&local_id);
        log::info!("按同步结果删除本地书 id={local_id}（对端已删除）");
        return Ok(Some(local_id));
    }
    let Some(fields) = fields else {
        return Ok(None);
    };
    if apply_book_fields(app, &local_id, fields)? {
        Ok(Some(local_id))
    } else {
        Ok(None)
    }
}

fn apply_progress<R: tauri::Runtime>(
    app: &AppHandle<R>,
    index: &mut BookIndex,
    book_uid: &str,
    deleted: bool,
    entry: Option<&Value>,
) -> Result<bool, String> {
    let Some(local_id) = index.resolve(app, book_uid)? else {
        return Ok(false);
    };
    if deleted {
        return Ok(false); // 书的删除会连进度一起清掉，这里不重复动作
    }
    let Some(entry) = entry else {
        return Ok(false);
    };
    let mut shelf = storage::read_state(app, SHELF_KEY)?.unwrap_or_else(|| json!({}));
    let Some(map) = shelf.as_object_mut() else {
        return Ok(false);
    };
    let current = map.get(&local_id).cloned().unwrap_or_else(|| json!({}));
    let mut merged = current.as_object().cloned().unwrap_or_default();
    let mut changed = false;
    for (key, value) in entry.as_object().into_iter().flatten() {
        if merged.get(key) != Some(value) {
            merged.insert(key.clone(), value.clone());
            changed = true;
        }
    }
    if !changed {
        return Ok(false);
    }
    merged.insert("bookId".to_string(), json!(local_id));
    map.insert(local_id, Value::Object(merged));
    storage::write_state(app, SHELF_KEY, &shelf)?;
    Ok(true)
}

/// 按引擎里的书签实体重写某本书的 `bookmarks.json`。
fn apply_bookmarks<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    local_id: &str,
    book_uid: &str,
) -> Result<bool, String> {
    let values = {
        let guard = lock_engine(engine);
        let mut items: Vec<(String, Value)> = guard
            .entities_of_kind("bookmark", false)
            .into_iter()
            .filter(|entity| book_ref_of(entity) == book_uid)
            .map(|entity| {
                (
                    entity.id.clone(),
                    bookmark_value(&entity.id, local_id, entity),
                )
            })
            .collect();
        items.sort_by(|a, b| a.0.cmp(&b.0));
        items.into_iter().map(|(_, value)| value).collect::<Vec<Value>>()
    };
    let current = book_store::get_bookmarks(app, local_id)?;
    if current == values {
        return Ok(false);
    }
    book_store::put_bookmarks(app, local_id, &values)?;
    Ok(true)
}

/// 按引擎里的规则实体重写本地文本替换清单（`readerx.textReplacements`）。
///
/// - 全局规则直接落地；按书生效的规则要先把书实体 id 翻回本机书 id，翻不出来
///   （本机还没导入那本书）的**留在引擎里不落地**，等书落到本机后再补一次；
/// - 顺序按创建时间、其次实体 id（两台设备看到同一个顺序，不会各排各的）；
/// - 写之前先比一遍，值没变不写盘（避免每次同步都无谓地敲一次状态文件）。
fn apply_text_replaces<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    index: &mut BookIndex,
) -> Result<bool, String> {
    // 先把实体拷出来再开锁：落地要读 / 写状态文件，不能抱着引擎锁做 I/O
    let entities: Vec<Entity> = lock_engine(engine)
        .entities_of_kind("text_replace", false)
        .into_iter()
        .cloned()
        .collect();
    let mut items: Vec<(i64, String, Value)> = Vec::new();
    for entity in entities {
        let find = text_field(&entity, "find");
        if find.is_empty() {
            continue;
        }
        let scope = match text_field(&entity, "scope").as_str() {
            "book" => "book",
            _ => "global",
        };
        let book_uid = book_ref_of(&entity);
        let book_id = if scope == "book" {
            match index.resolve(app, &book_uid)? {
                Some(local_id) => local_id,
                // 书还没到本机：规则留在引擎里，等书落地时补
                None => continue,
            }
        } else {
            String::new()
        };
        let created_at = entity.field("created_at").and_then(|v| v.as_i64()).unwrap_or(0);
        items.push((
            created_at,
            entity.id.clone(),
            json!({
                "id": entity.id,
                "scope": scope,
                "bookId": book_id,
                "find": find,
                "replace": text_field(&entity, "replace"),
                "regex": entity.field("regex").and_then(|v| v.as_bool()).unwrap_or(false),
                "createdAt": created_at,
            }),
        ));
    }
    items.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let next = Value::Array(items.into_iter().map(|(_, _, value)| value).collect());
    write_state_if_changed(app, TEXT_REPLACES_KEY, &next)
}

/// 按引擎里的规则实体重写本地分章规则清单（`readerx.chapterRules` 的用户自定义部分）。
///
/// 内置规则是代码常量、不进状态文件，因此这里写出来的每一条都带 `builtin: false`。
fn apply_chapter_rules<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
) -> Result<bool, String> {
    let entities: Vec<Entity> = lock_engine(engine)
        .entities_of_kind("chapter_rule", false)
        .into_iter()
        .cloned()
        .collect();
    let mut items: Vec<(i64, String, Value)> = entities
        .into_iter()
        .filter_map(|entity| {
            let name = text_field(&entity, "name");
            let pattern = text_field(&entity, "pattern");
            if name.is_empty() || pattern.is_empty() {
                return None;
            }
            let created_at = entity.field("created_at").and_then(|v| v.as_i64()).unwrap_or(0);
            Some((
                created_at,
                entity.id.clone(),
                json!({
                    "id": entity.id,
                    "name": name,
                    "pattern": pattern,
                    "builtin": false,
                    "createdAt": created_at,
                }),
            ))
        })
        .collect();
    items.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let next = Value::Array(items.into_iter().map(|(_, _, value)| value).collect());
    write_state_if_changed(app, CHAPTER_RULES_KEY, &next)
}

/// 状态文件只在值真的变了时重写（同步落地路径会被反复调用）。
fn write_state_if_changed<R: tauri::Runtime>(
    app: &AppHandle<R>,
    key: &str,
    next: &Value,
) -> Result<bool, String> {
    let current = storage::read_state(app, key)?;
    if current.as_ref() == Some(next) {
        return Ok(false);
    }
    storage::write_state(app, key, next)?;
    Ok(true)
}

/// 实体上的字符串字段（缺省空串）。
fn text_field(entity: &Entity, field: &str) -> String {
    entity
        .field(field)
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// 落地分组：同步来的分组在本机按**名字**对应，缺的补上，删掉的移除。
fn apply_groups<R: tauri::Runtime>(
    app: &AppHandle<R>, snapshots: &[Snapshot],
) -> Result<bool, String> {
    let names: Vec<(bool, &str)> = snapshots
        .iter()
        .filter_map(|snapshot| match snapshot {
            Snapshot::Group { deleted, name } if !name.is_empty() => {
                Some((*deleted, name.as_str()))
            }
            _ => None,
        })
        .collect();
    if names.is_empty() {
        return Ok(false);
    }
    let mut groups = storage::read_state(app, GROUPS_KEY)?
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let mut changed = false;
    for (deleted, name) in names {
        let existing = groups.iter().position(|group| group_name(group) == Some(name));
        match (deleted, existing) {
            (true, Some(index)) => {
                groups.remove(index);
                changed = true;
            }
            (false, None) => {
                groups.push(json!({
                    "id": new_local_id("grp"),
                    "name": name,
                    "createdAt": now_ms(),
                }));
                changed = true;
            }
            _ => {}
        }
    }
    if changed {
        storage::write_state(app, GROUPS_KEY, &Value::Array(groups))?;
    }
    Ok(changed)
}

fn group_name(group: &Value) -> Option<&str> {
    group.get("name").and_then(Value::as_str).map(str::trim)
}

/// 落地书源：按地址对应本机书源，缺的建、删的删。
fn apply_source(
    existing: &[BookSource],
    uid: &str,
    deleted: bool,
    payload: Option<&Value>,
) -> Result<bool, String> {
    let found = existing
        .iter()
        .find(|source| identity::source_uid(&source.book_source_url) == uid);
    if deleted {
        if let Some(source) = found {
            readerx_source::store::delete_source(&source.id).map_err(|e| e.to_string())?;
            return Ok(true);
        }
        return Ok(false);
    }
    let Some(payload) = payload else {
        return Ok(false);
    };
    // 多值字段：并发改同一份书源时两个值都在，取最新的那个先让人看到，
    // 另一个留在冲突队列里等裁决（见 docs/sync.md）
    let mut json = match payload {
        Value::Array(items) => items.last().cloned().unwrap_or(Value::Null),
        other => other.clone(),
    };
    let Some(object) = json.as_object_mut() else {
        return Ok(false);
    };
    let id = found
        .map(|source| source.id.clone())
        .unwrap_or_else(|| new_local_id("src"));
    object.insert("id".to_string(), json!(id));
    // 书源分组是本机归属、不参与同步：本地已有就保留，新来的先不分组
    match found.and_then(|source| source.group_id.clone()) {
        Some(group) => {
            object.insert("groupId".to_string(), json!(group));
        }
        None => {
            object.remove("groupId");
        }
    }
    let source: BookSource =
        serde_json::from_value(json).map_err(|e| format!("同步来的书源无法解析: {e}"))?;
    if let Some(old) = found {
        if same_source(old, &source) {
            return Ok(false);
        }
    }
    readerx_source::store::put_source(&source).map_err(|e| e.to_string())?;
    Ok(true)
}

fn same_source(a: &BookSource, b: &BookSource) -> bool {
    match (serde_json::to_value(a), serde_json::to_value(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// 同步分组 id → 本机分组 id（同步来的书要落进本机已有的同名分组）。
fn local_group_id<R: tauri::Runtime>(
    app: &AppHandle<R>, sync_group: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(sync_group) = sync_group else {
        return Ok(None);
    };
    let groups = storage::read_state(app, GROUPS_KEY)?
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    Ok(groups
        .iter()
        .find(|group| {
            group_name(group)
                .map(|name| identity::group_uid(name) == sync_group)
                .unwrap_or(false)
        })
        .and_then(|group| group.get("id").and_then(Value::as_str).map(str::to_string)))
}

// ---------------------------------------------------------------------------
// 字段级发布
// ---------------------------------------------------------------------------

/// 本机书籍元信息 → 引擎字段。
fn book_values(facts: &LocalFacts, meta: &BookSyncMeta) -> BTreeMap<String, Value> {
    let mut fields = BTreeMap::new();
    fields.insert("title".to_string(), json!(meta.title));
    fields.insert("author".to_string(), json!(meta.author));
    fields.insert("intro".to_string(), option_json(meta.intro.as_deref()));
    fields.insert("tags".to_string(), json!(meta.tags));
    fields.insert(
        "group".to_string(),
        option_json(facts.group_sync_id(meta.group_id.as_deref()).as_deref()),
    );
    fields.insert("format".to_string(), json!(meta.format));
    fields.insert("file_name".to_string(), json!(meta.file_name));
    fields.insert("size".to_string(), json!(meta.size));
    fields.insert("source".to_string(), option_json(meta.source.as_deref()));
    fields.insert("book_url".to_string(), option_json(meta.book_url.as_deref()));
    fields.insert("source_tags".to_string(), json!(meta.source_tags));
    fields.insert("split_desc".to_string(), json!(meta.split_desc));
    fields
}

/// 算 uid 时的 `LocalFacts` 版本（要先把本机书源 id 翻译成地址）。
fn book_uid_of_parts(facts: &mut LocalFacts, meta: &BookSyncMeta) -> String {
    let source_url = facts.source_url(meta.book_source_id.as_deref());
    identity::book_uid(&BookKey {
        source_url: source_url.as_deref(),
        book_url: meta.book_url.as_deref(),
        file_name: &meta.file_name,
        size: meta.size,
    })
}

fn progress_values(entry: &Value) -> BTreeMap<String, Value> {
    let mut fields = BTreeMap::new();
    let number = |key: &str| entry.get(key).and_then(Value::as_i64);
    fields.insert("chapter".to_string(), json!(number("chapter").unwrap_or(0)));
    if let Some(cid) = entry.get("chapterCid").and_then(Value::as_str) {
        fields.insert("chapter_cid".to_string(), json!(cid));
    }
    fields.insert("char_offset".to_string(), json!(number("charOffset").unwrap_or(0)));
    if let Some(context) = entry.get("context").and_then(Value::as_str) {
        fields.insert("context".to_string(), json!(context));
    }
    fields.insert("updated_at".to_string(), json!(number("updatedAt").unwrap_or(0)));
    fields
}

fn bookmark_values(value: &Value, book_uid: &str) -> BTreeMap<String, Value> {
    let mut fields = BTreeMap::new();
    fields.insert("book_id".to_string(), json!(book_uid));
    for (key, field) in [
        ("chapterCid", "chapter_cid"),
        ("chapterTitle", "chapter_title"),
        ("text", "text"),
        ("before", "before"),
        ("after", "after"),
    ] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            fields.insert(field.to_string(), json!(text));
        }
    }
    for (key, field) in [
        ("chapterIndex", "chapter_index"),
        ("unitIndex", "unit_index"),
        ("charStart", "char_start"),
        ("charEnd", "char_end"),
        ("createdAt", "created_at"),
    ] {
        if let Some(number) = value.get(key).and_then(Value::as_i64) {
            fields.insert(field.to_string(), json!(number));
        }
    }
    if let Some(note) = value.get("note").and_then(Value::as_str) {
        fields.insert("note".to_string(), json!(note));
    }
    fields
}

/// 引擎里的书签实体 → 前端书签记录（字段名回到前端口径）。
fn bookmark_value(id: &str, local_book_id: &str, entity: &Entity) -> Value {
    let text = |field: &str| entity.field(field).unwrap_or(Value::Null);
    json!({
        "id": id,
        "bookId": local_book_id,
        "chapterCid": text("chapter_cid"),
        "chapterIndex": text("chapter_index"),
        "chapterTitle": text("chapter_title"),
        "unitIndex": text("unit_index"),
        "charStart": text("char_start"),
        "charEnd": text("char_end"),
        "text": text("text"),
        "before": text("before"),
        "after": text("after"),
        "createdAt": text("created_at"),
    })
}

/// 文本替换规则的引擎字段。`book_id` 存书实体 id（uid），全局规则为空串。
fn text_replace_values(
    scope: &str,
    book_uid: &str,
    find: &str,
    replace: &str,
    regex: bool,
    rule: &Value,
) -> BTreeMap<String, Value> {
    let mut fields = BTreeMap::new();
    fields.insert("scope".to_string(), json!(scope));
    fields.insert("book_id".to_string(), json!(book_uid));
    fields.insert("find".to_string(), json!(find));
    fields.insert("replace".to_string(), json!(replace));
    fields.insert("regex".to_string(), json!(regex));
    fields.insert(
        "created_at".to_string(),
        json!(rule.get("createdAt").and_then(Value::as_i64).unwrap_or(0)),
    );
    fields
}

/// 分章规则的引擎字段：名称 + 正则即身份，另带创建时间（只用来稳定显示顺序）。
fn chapter_rule_values(name: &str, pattern: &str, created_at: i64) -> BTreeMap<String, Value> {
    let mut fields = BTreeMap::new();
    fields.insert("name".to_string(), json!(name.trim()));
    fields.insert("pattern".to_string(), json!(pattern.trim()));
    fields.insert("created_at".to_string(), json!(created_at));
    fields
}

fn source_payload(source: &BookSource) -> Value {
    let mut json = serde_json::to_value(source).unwrap_or_else(|_| json!({}));
    if let Some(object) = json.as_object_mut() {
        // id 每台设备各自生成；groupId 是本机的书源分组归属，都不进同步载荷
        object.remove("id");
        object.remove("groupId");
    }
    json
}

/// 逐个字段比较后发布：值相同不产生操作。
fn publish_fields(
    engine: &mut SyncEngine,
    id: &str,
    wanted: &BTreeMap<String, Value>,
) -> Result<(), SyncError> {
    for (field, value) in wanted {
        if value.is_array() {
            publish_set(engine, id, field, value)?;
        } else {
            publish_value(engine, id, field, value.clone())?;
        }
    }
    Ok(())
}

/// 发布单值字段（相同则跳过；待裁决的字段不碰）。
fn publish_value(
    engine: &mut SyncEngine,
    id: &str,
    field: &str,
    value: Value,
) -> Result<(), SyncError> {
    let Some(entity) = engine.entity(id) else {
        return Ok(());
    };
    if entity.conflicted.contains(field) {
        log::debug!("字段有待裁决的冲突，暂不自动改写 entity={id} field={field}");
        return Ok(());
    }
    let current = entity.field(field);
    if current.as_ref() == Some(&value) {
        return Ok(());
    }
    match (current, value.is_null()) {
        (None, true) => Ok(()),
        (Some(current), true) if current.is_null() => Ok(()),
        (_, true) => engine.unset_field(id, field),
        (_, false) => engine.set_field(id, field, value),
    }
}

/// 发布集合字段：只做增删差集（集合语义下「重写整个集合」会丢掉对端加的元素）。
fn publish_set(
    engine: &mut SyncEngine,
    id: &str,
    field: &str,
    value: &Value,
) -> Result<(), SyncError> {
    let Some(entity) = engine.entity(id) else {
        return Ok(());
    };
    if entity.conflicted.contains(field) {
        return Ok(());
    }
    let wanted: Vec<String> = value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let current = engine.set_elements(id, field);
    for item in &wanted {
        if !current.iter().any(|existing| existing == item) {
            engine.add_element(id, field, item, None)?;
        }
    }
    for item in &current {
        if !wanted.iter().any(|wanted| wanted == item) {
            engine.remove_element(id, field, item)?;
        }
    }
    Ok(())
}

/// 发布多值字段（书源的整份 JSON）：相同值不重复写入。
fn publish_multi(
    engine: &mut SyncEngine,
    id: &str,
    field: &str,
    value: Value,
) -> Result<(), SyncError> {
    let Some(entity) = engine.entity(id) else {
        return Ok(());
    };
    if entity.conflicted.contains(field) {
        log::debug!("书源有多值冲突待裁决，暂不自动改写 entity={id}");
        return Ok(());
    }
    let current = entity.field(field).unwrap_or(Value::Null);
    let already = match &current {
        Value::Array(items) => items.iter().any(|item| item == &value),
        other => other == &value,
    };
    if already {
        return Ok(());
    }
    engine.set_field(id, field, value)
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

fn option_json(value: Option<&str>) -> Value {
    match value {
        Some(text) if !text.trim().is_empty() => json!(text),
        _ => Value::Null,
    }
}

fn new_local_id(prefix: &str) -> String {
    format!("{prefix}-{}", readerx_sync::new_id().to_string().to_lowercase())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_values_map_camel_case_keys() {
        let entry = json!({
            "bookId": "b1",
            "chapter": 3,
            "chapterCid": "c0004",
            "charOffset": 120,
            "context": "风停了",
            "updatedAt": 1700,
        });
        let values = progress_values(&entry);
        assert_eq!(values["chapter"], json!(3));
        assert_eq!(values["chapter_cid"], json!("c0004"));
        assert_eq!(values["char_offset"], json!(120));
        assert_eq!(values["context"], json!("风停了"));
        assert_eq!(values["updated_at"], json!(1700));
    }

    #[test]
    fn bookmark_values_keep_position_fields() {
        let mark = json!({
            "id": "bm-1",
            "bookId": "b1",
            "chapterCid": "c0002",
            "chapterIndex": 1,
            "chapterTitle": "第二章",
            "unitIndex": 4,
            "charStart": 10,
            "charEnd": 20,
            "text": "选中",
            "before": "前",
            "after": "后",
            "createdAt": 99,
        });
        let values = bookmark_values(&mark, "b-abc");
        assert_eq!(values["book_id"], json!("b-abc"));
        assert_eq!(values["chapter_cid"], json!("c0002"));
        assert_eq!(values["char_start"], json!(10));
        assert_eq!(values["char_end"], json!(20));
        assert_eq!(values["created_at"], json!(99));
        assert!(!values.contains_key("id"), "实体 id 就是书签 id，不进字段");
    }

    #[test]
    fn bookmark_value_round_trips_back_to_frontend_shape() {
        let mut fields = BTreeMap::new();
        fields.insert("book_id".to_string(), json!("b-abc"));
        fields.insert("chapter_cid".to_string(), json!("c0002"));
        fields.insert("char_start".to_string(), json!(10));
        fields.insert("char_end".to_string(), json!(20));
        fields.insert("text".to_string(), json!("选中"));
        let mut entity = Entity::new("bm-1", "bookmark", readerx_sync::Hlc::default(), 1);
        for (name, value) in fields {
            entity.fields.insert(
                name,
                readerx_sync::FieldState::Value {
                    value,
                    hlc: readerx_sync::Hlc::default(),
                    origin: readerx_sync::model::Stamp::new("A", 1),
                },
            );
        }
        let value = bookmark_value("bm-1", "local-1", &entity);
        assert_eq!(value["id"], json!("bm-1"));
        assert_eq!(value["bookId"], json!("local-1"));
        assert_eq!(value["charEnd"], json!(20));
        assert_eq!(value["chapterIndex"], Value::Null);
    }

    #[test]
    fn source_payload_drops_local_fields() {
        let source = BookSource {
            schema_version: 1,
            id: "src-abc".to_string(),
            name: "示例源".to_string(),
            book_source_url: "https://example.com".to_string(),
            author: String::new(),
            version: String::new(),
            comment: String::new(),
            enabled: true,
            capabilities: Default::default(),
            auto_auth: true,
            group_id: Some("sg-1".to_string()),
            user_agent: String::new(),
            headers: Default::default(),
            update_time: 0,
            js: "function searchBook(){}".to_string(),
        };
        let payload = source_payload(&source);
        assert!(payload.get("id").is_none());
        assert!(payload.get("groupId").is_none());
        assert_eq!(payload["name"], json!("示例源"));
        assert!(payload["js"].as_str().unwrap().contains("searchBook"));
    }

    #[test]
    fn option_json_normalizes_empty_strings() {
        assert_eq!(option_json(None), Value::Null);
        assert_eq!(option_json(Some("   ")), Value::Null);
        assert_eq!(option_json(Some("简介")), json!("简介"));
    }
}

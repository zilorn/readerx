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
//!   迁移后的本地书籍 ID 与 uid 一致（见 [`super::book_ids`]）。

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use tauri::AppHandle;

use readerx_sync::assets::AssetKind;
use readerx_sync::net::{lock_engine, SharedEngine};
use readerx_sync::{Entity, SyncEngine, SyncError};

use crate::book_store::{self, BookSyncMeta, ChapterRef};
use crate::models::BookSource;
use crate::storage;

use super::identity::{self, BookKey};

/// 阅读进度所在的偏好 key（前端 `store.ts` 的 `SHELF_KEY`，两边必须一致）
const SHELF_KEY: &str = "readerx.shelf";
/// 书架分组所在的偏好 key（前端 `groups.ts` 的 `GROUPS_KEY`）
const GROUPS_KEY: &str = "readerx.groups";
/// 书源分组所在的偏好 key（前端 `sourceGroups.ts` 的 `SOURCE_GROUPS_KEY`）
const SOURCE_GROUPS_KEY: &str = "readerx.sourceGroups";
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
    /// 阅读时长变化 → 重载统计
    pub reading_time: bool,
    /// 分组有变化 → 重新读回分组
    pub groups: bool,
    /// 书源分组有变化 → 重新读回书源分组
    pub source_groups: bool,
    /// 书源有变化 → 重新拉书源列表
    pub sources: bool,
    /// 书签有变化的本机书 id → 只重载这几本
    pub bookmarks: Vec<String>,
    /// 注释有变化的书 id → 失效并重载阅读页注释
    pub annotations: Vec<String>,
    /// 文本替换规则有变化 → 重新读回规则清单
    pub text_replaces: bool,
    /// 分章规则有变化 → 重新读回规则清单
    pub chapter_rules: bool,
    /// 章节结构 / 正文有变化的本机书 id → 重载这几本的正文缓存
    pub chapters: Vec<String>,
    /// 本次落地删掉的本机书 id（对端删了它们）
    pub deleted_books: Vec<String>,
}

impl AppliedChanges {
    fn merge(&mut self, next: AppliedChanges) {
        self.books |= next.books;
        self.progress |= next.progress;
        self.reading_time |= next.reading_time;
        self.groups |= next.groups;
        self.source_groups |= next.source_groups;
        self.sources |= next.sources;
        self.text_replaces |= next.text_replaces;
        self.chapter_rules |= next.chapter_rules;
        self.bookmarks.extend(next.bookmarks);
        self.annotations.extend(next.annotations);
        self.chapters.extend(next.chapters);
        self.deleted_books.extend(next.deleted_books);
    }

    pub fn is_empty(&self) -> bool {
        !self.books
            && !self.progress
            && !self.reading_time
            && !self.groups
            && !self.source_groups
            && !self.sources
            && !self.text_replaces
            && !self.chapter_rules
            && self.bookmarks.is_empty()
            && self.annotations.is_empty()
            && self.chapters.is_empty()
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
    if super::book_ids::canonical_id(&meta.id) { return meta.id.clone(); }
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
    if super::book_ids::canonical_id(book_id) { return book_id.to_string(); }
    match book_store::get_sync_meta(app, book_id) {
        Ok(Some(meta)) => book_uid_of(app, &meta),
        // 元信息读不出来（文件已删）：用本机 id 兜底。它不会和别的设备对齐，
        // 但能保证「删除 / 重置」这类操作至少在本机引擎里是一致的。
        _ => identity::book_uid(&BookKey { file_name: book_id, ..BookKey::default() }),
    }
}

/// [`book_uid_of_id`] 的对外版本：本地写入钩子维护书身份索引时用（集成测试也用它
/// 验证「本机算出来的书身份与对端一致」）。
pub fn local_uid<R: tauri::Runtime>(app: &AppHandle<R>, book_id: &str) -> String {
    book_uid_of_id(app, book_id)
}

/// 内置隐藏分组不在分组清单中，使用固定身份跨设备传递。
const HIDDEN_GROUP_ID: &str = "__hidden__";

/// 本机侧的事实：分组归属与书源地址（发布书籍元信息时要把本机 id 翻译成跨设备身份）。
#[derive(Debug, Default)]
struct LocalFacts {
    /// 本机分组 id → 同步分组 id
    groups: HashMap<String, String>,
    /// 本机书源分组 id → 同步书源分组 id
    source_groups: HashMap<String, String>,
    /// 本机书源 id → 书源地址（在线书身份用）
    source_urls: HashMap<String, String>,
}

impl LocalFacts {
    fn load<R: tauri::Runtime>(app: &AppHandle<R>) -> LocalFacts {
        LocalFacts {
            groups: group_ids(app, GROUPS_KEY, identity::group_uid),
            source_groups: group_ids(app, SOURCE_GROUPS_KEY, identity::source_group_uid),
            source_urls: HashMap::new(),
        }
    }

    fn group_sync_id(&self, local_group_id: Option<&str>) -> Option<String> {
        local_group_id.and_then(|id| {
            if id == HIDDEN_GROUP_ID {
                Some(HIDDEN_GROUP_ID.to_string())
            } else {
                self.groups.get(id).cloned()
            }
        })
    }

    /// 书源分组的同步 id（书源归属发布时用）。
    fn source_group_sync_id(&self, local_group_id: Option<&str>) -> Option<String> {
        local_group_id.and_then(|id| self.source_groups.get(id).cloned())
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

/// 读一份分组清单（`readerx.groups` / `readerx.sourceGroups` 同构），返回
/// 「本机分组 id → 同步分组 id」。书源分组与书架分组只差 key 与身份派生函数。
fn group_ids<R: tauri::Runtime>(
    app: &AppHandle<R>,
    key: &str,
    uid_of: fn(&str) -> String,
) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Ok(Some(groups)) = storage::read_state(app, key) {
        for group in groups.as_array().map(Vec::as_slice).unwrap_or_default() {
            let (Some(id), Some(name)) = (
                group.get("id").and_then(Value::as_str),
                group.get("name").and_then(Value::as_str),
            ) else {
                continue;
            };
            let prefix = if key == SOURCE_GROUPS_KEY {
                "sg-"
            } else {
                "g-"
            };
            map.insert(id.to_string(), identity::entity_id(id, prefix, uid_of(name)));
        }
    }
    map
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

    // 旧实体可能没有建书所需的书源地址。只补身份已验证的缺失字段，保留远端编辑。
    if let Some(url) = facts.source_url(meta.book_source_id.as_deref()) {
        let missing = engine.entity(&uid)
            .and_then(|entity| entity.field("source_url"))
            .is_none_or(|value| value.as_str().is_none_or(|text| text.trim().is_empty()));
        if missing {
            publish_fields(engine, &uid, &BTreeMap::from([("source_url".to_string(), json!(url))]))?;
        }
    }

    // 升级后的对账补齐旧同步实体的书源 ID，不覆盖已有的统一关联。
    if let Some(id) = book_values(facts, meta).get("book_source_id").and_then(Value::as_str) {
        let missing = engine.entity(&uid).and_then(|entity| entity.field("book_source_id"))
            .is_none_or(|value| value.as_str().is_none_or(|id| !identity::stable_id(id, "s-")));
        if missing {
            publish_value(engine, &uid, "book_source_id", json!(id))?;
        }
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
/// **必须在本地删书之前调用**：定位书身份要读取书籍元信息。
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
    // 暂存区里还没落地的正文跟着书一起丢掉：书都没了，正文留着只会占地方
    if let Err(error) = guard.drop_staged(&uid) {
        log::warn!("清理书籍暂存正文失败（{book_id}）：{error}");
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

/// 每条 note 独立发布；快照缺少的远端 note 不解释成删除。
/// 启动对账只补引擎缺少的注释，已有实体以引擎为准，避免旧磁盘重发覆盖。
pub fn publish_annotations<R: tauri::Runtime>(
    app: &AppHandle<R>, engine: &SharedEngine, index: &mut BookIndex,
    book_id: &str, annotations: &[Value], only_missing: bool,
) -> Result<(), SyncError> {
    let notes = crate::annotations::flatten(annotations).map_err(SyncError::Io)?;
    let uid = index.uid_for(app, book_id);
    let mut guard = lock_engine(engine);
    for (note_id, note) in notes {
        // 按书限定实体身份，导入旧备份或碰巧同名不会串到别的书。
        let id = format!("annotation:{uid}:{note_id}");
        let values = BTreeMap::from([
            ("book_id".into(), json!(uid)),
            ("note_id".into(), json!(note_id)),
            ("anchor".into(), note.anchor),
            ("note".into(), note.value["text"].clone()),
            ("created_at".into(), note.value["createdAt"].clone()),
            ("updated_at".into(), note.value["updatedAt"].clone()),
        ]);
        if guard.entity(&id).is_none() {
            guard.create_entity("annotation", Some(id), values)?;
        } else if !only_missing {
            if guard.entity(&id).is_some_and(Entity::is_deleted) { guard.restore_entity(&id)?; }
            publish_fields(&mut guard, &id, &values)?;
        }
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
        let uid = identity::entity_id(
            group.get("id").and_then(Value::as_str).unwrap_or_default(),
            "g-",
            identity::group_uid(name),
        );
        live.push(uid.clone());
        if guard.entity(&uid).is_none() {
            guard.create_entity("group", Some(uid), [("name", json!(name))])?;
        } else {
            publish_value(&mut guard, &uid, "name", json!(name))?;
        }
    }
    tombstone_missing_groups(&mut guard, "group", &live)
}

/// 发布书源分组清单（`readerx.sourceGroups` 的整个数组）。
///
/// 与书架分组同构（名字即身份），只是实体类型与身份派生不同命名空间 ——
/// 两个清单里各有一个「科幻」时它们是两个分组，不会互相认领。
pub fn publish_source_groups<R: tauri::Runtime>(
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
        let uid = identity::entity_id(
            group.get("id").and_then(Value::as_str).unwrap_or_default(),
            "sg-",
            identity::source_group_uid(name),
        );
        live.push(uid.clone());
        // 创建时间只用来稳定显示顺序（新建的分组排在后面），并发不一致不算冲突
        let created_at = group.get("createdAt").and_then(Value::as_i64).unwrap_or(0);
        let values = [("name", json!(name)), ("created_at", json!(created_at))];
        if guard.entity(&uid).is_none() {
            guard.create_entity("source_group", Some(uid), values)?;
        } else {
            for (field, value) in values {
                publish_value(&mut guard, &uid, field, value)?;
            }
        }
    }
    tombstone_missing_groups(&mut guard, "source_group", &live)
}

/// 引擎里有、本地清单里没有的分组 → 墓碑（用户在本机删掉了它）。
fn tombstone_missing_groups(
    engine: &mut SyncEngine,
    kind: &str,
    live: &[String],
) -> Result<(), SyncError> {
    let stale: Vec<String> = engine
        .entities_of_kind(kind, false)
        .into_iter()
        .map(|entity| entity.id.clone())
        .filter(|id| !live.iter().any(|uid| uid == id))
        .collect();
    for id in stale {
        engine.delete_entity(&id, Some("分组已删除".to_string()))?;
    }
    Ok(())
}

/// 发布书源：ID 与本地一致，分组归属走独立的 `group` 字段。
pub fn publish_source<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    source: &BookSource,
) -> Result<(), SyncError> {
    let facts = LocalFacts::load(app);
    publish_source_with(engine, &facts, source)
}

/// 发布一份书源（调用方已有 [`LocalFacts`]，对账时批量发布用）。
fn publish_source_with(
    engine: &SharedEngine,
    facts: &LocalFacts,
    source: &BookSource,
) -> Result<(), SyncError> {
    let uid = identity::entity_id(
        &source.id,
        "s-",
        identity::source_uid(&source.book_source_url),
    );
    let payload = source_payload(source);
    let group = facts.source_group_sync_id(source.group_id.as_deref());
    let mut guard = lock_engine(engine);
    if guard.entity(&uid).is_none() {
        guard.create_entity(
            "book_source",
            Some(uid),
            [
                ("name", json!(source.name)),
                ("url", json!(source.book_source_url)),
                ("json", payload),
                ("group", option_json(group.as_deref())),
            ],
        )?;
        return Ok(());
    }
    publish_value(&mut guard, &uid, "name", json!(source.name))?;
    publish_value(&mut guard, &uid, "url", json!(source.book_source_url))?;
    publish_value(&mut guard, &uid, "group", option_json(group.as_deref()))?;
    publish_multi(&mut guard, &uid, "json", payload)?;
    Ok(())
}

/// 删除一份书源（按地址定位实体）。
pub fn publish_source_delete<R: tauri::Runtime>(
    _app: &AppHandle<R>,
    engine: &SharedEngine,
    book_source_url: &str,
) -> Result<(), SyncError> {
    let uid = identity::entity_id(book_source_url, "s-", identity::source_uid(book_source_url));
    let mut guard = lock_engine(engine);
    if guard.entity(&uid).is_some() {
        guard.delete_entity(&uid, Some("书源已删除".to_string()))?;
    }
    Ok(())
}

/// 重新发布**已分组的书源**（书源分组清单改名后调用）。
///
/// 分组改名沿用 ID；归属未变时不会写操作。
pub fn republish_grouped_sources<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
) -> Result<(), SyncError> {
    let sources = readerx_source::store::list_sources().map_err(SyncError::Io)?;
    let facts = LocalFacts::load(app);
    for source in sources.iter().filter(|source| source.group_id.is_some()) {
        publish_source_with(engine, &facts, source)?;
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

/// 发布一本书的章节目录（结构）。
///
/// 目录是派生数据（正文的章节头），以「一本书一份、整份 LWW」的方式同步：
/// 不拆成逐章实体，免得一次目录刷新写下上千条操作。空目录不发布（没有章节的书
/// 没有结构可言，发布出去只会给对端一个空壳）。
pub fn publish_structure<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    index: &mut BookIndex,
    book_id: &str,
    chapters: &[ChapterRef],
) -> Result<(), SyncError> {
    if chapters.is_empty() {
        return Ok(());
    }
    let uid = index.uid_for(app, book_id);
    let id = identity::book_structure_uid(&uid);
    let value = serde_json::to_value(chapters).map_err(|e| SyncError::Protocol(e.to_string()))?;
    let mut guard = lock_engine(engine);
    match guard.entity(&id) {
        None => {
            guard.create_entity(
                "book_structure",
                Some(id),
                [("book_id", json!(uid)), ("chapters", value)],
            )?;
        }
        // 书曾被删过（目录跟着进了墓碑）后又在本机重新导入：视为有意恢复
        Some(entity) if entity.is_deleted() => {
            guard.restore_entity(&id)?;
            publish_value(&mut guard, &id, "chapters", value)?;
        }
        Some(_) => publish_value(&mut guard, &id, "chapters", value)?,
    }
    Ok(())
}

/// 升级修复：旧同步把内置隐藏归属漏写成 null，在落地旧操作之前保住本机隐藏书。
/// 仅由服务在首次升级时调用，普通分组变更与已删除书不受影响。
pub(crate) fn migrate_hidden_groups<R: tauri::Runtime>(
    app: &AppHandle<R>, engine: &SharedEngine,
) -> Result<(), SyncError> {
    for meta in book_store::list_sync_meta(app).map_err(SyncError::Io)? {
        if meta.group_id.as_deref() != Some(HIDDEN_GROUP_ID) { continue; }
        let uid = book_uid_of(app, &meta);
        let mut guard = lock_engine(engine);
        let needs_repair = guard.entity(&uid).is_some_and(|entity| {
            !guard.is_effectively_deleted(entity)
                && entity.field("group").is_none_or(|group| group.is_null())
        });
        if needs_repair { guard.set_field(&uid, "group", json!(HIDDEN_GROUP_ID))?; }
    }
    lock_engine(engine).flush()?;
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
    reconcile_annotations_mode(app, engine, index, false)
}

/// 备份导入属于显式本地改动；注释缺失也要发布删除，启动则只补缺失实体。
pub(crate) fn reconcile_annotations_mode<R: tauri::Runtime>(
    app: &AppHandle<R>, engine: &SharedEngine, index: &mut BookIndex, imported: bool,
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

    for meta in &books {
        // 读失败须中止对账，不能先推进落库游标再以空注释覆盖。
        let annotations = book_store::get_annotations(app, &meta.id).map_err(SyncError::Io)?;
        publish_annotations(app, engine, index, &meta.id, &annotations, !imported)?;
        let uid = index.uid_for(app, &meta.id);
        if imported {
            let present = crate::annotations::flatten(&annotations).map_err(SyncError::Io)?;
            let mut guard = lock_engine(engine);
            let removed = guard.entities_of_kind("annotation", false).into_iter()
                .filter(|entity| book_ref_of(entity) == uid &&
                    entity.field("note_id").and_then(|v| v.as_str().map(str::to_owned)).is_some_and(|id| !present.contains_key(&id)))
                .map(|entity| entity.id.clone()).collect::<Vec<_>>();
            for id in removed { guard.delete_entity(&id, Some("备份恢复移除注释".into()))?; }
        }
        apply_annotations(app, engine, &meta.id, &uid).map_err(SyncError::Io)?;
    }

    // 分组与书源（书源分组要排在书源前面：书源的归属按分组实体 id 发布）
    if let Ok(Some(groups)) = storage::read_state(app, GROUPS_KEY) {
        publish_groups(app, engine, &groups)?;
    }
    if let Ok(Some(groups)) = storage::read_state(app, SOURCE_GROUPS_KEY) {
        publish_source_groups(app, engine, &groups)?;
    }
    // 规则类数据（文本替换 / 分章规则）
    if let Ok(Some(rules)) = storage::read_state(app, TEXT_REPLACES_KEY) {
        publish_text_replaces(app, engine, index, &rules)?;
    }
    if let Ok(Some(rules)) = storage::read_state(app, CHAPTER_RULES_KEY) {
        publish_chapter_rules(app, engine, &rules)?;
    }
    // 目录（结构）：只读数据库章节头，不解析正文 —— 首次启用同步时
    // 要把现有书库的目录一起灌进引擎，不能按「读整本」的代价来
    match book_store::list_sync_structures(app) {
        Ok(structures) => {
            for (book_id, chapters) in &structures {
                publish_structure(app, engine, index, book_id, chapters)?;
            }
        }
        Err(error) => log::warn!("同步对账未能读取书籍目录：{error}"),
    }
    if let Ok(sources) = readerx_source::store::list_sources() {
        for source in &sources {
            publish_source_with(engine, &facts, source)?;
        }
    }
    super::reading_time::publish(app, engine)?;
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
    let mut changes = apply_snapshots(app, engine, index, snapshots)?;
    changes.reading_time |= super::reading_time::apply(app, engine)?;
    apply_online_books(app, engine, index, &mut changes)?;
    apply_staged_content(app, engine, index, &mut changes)?;
    apply_staged_assets(app, engine, index, &mut changes)?;
    Ok(changes)
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
    let mut changes = apply_snapshots(app, engine, index, snapshots)?;
    changes.reading_time |= super::reading_time::apply(app, engine)?;
    apply_online_books(app, engine, index, &mut changes)?;
    apply_staged_content(app, engine, index, &mut changes)?;
    apply_staged_assets(app, engine, index, &mut changes)?;
    Ok(changes)
}

/// 在线书无需缓存正文也能按书源阅读；每次落地重试尚未创建的书，兼容旧同步记录
/// 以及书源、元信息、目录分批到达的情况。书源已在 apply_snapshots 中先行落地。
fn apply_online_books<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    index: &mut BookIndex,
    changes: &mut AppliedChanges,
) -> Result<(), SyncError> {
    let books: Vec<String> = {
        let guard = lock_engine(engine);
        guard.entities_of_kind("book", false).into_iter()
            .filter(|entity| entity.field("book_url")
                .is_some_and(|value| value.as_str().is_some_and(|url| !url.trim().is_empty())))
            .map(|entity| entity.id.clone())
            .collect()
    };
    let mut sources = None;
    for uid in books {
        if index.resolve(app, &uid).map_err(SyncError::Io)?.is_some() {
            continue;
        }
        let Some(local_id) = create_local_book_from_sync(app, engine, index, &uid, &mut sources)? else {
            continue;
        };
        changes.books = true;
        changes.chapters.push(local_id);
        // 新书创建前跳过的进度、书签及书籍规则按引擎当前值补落地。
        let related: Vec<String> = {
            let guard = lock_engine(engine);
            ["reading_progress", "bookmark", "annotation", "text_replace"].into_iter()
                .flat_map(|kind| guard.entities_of_kind(kind, true))
                .filter(|entity| book_ref_of(entity) == uid)
                .map(|entity| entity.id.clone())
                .collect()
        };
        let snapshots = collect_snapshots(engine, usize::MAX, &related)?;
        changes.merge(apply_snapshots(app, engine, index, snapshots)?);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 正文落地：暂存区 → 书库（必要时建书）
// ---------------------------------------------------------------------------

/// 把引擎暂存区里的正文写进书库。
///
/// 本机还没有这本书时**按引擎里的元信息建一本**：在线书也可在正文到达前创建。
/// 导入书的正文同步让「这台设备也要能读
/// 这本书」。建书需要几样东西凑齐，缺一不可（缺了就先把正文留在暂存区，等下次）：
///
/// - 书实体（书名 / 格式 / 文件名 / 字节数 / 书源地址）—— 元信息都没同步过来时建不了；
/// - 在线书还要求本机有对应的**书源**：书身份由「书源地址 + 书籍地址」派生，
///   书源缺失时算出来的身份与引擎里的对不上，建出来的书会变成同步不到的孤儿；
/// - PDF 与其他导入书一样：阅读使用已解析的正文块与页面图片。
fn apply_staged_content<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    index: &mut BookIndex,
    changes: &mut AppliedChanges,
) -> Result<(), SyncError> {
    let books = lock_engine(engine).staged_books();
    let mut sources = None;
    for book_uid in books {
        let (local_id, created) = match index.resolve(app, &book_uid).map_err(SyncError::Io)? {
            Some(local_id) => (local_id, false),
            None => match create_local_book_from_sync(app, engine, index, &book_uid, &mut sources)? {
                Some(local_id) => (local_id, true),
                None => continue,
            },
        };
        let bodies = lock_engine(engine).staged_bodies(&book_uid);
        if bodies.is_empty() {
            continue;
        }
        match book_store::apply_sync_chapters(app, &local_id, &bodies) {
            // 重建书时正文已经随书一次写齐（`put_book`），这里返回 0 是正常的；
            // 已有书返回 0 说明内容与本地一致（重复推送）：两种情况都该清掉暂存
            Ok(0) => {
                if created {
                    changes.books = true;
                    changes.chapters.push(local_id);
                }
            }
            Ok(applied) => {
                changes.books = true;
                if !changes.chapters.contains(&local_id) {
                    changes.chapters.push(local_id.clone());
                }
                log::debug!("同步正文已落地 book={local_id} 章节={applied}");
            }
            Err(error) => {
                // 写盘失败：暂存留着，下次同步 / 下次落地再试（不能当成已经落地）
                return Err(SyncError::Io(error));
            }
        }
        // 元信息比正文先到时，进度与书签曾因无本机书而跳过；建书后重新落地其当前状态。
        let related: Vec<String> = {
            let guard = lock_engine(engine);
            ["reading_progress", "bookmark", "annotation"].into_iter()
                .flat_map(|kind| guard.entities_of_kind(kind, true))
                .filter(|entity| book_ref_of(entity) == book_uid)
                .map(|entity| entity.id.clone()).collect()
        };
        let snapshots = collect_snapshots(engine, usize::MAX, &related)?;
        changes.merge(apply_snapshots(app, engine, index, snapshots)?);
        clear_staged(engine, &book_uid, &bodies)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 资源落地：暂存区 → 书库（封面写回元信息，插图写进图片目录）
// ---------------------------------------------------------------------------

/// 把引擎暂存区里的资源写进书库。
///
/// 与正文落地同一套边界：**本机没有这本书就不落地**（元信息还没同步过来的书，
/// 资源留着等它）；书在就逐份写，写成功才清暂存（写失败留着下次再试）。
fn apply_staged_assets<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    index: &mut BookIndex,
    changes: &mut AppliedChanges,
) -> Result<(), SyncError> {
    // 这批资源属于**哪台设备**：来源自带的数据根（一个进程里跑两台设备时不能靠猜）
    let root = {
        let guard = lock_engine(engine);
        guard.content_data_root()
    };
    // 先把清单取出来再逐本处理：**不能**边循环边加锁 —— `for x in lock_engine(..).foo()`
    // 的临时守卫会活到整个循环体结束，循环体里再取一次锁就是自己等自己（死锁）
    let books = {
        let guard = lock_engine(engine);
        guard.staged_asset_books()
    };
    for book_uid in books {
        // 没有本机书时不读取资源体：暂存 JSON 会解码图片并重算 SHA-256。
        let Some(local_id) = index.resolve(app, &book_uid).map_err(SyncError::Io)? else {
            continue;
        };
        let assets = {
            let guard = lock_engine(engine);
            guard.staged_assets(&book_uid)
        };
        if assets.is_empty() {
            continue;
        }
        let mut landed: Vec<(AssetKind, String)> = Vec::new();
        for asset in &assets {
            match asset.kind {
                AssetKind::Cover => {
                    // 封面就是元信息里的一段 data URL：原文优先（字节拼回来的只要差一个
                    // 字符就会被当成「又变了一次」而反复写盘）
                    let value = asset
                        .data_url
                        .clone()
                        .unwrap_or_else(|| crate::book_images::image_data_url(&asset.mime, &asset.bytes));
                    match book_store::set_cover_at(app, root.as_deref(), &local_id, Some(&value)) {
                        Ok(true) => {
                            changes.books = true;
                            log::debug!("同步封面已落地 book={local_id}");
                        }
                        Ok(false) => {}
                        Err(error) => {
                            return Err(SyncError::Io(error));
                        }
                    }
                }
                AssetKind::Illustration => {
                    // 插图落到图片目录，文件名用**设备无关的归一名**（对端正文块里引用的
                    // 就是这个名字）：两台设备因此对同一段正文算出同一个指纹
                    if !crate::book_images::valid_asset_name(&asset.name) {
                        log::warn!("对端推来的插图名字不合法，已跳过 name={}", asset.name);
                        continue;
                    }
                    let result = crate::book_images::images_root_at(app, root.as_deref())
                        .and_then(|root| crate::book_images::store_asset(&root, &asset.name, &asset.bytes));
                    match result {
                        Ok(_) => {
                            changes.books = true;
                            if !changes.chapters.contains(&local_id) {
                                // 正文块里的引用可能还是旧名字（带本机书 id 前缀），
                                // 前端要重载这本书的正文才能看到新引用
                                changes.chapters.push(local_id.clone());
                            }
                        }
                        Err(error) => {
                            return Err(SyncError::Io(error));
                        }
                    }
                }
            }
            landed.push((asset.kind, asset.name.clone()));
        }
        // 正文块里的旧引用（带本机书 id 前缀）就地归一：不这么做，本机发出去的正文
        // 与对端的对不上，正文通道会一直认为「两边不一样」而反复重传
        if landed.iter().any(|(kind, _)| *kind == AssetKind::Illustration) {
            normalize_book_images(app, root.as_deref(), &local_id, changes)?;
        }
        if !landed.is_empty() {
            let cleared = {
                let mut guard = lock_engine(engine);
                guard.clear_staged_assets(&book_uid, &landed)
            };
            cleared.map_err(|error| SyncError::Io(error.to_string()))?;
        }
    }
    Ok(())
}

/// 见 [`book_store::normalize_book_images`]：把正文块里的旧引用归一，有改动才算落地。
fn normalize_book_images<R: tauri::Runtime>(
    app: &AppHandle<R>,
    root: Option<&std::path::Path>,
    local_id: &str,
    changes: &mut AppliedChanges,
) -> Result<(), SyncError> {
    match book_store::normalize_book_images(app, root, local_id) {
        Ok(true) => {
            if !changes.chapters.contains(&local_id.to_string()) {
                changes.chapters.push(local_id.to_string());
            }
            log::info!("同步插图引用已归一 book={local_id}");
        }
        Ok(false) => {}
        Err(error) => log::warn!("插图引用归一失败（{local_id}）：{error}"),
    }
    Ok(())
}

/// 清掉刚刚落地的那些暂存章。
fn clear_staged(
    engine: &SharedEngine,
    book_uid: &str,
    bodies: &[readerx_sync::content::ChapterContent],
) -> Result<(), SyncError> {
    let cids: Vec<String> = bodies.iter().map(|body| body.cid.clone()).collect();
    lock_engine(engine).clear_staged(book_uid, &cids)
}

/// 按引擎里的元信息 + 目录 + 暂存正文新建本地书。
///
/// 返回新建的本机书 id；在线书只需元信息与匹配书源，导入书还需要章节。
/// 条件不满足时返回 `None`，等待下一次落地重试。
fn create_local_book_from_sync<R: tauri::Runtime>(
    app: &AppHandle<R>,
    engine: &SharedEngine,
    index: &mut BookIndex,
    book_uid: &str,
    sources: &mut Option<Vec<BookSource>>,
) -> Result<Option<String>, SyncError> {
    let (fields, structure) = {
        let guard = lock_engine(engine);
        let Some(entity) = guard.entity(book_uid) else {
            return Ok(None);
        };
        if guard.is_effectively_deleted(entity) {
            return Ok(None);
        }
        let fields = book_snapshot_fields(entity);
        let structure = guard
            .entity(&identity::book_structure_uid(book_uid))
            .filter(|entity| !guard.is_effectively_deleted(entity))
            .and_then(|entity| entity.field("chapters"))
            .and_then(|value| serde_json::from_value::<Vec<ChapterRef>>(value).ok())
            .unwrap_or_default();
        (fields, structure)
    };

    // 在线书：书身份含书源地址，本机没有对应书源时建出来的书与引擎对不上
    let book_source_id = if fields.book_url.is_some() {
        // 一次落地只读一遍书源；读取错误必须返回，不能伪装成书源缺失。
        if sources.is_none() {
            *sources = Some(readerx_source::store::list_sources().map_err(SyncError::Io)?);
        }
        match matching_source(sources.as_deref().unwrap_or_default(), &fields, book_uid) {
            Some(source) => Some(source.id.clone()),
            None => {
                log::debug!("在线书暂不能建书：书源缺失或身份不匹配 uid={book_uid} 载荷含书源地址={}", fields.source_url.is_some());
                return Ok(None);
            }
        }
    } else {
        None
    };

    let bodies = lock_engine(engine).staged_bodies(book_uid);
    let chapters = merge_structure_with_bodies(&structure, &bodies);
    if chapters.is_empty() && book_source_id.is_none() {
        return Ok(None);
    }
    let group_id = local_group_id(app, fields.group.as_deref()).map_err(SyncError::Io)?;
    if !super::book_ids::canonical_id(book_uid) {
        return Err(SyncError::Io("同步书籍 ID 格式无效".into()));
    }
    let local_id = book_uid.to_string();
    let online = book_source_id.is_some();
    let book = crate::models::LocalBook {
        id: local_id.clone(),
        title: fields.title.clone(),
        author: fields.author.clone(),
        intro: fields.intro.clone(),
        format: fields.format.clone(),
        file_name: fields.file_name.clone(),
        size: fields.size,
        imported_at: now_ms(),
        hue: hue_from_uid(book_uid),
        split_desc: fields.split_desc.clone(),
        // 封面不在同步范围（data URL 会把操作日志撑爆）：新书先没有封面
        cover: None,
        chapters,
        group_id,
        source: fields.source.clone(),
        book_source_id,
        book_url: fields.book_url.clone(),
        tags: (!fields.tags.is_empty()).then(|| fields.tags.clone()),
        source_tags: (!fields.source_tags.is_empty()).then(|| fields.source_tags.clone()),
    };
    book_store::put_book(app, book).map_err(SyncError::Io)?;
    index.insert(&local_id, book_uid);
    log::info!("同步新建本地书 id={local_id} 在线书={}", online);
    Ok(Some(local_id))
}

/// 按目录排出章节顺序，并把暂存正文填进对应章节。
fn merge_structure_with_bodies(
    structure: &[ChapterRef],
    bodies: &[readerx_sync::content::ChapterContent],
) -> Vec<crate::models::LocalBookChapter> {
    let mut chapters: Vec<crate::models::LocalBookChapter> = structure
        .iter()
        .map(|entry| crate::models::LocalBookChapter {
            cid: entry.cid.clone(),
            title: entry.title.clone(),
            paragraphs: Vec::new(),
            blocks: None,
            url: entry.url.clone(),
        })
        .collect();
    for body in bodies {
        let blocks = body
            .blocks
            .as_ref()
            .and_then(|value| serde_json::from_value(value.clone()).ok());
        match chapters.iter_mut().find(|chapter| chapter.cid == body.cid) {
            Some(chapter) => {
                chapter.paragraphs = body.paragraphs.clone();
                chapter.blocks = blocks;
                if chapter.title.is_empty() {
                    chapter.title = body.title.clone();
                }
                if chapter.url.is_none() {
                    chapter.url = body.url.clone();
                }
            }
            None => chapters.push(crate::models::LocalBookChapter {
                cid: body.cid.clone(),
                title: body.title.clone(),
                paragraphs: body.paragraphs.clone(),
                blocks,
                url: body.url.clone(),
            }),
        }
    }
    chapters
}

/// 优先按统一书源 ID 关联；旧载荷按地址与书籍身份匹配。
fn matching_source<'a>(
    sources: &'a [BookSource],
    fields: &BookEntityFields,
    uid: &str,
) -> Option<&'a BookSource> {
    if let Some(id) = fields.book_source_id.as_deref() {
        if let Some(source) = sources.iter().find(|source| source.id == id) {
            return Some(source);
        }
    }
    let matches_identity = |source: &&BookSource| {
        identity::book_uid(&BookKey {
            source_url: Some(&source.book_source_url),
            book_url: fields.book_url.as_deref(),
            file_name: &fields.file_name,
            size: fields.size,
        }) == uid
    };
    if let Some(url) = fields.source_url.as_deref() {
        let wanted = identity::source_uid(url);
        if let Some(source) = sources.iter()
            .filter(|source| identity::source_uid(&source.book_source_url) == wanted)
            .find(matches_identity) {
            return Some(source);
        }
    }
    sources.iter().find(matches_identity)
}

/// 由书实体 id 派生一个稳定的色相（0–359）：封面不同步，新书也要有个可辨的底色。
fn hue_from_uid(uid: &str) -> u32 {
    let hex: String = uid.chars().filter(|c| c.is_ascii_hexdigit()).take(4).collect();
    u32::from_str_radix(&hex, 16).unwrap_or(0) % 360
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

    // 分组排在最前：书要按本机分组 id 落归属，书源也一样（按本机书源分组 id）
    if apply_groups(app, &snapshots).map_err(SyncError::Io)? {
        changes.groups = true;
    }
    if apply_source_groups(app, &snapshots).map_err(SyncError::Io)? {
        changes.source_groups = true;
    }
    for snapshot in &snapshots {
        if let Snapshot::Book { uid, deleted, fields } = snapshot {
            match apply_book(app, index, uid, *deleted, fields.as_deref()) {
                Ok(Some(local_id)) => {
                    changes.books = true;
                    if *deleted {
                        changes.deleted_books.push(local_id);
                        // 对端删了这本书：它还没落地的正文也没意义了
                        if let Err(error) = lock_engine(engine).drop_staged(uid) {
                            log::warn!("清理已删书籍的暂存正文失败（{uid}）：{error}");
                        }
                    }
                }
                Ok(None) => {}
                Err(error) => return Err(SyncError::Io(error)),
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
    // 目录排在书之后：书被删掉时目录的落地会自然跳过（本机已经没有这本书了）。
    // 本机没有这本书时也跳过 —— 目录本身不带正文，光有目录的书打开是空白；
    // 等正文（内容通道）到了再连目录一起建书。
    for snapshot in &snapshots {
        if let Snapshot::Structure { book_uid, deleted: false, chapters: Some(chapters) } = snapshot {
            let Some(local_id) = index.resolve(app, book_uid).map_err(SyncError::Io)? else {
                continue;
            };
            match book_store::apply_sync_structure(app, &local_id, chapters) {
                Ok(true) => {
                    changes.books = true;
                    if !changes.chapters.contains(&local_id) {
                        changes.chapters.push(local_id);
                    }
                }
                Ok(false) => {}
                Err(error) => return Err(SyncError::Io(error)),
            }
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
    let mut annotation_books = Vec::new();
    for snapshot in &snapshots {
        if let Snapshot::Annotation { book_uid } = snapshot {
            if let Some(local_id) = index.resolve(app, book_uid).map_err(SyncError::Io)? {
                if !annotation_books.contains(&local_id) { annotation_books.push(local_id); }
            }
        }
    }
    for local_id in annotation_books {
        let uid = index.uid_for(app, &local_id);
        if apply_annotations(app, engine, &local_id, &uid).map_err(SyncError::Io)? {
            changes.annotations.push(local_id);
        }
    }
    let sources = if snapshots.iter().any(|s| matches!(s, Snapshot::Source { .. })) {
        readerx_source::store::list_sources().unwrap_or_default()
    } else {
        Vec::new()
    };
    for snapshot in &snapshots {
        if let Snapshot::Source { uid, deleted, payload, group } = snapshot {
            if apply_source(app, &sources, uid, *deleted, payload.as_ref(), group.as_deref())
                .map_err(SyncError::Io)?
            {
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
        book_source_id: fields
            .book_source_id
            .clone()
            .filter(|id| identity::stable_id(id, "s-"))
            .or(book_store::get_sync_meta(app, local_id)?.and_then(|m| m.book_source_id)),
        // source_url 只是同步载荷（对端建书时用它找回自己的书源），不落进本机元信息
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
            "annotation" => snapshots.push(Snapshot::Annotation { book_uid: book_ref_of(entity) }),
            "group" => snapshots.push(Snapshot::Group {
                uid: id,
                deleted,
                name: entity
                    .field("name")
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default(),
            }),
            "source_group" => snapshots.push(Snapshot::SourceGroup {
                uid: id,
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
                // 分组归属（书源分组实体 id）；对端把书源移出分组时是 null
                group: entity.field("group").and_then(|v| v.as_str().map(str::to_string)),
            }),
            // 规则类数据：一条规则变没变不改变落地动作 —— 每次都由引擎实体**整表重写**
            // 本地清单（规则条数少，重建比逐条对账更好推理，也不会漏掉删除）
            "text_replace" => snapshots.push(Snapshot::TextReplace),
            "chapter_rule" => snapshots.push(Snapshot::ChapterRule),
            // 目录：整份落到本地数据库（按 cid 复用原有正文）
            "book_structure" => snapshots.push(Snapshot::Structure {
                book_uid: book_ref_of(entity),
                deleted,
                chapters: (!deleted)
                    .then(|| entity.field("chapters"))
                    .flatten()
                    .and_then(|value| serde_json::from_value::<Vec<ChapterRef>>(value).ok()),
            }),
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
    Annotation { book_uid: String },
    Group {
        uid: String,
        deleted: bool,
        name: String,
    },
    SourceGroup {
        uid: String,
        deleted: bool,
        name: String,
    },
    Source {
        uid: String,
        deleted: bool,
        payload: Option<Value>,
        /// 书源分组实体 id（uid）：落地时按名字翻回本机分组 id
        group: Option<String>,
    },
    /// 文本替换规则有变化（落地时整表重写本地清单）
    TextReplace,
    /// 分章规则有变化（同上）
    ChapterRule,
    /// 书籍目录（结构）快照
    Structure {
        /// 书实体 id（uid）
        book_uid: String,
        deleted: bool,
        chapters: Option<Vec<ChapterRef>>,
    },
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
    /// 书源地址（在线书建书时要用它找回本机的书源；导入书为空）
    source_url: Option<String>,
    book_source_id: Option<String>,
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
        source_url: text("source_url"),
        book_source_id: text("book_source_id"),
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
    storage::update_state(app, SHELF_KEY, |state| {
        let shelf = state.get_or_insert_with(|| json!({}));
        let Some(map) = shelf.as_object_mut() else {
            return Ok(());
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
            return Ok(());
        }
        merged.insert("bookId".to_string(), json!(local_id));
        map.insert(local_id, Value::Object(merged));
        Ok(())
    })
}

/// 按引擎里的书签实体重写某本书的数据库书签。
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

/// 将每条实体按锚点聚合，同段两台设备首次新增时即使段落 id 不同也只有一条记录。
pub(crate) fn apply_annotations<R: tauri::Runtime>(
    app: &AppHandle<R>, engine: &SharedEngine, local_id: &str, book_uid: &str,
) -> Result<bool, String> {
    let entities: Vec<Entity> = lock_engine(engine).entities_of_kind("annotation", true)
        .into_iter().filter(|entity| book_ref_of(entity) == book_uid).cloned().collect();
    let current = book_store::get_annotations(app, local_id)?;
    let existing = crate::annotations::flatten(&current)?;
    let mut values = current.clone();
    for entity in entities {
        let Some(note_id) = entity.field("note_id").and_then(|v| v.as_str().map(str::to_owned)) else {
            return Err("同步注释身份无效".into());
        };
        if entity.is_deleted() {
            for record in &mut values {
                record["notes"].as_array_mut().unwrap().retain(|note| note["id"].as_str() != Some(&note_id));
            }
            continue;
        }
        let anchor = entity.field("anchor").ok_or("同步注释锚点缺失")?;
        if !anchor.is_object() { return Err("同步注释锚点无效".into()); }
        let mut value = existing.get(&note_id).map(|note| note.value.clone()).unwrap_or_else(|| json!({}));
        value.as_object_mut().ok_or("本机注释内容无效")?.extend(json!({"id": note_id, "text": entity.field("note"), "createdAt": entity.field("created_at"), "updatedAt": entity.field("updated_at")}).as_object().unwrap().clone());
        let note = crate::annotations::Note {
            paragraph_id: format!("paragraph:{}:{}:{}", anchor["chapterCid"].as_str().unwrap_or_default(), anchor["unitIndex"], anchor["fingerprint"].as_str().unwrap_or_default()),
            anchor,
            value,
        };
        // 先校验远端完整记录；无效数据不得写入后让前端整本读失败。
        let mut record = note.anchor.clone();
        record["id"] = json!(note.paragraph_id);
        record["notes"] = json!([note.value]);
        crate::annotations::flatten(&[record])?;
        crate::annotations::upsert(&mut values, &note);
    }
    values.retain(|record| !record["notes"].as_array().unwrap().is_empty());
    // notes 按创建时间与 id 排序，重复落库必须幂等，不随引擎遍历顺序来回变。
    for record in &mut values {
        record["notes"].as_array_mut().unwrap().sort_by(|a,b| {
            a["createdAt"].as_u64().cmp(&b["createdAt"].as_u64()).then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
        });
    }
    if current == values { return Ok(false); }
    book_store::put_annotations(app, local_id, &values)?;
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
    storage::update_state(app, key, |state| {
        *state = Some(next.clone());
        Ok(())
    })
}

/// 实体上的字符串字段（缺省空串）。
fn text_field(entity: &Entity, field: &str) -> String {
    entity
        .field(field)
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// 落地分组：清单直接使用同步实体 ID，缺的补上，删掉的移除。
fn apply_groups<R: tauri::Runtime>(
    app: &AppHandle<R>, snapshots: &[Snapshot],
) -> Result<bool, String> {
    apply_group_list(app, GROUPS_KEY, snapshots, |snapshot| match snapshot {
        Snapshot::Group { uid, deleted, name } if !name.is_empty() => {
            Some((*deleted, uid.as_str(), name.as_str()))
        }
        _ => None,
    })
}

/// 落地书源分组：与书架分组同一套口径（按名字对应，缺的补、删的删）。
///
/// 必须在书源之前落地：书源的归属要按「本机分组 id」写进源文件。
fn apply_source_groups<R: tauri::Runtime>(
    app: &AppHandle<R>, snapshots: &[Snapshot],
) -> Result<bool, String> {
    apply_group_list(app, SOURCE_GROUPS_KEY, snapshots, |snapshot| match snapshot {
        Snapshot::SourceGroup { uid, deleted, name } if !name.is_empty() => {
            Some((*deleted, uid.as_str(), name.as_str()))
        }
        _ => None,
    })
}

/// 落地一份分组清单（书架 / 书源分组共用）：同步来的分组按名字对应，缺的补上，删掉的移除。
fn apply_group_list<R: tauri::Runtime>(
    app: &AppHandle<R>,
    key: &str,
    snapshots: &[Snapshot],
    pick: impl Fn(&Snapshot) -> Option<(bool, &str, &str)>,
) -> Result<bool, String> {
    let names: Vec<(bool, &str, &str)> = snapshots.iter().filter_map(pick).collect();
    if names.is_empty() {
        return Ok(false);
    }
    storage::update_state(app, key, |state| {
        let mut groups = state
            .clone()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default();
        let mut changed = false;
        for (deleted, uid, name) in names {
            let existing = groups.iter().position(|group| {
                let id = group.get("id").and_then(Value::as_str).unwrap_or_default();
                let prefix = if key == SOURCE_GROUPS_KEY {
                    "sg-"
                } else {
                    "g-"
                };
                id == uid || (!identity::stable_id(id, prefix) && group_name(group) == Some(name))
            });
            match (deleted, existing) {
                (true, Some(index)) => {
                    groups.remove(index);
                    changed = true;
                }
                (false, None) => {
                    groups.push(json!({
                        "id": uid,
                        "name": name,
                        "createdAt": now_ms(),
                    }));
                    changed = true;
                }
                (false, Some(index)) => {
                    if groups[index]["name"] != name {
                        groups[index]["name"] = json!(name);
                        changed = true;
                    }
                }
                _ => {}
            }
        }
        if changed {
            *state = Some(Value::Array(groups));
        }
        Ok(())
    })
}

fn group_name(group: &Value) -> Option<&str> {
    group.get("name").and_then(Value::as_str).map(str::trim)
}

/// 落地书源：按地址对应本机书源，缺的建、删的删。
fn apply_source<R: tauri::Runtime>(
    app: &AppHandle<R>,
    existing: &[BookSource],
    uid: &str,
    deleted: bool,
    payload: Option<&Value>,
    group: Option<&str>,
) -> Result<bool, String> {
    let found = existing.iter().find(|source| {
        identity::entity_id(&source.id, "s-", identity::source_uid(&source.book_source_url)) == uid
    });
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
    object.insert("id".to_string(), json!(uid));
    // 分组归属以同步结果为准（组名 → 本机分组 id）：对端把书源移出分组、
    // 或那个分组已被删掉时，源文件里的 groupId 一并清掉，不留悬空引用
    match local_source_group_id(app, group)? {
        Some(local) => {
            object.insert("groupId".to_string(), json!(local));
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
    super::data_ids::save_source(&storage::data_root(app)?, &source, found.map(|old| old.id.as_str()).unwrap_or(uid))?;
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
    if sync_group == Some(HIDDEN_GROUP_ID) {
        return Ok(Some(HIDDEN_GROUP_ID.to_string()));
    }
    local_group_id_in(app, GROUPS_KEY, identity::group_uid, sync_group)
}

/// 同步书源分组 id → 本机书源分组 id（同步来的书源要落进本机已有的同名分组）。
fn local_source_group_id<R: tauri::Runtime>(
    app: &AppHandle<R>, sync_group: Option<&str>,
) -> Result<Option<String>, String> {
    local_group_id_in(app, SOURCE_GROUPS_KEY, identity::source_group_uid, sync_group)
}

/// 按「同步分组 id = 分组名派生值」在本地清单里找回本机分组 id。
///
/// 找不到（分组已被删 / 对端改名后留下的旧 id）时返回 `None`：调用方按「未分组」落地，
/// 不留悬空引用。同步分组 id 与本地 id 的计算方式不同，因此要传身份派生函数。
fn local_group_id_in<R: tauri::Runtime>(
    app: &AppHandle<R>,
    key: &str,
    uid_of: fn(&str) -> String,
    sync_group: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(sync_group) = sync_group else {
        return Ok(None);
    };
    let groups = storage::read_state(app, key)?
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    Ok(groups
        .iter()
        .find(|group| {
            group_name(group)
                .map(|name| {
                    identity::entity_id(
                        group.get("id").and_then(Value::as_str).unwrap_or_default(),
                        if key == SOURCE_GROUPS_KEY {
                            "sg-"
                        } else {
                            "g-"
                        },
                        uid_of(name),
                    ) == sync_group
                })
                .unwrap_or(false)
        })
        .and_then(|group| group.get("id").and_then(Value::as_str).map(str::to_string)))
}

// ---------------------------------------------------------------------------
// 字段级发布
// ---------------------------------------------------------------------------

/// 本机书籍元信息 → 引擎字段。
fn book_values(facts: &mut LocalFacts, meta: &BookSyncMeta) -> BTreeMap<String, Value> {
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
    let source_id = meta.book_source_id.as_deref().and_then(|id| {
        if identity::stable_id(id, "s-") { Some(id.to_string()) }
        else { facts.source_url(Some(id)).map(|url| identity::source_uid(&url)) }
    });
    fields.insert("book_source_id".to_string(), option_json(source_id.as_deref()));
    // 书源地址：对端建这本书时要靠它找回自己那边的书源（书身份含书源地址）
    fields.insert(
        "source_url".to_string(),
        option_json(facts.source_url(meta.book_source_id.as_deref()).as_deref()),
    );
    fields.insert("source_tags".to_string(), json!(meta.source_tags));
    fields.insert("split_desc".to_string(), json!(meta.split_desc));
    fields
}

/// 算 uid 时的 `LocalFacts` 版本（要先把本机书源 id 翻译成地址）。
fn book_uid_of_parts(facts: &mut LocalFacts, meta: &BookSyncMeta) -> String {
    if super::book_ids::canonical_id(&meta.id) { return meta.id.clone(); }
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
        // 展示样式（线条 / 颜色）：旧记录没有这两个字段，缺省按默认样式渲染
        ("style", "style"),
        ("color", "color"),
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
    let mut value = json!({
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
        "style": text("style"),
        "color": text("color"),
        "createdAt": text("created_at"),
    });
    // 旧记录没有样式字段：缺省（null）不落盘，保持书签记录原有字段形状
    if let Some(object) = value.as_object_mut() {
        for field in ["style", "color"] {
            if object.get(field).map(Value::is_null).unwrap_or(false) {
                object.remove(field);
            }
        }
    }
    value
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
        object.insert("id".into(),
            json!(identity::entity_id(
                &source.id,
                "s-",
                identity::source_uid(&source.book_source_url)
            )),
        );
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
    fn online_directory_without_bodies_preserves_fetch_urls() {
        let structure = vec![
            ChapterRef { cid: "c1".into(), title: "第一章".into(), url: Some("https://example.com/1".into()) },
            ChapterRef { cid: "c2".into(), title: "第二章".into(), url: Some("https://example.com/2".into()) },
        ];
        let chapters = merge_structure_with_bodies(&structure, &[]);
        assert_eq!(chapters.len(), 2);
        for (chapter, entry) in chapters.iter().zip(&structure) {
            assert_eq!(chapter.cid, entry.cid);
            assert_eq!(chapter.title, entry.title);
            assert_eq!(chapter.url, entry.url);
            assert!(chapter.paragraphs.is_empty());
            assert!(chapter.blocks.is_none());
        }
    }

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
            "style": "wavy",
            "color": "red",
            "createdAt": 99,
        });
        let values = bookmark_values(&mark, "b-abc");
        assert_eq!(values["book_id"], json!("b-abc"));
        assert_eq!(values["chapter_cid"], json!("c0002"));
        assert_eq!(values["char_start"], json!(10));
        assert_eq!(values["char_end"], json!(20));
        assert_eq!(values["style"], json!("wavy"));
        assert_eq!(values["color"], json!("red"));
        assert_eq!(values["created_at"], json!(99));
        assert!(!values.contains_key("id"), "实体 id 就是书签 id，不进字段");

        // 旧记录没有样式字段：不写空值，引擎里也不该出现这两个键
        let legacy = json!({ "id": "bm-2", "bookId": "b1", "charStart": 1, "charEnd": 2 });
        let legacy_values = bookmark_values(&legacy, "b-abc");
        assert!(!legacy_values.contains_key("style"));
        assert!(!legacy_values.contains_key("color"));
    }

    #[test]
    fn bookmark_value_round_trips_back_to_frontend_shape() {
        let mut fields = BTreeMap::new();
        fields.insert("book_id".to_string(), json!("b-abc"));
        fields.insert("chapter_cid".to_string(), json!("c0002"));
        fields.insert("char_start".to_string(), json!(10));
        fields.insert("char_end".to_string(), json!(20));
        fields.insert("text".to_string(), json!("选中"));
        fields.insert("style".to_string(), json!("marker"));
        fields.insert("color".to_string(), json!("blue"));
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
        assert_eq!(value["style"], json!("marker"));
        assert_eq!(value["color"], json!("blue"));
        assert_eq!(value["chapterIndex"], Value::Null);
    }

    #[test]
    fn bookmark_value_omits_missing_appearance_fields() {
        // 旧书签（引擎里没有 style/color）落地成前端记录时不写 null，保持字段形状
        let mut entity = Entity::new("bm-1", "bookmark", readerx_sync::Hlc::default(), 1);
        entity.fields.insert(
            "char_start".to_string(),
            readerx_sync::FieldState::Value {
                value: json!(10),
                hlc: readerx_sync::Hlc::default(),
                origin: readerx_sync::model::Stamp::new("A", 1),
            },
        );
        let value = bookmark_value("bm-1", "local-1", &entity);
        assert!(!value.as_object().unwrap().contains_key("style"));
        assert!(!value.as_object().unwrap().contains_key("color"));
    }

    #[test]
    fn source_matching_recovers_missing_address_without_guessing_by_host() {
        let source: BookSource = serde_json::from_value(json!({
            "id": "src-test", "name": "测试", "bookSourceUrl": "https://example.com",
            "js": ""
        })).unwrap();
        let mut entity = Entity::new("book", "book", readerx_sync::Hlc::default(), 1);
        entity.fields.insert("book_url".into(), readerx_sync::FieldState::Value {
            value: json!("https://example.com/book/1"), hlc: readerx_sync::Hlc::default(),
            origin: readerx_sync::model::Stamp::new("A", 1),
        });
        let mut fields = book_snapshot_fields(&entity);
        let uid = identity::book_uid(&BookKey {
            source_url: Some(&source.book_source_url), book_url: fields.book_url.as_deref(),
            ..BookKey::default()
        });
        let sources = vec![source];
        assert_eq!(matching_source(&sources, &fields, &uid).unwrap().id, "src-test");
        fields.source_url = Some("https://obsolete.example.com".into());
        assert!(matching_source(&sources, &fields, &uid).is_some());
        assert!(matching_source(&sources, &fields, "b-other").is_none());
        assert!(matching_source(&[], &fields, &uid).is_none());
        fields.source_url = Some(" HTTPS://EXAMPLE.COM/ ".into());
        assert!(matching_source(&sources, &fields, &uid).is_some());
        let mut wrong = sources[0].clone();
        wrong.book_source_url = "https://example.com/other-source".into();
        assert!(matching_source(&[wrong.clone()], &fields, &uid).is_none());
        let id = identity::source_uid("https://example.com");
        wrong.id = id.clone();
        fields.book_source_id = Some(id.clone());
        assert_eq!(matching_source(&[wrong], &fields, &uid).unwrap().id, id,
            "书源地址更新后，统一 ID 仍能恢复原书关联");
    }

    /// 载荷保留统一 `id`；`groupId` 单独同步，
    /// 归属走实体的 `group` 字段（存书源分组实体 id），因此并发改分组与改 JS 不会互相盖掉。
    #[test]
    fn source_payload_keeps_shared_id_and_separates_group() {
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
        assert_eq!(payload["id"], identity::source_uid(&source.book_source_url));
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

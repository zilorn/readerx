//! 导入：读归档 → 合并 / 覆盖写回本地。
//!
//! 两种语义（[`ImportMode`]）共用同一套「先写后删」的顺序：
//!
//! 1. 写完归档里的数据（书籍 / 插图 / 书源 / 登录态 / 状态文件）；
//! 2. 覆盖模式下再把归档里没有的本地书与书源删掉。
//!
//! 顺序不能反：中途失败 / 断电时，最坏结果是「本机多出几本已有的书」，
//! 而不会出现「书删了一半、备份还没写进去」。
//!
//! 「这是哪本书 / 哪个分组、落到哪里」的规划在 `plan.rs`；这里只管写盘。

use super::archive::{self, ArchiveScan};
use super::merge::{self, Remap};
use super::plan::{self, ArchiveSource, BookAction, BookPlan, LocalBook};
use super::{ImportMode, ImportSummary};
use super::{BOOKS_DIR, IMAGES_DIR, SESSIONS_DIR, STATE_DIR};
use crate::book_store;
use crate::models::BookSource;
use crate::storage;
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, File};
use std::path::Path;
use tauri::AppHandle;
use zip::ZipArchive;

/// 导入全过程（顺序见文件头注释）
pub(super) fn apply<R: tauri::Runtime>(
    app: &AppHandle<R>,
    path: &str,
    mode: ImportMode,
    report: &mut dyn FnMut(&str, u64, u64),
) -> Result<ImportSummary, String> {
    let file = archive::open_source(app, path)?;
    let bytes = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let mut zip = archive::open_zip_from(file)?;
    let manifest = archive::read_manifest(&mut zip)?;
    let scan = archive::classify(&mut zip, manifest, bytes);
    log::info!(
        "开始导入备份 方式={} 书籍={} 插图={} 书源={} 状态={} 登录信息={}",
        mode.as_str(),
        scan.books.len(),
        scan.images.len(),
        scan.sources.len(),
        scan.state_keys.len(),
        scan.manifest.credentials
    );

    let mut summary = ImportSummary {
        mode: mode.as_str().to_string(),
        ..Default::default()
    };
    let local_books = plan::local_books(app)?;
    let local_sources = readerx_source::store::list_sources().unwrap_or_default();
    let archive_sources = plan::read_archive_sources(&mut zip, &scan)?;
    let archive_books = plan::read_archive_books(&mut zip, &scan, &archive_sources, mode)?;

    // 分组换算表：书与书源的 groupId 都要跟着走
    let remap = plan::plan_remap(app, mode, &local_books, &archive_books, &mut zip, &scan)?;
    let plan: Vec<BookPlan> = archive_books
        .iter()
        .map(|book| plan::plan_book(book, &local_books, mode))
        .collect();

    write_books(app, &mut zip, &plan, &remap, mode, &mut summary, report)?;
    write_images(app, &mut zip, &scan, &plan, mode, &mut summary, report)?;
    write_sources(&local_sources, &archive_sources, &remap, mode, &mut summary)?;
    write_sessions(app, &mut zip, &scan, report)?;
    write_state(app, &mut zip, &scan, &remap, mode, &mut summary)?;

    if mode == ImportMode::Replace {
        remove_extras(
            app,
            &plan,
            &archive_sources,
            &local_books,
            &local_sources,
            &mut summary,
        )?;
    }

    let aliases = archive_sources.iter().map(|source| {
        let local = if mode == ImportMode::Merge {
            local_sources.iter().find(|local| same_source(&local.book_source_url, &source.url))
        } else { None };
        let target = local.map(|local| crate::sync::identity::entity_id(&local.id, "s-", crate::sync::identity::source_uid(&local.book_source_url)))
            .unwrap_or_else(|| crate::sync::identity::entity_id(&source.id, "s-", crate::sync::identity::source_uid(&source.url)));
        (source.id.clone(), target)
    }).collect();
    readerx_source::id_migration::migrate(&storage::data_root(app)?, &aliases)?;
    crate::sync::book_ids::migrate(app)?;
    crate::sync::data_ids::migrate(&storage::data_root(app)?)?;

    // 同步已启用时做一次全量对账，让导入的书 / 书源进入同步引擎（没启用是空操作）
    crate::sync::service_hook(app).on_data_imported();

    log::info!(
        "数据导入完成 方式={} 新增书籍={} 覆盖={} 已有={} 删除={} 插图={} 书源+{} ~{} ={} 删除={} 状态={}",
        mode.as_str(),
        summary.books_added,
        summary.books_updated,
        summary.books_skipped,
        summary.books_removed,
        summary.images_added,
        summary.sources_added,
        summary.sources_updated,
        summary.sources_skipped,
        summary.sources_removed,
        summary.state_keys.len()
    );
    Ok(summary)
}

#[allow(clippy::too_many_arguments)]
fn write_books<R: tauri::Runtime>(
    app: &AppHandle<R>,
    zip: &mut ZipArchive<File>,
    plan: &[BookPlan],
    remap: &Remap,
    mode: ImportMode,
    summary: &mut ImportSummary,
    report: &mut dyn FnMut(&str, u64, u64),
) -> Result<(), String> {
    let root = storage::data_root(app)?.join(BOOKS_DIR);
    report("books", 0, plan.len() as u64);
    for (index, item) in plan.iter().enumerate() {
        match item.action {
            BookAction::Add => summary.books_added += 1,
            BookAction::Update => summary.books_updated += 1,
            BookAction::Skip => summary.books_skipped += 1,
        }
        if item.action != BookAction::Skip {
            let dir = root.join(&item.local_id);
            fs::create_dir_all(&dir).map_err(|e| format!("创建书籍目录失败: {e}"))?;
            for name in &item.entries {
                let Some(file) = name.rsplit('/').next() else {
                    continue;
                };
                let Some(bytes) = archive::read_entry(zip, name)? else {
                    continue;
                };
                match file {
                    "bookdetail.json" => {
                        let value = remap_detail(&bytes, remap, mode)?;
                        write_bytes(&dir.join(file), &value)?;
                    }
                    "annotations.json" => {
                        merge_annotation_file(app, &item.local_id, &bytes, mode)?;
                    }
                    "bookmarks.json" => {
                        merge_bookmark_file(app, &item.local_id, &bytes, mode)?;
                    }
                    _ => write_bytes(&dir.join(file), &bytes)?,
                }
            }
        }
        // 本机已有同一本书（另一个 id）：归档里的书签仍要并进本机那本，不能丢
        if item.action == BookAction::Skip {
            let name = format!("{BOOKS_DIR}/{}/bookmarks.json", item.archive_id);
            if let Some(bytes) = archive::read_entry(zip, &name)? {
                merge_bookmark_file(app, &item.local_id, &bytes, mode)?;
            }
        }
        if item.action == BookAction::Skip {
            let name = format!("{BOOKS_DIR}/{}/annotations.json", item.archive_id);
            if let Some(bytes) = archive::read_entry(zip, &name)? {
                merge_annotation_file(app, &item.local_id, &bytes, mode)?;
            }
        } else if mode == ImportMode::Replace
            && !item
                .entries
                .iter()
                .any(|name| name.ends_with("/annotations.json"))
        {
            // 恢复旧备份：归档缺少注释时清空当前书的注释。
            book_store::put_annotations(app, &item.local_id, &[])?;
        }
        report("books", index as u64 + 1, plan.len() as u64);
    }
    Ok(())
}

/// `bookdetail.json` 里的分组归属翻成本机分组 id（其余字段原样保留）
fn remap_detail(bytes: &[u8], remap: &Remap, mode: ImportMode) -> Result<Vec<u8>, String> {
    if mode == ImportMode::Replace {
        return Ok(bytes.to_vec());
    }
    let mut value: Value =
        serde_json::from_slice(bytes).map_err(|e| format!("书籍元信息无法解析: {e}"))?;
    if let Some(group) = value.get("groupId").and_then(Value::as_str) {
        if let Some(local_id) = remap.groups.get(group) {
            if let Some(object) = value.as_object_mut() {
                object.insert("groupId".to_string(), Value::String(local_id.clone()));
            }
        }
    }
    serde_json::to_vec_pretty(&value).map_err(|e| format!("书籍元信息序列化失败: {e}"))
}

/// 同段记录合并其 notes，重复 note id 保留本机内容；覆盖恢复直接采用归档。
fn merge_annotation_file<R: tauri::Runtime>(
    app: &AppHandle<R>,
    local_id: &str,
    bytes: &[u8],
    mode: ImportMode,
) -> Result<(), String> {
    let incoming: Value =
        serde_json::from_slice(bytes).map_err(|e| format!("注释无法解析: {e}"))?;
    if incoming.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("注释格式版本不受支持".into());
    }
    let arriving = incoming
        .get("annotations")
        .and_then(Value::as_array)
        .ok_or("注释记录无效")?;
    let existing = book_store::get_annotations(app, local_id)?;
    let merged = merge_annotations(&existing, arriving, mode == ImportMode::Replace)?;
    book_store::put_annotations(app, local_id, &merged)
}
fn merge_annotations(
    local: &[Value],
    incoming: &[Value],
    replace: bool,
) -> Result<Vec<Value>, String> {
    let mut out = if replace { Vec::new() } else { local.to_vec() };
    for paragraph in incoming {
        let notes = paragraph
            .get("notes")
            .and_then(Value::as_array)
            .ok_or("注释列表无效")?;
        let Some(existing) = out.iter_mut().find(|item| {
            item["chapterCid"] == paragraph["chapterCid"]
                && item["unitIndex"] == paragraph["unitIndex"]
                && item["fingerprint"] == paragraph["fingerprint"]
        }) else {
            out.push(paragraph.clone());
            continue;
        };
        let target = existing
            .get_mut("notes")
            .and_then(Value::as_array_mut)
            .ok_or("本机注释列表无效")?;
        for note in notes {
            let id = note
                .get("id")
                .and_then(Value::as_str)
                .ok_or("注释身份无效")?;
            if !target
                .iter()
                .any(|item| item.get("id").and_then(Value::as_str) == Some(id))
            {
                target.push(note.clone());
            }
        }
    }
    Ok(out)
}

/// 书签取并集（按书签 id，与同步同一口径）；覆盖模式下归档那份直接取代本机那份。
fn merge_bookmark_file<R: tauri::Runtime>(
    app: &AppHandle<R>,
    local_id: &str,
    bytes: &[u8],
    mode: ImportMode,
) -> Result<(), String> {
    let incoming: Value =
        serde_json::from_slice(bytes).map_err(|e| format!("书签无法解析: {e}"))?;
    let arriving: Vec<Value> = incoming
        .get("bookmarks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // 读失败不能当成「这本书没有书签」：那样写回去就等于把本机书签删了
    let existing = match book_store::get_bookmarks(app, local_id) {
        Ok(list) => list,
        Err(error) => {
            log::warn!("本机书签读取失败，本次跳过这本书的书签：{error}");
            return Ok(());
        }
    };
    let merged = merge_bookmarks(&existing, &arriving, local_id, mode == ImportMode::Replace);
    book_store::put_bookmarks(app, local_id, &merged)?;
    Ok(())
}

fn merge_bookmarks(
    local: &[Value],
    incoming: &[Value],
    local_id: &str,
    replace: bool,
) -> Vec<Value> {
    let mut out: Vec<Value> = if replace { Vec::new() } else { local.to_vec() };
    let mut seen: HashSet<String> = out
        .iter()
        .filter_map(|bookmark| bookmark.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    for bookmark in incoming {
        let Some(id) = bookmark.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !seen.insert(id.to_string()) {
            continue;
        }
        let mut bookmark = bookmark.clone();
        if let Some(object) = bookmark.as_object_mut() {
            object.insert("bookId".to_string(), Value::String(local_id.to_string()));
        }
        out.push(bookmark);
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn write_images<R: tauri::Runtime>(
    app: &AppHandle<R>,
    zip: &mut ZipArchive<File>,
    scan: &ArchiveScan,
    plan: &[BookPlan],
    mode: ImportMode,
    summary: &mut ImportSummary,
    report: &mut dyn FnMut(&str, u64, u64),
) -> Result<(), String> {
    let root = crate::book_images::images_root(app)?;
    let wanted: HashSet<&str> = plan
        .iter()
        .filter(|item| item.action != BookAction::Skip)
        .map(|item| item.archive_id.as_str())
        .collect();
    report("images", 0, scan.images.len() as u64);
    for (index, name) in scan.images.iter().enumerate() {
        // 图片文件名是 `<书籍 id>_<sha1>.<ext>`：最后一段下划线就是归属分隔符
        if let Some((book_id, _)) = name.rsplit_once('_') {
            if !wanted.contains(book_id) {
                report("images", index as u64 + 1, scan.images.len() as u64);
                continue;
            }
        }
        let target = root.join(name);
        // 同名 = 同一张（名字里带着来源地址的哈希）：合并模式不重复写
        if !(mode == ImportMode::Merge && target.is_file()) {
            if let Some(bytes) = archive::read_entry(zip, &format!("{IMAGES_DIR}/{name}"))? {
                write_bytes(&target, &bytes)?;
                summary.images_added += 1;
            }
        }
        report("images", index as u64 + 1, scan.images.len() as u64);
    }
    Ok(())
}

fn write_sources(
    local: &[BookSource],
    archive: &[ArchiveSource],
    remap: &Remap,
    mode: ImportMode,
    summary: &mut ImportSummary,
) -> Result<(), String> {
    for item in archive {
        let by_id = local.iter().any(|source| source.id == item.id);
        let by_url = local
            .iter()
            .any(|source| same_source(&source.book_source_url, &item.url));
        let skip = mode == ImportMode::Merge && !by_id && by_url;
        if skip {
            summary.sources_skipped += 1;
            continue;
        }
        let mut source = item.source.clone();
        if mode == ImportMode::Merge {
            source.group_id = item.group_id.as_ref().map(|group| {
                remap
                    .source_groups
                    .get(group)
                    .cloned()
                    .unwrap_or_else(|| group.clone())
            });
        }
        // 书源文件与登录态由引擎 crate 负责格式与原子写，App 不另写一套
        readerx_source::store::put_source(&source)?;
        if by_id {
            summary.sources_updated += 1;
        } else {
            summary.sources_added += 1;
        }
    }
    Ok(())
}

/// 两条书源地址是不是同一个站点（与 `identity::source_uid` 同一套归一化）
fn same_source(left: &str, right: &str) -> bool {
    left.trim()
        .trim_end_matches('/')
        .eq_ignore_ascii_case(right.trim().trim_end_matches('/'))
}

/// 书源登录态：字节原样写回（格式由 readerx-source 定义，这里不解析，免得丢字段）。
/// 归档里没有这一节（导出时没勾选「包含登录信息」）就什么都不做。
fn write_sessions<R: tauri::Runtime>(
    app: &AppHandle<R>,
    zip: &mut ZipArchive<File>,
    scan: &ArchiveScan,
    report: &mut dyn FnMut(&str, u64, u64),
) -> Result<(), String> {
    if scan.sessions.is_empty() {
        return Ok(());
    }
    let root = storage::data_root(app)?.join(SESSIONS_DIR);
    report("sessions", 0, scan.sessions.len() as u64);
    for (index, id) in scan.sessions.iter().enumerate() {
        if let Some(bytes) = archive::read_entry(zip, &format!("{SESSIONS_DIR}/{id}.json"))? {
            write_bytes(&root.join(format!("{id}.json")), &bytes)?;
        }
        report("sessions", index as u64 + 1, scan.sessions.len() as u64);
    }
    // 只记数量：Cookie 内容永不进日志
    log::info!("已导入 {} 个书源登录态", scan.sessions.len());
    Ok(())
}

fn write_state<R: tauri::Runtime>(
    app: &AppHandle<R>,
    zip: &mut ZipArchive<File>,
    scan: &ArchiveScan,
    remap: &Remap,
    mode: ImportMode,
    summary: &mut ImportSummary,
) -> Result<(), String> {
    for key in &scan.state_keys {
        let Some(incoming) = archive::read_entry_json(zip, &format!("{STATE_DIR}/{key}.json"))?
        else {
            continue;
        };
        let changed = storage::update_state(app, key, |local| {
            let value = match mode {
                ImportMode::Merge => merge::merge_state(key, local.as_ref(), &incoming, remap),
                ImportMode::Replace => incoming,
            };
            // 只在真的变了时落盘与计数：合并模式下「本机本来就是这样」不该报成一次更新
            *local = Some(value);
            Ok(())
        })?;
        if changed {
            summary.state_keys.push(key.clone());
        }
    }
    // 覆盖恢复：归档里没有这些内容类状态 = 当时就是空的，本机那份不能留
    if mode == ImportMode::Replace {
        for key in merge::CONTENT_KEYS {
            if !scan.state_keys.iter().any(|item| item == key) {
                storage::remove_state(app, key)?;
            }
        }
    }
    Ok(())
}

/// 覆盖恢复：删掉归档里没有的本地书与书源（**写完之后**才删）
fn remove_extras<R: tauri::Runtime>(
    app: &AppHandle<R>,
    plan: &[BookPlan],
    archive_sources: &[ArchiveSource],
    local_books: &[LocalBook],
    local_sources: &[BookSource],
    summary: &mut ImportSummary,
) -> Result<(), String> {
    let keep_books: HashSet<&str> = plan.iter().map(|item| item.local_id.as_str()).collect();
    let hook = crate::sync::service_hook(app);
    for book in local_books {
        if keep_books.contains(book.id.as_str()) {
            continue;
        }
        // 同步删除要读 bookdetail.json 定位身份，必须在删文件之前
        hook.on_book_deleted(&book.id);
        book_store::delete_book(app, &book.id)?;
        summary.books_removed += 1;
    }
    let keep_sources: HashSet<&str> = archive_sources
        .iter()
        .map(|item| item.id.as_str())
        .collect();
    for source in local_sources {
        if keep_sources.contains(source.id.as_str()) {
            continue;
        }
        hook.on_source_deleted(source);
        storage::delete_book_source(app, &source.id)?;
        summary.sources_removed += 1;
    }
    Ok(())
}

/// 原子写：临时文件 + rename（与各存储模块同一口径，中途失败不留半个文件）
fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let Some(name) = path.file_name() else {
        return Err("非法的文件路径".to_string());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let temp = path.with_file_name(format!("{}.tmp", name.to_string_lossy()));
    let _temporary = crate::temporary_file::TemporaryFile(temp.clone());
    fs::write(&temp, bytes).map_err(|e| format!("写入文件失败: {e}"))?;
    fs::rename(&temp, path).map_err(|e| format!("写入文件失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn annotations_merge_notes_per_paragraph_and_replace() {
        let local = vec![
            serde_json::json!({"id":"local", "chapterCid":"c1", "unitIndex":2, "fingerprint":"same", "notes":[{"id":"n1","text":"local"}]}),
        ];
        let incoming = vec![
            serde_json::json!({"id":"incoming", "chapterCid":"c1", "unitIndex":2, "fingerprint":"same", "notes":[{"id":"n1","text":"remote"},{"id":"n2","text":"added"}]}),
        ];
        let merged = merge_annotations(&local, &incoming, false).unwrap();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["notes"].as_array().unwrap().len(), 2);
        assert_eq!(merged[0]["notes"][0]["text"], "local");
        assert_eq!(
            merge_annotations(&local, &incoming, true).unwrap(),
            incoming
        );
        assert!(merge_annotations(&local, &[serde_json::json!({"id":"bad"})], false).is_err());
    }

    #[test]
    fn bookmarks_merge_by_id_and_follow_the_local_book_id() {
        let local = vec![json!({ "id": "bm-1", "bookId": "local-1", "text": "甲" })];
        let incoming = vec![
            json!({ "id": "bm-1", "bookId": "local-9", "text": "甲（归档）" }),
            json!({ "id": "bm-2", "bookId": "local-9", "text": "乙" }),
        ];
        let merged = merge_bookmarks(&local, &incoming, "local-1", false);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0]["text"], "甲", "同 id 保留本机那条");
        assert_eq!(merged[1]["bookId"], "local-1");
    }

    #[test]
    fn bookmarks_replace_when_restoring() {
        let local = vec![json!({ "id": "bm-1", "bookId": "local-1" })];
        let incoming = vec![json!({ "id": "bm-2", "bookId": "local-9" })];
        let merged = merge_bookmarks(&local, &incoming, "local-1", true);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["id"], "bm-2");
    }

    #[test]
    fn detail_group_is_remapped_but_other_fields_are_kept() {
        let mut remap = Remap::default();
        remap
            .groups
            .insert("grp-a".to_string(), "grp-local".to_string());
        let bytes = serde_json::to_vec(&json!({
            "schemaVersion": 1, "id": "local-1", "title": "三体", "groupId": "grp-a"
        }))
        .unwrap();
        let out: Value =
            serde_json::from_slice(&remap_detail(&bytes, &remap, ImportMode::Merge).unwrap())
                .unwrap();
        assert_eq!(out["groupId"], "grp-local");
        assert_eq!(out["title"], "三体");
        assert_eq!(out["id"], "local-1");
    }

    #[test]
    fn detail_is_written_verbatim_when_restoring() {
        let bytes = r#"{"groupId":"grp-a","title":"三体"}"#.as_bytes();
        let out = remap_detail(bytes, &Remap::default(), ImportMode::Replace).unwrap();
        assert_eq!(out, bytes);
    }
}

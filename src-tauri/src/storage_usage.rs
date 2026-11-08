//! 应用数据占用与按书清理。
//!
//! 占用按数据根里的普通文件归类，各类字节相加等于总占用。符号链接不跟随、不计入。
//! 翻译缓存存在 `books.sqlite3` 里，只额外给出逻辑大小，不重复加进总额。
//! 清理只删除可重建的缓存和 `.migrated` 留底，不删除书籍、书签、注释或阅读进度。

use crate::book_images;
use crate::book_store::{self, BookCacheFootprint};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::Path;
use tauri::AppHandle;

const KIND_IMAGES: &str = "images";
const KIND_TTS: &str = "tts";
const KIND_TRANSLATION: &str = "translation";
const KIND_MIGRATED: &str = "migrated";

const CATEGORY_ORDER: [&str; 9] = [
    "library", "images", "tts", "sources", "sync", "logs", "state", "migrated", "other",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReport {
    pub total_bytes: u64,
    pub categories: Vec<StorageCategory>,
    /// 书库文件内的译文逻辑大小，已包含在 library 类别里。
    pub translation_bytes: u64,
    pub books: Vec<BookStorage>,
    pub unscoped: UnscopedStorage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCategory {
    pub id: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookStorage {
    pub book_id: String,
    pub images_bytes: u64,
    pub images_exclusive_bytes: u64,
    pub tts_bytes: u64,
    pub translation_bytes: u64,
    pub migrated_bytes: u64,
    /// 元信息与章节 JSON 的逻辑大小，只用于展示，清理不会删除。
    pub content_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UnscopedStorage {
    pub images_bytes: u64,
    pub migrated_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct CleanupRequest {
    pub book_ids: Vec<String>,
    pub kinds: Vec<String>,
    pub include_unscoped: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub removed_bytes: u64,
    pub books: u64,
    pub images: u64,
    pub translation_rows: u64,
    pub migrated_files: u64,
}

pub(crate) fn usage<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<StorageReport, String> {
    usage_at(&crate::storage::data_root(app)?)
}

pub(crate) fn usage_at(root: &Path) -> Result<StorageReport, String> {
    book_store::with_library_lock(|| usage_locked(root))
}

pub(crate) fn cleanup<R: tauri::Runtime>(
    app: &AppHandle<R>,
    request: CleanupRequest,
) -> Result<CleanupResult, String> {
    cleanup_at(&crate::storage::data_root(app)?, request)
}

pub(crate) fn cleanup_at(root: &Path, request: CleanupRequest) -> Result<CleanupResult, String> {
    book_store::with_library_lock(|| cleanup_locked(root, request))
}

fn usage_locked(root: &Path) -> Result<StorageReport, String> {
    let mut category_bytes: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut migrated_by_book: HashMap<String, u64> = HashMap::new();
    let mut unscoped_migrated = 0u64;
    let mut total = 0u64;
    let mut skipped = 0u64;
    if root.is_dir() {
        walk_files(
            root,
            &mut |path, meta| {
                let Ok(rel) = path.strip_prefix(root) else {
                    return;
                };
                let bytes = meta.len();
                total += bytes;
                let category = classify(rel);
                *category_bytes.entry(category).or_insert(0) += bytes;
                if category == "migrated" {
                    match migrated_owner(root, path) {
                        Some(id) => *migrated_by_book.entry(id).or_insert(0) += bytes,
                        None => unscoped_migrated += bytes,
                    }
                }
            },
            &mut skipped,
        )?;
    }
    if skipped > 0 {
        log::warn!("统计占用时跳过无法读取的条目 n={skipped}");
    }

    let footprints = book_store::storage_books(root)?;
    let tts = tts_sizes(root)?;
    let images = image_usage(root, &footprints)?;
    let footprint_by_id: HashMap<&str, &BookCacheFootprint> = footprints
        .iter()
        .map(|book| (book.id.as_str(), book))
        .collect();

    let mut ids = BTreeSet::new();
    for book in &footprints {
        ids.insert(book.id.clone());
    }
    ids.extend(tts.keys().cloned());
    ids.extend(migrated_by_book.keys().cloned());

    let mut books: Vec<BookStorage> = ids
        .into_iter()
        .map(|id| {
            let footprint = footprint_by_id.get(id.as_str());
            BookStorage {
                images_bytes: images.referenced.get(&id).copied().unwrap_or(0),
                images_exclusive_bytes: images.exclusive.get(&id).copied().unwrap_or(0),
                tts_bytes: tts.get(&id).copied().unwrap_or(0),
                translation_bytes: footprint.map(|book| book.translation_bytes).unwrap_or(0),
                migrated_bytes: migrated_by_book.get(&id).copied().unwrap_or(0),
                content_bytes: footprint.map(|book| book.content_bytes).unwrap_or(0),
                book_id: id,
            }
        })
        .collect();
    books.sort_by(|left, right| {
        footprint_score(right)
            .cmp(&footprint_score(left))
            .then_with(|| left.book_id.cmp(&right.book_id))
    });

    let translation_bytes = footprints.iter().map(|book| book.translation_bytes).sum();
    let categories = CATEGORY_ORDER
        .into_iter()
        .filter_map(|id| {
            let bytes = category_bytes.get(id).copied().unwrap_or(0);
            (bytes > 0).then(|| StorageCategory {
                id: id.to_string(),
                bytes,
            })
        })
        .collect();

    Ok(StorageReport {
        total_bytes: total,
        categories,
        translation_bytes,
        books,
        unscoped: UnscopedStorage {
            images_bytes: images.orphan_bytes,
            migrated_bytes: unscoped_migrated,
        },
    })
}

fn footprint_score(book: &BookStorage) -> u64 {
    book.content_bytes
        .saturating_add(book.images_bytes)
        .saturating_add(book.tts_bytes)
        .saturating_add(book.translation_bytes)
        .saturating_add(book.migrated_bytes)
}

fn cleanup_locked(root: &Path, request: CleanupRequest) -> Result<CleanupResult, String> {
    let kinds = normalize_kinds(&request.kinds)?;
    let ids = normalize_ids(&request.book_ids)?;
    if kinds.is_empty() || (ids.is_empty() && !request.include_unscoped) {
        return Ok(CleanupResult::default());
    }
    let selected: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut result = CleanupResult {
        books: ids.len() as u64,
        ..CleanupResult::default()
    };

    if kinds.contains(KIND_IMAGES) {
        let (files, bytes) = delete_images(root, &selected, request.include_unscoped)?;
        result.images = files;
        result.removed_bytes += bytes;
    }
    if kinds.contains(KIND_TTS) {
        for id in &ids {
            result.removed_bytes += clear_tts_dir(root, id)?;
        }
    }
    if kinds.contains(KIND_MIGRATED) {
        let (files, bytes) = delete_migrated(root, &selected, request.include_unscoped)?;
        result.migrated_files = files;
        result.removed_bytes += bytes;
        for id in &ids {
            let dir = root.join("books").join(id);
            if dir.is_dir() {
                remove_empty_dirs(&dir);
            }
        }
    }
    if kinds.contains(KIND_TRANSLATION) {
        let logical: u64 = book_store::storage_books(root)?
            .into_iter()
            .filter(|book| selected.contains(book.id.as_str()))
            .map(|book| book.translation_bytes)
            .sum();
        let rows = book_store::clear_translation_caches(root, &ids)?;
        result.translation_rows = rows;
        result.removed_bytes += logical;
    }

    log::info!(
        "已清理应用数据 books={} images={} translation_rows={} migrated={} bytes={}",
        result.books,
        result.images,
        result.translation_rows,
        result.migrated_files,
        result.removed_bytes
    );
    Ok(result)
}

fn normalize_kinds(kinds: &[String]) -> Result<HashSet<&'static str>, String> {
    let mut out = HashSet::new();
    for kind in kinds {
        let normalized = match kind.as_str() {
            KIND_IMAGES => KIND_IMAGES,
            KIND_TTS => KIND_TTS,
            KIND_TRANSLATION => KIND_TRANSLATION,
            KIND_MIGRATED => KIND_MIGRATED,
            _ => return Err("不支持的清理类别".into()),
        };
        out.insert(normalized);
    }
    Ok(out)
}

fn normalize_ids(ids: &[String]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for id in ids {
        if !crate::storage::valid_component(id) {
            return Err("非法的书籍 id".into());
        }
        if seen.insert(id.clone()) {
            out.push(id.clone());
        }
    }
    Ok(out)
}

fn classify(rel: &Path) -> &'static str {
    let name = rel
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if name.ends_with(".migrated") {
        return "migrated";
    }
    let top = rel
        .components()
        .next()
        .and_then(|component| component.as_os_str().to_str())
        .unwrap_or("");
    match top {
        "books.sqlite3" | "books.sqlite3-wal" | "books.sqlite3-shm" | "books.sqlite3-journal" => {
            "library"
        }
        "books" => "library",
        "images" => "images",
        "tts-audio" => "tts",
        "book_sources" | "source_sessions" => "sources",
        "sync" => "sync",
        "logs" => "logs",
        "state" => "state",
        _ => "other",
    }
}

/// `books/<id>.json.migrated` 与 `books/<id>/` 下的留底归到这本书，其余留底没有归属。
fn migrated_owner(root: &Path, path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    if !name.ends_with(".migrated") {
        return None;
    }
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = rel.components();
    if parts.next()?.as_os_str() != "books" {
        return None;
    }
    let second = parts.next()?.as_os_str().to_str()?;
    let id = if parts.next().is_none() {
        second.strip_suffix(".json.migrated")?
    } else {
        second
    };
    crate::storage::valid_component(id).then(|| id.to_string())
}

fn walk_files(
    root: &Path,
    visit: &mut impl FnMut(&Path, &fs::Metadata),
    skipped: &mut u64,
) -> Result<(), String> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let meta = match fs::symlink_metadata(&dir) {
            Ok(meta) => meta,
            Err(_) => {
                *skipped += 1;
                continue;
            }
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => {
                *skipped += 1;
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    *skipped += 1;
                    continue;
                }
            };
            let path = entry.path();
            let meta = match fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(_) => {
                    *skipped += 1;
                    continue;
                }
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                visit(&path, &meta);
            }
        }
    }
    Ok(())
}

fn dir_size(dir: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    let mut skipped = 0u64;
    walk_files(dir, &mut |_, meta| total += meta.len(), &mut skipped)?;
    Ok(total)
}

fn tts_sizes(root: &Path) -> Result<HashMap<String, u64>, String> {
    let dir = root.join("tts-audio");
    if !dir.exists() {
        return Ok(HashMap::new());
    }
    let meta = fs::symlink_metadata(&dir).map_err(|error| format!("读取听书缓存失败: {error}"))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Ok(HashMap::new());
    }
    let mut out = HashMap::new();
    for entry in fs::read_dir(&dir).map_err(|error| format!("读取听书缓存目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取听书缓存目录失败: {error}"))?;
        let path = entry.path();
        let meta =
            fs::symlink_metadata(&path).map_err(|error| format!("读取听书缓存失败: {error}"))?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if !crate::storage::valid_component(&id) {
            continue;
        }
        out.insert(id, dir_size(&path)?);
    }
    Ok(out)
}

struct ImageUsage {
    referenced: HashMap<String, u64>,
    exclusive: HashMap<String, u64>,
    orphan_bytes: u64,
    /// 本地文件名 → 引用它的书籍。
    owners: HashMap<String, HashSet<String>>,
}

fn image_usage(root: &Path, books: &[BookCacheFootprint]) -> Result<ImageUsage, String> {
    let images = root.join("images");
    let mut owners: HashMap<String, HashSet<String>> = HashMap::new();
    for book in books {
        for local in &book.image_locals {
            if book_images::valid_local_name(local) {
                owners
                    .entry(local.clone())
                    .or_default()
                    .insert(book.id.clone());
            }
        }
    }
    let mut sizes = HashMap::new();
    let mut orphan_bytes = 0u64;
    if images.is_dir() {
        let meta =
            fs::symlink_metadata(&images).map_err(|error| format!("读取插图目录失败: {error}"))?;
        if !meta.file_type().is_symlink() {
            for entry in
                fs::read_dir(&images).map_err(|error| format!("读取插图目录失败: {error}"))?
            {
                let entry = entry.map_err(|error| format!("读取插图目录失败: {error}"))?;
                let path = entry.path();
                let meta = match fs::symlink_metadata(&path) {
                    Ok(meta) => meta,
                    Err(_) => continue,
                };
                if meta.file_type().is_symlink() || !meta.is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if !book_images::valid_local_name(&name) {
                    continue;
                }
                let bytes = meta.len();
                if owners.contains_key(&name) {
                    sizes.insert(name, bytes);
                } else {
                    orphan_bytes += bytes;
                    sizes.insert(name, bytes);
                }
            }
        }
    }
    let mut referenced: HashMap<String, u64> = HashMap::new();
    let mut exclusive: HashMap<String, u64> = HashMap::new();
    for (local, book_ids) in &owners {
        let Some(bytes) = sizes.get(local).copied() else {
            continue;
        };
        for id in book_ids {
            *referenced.entry(id.clone()).or_insert(0) += bytes;
            if book_ids.len() == 1 {
                *exclusive.entry(id.clone()).or_insert(0) += bytes;
            }
        }
    }
    Ok(ImageUsage {
        referenced,
        exclusive,
        orphan_bytes,
        owners,
    })
}

fn delete_images(
    root: &Path,
    selected: &HashSet<&str>,
    include_unscoped: bool,
) -> Result<(u64, u64), String> {
    let usage = image_usage(root, &book_store::storage_books(root)?)?;
    let images = root.join("images");
    let mut files = 0u64;
    let mut bytes = 0u64;
    for (local, book_ids) in &usage.owners {
        if book_ids.is_empty() || !book_ids.iter().all(|id| selected.contains(id.as_str())) {
            continue;
        }
        let removed = remove_image(&images, local)?;
        if removed > 0 {
            files += 1;
            bytes += removed;
        }
    }
    if include_unscoped && images.is_dir() {
        for entry in fs::read_dir(&images).map_err(|error| format!("读取插图目录失败: {error}"))?
        {
            let entry = entry.map_err(|error| format!("读取插图目录失败: {error}"))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if usage.owners.contains_key(&name) || !book_images::valid_local_name(&name) {
                continue;
            }
            let removed = remove_regular_file(&entry.path())?;
            if removed > 0 {
                files += 1;
                bytes += removed;
            }
        }
    }
    Ok((files, bytes))
}

fn remove_image(images: &Path, local: &str) -> Result<u64, String> {
    if !book_images::valid_local_name(local) {
        return Ok(0);
    }
    let path = book_images::resolve(images, local)?;
    remove_regular_file(&path)
}

fn clear_tts_dir(root: &Path, id: &str) -> Result<u64, String> {
    if !crate::storage::valid_component(id) {
        return Err("非法的书籍 id".into());
    }
    let dir = root.join("tts-audio").join(id);
    if !dir.exists() {
        return Ok(0);
    }
    let meta = fs::symlink_metadata(&dir).map_err(|error| format!("读取听书缓存失败: {error}"))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Ok(0);
    }
    let bytes = dir_size(&dir)?;
    fs::remove_dir_all(&dir).map_err(|error| format!("清除听书缓存失败: {error}"))?;
    Ok(bytes)
}

fn delete_migrated(
    root: &Path,
    selected: &HashSet<&str>,
    include_unscoped: bool,
) -> Result<(u64, u64), String> {
    let mut files = Vec::new();
    let mut skipped = 0u64;
    if root.is_dir() {
        walk_files(
            root,
            &mut |path, _| {
                let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                    return;
                };
                if !name.ends_with(".migrated") {
                    return;
                }
                let owned = migrated_owner(root, path);
                let delete = match &owned {
                    Some(id) => selected.contains(id.as_str()),
                    None => include_unscoped,
                };
                if delete {
                    files.push(path.to_path_buf());
                }
            },
            &mut skipped,
        )?;
    }
    let mut count = 0u64;
    let mut bytes = 0u64;
    for path in files {
        let removed = remove_regular_file(&path)?;
        if removed > 0 {
            count += 1;
            bytes += removed;
        }
    }
    Ok((count, bytes))
}

fn remove_regular_file(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }
    let meta = fs::symlink_metadata(path).map_err(|error| format!("删除文件失败: {error}"))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Ok(0);
    }
    let bytes = meta.len();
    fs::remove_file(path).map_err(|error| format!("删除文件失败: {error}"))?;
    Ok(bytes)
}

fn remove_empty_dirs(dir: &Path) {
    let meta = match fs::symlink_metadata(dir) {
        Ok(meta) => meta,
        Err(_) => return,
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return;
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                remove_empty_dirs(&path);
            }
        }
    }
    let _ = fs::remove_dir(dir);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ChapterBlock, LocalBook, LocalBookChapter};
    use std::path::PathBuf;

    fn temp_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("readerx-storage-{name}-{}", readerx_sync::new_id()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, bytes).unwrap();
    }

    fn hash(ch: char) -> String {
        ch.to_string().repeat(40)
    }

    fn book(id: &str, locals: &[&str]) -> LocalBook {
        LocalBook {
            id: id.to_string(),
            title: format!("书 {id}"),
            author: "作者".into(),
            intro: None,
            format: "epub".into(),
            file_name: "book.epub".into(),
            size: 1,
            imported_at: 1,
            hue: 1,
            split_desc: "按章".into(),
            cover: None,
            chapters: vec![LocalBookChapter {
                cid: "c0001".into(),
                title: "第一章".into(),
                volume: None,
                paragraphs: vec!["正文".into()],
                blocks: Some(
                    locals
                        .iter()
                        .map(|local| ChapterBlock {
                            kind: "img".into(),
                            text: None,
                            level: None,
                            src: None,
                            alt: None,
                            remote: None,
                            local: Some((*local).to_string()),
                            imgs: None,
                        })
                        .collect(),
                ),
                url: None,
            }],
            group_id: None,
            source: None,
            book_source_id: None,
            book_url: None,
            tags: None,
            source_tags: None,
        }
    }

    #[test]
    fn usage_partitions_files_and_skips_symlinks() {
        let root = temp_root("partition");
        write(&root.join("books/pending.json"), b"library!");
        write(&root.join("images/pic.jpg"), b"img");
        write(&root.join("tts-audio/b1/clip"), b"audio");
        write(&root.join("state/readerx.theme.json"), b"theme");
        write(
            &root.join("state/readerx.groups.json.migrated"),
            b"old-groups",
        );
        write(&root.join("logs/today/readerx.log"), b"log");
        write(&root.join("notes.txt"), b"other");
        let outside = temp_root("outside");
        write(&outside.join("secret.bin"), &vec![7u8; 5000]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(&outside, root.join("linked")).unwrap();
            symlink(outside.join("secret.bin"), root.join("linked-file")).unwrap();
        }

        let report = usage_at(&root).unwrap();
        let sum: u64 = report
            .categories
            .iter()
            .map(|category| category.bytes)
            .sum();
        assert_eq!(report.total_bytes, sum);
        assert!(report.total_bytes < 5000, "符号链接目标不应计入占用");
        let category = |id: &str| {
            report
                .categories
                .iter()
                .find(|category| category.id == id)
                .map(|category| category.bytes)
                .unwrap_or(0)
        };
        assert_eq!(category("library"), 8);
        assert_eq!(category("images"), 3);
        assert_eq!(category("tts"), 5);
        assert_eq!(category("state"), 5);
        assert_eq!(category("migrated"), 10);
        assert_eq!(category("logs"), 3);
        assert_eq!(category("other"), 5);
        assert_eq!(report.unscoped.migrated_bytes, 10);
        let tts_book = report
            .books
            .iter()
            .find(|book| book.book_id == "b1")
            .unwrap();
        assert_eq!(tts_book.tts_bytes, 5);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn cleanup_keeps_other_books_pending_files_and_unselected_migrated() {
        let root = temp_root("cleanup-files");
        write(&root.join("books/b1/bookdetail.json"), b"pending");
        write(
            &root.join("books/b1/bookdetail.json.migrated"),
            b"legacy-b1",
        );
        write(&root.join("books/b2.json.migrated"), b"legacy-b2");
        write(
            &root.join("state/readerx.shelf.json.migrated"),
            b"legacy-state",
        );
        write(&root.join("tts-audio/b1/clip"), b"audio-b1");
        write(&root.join("tts-audio/b2/clip"), b"audio-b2");

        let result = cleanup_at(
            &root,
            CleanupRequest {
                book_ids: vec!["b1".into()],
                kinds: vec![KIND_TTS.into(), KIND_MIGRATED.into()],
                include_unscoped: false,
            },
        )
        .unwrap();
        assert!(result.removed_bytes > 0);
        assert!(!root.join("tts-audio/b1").exists());
        assert!(!root.join("books/b1/bookdetail.json.migrated").exists());
        assert_eq!(
            fs::read(root.join("books/b1/bookdetail.json")).unwrap(),
            b"pending"
        );
        assert!(root.join("books/b2.json.migrated").is_file());
        assert!(root.join("tts-audio/b2/clip").is_file());
        assert!(root.join("state/readerx.shelf.json.migrated").is_file());

        cleanup_at(
            &root,
            CleanupRequest {
                book_ids: Vec::new(),
                kinds: vec![KIND_MIGRATED.into()],
                include_unscoped: true,
            },
        )
        .unwrap();
        assert!(!root.join("state/readerx.shelf.json.migrated").exists());
        assert!(root.join("books/b2.json.migrated").is_file());
        let rejected = cleanup_at(
            &root,
            CleanupRequest {
                book_ids: vec!["../b2".into()],
                kinds: vec![KIND_MIGRATED.into()],
                include_unscoped: false,
            },
        );
        assert!(rejected.is_err());
        assert!(root.join("books/b2.json.migrated").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cleanup_images_and_translations_follow_ownership() {
        let root = temp_root("cleanup-books");
        let shared = format!("{}.jpg", hash('a'));
        let exclusive = format!("{}.png", hash('b'));
        let orphan = format!("{}.gif", hash('c'));
        write(&root.join("images").join(&shared), b"shrd");
        write(&root.join("images").join(&exclusive), b"ex");
        write(&root.join("images").join(&orphan), b"orp");
        book_store::put_book_at(&root, book("b1", &[&shared, &exclusive])).unwrap();
        book_store::put_book_at(&root, book("b2", &[&shared])).unwrap();
        let db = rusqlite::Connection::open(root.join("books.sqlite3")).unwrap();
        db.execute(
            "INSERT INTO translations(book_id,cid,key,source,kind,text) VALUES('b1','c0001','k','原文','paragraph','译文')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO translation_books(book_id,state) VALUES('b1','{\"overrides\":{},\"terms\":[{\"source\":\"甲\"}]}')",
            [],
        )
        .unwrap();
        drop(db);

        let report = usage_at(&root).unwrap();
        let b1 = report
            .books
            .iter()
            .find(|book| book.book_id == "b1")
            .unwrap();
        let b2 = report
            .books
            .iter()
            .find(|book| book.book_id == "b2")
            .unwrap();
        assert_eq!(b1.images_bytes, 6);
        assert_eq!(b1.images_exclusive_bytes, 2);
        assert_eq!(b2.images_exclusive_bytes, 0);
        assert!(b1.translation_bytes > 0);
        assert_eq!(report.translation_bytes, b1.translation_bytes);
        assert_eq!(report.unscoped.images_bytes, 3);
        let category_sum: u64 = report
            .categories
            .iter()
            .map(|category| category.bytes)
            .sum();
        assert_eq!(category_sum, report.total_bytes);

        cleanup_at(
            &root,
            CleanupRequest {
                book_ids: vec!["b1".into()],
                kinds: vec![KIND_IMAGES.into(), KIND_TRANSLATION.into()],
                include_unscoped: false,
            },
        )
        .unwrap();
        assert!(!root.join("images").join(&exclusive).exists());
        assert!(root.join("images").join(&shared).exists());
        assert!(root.join("images").join(&orphan).exists());
        let db = rusqlite::Connection::open(root.join("books.sqlite3")).unwrap();
        let translations: i64 = db
            .query_row("SELECT count(*) FROM translations", [], |row| row.get(0))
            .unwrap();
        let state: String = db
            .query_row(
                "SELECT state FROM translation_books WHERE book_id='b1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let epoch: i64 = db
            .query_row(
                "SELECT epoch FROM translation_epochs WHERE book_id='b1' AND cid='c0001'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let books: i64 = db
            .query_row("SELECT count(*) FROM books", [], |row| row.get(0))
            .unwrap();
        assert_eq!(translations, 0);
        assert!(state.contains("甲"));
        assert!(epoch >= 2);
        assert_eq!(books, 2);
        drop(db);

        cleanup_at(
            &root,
            CleanupRequest {
                book_ids: vec!["b1".into(), "b2".into()],
                kinds: vec![KIND_IMAGES.into()],
                include_unscoped: true,
            },
        )
        .unwrap();
        assert!(!root.join("images").join(&shared).exists());
        assert!(!root.join("images").join(&orphan).exists());
        let _ = fs::remove_dir_all(&root);
    }
}

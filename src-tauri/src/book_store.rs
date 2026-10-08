//! 本地书籍数据存储在应用数据根的 `books.sqlite3`。
//! 元信息、逐章正文与派生指纹、书签和注释经 SQLite 事务读写。
//! 旧目录 / 整书 JSON 逐本迁移，成功后改名 `.migrated` 留底，失败保留读回退。
//! TTS、书源、状态 JSON 与图片字节保持文件存储；备份仍采用原 JSON 归档格式。

use crate::models::{
    BookChapterPatch, BookMeta, BookMetaPatch, ChapterBlock, ChapterHead, LocalBook,
    LocalBookChapter,
};
use readerx_sync::content::{ChapterContent, ChapterDigest};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::BufReader;
#[cfg(test)]
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

#[path = "book_store/sqlite.rs"]
mod sqlite;

/// 旧布局 / 便携备份的元信息文件名
const BOOKDETAIL_FILE: &str = "bookdetail.json";
/// 旧布局 / 便携备份的正文文件名
const CONTENT_FILE: &str = "content.json";
/// 段落注释文件
const ANNOTATIONS_FILE: &str = "annotations.json";
/// 书签文件
const BOOKMARKS_FILE: &str = "bookmarks.json";
/// 当前文件格式版本（文件信封里的 `schemaVersion`）
const SCHEMA_VERSION: u32 = 1;

fn schema_version() -> u32 {
    SCHEMA_VERSION
}

// ---------------------------------------------------------------------------
// 文件格式
// ---------------------------------------------------------------------------

/// `bookdetail.json`：书籍元信息（不含正文）。
///
/// 与 [`LocalBook`] 字段同构（只少 `chapters`），两边必须保持一致 ——
/// 单元测试 `detail_round_trip_keeps_every_field` 会在加了字段却忘记同步时失败。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookDetail {
    #[serde(default = "schema_version")]
    schema_version: u32,
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    intro: Option<String>,
    #[serde(default)]
    format: String,
    #[serde(default)]
    file_name: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    imported_at: u64,
    #[serde(default)]
    hue: u32,
    #[serde(default)]
    split_desc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    book_source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    book_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_tags: Option<Vec<String>>,
}

impl BookDetail {
    /// 从整书取元信息（正文留给 content.json）
    fn from_book(book: &LocalBook) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            id: book.id.clone(),
            title: book.title.clone(),
            author: book.author.clone(),
            intro: book.intro.clone(),
            format: book.format.clone(),
            file_name: book.file_name.clone(),
            size: book.size,
            imported_at: book.imported_at,
            hue: book.hue,
            split_desc: book.split_desc.clone(),
            cover: book.cover.clone(),
            group_id: book.group_id.clone(),
            source: book.source.clone(),
            book_source_id: book.book_source_id.clone(),
            book_url: book.book_url.clone(),
            tags: book.tags.clone(),
            source_tags: book.source_tags.clone(),
        }
    }

    /// 拼回整书（正文由 content.json 提供）
    fn into_book(self, chapters: Vec<LocalBookChapter>) -> LocalBook {
        LocalBook {
            id: self.id,
            title: self.title,
            author: self.author,
            intro: self.intro,
            format: self.format,
            file_name: self.file_name,
            size: self.size,
            imported_at: self.imported_at,
            hue: self.hue,
            split_desc: self.split_desc,
            cover: self.cover,
            chapters,
            group_id: self.group_id,
            source: self.source,
            book_source_id: self.book_source_id,
            book_url: self.book_url,
            tags: self.tags,
            source_tags: self.source_tags,
        }
    }

    /// 书库列表用的轻量元信息（章节只留标题 / 字数）
    fn into_meta(self, chapters: Vec<ChapterHead>) -> BookMeta {
        BookMeta {
            id: self.id,
            title: self.title,
            author: self.author,
            intro: self.intro,
            format: self.format,
            file_name: self.file_name,
            size: self.size,
            imported_at: self.imported_at,
            hue: self.hue,
            split_desc: self.split_desc,
            cover: self.cover,
            chapters,
            group_id: self.group_id,
            source: self.source,
            book_source_id: self.book_source_id,
            book_url: self.book_url,
            tags: self.tags,
            source_tags: self.source_tags,
        }
    }
}

/// `content.json` 的信封：正文单独成文件，留一层具名字段便于以后加东西
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookContent {
    #[serde(default = "schema_version")]
    schema_version: u32,
    #[serde(default)]
    chapters: Vec<LocalBookChapter>,
}

/// `bookmarks.json` 的信封：书签记录本身是前端定义的结构，后端原样存取
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookmarkFile {
    #[serde(default = "schema_version")]
    schema_version: u32,
    #[serde(default)]
    bookmarks: Vec<Value>,
}

/// 注释按段落聚合，记录与 notes 的结构由前端维护。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnnotationFile {
    schema_version: u32,
    annotations: Vec<Value>,
}

fn read_annotations_file(path: &Path) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("读取注释失败: {e}"))?;
    let file: AnnotationFile =
        serde_json::from_str(&text).map_err(|e| format!("解析注释失败: {e}"))?;
    if file.schema_version != SCHEMA_VERSION {
        return Err("注释格式版本不受支持".into());
    }
    Ok(file.annotations)
}
#[cfg(test)]
fn write_annotations_file(path: &Path, annotations: &[Value]) -> Result<(), String> {
    write_json_atomic(
        path,
        &AnnotationFile {
            schema_version: SCHEMA_VERSION,
            annotations: annotations.to_vec(),
        },
        "注释",
    )
}

/// 章节正文（blocks / paragraphs）的「只算字数」视图。
/// `src` 等图片载荷字段故意不在这里声明：旧版本曾把图片以 data URL 写进章节块，
/// serde 遇到未声明字段会跳过（`IgnoredAny` 语义，字符串只扫描不分配），
/// 因此扫描一本内嵌几百 MB base64 的书也不会把内存打满。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChapterScan {
    #[serde(default)]
    cid: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    paragraphs: Vec<String>,
    #[serde(default)]
    blocks: Option<Vec<BlockScan>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlockScan {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

/// `content.json` 的扫描视图（只要章节头）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentScan {
    #[serde(default)]
    chapters: Vec<ChapterScan>,
}

/// 旧布局整书文件（`books/<id>.json`）的扫描视图：迁移没成功时仍照旧列出来
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookScan {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    intro: Option<String>,
    #[serde(default)]
    format: String,
    #[serde(default)]
    file_name: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    imported_at: u64,
    #[serde(default)]
    hue: u32,
    #[serde(default)]
    split_desc: String,
    #[serde(default)]
    cover: Option<String>,
    #[serde(default)]
    chapters: Vec<ChapterScan>,
    #[serde(default)]
    group_id: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    book_source_id: Option<String>,
    #[serde(default)]
    book_url: Option<String>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    source_tags: Option<Vec<String>>,
}

/// 章节扫描结果 → 轻量头。字数口径：有结构化 blocks 时只统计 p/h 文本（UTF-16，
/// 与前端 `chapterMirrorCharsOf` 一致），否则退回段落文本；书架进度 / 详情字数都用它。
fn scan_chapter_head(chapter: ChapterScan) -> ChapterHead {
    let chars = match &chapter.blocks {
        Some(blocks) if !blocks.is_empty() => blocks
            .iter()
            .filter(|block| block.kind == "p" || block.kind == "h")
            .map(|block| {
                block
                    .text
                    .as_deref()
                    .map(|text| text.encode_utf16().count())
                    .unwrap_or(0)
            })
            .sum::<usize>() as u64,
        _ => chapter
            .paragraphs
            .iter()
            .map(|paragraph| paragraph.encode_utf16().count() as u64)
            .sum(),
    };
    ChapterHead {
        cid: chapter.cid,
        title: chapter.title,
        url: chapter.url,
        chars,
    }
}

// ---------------------------------------------------------------------------
// 路径与落盘
// ---------------------------------------------------------------------------

/// 原子写 JSON：先写临时文件再替换（中途失败 / 进程被杀不会留下半截文件）
#[cfg(test)]
fn write_json_atomic<T: Serialize>(path: &Path, value: &T, what: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let _temporary = crate::temporary_file::TemporaryFile(tmp.clone());
    {
        let file = fs::File::create(&tmp).map_err(|e| format!("写入{what}失败: {e}"))?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer(&mut writer, value).map_err(|e| format!("序列化{what}失败: {e}"))?;
        std::io::Write::flush(&mut writer).map_err(|e| format!("写入{what}失败: {e}"))?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|e| format!("写入{what}失败: {e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("写入{what}失败: {e}"))
}

/// 读整份 JSON（流式：不把整份文本读进内存）
fn read_json_file<T: DeserializeOwned>(path: &Path, what: &str) -> Result<T, String> {
    let file = fs::File::open(path).map_err(|e| format!("读取{what}失败: {e}"))?;
    serde_json::from_reader(BufReader::new(file)).map_err(|e| format!("解析{what}失败: {e}"))
}

/// 元信息扫描的上限：不超过它就把文件读进内存用 `from_slice`（快），
/// 超过则流式解析（慢，但内存占用与文件大小无关 —— 这种量级只可能是
/// 历史遗留的巨型书籍 JSON，且会在迁移 / 首次打开后瘦身）。
const META_SCAN_IN_MEMORY_LIMIT: u64 = 24 * 1024 * 1024;

/// 按文件体量选择解析方式扫描 JSON（图片载荷字段不参与解析，不会被分配）
fn scan_json_file<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let size = fs::metadata(path)
        .map_err(|e| format!("读取书籍失败: {e}"))?
        .len();
    if size <= META_SCAN_IN_MEMORY_LIMIT {
        let bytes = fs::read(path).map_err(|e| format!("读取书籍失败: {e}"))?;
        serde_json::from_slice(&bytes).map_err(|e| format!("解析书籍失败: {e}"))
    } else {
        let file = fs::File::open(path).map_err(|e| format!("读取书籍失败: {e}"))?;
        serde_json::from_reader(BufReader::new(file)).map_err(|e| format!("解析书籍失败: {e}"))
    }
}

// ---------------------------------------------------------------------------
// 目录布局的读写（纯路径，便于单测）
// ---------------------------------------------------------------------------

/// 整本书拆成 `bookdetail.json` + `content.json` 落盘（各自原子替换）。
///
/// **先写正文再写元信息**：书名等信息是「书已在书架上」的标志（列表按 bookdetail.json
/// 判定），正文先落盘可以保证「列表里能看到的书一定有正文」；反过来写就会出现
/// 一本点开是空白的书。
#[cfg(test)]
fn write_book_files(dir: &Path, book: LocalBook) -> Result<(), String> {
    let detail = BookDetail::from_book(&book);
    let content = BookContent {
        schema_version: SCHEMA_VERSION,
        chapters: book.chapters,
    };
    write_json_atomic(&dir.join(CONTENT_FILE), &content, "书籍正文")?;
    write_digest_file(dir, &content.chapters)?;
    write_json_atomic(&dir.join(BOOKDETAIL_FILE), &detail, "书籍元信息")
}

/// 只回写正文（逐章回写用）
#[cfg(test)]
fn write_book_content(dir: &Path, chapters: &[LocalBookChapter]) -> Result<(), String> {
    write_book_content_with_digests(dir, chapters, None)
}

/// 写正文 + 章节指纹缓存：`digests` 为 `Some` 时直接用调用方算好的（逐章回写路径
/// 只重算改动的那几章），`None` 时整本重算。
#[cfg(test)]
fn write_book_content_with_digests(
    dir: &Path,
    chapters: &[LocalBookChapter],
    digests: Option<Vec<ChapterDigest>>,
) -> Result<(), String> {
    let content = BookContent {
        schema_version: SCHEMA_VERSION,
        chapters: chapters.to_vec(),
    };
    write_json_atomic(&dir.join(CONTENT_FILE), &content, "书籍正文")?;
    match digests {
        Some(digests) => {
            // 插图引用同样只在被回写的那几章上更新：其余章保持缓存里的原值
            let mut assets = read_digest_assets(dir, chapters.len());
            for (index, chapter) in chapters.iter().enumerate() {
                if let Some(slot) = assets.get_mut(index) {
                    *slot = ChapterAssets {
                        locals: chapter_asset_locals(chapter),
                    };
                }
            }
            write_digest_file_with(dir, digests, assets)
        }
        None => write_digest_file(dir, chapters),
    }
}

/// 读整本书（不含图片迁移；调用方按需再迁移）
fn read_book_from_dir(dir: &Path) -> Result<Option<LocalBook>, String> {
    let detail_path = dir.join(BOOKDETAIL_FILE);
    if !detail_path.is_file() {
        return Ok(None);
    }
    let detail: BookDetail = read_json_file(&detail_path, "书籍元信息")?;
    let content_path = dir.join(CONTENT_FILE);
    // 正文缺失（写入中断 / 手工删过）时按「没有正文」读出：书名等信息还在，
    // 用户看到的是空书而不是书架少一本
    let chapters = if content_path.is_file() {
        read_json_file::<BookContent>(&content_path, "书籍正文")?.chapters
    } else {
        Vec::new()
    };
    Ok(Some(detail.into_book(chapters)))
}

/// 书库列表用的元信息：元信息来自 bookdetail.json，章节头扫 content.json
fn read_meta_from_dir(dir: &Path) -> Result<Option<BookMeta>, String> {
    let detail_path = dir.join(BOOKDETAIL_FILE);
    if !detail_path.is_file() {
        return Ok(None);
    }
    let detail: BookDetail = read_json_file(&detail_path, "书籍元信息")?;
    let content_path = dir.join(CONTENT_FILE);
    let chapters = if content_path.is_file() {
        match scan_json_file::<ContentScan>(&content_path) {
            Ok(scan) => scan.chapters.into_iter().map(scan_chapter_head).collect(),
            Err(error) => {
                log::warn!("旧书籍正文损坏，保留书架元信息：{error}");
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    Ok(Some(detail.into_meta(chapters)))
}

/// 旧布局整书文件 → 目录布局（幂等）：先写齐两个新文件，成功后才删旧文件。
/// 任何一步失败都保留旧文件，调用方下次仍能按旧布局读出来。
#[cfg(test)]
fn convert_legacy_book(
    dir: &Path,
    legacy: &Path,
    images_root: Option<&Path>,
) -> Result<(), String> {
    let mut book: LocalBook = read_json_file(legacy, "书籍")?;
    // 旧数据里的 data URL 图片：迁移机会只有这一次，顺手抽成文件
    if let Some(root) = images_root {
        crate::book_images::migrate_book(root, &mut book);
    }
    crate::storage::ensure_dir(dir)?;
    write_book_files(dir, book)?;
    fs::remove_file(legacy).map_err(|e| format!("删除旧书籍文件失败: {e}"))
}

/// 读一本书的书签（文件缺失 / 空文件都按「没有书签」处理）
fn read_bookmarks_file(path: &Path) -> Result<Vec<Value>, String> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("读取书签失败: {e}"))?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let file: BookmarkFile =
        serde_json::from_str(&text).map_err(|e| format!("解析书签失败: {e}"))?;
    Ok(file.bookmarks)
}

#[cfg(test)]
fn write_bookmarks_file(path: &Path, bookmarks: &[Value]) -> Result<(), String> {
    let file = BookmarkFile {
        schema_version: SCHEMA_VERSION,
        bookmarks: bookmarks.to_vec(),
    };
    write_json_atomic(path, &file, "书签")
}

// ---------------------------------------------------------------------------
// 旧布局迁移
// ---------------------------------------------------------------------------

/// 所有书库入口共用事务锁；不持锁调用同步引擎，避免引擎与磁盘锁顺序反转。
/// 读操作也参与，保证元信息、正文和派生缓存来自同一次完整写入。
fn library_transaction() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|error| error.into_inner())
}

/// 把「全库一份」的旧书签按书拆开写进各自的 `books/<id>/bookmarks.json`（幂等）。
/// 返回（已写入的书数，因书籍目录还不存在而暂时跳过的书数）——调用方据此决定
/// 能否归档旧文件：只要还有书没迁过来，旧文件就不能动。
#[cfg(test)]
fn split_legacy_bookmarks(legacy: &Path, books_dir: &Path) -> Result<(u64, u64), String> {
    let text = fs::read_to_string(legacy).map_err(|e| format!("读取旧书签失败: {e}"))?;
    let map: HashMap<String, Vec<Value>> =
        serde_json::from_str(&text).map_err(|e| format!("解析旧书签失败: {e}"))?;
    let mut migrated = 0u64;
    let mut pending = 0u64;
    for (book_id, bookmarks) in map {
        if bookmarks.is_empty() {
            continue;
        }
        if !crate::storage::valid_component(&book_id) {
            log::warn!("旧书签里的书籍 id 非法，已跳过");
            continue;
        }
        let dir = books_dir.join(&book_id);
        if !dir.is_dir() {
            if books_dir.join(format!("{book_id}.json")).is_file() {
                // 这本书还在旧布局里（它自己的迁移没成功）：书签这次不能迁，
                // 旧文件先留着，等书迁过来再一起搬
                pending += 1;
                log::debug!("旧书签对应的书籍尚未迁移，本次跳过");
            } else {
                // 书早就删了：孤儿书签没有归属，丢弃（留着只会越积越多）
                log::debug!("旧书签对应的书籍已不存在，已丢弃");
            }
            continue;
        }
        write_bookmarks_file(&dir.join(BOOKMARKS_FILE), &bookmarks)?;
        migrated += 1;
    }
    Ok((migrated, pending))
}

// ---------------------------------------------------------------------------
// 对外读写
// ---------------------------------------------------------------------------

/// 读整本书。数据库优先；迁移失败时保留旧 JSON 读回退。
pub(crate) fn get_book<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<Option<LocalBook>, String> {
    let _transaction = library_transaction();
    sqlite::valid_id(id)?;
    let root = crate::storage::data_root(app)?;
    match sqlite::open(&root) {
        Ok(mut db) => {
            if let Some(mut book) = sqlite::get(&db, id)? {
                if crate::book_images::migrate_chapters(
                    &root.join("images"),
                    id,
                    &mut book.chapters,
                ) {
                    let tx = sqlite::transaction(&mut db)?;
                    sqlite::put(&tx, &book)?;
                    sqlite::commit(tx)?;
                }
                return Ok(Some(book));
            }
        }
        Err(error) => {
            if !root.join("books").join(id).join(BOOKDETAIL_FILE).is_file()
                && !root.join("books").join(format!("{id}.json")).is_file()
            {
                return Err(error);
            }
            log::warn!("数据库读取失败，使用未迁移书籍 id={id}");
        }
    }
    legacy_book_at(&root, id)
}

/// 整本写入（导入 / 在线书整本替换）。
pub(crate) fn put_book<R: tauri::Runtime>(
    app: &AppHandle<R>,
    mut book: LocalBook,
) -> Result<(), String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root(app)?;
    let mut db = sqlite::open(&root)?;
    sqlite::valid_id(&book.id)?;
    if sqlite::detail(&db, &book.id)?.is_none() && legacy_book_at(&root, &book.id)?.is_some() {
        return Err("书籍数据迁移失败，请查看应用日志".into());
    }
    crate::book_images::migrate_book(&root.join("images"), &mut book);
    let tx = sqlite::transaction(&mut db)?;
    sqlite::put(&tx, &book)?;
    sqlite::commit(tx)
}

/// 按 cid 增量回写章节正文；批次及字数 / 指纹 / 图片引用在同一事务内提交。
pub(crate) fn put_book_chapters<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    updates: &[BookChapterPatch],
) -> Result<(), String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root(app)?;
    let mut db = sqlite::open(&root)?;
    sqlite::patch(&mut db, &root, id, updates)
}

/// 下标仅是旧客户端的提示；身份必须以 cid 为准，目录变更不能改变正文归属。
#[cfg(test)]
fn patch_chapters(
    chapters: &mut [LocalBookChapter],
    updates: &[BookChapterPatch],
) -> Result<Vec<usize>, String> {
    let mut indices = Vec::with_capacity(updates.len());
    for update in updates {
        let cid = &update.chapter.cid;
        if cid.is_empty() {
            return Err("章节补丁缺少 cid".to_string());
        }
        let mut matches = chapters
            .iter()
            .enumerate()
            .filter(|(_, chapter)| chapter.cid == *cid);
        let Some((index, _)) = matches.next() else {
            return Err("章节目录已变化，补丁对应章节不存在".to_string());
        };
        if matches.next().is_some() {
            return Err("章节 cid 重复，无法定位补丁".to_string());
        }
        indices.push(index);
    }
    // 先验证整批，再修改；只写正文，目录里的标题和地址保留最新值。
    for (update, &index) in updates.iter().zip(&indices) {
        chapters[index].paragraphs = update.chapter.paragraphs.clone();
        chapters[index].blocks = update.chapter.blocks.clone();
    }
    Ok(indices)
}

/// 只改元信息（分组 / 书名 / 封面 / 标签…）：只读写 books 行，
/// 几百 MB 的正文不必读回来，也不经过 IPC。
pub(crate) fn patch_book_meta<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    patch: &BookMetaPatch,
) -> Result<(), String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root(app)?;
    let mut db = sqlite::open(&root)?;
    sqlite::require_book(&db, &root, id)?;
    let tx = sqlite::transaction(&mut db)?;
    let mut book = sqlite::detail(&tx, id)?
        .ok_or("书籍不存在")?
        .into_book(Vec::new());
    if patch.apply_to(&mut book) {
        sqlite::save_detail(&tx, &BookDetail::from_book(&book))?;
    }
    sqlite::commit(tx)
}

/// 读取某本书的书签（书不存在 / 没有书签都返回空列表）
pub(crate) fn get_bookmarks<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<Vec<Value>, String> {
    let _transaction = library_transaction();
    sqlite::valid_id(id)?;
    let root = crate::storage::data_root(app)?;
    match sqlite::open(&root) {
        Ok(db) if sqlite::detail(&db, id)?.is_some() => sqlite::records(&db, "bookmarks", id),
        Ok(_) => legacy_bookmarks_at(&root, id),
        Err(error) => {
            let path = root.join("books").join(id).join(BOOKMARKS_FILE);
            if !path.is_file() && !root.join("state/readerx.bookmarks.json").is_file() {
                return Err(error);
            }
            legacy_bookmarks_at(&root, id)
        }
    }
}

fn legacy_bookmarks_at(root: &Path, id: &str) -> Result<Vec<Value>, String> {
    let path = root.join("books").join(id).join(BOOKMARKS_FILE);
    if path.is_file() {
        return read_bookmarks_file(&path);
    }
    let global = root.join("state/readerx.bookmarks.json");
    if global.is_file() {
        let mut records: HashMap<String, Vec<Value>> = read_json_file(&global, "旧书签")?;
        return Ok(records.remove(id).unwrap_or_default());
    }
    Ok(Vec::new())
}

/// 覆盖式写入某本书的书签
pub(crate) fn put_bookmarks<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    bookmarks: &[Value],
) -> Result<(), String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root(app)?;
    let db = sqlite::open(&root)?;
    if sqlite::detail(&db, id)?.is_none() {
        if root.join("books").join(id).join(BOOKDETAIL_FILE).is_file()
            || root.join("books").join(format!("{id}.json")).is_file()
        {
            sqlite::require_book(&db, &root, id)?;
        }
        return Ok(());
    }
    sqlite::put_records(&db, "bookmarks", id, bookmarks)
}

pub(crate) fn get_annotations<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<Vec<Value>, String> {
    let _transaction = library_transaction();
    sqlite::valid_id(id)?;
    let root = crate::storage::data_root(app)?;
    match sqlite::open(&root) {
        Ok(db) if sqlite::detail(&db, id)?.is_some() => sqlite::records(&db, "annotations", id),
        Ok(_) => read_annotations_file(&root.join("books").join(id).join(ANNOTATIONS_FILE)),
        Err(error) => {
            let path = root.join("books").join(id).join(ANNOTATIONS_FILE);
            if !path.is_file() {
                return Err(error);
            }
            read_annotations_file(&path)
        }
    }
}
pub(crate) fn put_annotations<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    annotations: &[Value],
) -> Result<(), String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root(app)?;
    let db = sqlite::open(&root)?;
    sqlite::require_book(&db, &root, id)?;
    sqlite::put_records(&db, "annotations", id, annotations)
}

/// 前端快照只用于算差集，读改写在同一书库事务内保留刚落地的远端记录。
pub(crate) fn patch_annotations<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    previous: &[Value],
    next: &[Value],
) -> Result<Vec<Value>, String> {
    let changed = crate::annotations::changed(previous, next)?;
    let _transaction = library_transaction();
    let root = crate::storage::data_root(app)?;
    let mut db = sqlite::open(&root)?;
    sqlite::require_book(&db, &root, id)?;
    let tx = sqlite::transaction(&mut db)?;
    let mut current = sqlite::records(&tx, "annotations", id)?;
    let existing = crate::annotations::flatten(&current)?;
    for note in existing.values() {
        crate::annotations::upsert(&mut current, note);
    }
    for note in changed.values() {
        crate::annotations::upsert(&mut current, note);
    }
    sqlite::put_records(&tx, "annotations", id, &current)?;
    sqlite::commit(tx)?;
    Ok(current)
}

/// 删除一本书：数据库级联清理，文件缓存和独占图片仍在文件层清理。
pub(crate) fn delete_book<R: tauri::Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root(app)?;
    let db = sqlite::open(&root)?;
    sqlite::valid_id(id)?;
    let mut locals: Vec<_> = sqlite::assets(&db, id)?
        .into_iter()
        .map(|(_, local)| local)
        .collect();
    // Remove failed legacy inputs before the row, so a failed cleanup cannot resurrect the book.
    let books = root.join("books");
    for path in [
        books.join(id).join(CONTENT_FILE),
        books.join(format!("{id}.json")),
    ] {
        if let Ok(names) = image_locals_from_file(&path) {
            locals.extend(names);
        }
    }
    for path in [books.join(id), books.join(format!("{id}.json"))] {
        if path.is_dir() {
            fs::remove_dir_all(path).map_err(|e| e.to_string())?;
        } else if path.is_file() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    sqlite::delete(&db, id)?;
    let references = (|| {
        let mut references = remaining_image_locals(&books)?;
        for detail in sqlite::details(&db)? {
            references.extend(
                sqlite::assets(&db, &detail.id)?
                    .into_iter()
                    .map(|(_, local)| local),
            );
        }
        Ok::<_, String>(references)
    })();
    match references {
        Ok(references) => {
            crate::book_images::remove_book_images(&root.join("images"), &locals, |name| {
                !references.contains(name)
            });
        }
        Err(error) => log::warn!("删书后插图引用检查失败，保留图片：{error}"),
    }
    crate::storage::remove_book_tts_cache(app, id)?;
    log::info!("书籍已删除 id={id}（含书签、注释与听书缓存）");
    Ok(())
}

/// 把一本书章节里引用到的插图名**归一**（去掉本机书 id 前缀），有改动才写回正文。
///
/// 同步收到插图后调用：正文块里的引用与对端一致，两台设备才会对同一段正文算出同一个
/// 指纹（否则正文通道会一直认为「两边不一样」而反复重传）。正文里没有引用、
/// 或引用本来就归一时**一个字节都不写**（每次同步都重写整本正文是不可接受的）。
/// 返回是否改动过。
pub(crate) fn normalize_book_images<R: tauri::Runtime>(
    app: &AppHandle<R>,
    root: Option<&Path>,
    id: &str,
) -> Result<bool, String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root_at(app, root)?;
    let mut db = sqlite::open(&root)?;
    let Some(mut book) = sqlite::get(&db, id)? else {
        sqlite::reject_pending_migration(&root, id)?;
        return Ok(false);
    };
    if !crate::book_images::normalize_image_refs(&root.join("images"), &mut book.chapters) {
        return Ok(false);
    }
    let tx = sqlite::transaction(&mut db)?;
    sqlite::put(&tx, &book)?;
    sqlite::commit(tx)?;
    Ok(true)
}

/// 先保存待删书的插图引用，再删书籍文件；只清理其余书籍不再引用的文件。
#[cfg(test)]
fn delete_book_files(books: &Path, images: Option<&Path>, id: &str) -> Result<(), String> {
    let dir = books.join(id);
    let legacy = books.join(format!("{id}.json"));
    let mut locals = HashSet::new();
    // 旧布局迁移失败时仍有可能带着本地图片引用，两份文件都要在删除前读取。
    for path in [dir.join(CONTENT_FILE), legacy.clone()] {
        match image_locals_from_file(&path) {
            Ok(names) => locals.extend(names),
            Err(error) => log::warn!(
                "待删书籍插图引用读取失败 id={id}：{}",
                readerx_log::redact::urls_in_text(&error)
            ),
        }
    }
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| format!("删除书籍失败: {e}"))?;
    }
    if legacy.is_file() {
        fs::remove_file(&legacy).map_err(|e| format!("删除书籍失败: {e}"))?;
    }
    if let Some(images) = images.filter(|_| !locals.is_empty()) {
        match remaining_image_locals(books) {
            Ok(referenced) => {
                let locals: Vec<_> = locals.into_iter().collect();
                crate::book_images::remove_book_images(images, &locals, |name| {
                    !referenced.contains(name)
                });
            }
            // 无法确认是否共用时保留图片，删书仍成功，避免破坏其他书的插图。
            Err(error) => log::warn!(
                "书库插图引用检查失败，已跳过图片清理 id={id}：{}",
                readerx_log::redact::urls_in_text(&error)
            ),
        }
    }
    Ok(())
}

// 插图引用扫描只保留 local，跳过正文和 data URL；新旧布局共用 chapters 字段。
#[derive(Deserialize)]
struct ImageContentScan {
    #[serde(default)]
    chapters: Vec<ImageChapterScan>,
}

#[derive(Deserialize)]
struct ImageChapterScan {
    #[serde(default)]
    blocks: Option<Vec<ImageBlockScan>>,
}

#[derive(Deserialize)]
struct ImageBlockScan {
    #[serde(default)]
    local: Option<String>,
    #[serde(default)]
    imgs: Option<Vec<ImageLocalScan>>,
}

#[derive(Deserialize)]
struct ImageLocalScan {
    #[serde(default)]
    local: Option<String>,
}

/// 一本书引用到的图片文件名（整行图、段内图、PDF 页图），不读取图片载荷。
/// 文件不存在视为无引用；损坏或无法读取必须上报，不能误判为无人引用。
fn image_locals_from_file(path: &Path) -> Result<HashSet<String>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(error) => return Err(format!("读取插图引用失败: {error}")),
    };
    let content: ImageContentScan = serde_json::from_reader(BufReader::new(file))
        .map_err(|error| format!("解析插图引用失败: {error}"))?;
    let mut locals = HashSet::new();
    for chapter in content.chapters {
        for block in chapter.blocks.into_iter().flatten() {
            locals.extend(block.local);
            for image in block.imgs.into_iter().flatten() {
                locals.extend(image.local);
            }
        }
    }
    Ok(locals)
}

/// 删除待删书之后扫描剩余引用，两种布局都认；旧文件仍存在时也保留它的引用。
fn remaining_image_locals(books: &Path) -> Result<HashSet<String>, String> {
    if !books.exists() {
        return Ok(HashSet::new());
    }
    let entries = fs::read_dir(books).map_err(|e| format!("读取书库失败: {e}"))?;
    let mut referenced = HashSet::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取书库条目失败: {e}"))?;
        let path = entry.path();
        let kind = entry
            .file_type()
            .map_err(|e| format!("读取书库条目失败: {e}"))?;
        let content = if kind.is_dir() {
            path.join(CONTENT_FILE)
        } else if path.extension().and_then(|s| s.to_str()) == Some("json") {
            path
        } else {
            continue;
        };
        referenced.extend(image_locals_from_file(&content)?);
    }
    Ok(referenced)
}

/// 书库元数据列表（不含任何章节正文）：应用启动 / 书架只拉这一份，
/// 避免把每本书的全文经 IPC 搬到 WebView（含在线书内嵌的 data URL 大图）。
/// 数据库查询预计算的章节头；仅未迁移的旧书走 JSON 扫描。
pub(crate) fn list_book_meta<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<BookMeta>, String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root(app)?;
    let mut metas = match sqlite::open(&root) {
        Ok(db) => sqlite::metas(&db)?,
        Err(error) => {
            if !root.join("books").is_dir() {
                return Err(error);
            }
            log::warn!("数据库读取失败，列出未迁移书籍");
            Vec::new()
        }
    };
    if root.join("books").is_dir() {
        for meta in scan_books_dir(&root.join("books"))? {
            if !metas.iter().any(|existing| existing.id == meta.id) {
                metas.push(meta);
            }
        }
    }
    metas.sort_by_key(|book| std::cmp::Reverse(book.imported_at));
    Ok(metas)
}

/// 扫描书库目录，**两种布局都认**：
///
/// - `books/<id>/`：目录布局（元信息来自 bookdetail.json，章节头扫 content.json）；
/// - `books/<id>.json`：旧布局文件，仅当同名目录还没迁出来时才读它 ——
///   迁移没成功的书因此仍能出现在书架上，而不是「书凭空少了」。
///
/// 纯路径实现，便于单测。
fn scan_books_dir(dir: &Path) -> Result<Vec<BookMeta>, String> {
    let mut books = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("读取书库失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            match read_meta_from_dir(&path) {
                // 目录里没有 bookdetail.json：写入没完成（或不是书籍目录），跳过
                Ok(None) => {}
                Ok(Some(meta)) => books.push(meta),
                Err(error) => {
                    // 解析不出来的书不会出现在书架上：用户看到的是「书凭空少了」，
                    // 必须留下原因，否则只能靠猜
                    log::warn!("跳过无法解析的书籍目录 {}：{error}", path.display());
                }
            }
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        // 目录已经迁好时不再看旧文件（避免同一本书出现两次）
        if dir.join(id).join(BOOKDETAIL_FILE).is_file() {
            continue;
        }
        match scan_json_file::<BookScan>(&path) {
            Ok(scan) => books.push(BookMeta {
                id: scan.id,
                title: scan.title,
                author: scan.author,
                intro: scan.intro,
                format: scan.format,
                file_name: scan.file_name,
                size: scan.size,
                imported_at: scan.imported_at,
                hue: scan.hue,
                split_desc: scan.split_desc,
                cover: scan.cover,
                chapters: scan.chapters.into_iter().map(scan_chapter_head).collect(),
                group_id: scan.group_id,
                source: scan.source,
                book_source_id: scan.book_source_id,
                book_url: scan.book_url,
                tags: scan.tags,
                source_tags: scan.source_tags,
            }),
            Err(error) => {
                log::warn!("跳过无法解析的书籍文件 {}：{error}", path.display());
            }
        }
    }
    books.sort_by_key(|book| std::cmp::Reverse(book.imported_at));
    log::debug!("书库元数据扫描完成 books={}", books.len());
    Ok(books)
}

// ---------------------------------------------------------------------------
// 同步桥接视图：只读元信息（正文一个字节都不碰）
// ---------------------------------------------------------------------------

/// 可同步的书籍元信息（数据库 detail 中参与同步的那些字段）。
///
/// **为什么不直接用 [`LocalBook`]**：同步对账在每次启动、每次改书标签时都要跑，
/// 而读整本会解析所有章节正文。同步只关心元信息，因此单独读取数据库 detail。
///
/// 刻意不在这里的字段（不同步）：`cover`（data URL，会把操作日志撑爆）、
/// `imported_at` / `hue`（导入时间与封面色相）。书源 ID 与同步身份一致。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct BookSyncMeta {
    pub id: String,
    pub title: String,
    pub author: String,
    pub intro: Option<String>,
    pub format: String,
    pub file_name: String,
    pub size: u64,
    pub split_desc: String,
    pub source: Option<String>,
    pub book_source_id: Option<String>,
    pub book_url: Option<String>,
    pub tags: Vec<String>,
    pub source_tags: Vec<String>,
    pub group_id: Option<String>,
}

impl BookSyncMeta {
    fn from_detail(detail: &BookDetail) -> BookSyncMeta {
        BookSyncMeta {
            id: detail.id.clone(),
            title: detail.title.clone(),
            author: detail.author.clone(),
            intro: detail.intro.clone(),
            format: detail.format.clone(),
            file_name: detail.file_name.clone(),
            size: detail.size,
            split_desc: detail.split_desc.clone(),
            source: detail.source.clone(),
            book_source_id: detail.book_source_id.clone(),
            book_url: detail.book_url.clone(),
            tags: detail.tags.clone().unwrap_or_default(),
            source_tags: detail.source_tags.clone().unwrap_or_default(),
            group_id: detail.group_id.clone(),
        }
    }

    fn from_scan(scan: &BookScan) -> BookSyncMeta {
        BookSyncMeta {
            id: scan.id.clone(),
            title: scan.title.clone(),
            author: scan.author.clone(),
            intro: scan.intro.clone(),
            format: scan.format.clone(),
            file_name: scan.file_name.clone(),
            size: scan.size,
            split_desc: scan.split_desc.clone(),
            source: scan.source.clone(),
            book_source_id: scan.book_source_id.clone(),
            book_url: scan.book_url.clone(),
            tags: scan.tags.clone().unwrap_or_default(),
            source_tags: scan.source_tags.clone().unwrap_or_default(),
            group_id: scan.group_id.clone(),
        }
    }
}

/// 读取一本书的可同步元信息（只读数据库 detail；旧布局回退同样支持）。
pub(crate) fn get_sync_meta<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<Option<BookSyncMeta>, String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root(app)?;
    let db = sqlite::open(&root)?;
    if let Some(detail) = sqlite::detail(&db, id)? {
        return Ok(Some(BookSyncMeta::from_detail(&detail)));
    }
    Ok(legacy_book_at(&root, id)?
        .as_ref()
        .map(|book| BookSyncMeta::from_detail(&BookDetail::from_book(book))))
}

/// 目录布局的可同步元信息（纯路径，便于单测）。
#[cfg(test)]
fn sync_meta_from_dir(dir: &Path) -> Result<Option<BookSyncMeta>, String> {
    let path = dir.join(BOOKDETAIL_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let detail: BookDetail = read_json_file(&path, "书籍元信息")?;
    Ok(Some(BookSyncMeta::from_detail(&detail)))
}

/// 列出全部本地书的可同步元信息（两种布局都认，口径与书架列表一致）。
///
/// 只读数据库 detail；迁移失败的旧书籍仍使用元信息回退。
pub(crate) fn list_sync_meta<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<BookSyncMeta>, String> {
    list_sync_meta_at(app, None)
}

/// 同 [`list_sync_meta`]，但读指定的数据根（同步夹具里的「另一台设备」用）。
pub(crate) fn list_sync_meta_at<R: tauri::Runtime>(
    app: &AppHandle<R>,
    root: Option<&Path>,
) -> Result<Vec<BookSyncMeta>, String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root_at(app, root)?;
    let db = sqlite::open(&root)?;
    let mut out: Vec<_> = sqlite::details(&db)?
        .iter()
        .map(BookSyncMeta::from_detail)
        .collect();
    if root.join("books").is_dir() {
        for meta in scan_books_dir(&root.join("books"))? {
            if !out.iter().any(|existing| existing.id == meta.id) {
                // Failed migrations remain visible without reading all chapter bodies.
                let id = &meta.id;
                if let Some(detail) = legacy_detail_at(&root, id)? {
                    out.push(BookSyncMeta::from_detail(&detail));
                }
            }
        }
    }
    Ok(out)
}

/// 把同步合并后的元信息写回数据库 detail（只动 `want` 里的字段，
/// 封面 / 导入时间 / 色相 / 书源 id 原样保留）。返回是否真的改动了磁盘。
pub(crate) fn apply_sync_meta<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    want: &BookSyncMeta,
) -> Result<bool, String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root(app)?;
    let mut db = sqlite::open(&root)?;
    let tx = sqlite::transaction(&mut db)?;
    let Some(mut detail) = sqlite::detail(&tx, id)? else {
        sqlite::reject_pending_migration(&root, id)?;
        return Ok(false);
    };
    if BookSyncMeta::from_detail(&detail) == *want {
        return Ok(false);
    }
    detail.title = want.title.clone();
    detail.author = want.author.clone();
    detail.intro = want.intro.clone();
    detail.format = want.format.clone();
    detail.file_name = want.file_name.clone();
    detail.size = want.size;
    detail.split_desc = want.split_desc.clone();
    detail.source = want.source.clone();
    detail.book_url = want.book_url.clone();
    detail.book_source_id = want.book_source_id.clone();
    detail.group_id = want.group_id.clone();
    detail.tags = if want.tags.is_empty() {
        None
    } else {
        Some(want.tags.clone())
    };
    detail.source_tags = if want.source_tags.is_empty() {
        None
    } else {
        Some(want.source_tags.clone())
    };
    sqlite::save_detail(&tx, &detail)?;
    sqlite::commit(tx)?;
    Ok(true)
}

/// [`apply_sync_meta`] 的纯路径版本（便于单测）。
#[cfg(test)]
fn apply_sync_meta_in_dir(dir: &Path, want: &BookSyncMeta) -> Result<bool, String> {
    let path = dir.join(BOOKDETAIL_FILE);
    if !path.is_file() {
        // 书已经不在了（对端刚同步来、本地却没这个文件）：不是错误，跳过即可
        return Ok(false);
    }
    let mut detail: BookDetail = read_json_file(&path, "书籍元信息")?;
    if BookSyncMeta::from_detail(&detail) == *want {
        return Ok(false);
    }
    detail.title = want.title.clone();
    detail.author = want.author.clone();
    detail.intro = want.intro.clone();
    detail.format = want.format.clone();
    detail.file_name = want.file_name.clone();
    detail.size = want.size;
    detail.split_desc = want.split_desc.clone();
    detail.source = want.source.clone();
    detail.book_url = want.book_url.clone();
    detail.book_source_id = want.book_source_id.clone();
    detail.group_id = want.group_id.clone();
    detail.tags = if want.tags.is_empty() {
        None
    } else {
        Some(want.tags.clone())
    };
    detail.source_tags = if want.source_tags.is_empty() {
        None
    } else {
        Some(want.source_tags.clone())
    };
    write_json_atomic(&path, &detail, "书籍元信息")?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// 同步桥接视图：章节目录（结构）
// ---------------------------------------------------------------------------

/// 同步用的章节目录项：只有「这一章是谁、叫什么、从哪来」，**不含正文与字数**。
///
/// 字数（[`ChapterHead::chars`]）是正文的派生值：对端把目录落到本地后字数仍由本地
/// 正文算出来（没有正文的章节就是 0），同步过去只会在两端口径不完全一致时反复触发
/// 「目录变了」的重写。因此目录实体里只带定位信息。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterRef {
    #[serde(default)]
    pub cid: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// 整本书章节 → 同步用的目录项（从内存里的书建，导入 / 写整本时用）。
pub(crate) fn chapter_refs(chapters: &[LocalBookChapter]) -> Vec<ChapterRef> {
    chapters
        .iter()
        .map(|chapter| ChapterRef {
            cid: chapter.cid.clone(),
            title: chapter.title.clone(),
            url: chapter.url.clone(),
        })
        .collect()
}

/// `content.json` 的目录扫描视图：**只取章节头**，段落与结构化块一律不解析
/// （serde 对未声明字段走忽略语义：字符串只扫描、不分配），因此扫一本几百 MB 的书
/// 也不会把正文读进内存 —— 对账要为每本书算一份目录，不能按「读整本」的代价来。
#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChapterRefScan {
    #[serde(default)]
    cid: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: Option<String>,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentRefScan {
    #[serde(default)]
    chapters: Vec<ChapterRefScan>,
}

#[cfg(test)]
fn scan_chapter_refs(path: &Path) -> Result<Vec<ChapterRef>, String> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let scan: ContentRefScan = scan_json_file(path)?;
    Ok(scan
        .chapters
        .into_iter()
        .map(|chapter| ChapterRef {
            cid: chapter.cid,
            title: chapter.title,
            url: chapter.url,
        })
        .collect())
}

/// 列出全部本地书的目录（同步对账用；两种布局都认）。
///
/// 只读数据库章节头，**不解析正文**，也不统计字数：这是「启动时把书库
/// 目录灌进引擎」的那一步，不能按读整本的代价来。
pub(crate) fn list_sync_structures<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<(String, Vec<ChapterRef>)>, String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root(app)?;
    let db = sqlite::open(&root)?;
    let mut out = Vec::new();
    for detail in sqlite::details(&db)? {
        let refs = sqlite::refs(&db, &detail.id)?;
        if !refs.is_empty() {
            out.push((detail.id, refs));
        }
    }
    if root.join("books").is_dir() {
        for meta in scan_books_dir(&root.join("books"))? {
            if sqlite::detail(&db, &meta.id)?.is_some() {
                continue;
            }
            if !meta.chapters.is_empty() {
                out.push((
                    meta.id,
                    meta.chapters
                        .into_iter()
                        .map(|h| ChapterRef {
                            cid: h.cid,
                            title: h.title,
                            url: h.url,
                        })
                        .collect(),
                ));
            }
        }
    }
    Ok(out)
}

/// 把同步来的目录落到数据库：**按 cid 复用原有正文**，只更新标题 / 地址、
/// 增删章节并重排顺序。正文本身由内容通道单独搬运（见 docs/sync.md），这里一个字节
/// 都不改，因此「目录变了」不会顺带把谁读了一半的正文弄丢。
///
/// 返回是否真的改动了磁盘；目录（cid / 标题 / 地址）本来就一致时直接返回 false，
/// 不读取章节正文。
pub(crate) fn apply_sync_structure<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    want: &[ChapterRef],
) -> Result<bool, String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root(app)?;
    let mut db = sqlite::open(&root)?;
    let tx = sqlite::transaction(&mut db)?;
    if sqlite::detail(&tx, id)?.is_none() {
        sqlite::reject_pending_migration(&root, id)?;
        return Ok(false);
    }
    if sqlite::refs(&tx, id)? == want {
        return Ok(false);
    }
    let mut by_cid: HashMap<_, _> = sqlite::chapters(&tx, id)?
        .into_iter()
        .map(|c| (c.cid.clone(), c))
        .collect();
    let mut book = sqlite::detail(&tx, id)?
        .ok_or("书籍不存在")?
        .into_book(Vec::new());
    book.chapters = want
        .iter()
        .map(|entry| {
            let mut chapter = by_cid.remove(&entry.cid).unwrap_or(LocalBookChapter {
                cid: entry.cid.clone(),
                title: String::new(),
                url: None,
                paragraphs: Vec::new(),
                blocks: None,
            });
            chapter.title = entry.title.clone();
            chapter.url = entry.url.clone();
            chapter
        })
        .collect();
    sqlite::put(&tx, &book)?;
    sqlite::commit(tx)?;
    Ok(true)
}

/// [`apply_sync_structure`] 的纯路径版本（便于单测）。
#[cfg(test)]
fn apply_sync_structure_in_dir(dir: &Path, want: &[ChapterRef]) -> Result<bool, String> {
    let content_path = dir.join(CONTENT_FILE);
    let current = scan_chapter_refs(&content_path)?;
    if current == want {
        return Ok(false);
    }
    let content: BookContent = if content_path.is_file() {
        read_json_file(&content_path, "书籍正文")?
    } else {
        BookContent {
            schema_version: SCHEMA_VERSION,
            chapters: Vec::new(),
        }
    };
    let mut by_cid: HashMap<String, LocalBookChapter> = content
        .chapters
        .into_iter()
        .map(|chapter| (chapter.cid.clone(), chapter))
        .collect();
    let chapters: Vec<LocalBookChapter> = want
        .iter()
        .map(|entry| match by_cid.remove(&entry.cid) {
            Some(mut chapter) => {
                // 正文留用，只把目录里的元信息对齐（标题 / 地址可能在对端改过）
                chapter.title = entry.title.clone();
                chapter.url = entry.url.clone();
                chapter
            }
            None => LocalBookChapter {
                cid: entry.cid.clone(),
                title: entry.title.clone(),
                paragraphs: Vec::new(),
                blocks: None,
                url: entry.url.clone(),
            },
        })
        .collect();
    write_book_content(dir, &chapters)?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// 同步桥接视图：正文（指纹缓存 / 按需取章 / 落地）
// ---------------------------------------------------------------------------

/// 旧章节指纹缓存文件名；升级时归档。生产指纹与正文同事务存储在章节行内。
const DIGEST_FILE: &str = "digest.json";

/// 指纹文件格式：章节顺序与 `content.json` 一一对应（`hash` 为空串 = 该章没有正文）。
#[cfg(test)]
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookDigestFile {
    #[serde(default = "schema_version")]
    schema_version: u32,
    /// 生成这份指纹时 `content.json` 的修改时间（毫秒）与字节数：对不上说明有人在
    /// 外面改过正文，缓存作废、重建一次。
    #[serde(default)]
    content_mtime_ms: u64,
    #[serde(default)]
    content_size: u64,
    #[serde(default)]
    chapters: Vec<ChapterDigest>,
    /// 各章正文里引用到的插图本地副本文件名（与 `chapters` 同下标）。
    ///
    /// 资源通道对账要的就是这个：**引用**（图上没下下来时也要算引用）与
    /// 「`chapters` 里的正文指纹」共用一次整本扫描，因此不必为了同步再解析一遍正文。
    #[serde(default)]
    assets: Vec<ChapterAssets>,
}

/// 一章正文里引用到的插图（见 [`BookDigestFile::assets`]）。
#[cfg(test)]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChapterAssets {
    #[serde(default)]
    locals: Vec<String>,
}

/// 一章正文里引用到的插图本地副本文件名（整行图 + 段内图，去掉重复）。
fn chapter_asset_locals(chapter: &LocalBookChapter) -> Vec<String> {
    let mut locals: Vec<String> = Vec::new();
    for block in chapter.blocks.iter().flatten() {
        if let Some(local) = block.local.as_ref() {
            locals.push(local.clone());
        }
        for image in block.imgs.iter().flatten() {
            if let Some(local) = image.local.as_ref() {
                locals.push(local.clone());
            }
        }
    }
    locals.sort();
    locals.dedup();
    locals
}

#[cfg(test)]
fn content_stamp(path: &Path) -> (u64, u64) {
    let Ok(metadata) = fs::metadata(path) else {
        return (0, 0);
    };
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis() as u64)
        .unwrap_or(0);
    (mtime, metadata.len())
}

/// 一章正文的指纹（与引擎同一口径：只算正文，标题 / 地址 / 字数不参与）。
fn chapter_digest(chapter: &LocalBookChapter) -> ChapterDigest {
    let blocks = chapter
        .blocks
        .as_ref()
        .and_then(|blocks| serde_json::to_value(blocks).ok());
    let hash = if chapter
        .paragraphs
        .iter()
        .any(|text| !text.trim().is_empty())
        || blocks.is_some()
    {
        readerx_sync::content::body_fingerprint(&chapter.paragraphs, blocks.as_ref())
    } else {
        // 没有正文的章节：占位（保持与 content.json 的下标一致），同步时不参与搬运
        String::new()
    };
    ChapterDigest {
        cid: chapter.cid.clone(),
        hash,
    }
}

/// 写指纹缓存（正文写完之后调用；写失败只记日志，不影响正文本身）。
#[cfg(test)]
fn write_digest_file(dir: &Path, chapters: &[LocalBookChapter]) -> Result<(), String> {
    write_digest_file_with(dir, chapter_digests(chapters), chapter_assets(chapters))
}

/// 整本重算：章节指纹 + 插图引用（两者共用一次遍历）。
fn chapter_digests(chapters: &[LocalBookChapter]) -> Vec<ChapterDigest> {
    chapters.iter().map(chapter_digest).collect()
}

/// 见 [`chapter_digests`]。
#[cfg(test)]
fn chapter_assets(chapters: &[LocalBookChapter]) -> Vec<ChapterAssets> {
    chapters
        .iter()
        .map(|chapter| ChapterAssets {
            locals: chapter_asset_locals(chapter),
        })
        .collect()
}

/// 写指纹缓存（调用方已经算好两份清单，见 [`write_book_content_with_digests`] 的逐章路径）。
#[cfg(test)]
fn write_digest_file_with(
    dir: &Path,
    chapters: Vec<ChapterDigest>,
    assets: Vec<ChapterAssets>,
) -> Result<(), String> {
    let (mtime, size) = content_stamp(&dir.join(CONTENT_FILE));
    let file = BookDigestFile {
        schema_version: SCHEMA_VERSION,
        content_mtime_ms: mtime,
        content_size: size,
        chapters,
        assets,
    };
    write_json_atomic(&dir.join(DIGEST_FILE), &file, "章节指纹")
}

/// 读指纹缓存里的插图引用（逐章回写路径要保留没动过的那些章）。
///
/// 缓存缺失 / 过期 / 长度对不上时返回等长的空清单：那几章的引用会在下一次整本重算时补上，
/// 资源通道据此把它们当成「还没落地」—— 宁可不搬，也不要把错的引用发出去。
#[cfg(test)]
fn read_digest_assets(dir: &Path, chapters: usize) -> Vec<ChapterAssets> {
    let cached = read_json_file::<BookDigestFile>(&dir.join(DIGEST_FILE), "章节指纹")
        .ok()
        .filter(|file| file.assets.len() == chapters)
        .map(|file| file.assets)
        .unwrap_or_default();
    let mut assets = cached;
    assets.resize_with(chapters, ChapterAssets::default);
    assets
}

/// 读指纹缓存；缓存缺失 / 过期时**从正文重建**（一次整本解析，之后都走缓存）。
#[cfg(test)]
fn read_digest_file(dir: &Path) -> Result<Vec<ChapterDigest>, String> {
    let content_path = dir.join(CONTENT_FILE);
    let (mtime, size) = content_stamp(&content_path);
    if let Ok(file) = read_json_file::<BookDigestFile>(&dir.join(DIGEST_FILE), "章节指纹") {
        if file.content_mtime_ms == mtime && file.content_size == size {
            return Ok(file.chapters);
        }
    }
    // 缓存作废：整本重算（一次遍历同时补齐章节指纹与插图引用）
    let chapters = if content_path.is_file() {
        read_json_file::<BookContent>(&content_path, "书籍正文")?.chapters
    } else {
        Vec::new()
    };
    let digests: Vec<ChapterDigest> = chapter_digests(&chapters);
    if dir.is_dir() {
        if let Err(error) = write_digest_file(dir, &chapters) {
            log::debug!("章节指纹缓存写入失败（下次重建）：{error}");
        } else {
            log::info!("已按正文重建章节指纹缓存 dir={}", dir.display());
        }
    }
    Ok(digests)
}

/// 同步对账用：某本书**有正文**的章节摘要（没有正文的章节不返回）。
pub(crate) fn read_sync_digests_at<R: tauri::Runtime>(
    app: &AppHandle<R>,
    root: Option<&Path>,
    id: &str,
) -> Result<Vec<ChapterDigest>, String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root_at(app, root)?;
    let db = sqlite::open(&root)?;
    if sqlite::detail(&db, id)?.is_none() {
        return Ok(legacy_book_at(&root, id)?
            .map(|b| {
                chapter_digests(&b.chapters)
                    .into_iter()
                    .filter(|d| !d.hash.is_empty())
                    .collect()
            })
            .unwrap_or_default());
    }
    sqlite::digests(&db, id)
}

/// 一本书的封面（数据库元信息里的 data URL）。不碰正文。
///
/// 封面同步走资源通道（见 `docs/sync.md` 第 7.10 节）：引擎要的是「这段 data URL 的
/// 字节与指纹」，因此这里只提供只读入口，**不改存储形态** —— 封面仍然是元信息里的
/// 一段 data URL，界面那一侧一个字节都不用动。
pub(crate) fn get_cover_at<R: tauri::Runtime>(
    app: &AppHandle<R>,
    root: Option<&Path>,
    id: &str,
) -> Result<Option<String>, String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root_at(app, root)?;
    let db = sqlite::open(&root)?;
    if let Some(detail) = sqlite::detail(&db, id)? {
        return Ok(detail.cover);
    }
    Ok(legacy_detail_at(&root, id)?.and_then(|d| d.cover))
}

/// 写一本书的封面（`Some` 写值，`None` / 空串清除）；返回是否真的改动了磁盘。
///
/// 与 [`apply_sync_meta`] 的区别只有一个：它只动 `cover` 一个字段 ——
/// 「同步来一张封面」不该顺带把别的元信息按引擎里的旧值重写一遍。
pub(crate) fn set_cover_at<R: tauri::Runtime>(
    app: &AppHandle<R>,
    root: Option<&Path>,
    id: &str,
    cover: Option<&str>,
) -> Result<bool, String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root_at(app, root)?;
    let mut db = sqlite::open(&root)?;
    let tx = sqlite::transaction(&mut db)?;
    let Some(mut detail) = sqlite::detail(&tx, id)? else {
        sqlite::reject_pending_migration(&root, id)?;
        return Ok(false);
    };
    let want = cover.filter(|v| !v.is_empty()).map(str::to_string);
    if detail.cover == want {
        return Ok(false);
    }
    detail.cover = want;
    sqlite::save_detail(&tx, &detail)?;
    sqlite::commit(tx)?;
    Ok(true)
}

/// 同步对账用：某本书正文里引用到的插图（资源名 + 本地副本文件名）。
///
/// 与 [`read_sync_digests`] 同一份缓存、同一份来源（章节指纹），因此资源通道对账
/// **不需要解析正文**。没有本地副本的引用（还没下载下来）不在这里 —— 资源通道会按
/// 「引用 + 内容」的并集把它们当成「缺的那一份」。
pub(crate) fn read_sync_asset_refs_at<R: tauri::Runtime>(
    app: &AppHandle<R>,
    root: Option<&Path>,
    id: &str,
) -> Result<Vec<(String, String)>, String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root_at(app, root)?;
    let db = sqlite::open(&root)?;
    sqlite::assets(&db, id)
}

/// 按 cid 索引查询指定章节；正文内存占用与请求的章节同级。
pub(crate) fn read_chapters_by_cid_at<R: tauri::Runtime>(
    app: &AppHandle<R>,
    root: Option<&Path>,
    id: &str,
    cids: &[String],
) -> Result<Vec<LocalBookChapter>, String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root_at(app, root)?;
    let db = sqlite::open(&root)?;
    if sqlite::detail(&db, id)?.is_none() {
        let wanted: HashSet<_> = cids.iter().collect();
        return Ok(legacy_book_at(&root, id)?
            .map(|b| {
                b.chapters
                    .into_iter()
                    .filter(|c| wanted.contains(&c.cid))
                    .collect()
            })
            .unwrap_or_default());
    }
    Ok(sqlite::picked(&db, id, cids)?
        .into_iter()
        .map(|(_, c)| c)
        .collect())
}

pub(crate) fn apply_sync_chapters<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    bodies: &[ChapterContent],
) -> Result<usize, String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root(app)?;
    let mut db = sqlite::open(&root)?;
    sqlite::require_book(&db, &root, id)?;
    let tx = sqlite::transaction(&mut db)?;
    let mut next = sqlite::refs(&tx, id)?.len();
    let mut applied = 0;
    for body in bodies {
        if !has_body(body) {
            continue;
        }
        let mut matches = sqlite::picked(&tx, id, &[body.cid.clone()])?;
        if matches.len() > 1 {
            return Err("章节 cid 重复，无法同步正文".into());
        }
        let (position, mut chapter) = matches.pop().unwrap_or_else(|| {
            let p = next;
            next += 1;
            (
                p,
                LocalBookChapter {
                    cid: body.cid.clone(),
                    title: body.title.clone(),
                    url: body.url.clone(),
                    paragraphs: Vec::new(),
                    blocks: None,
                },
            )
        });
        let blocks = body
            .blocks
            .as_ref()
            .map(|v| {
                serde_json::from_value::<Vec<ChapterBlock>>(v.clone())
                    .map_err(|e| format!("同步章节块无效: {e}"))
            })
            .transpose()?;
        if chapter.paragraphs == body.paragraphs
            && serde_json::to_value(&chapter.blocks).ok() == serde_json::to_value(&blocks).ok()
        {
            continue;
        }
        chapter.paragraphs = body.paragraphs.clone();
        chapter.blocks = blocks;
        if chapter.title.is_empty() {
            chapter.title = body.title.clone();
        }
        if chapter.url.is_none() {
            chapter.url = body.url.clone();
        }
        sqlite::save_chapter(&tx, id, position, &chapter)?;
        applied += 1;
    }
    sqlite::commit(tx)?;
    Ok(applied)
}

/// 与引擎 `ChapterContent::has_body` 同一口径：空章节不算正文。
fn has_body(body: &ChapterContent) -> bool {
    body.paragraphs.iter().any(|text| !text.trim().is_empty())
        || body
            .blocks
            .as_ref()
            .and_then(|value| value.as_array())
            .is_some_and(|items| !items.is_empty())
}

fn legacy_book_at(root: &Path, id: &str) -> Result<Option<LocalBook>, String> {
    sqlite::valid_id(id)?;
    if let Some(book) = read_book_from_dir(&root.join("books").join(id))? {
        return Ok(Some(book));
    }
    let flat = root.join("books").join(format!("{id}.json"));
    if flat.is_file() {
        return read_json_file(&flat, "旧书籍").map(Some);
    }
    Ok(None)
}
fn legacy_detail_at(root: &Path, id: &str) -> Result<Option<BookDetail>, String> {
    sqlite::valid_id(id)?;
    let path = root.join("books").join(id).join(BOOKDETAIL_FILE);
    if path.is_file() {
        return read_json_file(&path, "旧书籍元信息").map(Some);
    }
    Ok(legacy_book_at(root, id)?
        .as_ref()
        .map(BookDetail::from_book))
}

pub(crate) fn contains_at<R: tauri::Runtime>(
    app: &AppHandle<R>,
    root: Option<&Path>,
    id: &str,
) -> Result<bool, String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root_at(app, root)?;
    Ok(sqlite::detail(&sqlite::open(&root)?, id)?.is_some())
}
pub(crate) fn export_books<R: tauri::Runtime>(
    app: &AppHandle<R>,
    zip: &mut zip::ZipWriter<fs::File>,
    report: &mut dyn FnMut(&str, u64, u64),
) -> Result<u64, String> {
    let _transaction = library_transaction();
    let root = crate::storage::data_root(app)?;
    let db = sqlite::open(&root)?;
    // Refuse a partial backup when any readable legacy book could not be imported.
    if root.join("books").is_dir() && !scan_books_dir(&root.join("books"))?.is_empty() {
        return Err("书籍迁移尚未完成，暂不能导出完整备份".into());
    }
    sqlite::export(&db, zip, report)
}
/// Backup JSON is a portable representation, not the on-disk database schema.
pub(crate) fn import_book_json<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    detail: &[u8],
    content: Option<&[u8]>,
) -> Result<(), String> {
    let mut detail: BookDetail =
        serde_json::from_slice(detail).map_err(|e| format!("书籍元信息无法解析: {e}"))?;
    detail.id = id.to_string();
    if detail.schema_version != SCHEMA_VERSION {
        return Err("书籍格式版本不受支持".into());
    }
    let chapters = match content {
        Some(bytes) => {
            let content: BookContent =
                serde_json::from_slice(bytes).map_err(|e| format!("书籍正文无法解析: {e}"))?;
            if content.schema_version != SCHEMA_VERSION {
                return Err("书籍正文格式版本不受支持".into());
            }
            content.chapters
        }
        None => Vec::new(),
    };
    put_book(app, detail.into_book(chapters))
}
/// Called by the journalled identity migration; old/new collision checks precede all writes.
pub(crate) fn rename_id_at(root: &Path, old: &str, new: &str) -> Result<(), String> {
    let _transaction = library_transaction();
    sqlite::valid_id(old)?;
    sqlite::valid_id(new)?;
    let mut db = sqlite::open(root)?;
    let tx = sqlite::transaction(&mut db)?;
    let from = sqlite::detail(&tx, old)?;
    let to = sqlite::detail(&tx, new)?;
    if from.is_some()
        && (root.join("books").join(new).join(BOOKDETAIL_FILE).is_file()
            || root.join("books").join(format!("{new}.json")).is_file())
    {
        return Err("书籍 ID 迁移目标仍有未迁入的旧书籍，原数据已保留".into());
    }
    if from.is_some() && to.is_some() {
        return Err("书籍 ID 迁移目标已存在".into());
    }
    if let Some(mut detail) = from {
        detail.id = new.to_string();
        tx.execute(
            "UPDATE books SET id=?1,detail=?2 WHERE id=?3",
            rusqlite::params![
                new,
                serde_json::to_string(&detail).map_err(|e| e.to_string())?,
                old
            ],
        )
        .map_err(|e| e.to_string())?;
        let mut records = sqlite::records(&tx, "bookmarks", new)?;
        fn remap(value: &mut Value, old: &str, new: &str) {
            match value {
                Value::Object(fields) => {
                    for (key, value) in fields {
                        if key == "bookId" && value.as_str() == Some(old) {
                            *value = Value::String(new.into());
                        } else {
                            remap(value, old, new);
                        }
                    }
                }
                Value::Array(values) => {
                    for value in values {
                        remap(value, old, new);
                    }
                }
                _ => {}
            }
        }
        for record in &mut records {
            remap(record, old, new);
        }
        sqlite::put_records(&tx, "bookmarks", new, &records)?;
    } else if to.is_none() {
        return Err("书籍 ID 迁移缺少原书籍".into());
    }
    sqlite::commit(tx)
}
pub(crate) fn remap_metadata_at(
    root: &Path,
    field: &str,
    remap: &std::collections::BTreeMap<String, String>,
) -> Result<(), String> {
    if remap.is_empty() || !root.join(sqlite::DATABASE).is_file() {
        return Ok(());
    }
    let _transaction = library_transaction();
    let mut db = sqlite::connect(root)?;
    let tx = sqlite::transaction(&mut db)?;
    for mut detail in sqlite::details(&tx)? {
        let value = match field {
            "groupId" => &mut detail.group_id,
            "bookSourceId" => &mut detail.book_source_id,
            _ => return Err("未知元信息引用".into()),
        };
        if let Some(new) = value.as_ref().and_then(|id| remap.get(id)) {
            *value = Some(new.clone());
            sqlite::save_detail(&tx, &detail)?;
        }
    }
    sqlite::commit(tx)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atomic_failures_clean_temporary_and_preserve_old_data() {
        struct Interrupted;
        impl serde::Serialize for Interrupted {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("partial", &1)?;
                Err(serde::ser::Error::custom("interrupted"))
            }
        }
        let dir = temp_dir("atomic-failures");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("content.json");
        fs::write(&path, b"old").unwrap();
        assert!(write_json_atomic(&path, &Interrupted, "正文").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert!(!dir.join("content.json.tmp").exists());
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        fs::write(path.join("keep"), b"old").unwrap();
        assert!(write_json_atomic(&path, &serde_json::json!({"new": 1}), "正文").is_err());
        assert!(!dir.join("content.json.tmp").exists());
        assert_eq!(fs::read(path.join("keep")).unwrap(), b"old");
        fs::remove_dir_all(dir).unwrap();
    }

    use crate::models::ChapterBlock;

    #[test]
    fn chapter_patch_follows_identity_after_reorder_and_keeps_directory_fields() {
        let mut chapters = vec![
            sample_chapter("b", "新标题", "旧正文"),
            sample_chapter("a", "A", "A正文"),
        ];
        let patch = BookChapterPatch {
            index: 1,
            chapter: sample_chapter("b", "旧标题", "新正文"),
        };
        assert_eq!(patch_chapters(&mut chapters, &[patch]).unwrap(), vec![0]);
        assert_eq!(chapters[0].title, "新标题");
        assert_eq!(chapters[0].paragraphs, vec!["新正文"]);
        assert_eq!(chapters[1].paragraphs, vec!["A正文"]);
        let patches = [
            BookChapterPatch {
                index: 0,
                chapter: sample_chapter("a", "A", "不应写入"),
            },
            BookChapterPatch {
                index: 1,
                chapter: sample_chapter("deleted", "删除章", "正文"),
            },
        ];
        assert!(patch_chapters(&mut chapters, &patches).is_err());
        assert_eq!(chapters[1].paragraphs, vec!["A正文"]);
        chapters[1].cid = "b".into();
        assert!(patch_chapters(
            &mut chapters,
            &[BookChapterPatch {
                index: 0,
                chapter: sample_chapter("b", "B", "正文")
            }]
        )
        .is_err());
    }

    #[test]
    fn concurrent_structure_and_body_updates_keep_both_changes() {
        let dir = temp_dir("concurrent");
        let chapters = vec![
            sample_chapter("a", "A", "旧正文"),
            sample_chapter("b", "B", "B正文"),
        ];
        write_book_content(&dir, &chapters).unwrap();
        let start = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                start.wait();
                let _transaction = library_transaction();
                apply_sync_structure_in_dir(
                    &dir,
                    &[
                        ChapterRef {
                            cid: "b".into(),
                            title: "B".into(),
                            url: None,
                        },
                        ChapterRef {
                            cid: "a".into(),
                            title: "新A".into(),
                            url: None,
                        },
                    ],
                )
                .unwrap();
            });
            scope.spawn(|| {
                start.wait();
                let _transaction = library_transaction();
                let mut content: BookContent =
                    read_json_file(&dir.join(CONTENT_FILE), "正文").unwrap();
                patch_chapters(
                    &mut content.chapters,
                    &[BookChapterPatch {
                        index: 0,
                        chapter: sample_chapter("a", "旧A", "下载正文"),
                    }],
                )
                .unwrap();
                std::thread::yield_now();
                write_book_content(&dir, &content.chapters).unwrap();
            });
        });
        let content: BookContent = read_json_file(&dir.join(CONTENT_FILE), "正文").unwrap();
        assert_eq!(content.chapters[0].cid, "b");
        assert_eq!(content.chapters[1].title, "新A");
        assert_eq!(content.chapters[1].paragraphs, vec!["下载正文"]);
        fs::remove_dir_all(dir).unwrap();
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "readerx-book-store-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_chapter(cid: &str, title: &str, text: &str) -> LocalBookChapter {
        LocalBookChapter {
            cid: cid.to_string(),
            title: title.to_string(),
            paragraphs: vec![text.to_string()],
            blocks: Some(vec![ChapterBlock {
                kind: "p".to_string(),
                text: Some(text.to_string()),
                level: None,
                src: None,
                alt: None,
                remote: None,
                local: None,
                imgs: None,
            }]),
            url: Some(format!("https://example.com/{cid}")),
        }
    }

    fn sample_book(id: &str) -> LocalBook {
        LocalBook {
            id: id.to_string(),
            title: "测试书".to_string(),
            author: "作者".to_string(),
            intro: Some("简介".to_string()),
            format: "epub".to_string(),
            file_name: "book.epub".to_string(),
            size: 1234,
            imported_at: 1_700_000_000,
            hue: 7,
            split_desc: "按章".to_string(),
            cover: Some("data:image/png;base64,AAAA".to_string()),
            chapters: vec![sample_chapter("c0001", "第一章", "正文")],
            group_id: Some("g1".to_string()),
            source: Some("webdav".to_string()),
            book_source_id: Some("src1".to_string()),
            book_url: Some("https://example.com/book".to_string()),
            tags: Some(vec!["标签".to_string()]),
            source_tags: Some(vec!["源标签".to_string()]),
        }
    }

    fn write_image_book(books: &Path, id: &str, locals: &[&str], legacy: bool, inline: bool) {
        let blocks: Vec<_> = locals
            .iter()
            .map(|local| {
                if inline {
                    serde_json::json!({"kind": "p", "text": "正文", "imgs": [{"local": local}]})
                } else {
                    serde_json::json!({"kind": "img", "local": local})
                }
            })
            .collect();
        let value = serde_json::json!({"id": id, "chapters": [{"blocks": blocks}]});
        let path = if legacy {
            books.join(format!("{id}.json"))
        } else {
            let dir = books.join(id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(BOOKMARKS_FILE), "{}").unwrap();
            dir.join(CONTENT_FILE)
        };
        write_json_atomic(&path, &value, "测试书籍").unwrap();
    }

    #[test]
    fn delete_book_removes_exclusive_images_before_losing_references() {
        let root = temp_dir("delete-exclusive");
        let books = root.join("books");
        let images = root.join("images");
        fs::create_dir_all(&books).unwrap();
        fs::create_dir_all(&images).unwrap();
        let block = "1111111111111111111111111111111111111111.png";
        let inline = "2222222222222222222222222222222222222222.jpg";
        let pdf = "b1_3333333333333333333333333333333333333333.png";
        let unrelated = "4444444444444444444444444444444444444444.png";
        write_image_book(&books, "b1", &[block, pdf, block], false, false);
        // 同一书的旧文件也必须在删除前取引用，段内图不能漏掉。
        write_image_book(&books, "b1", &[inline], true, true);
        for name in [block, inline, pdf, unrelated] {
            fs::write(images.join(name), b"image").unwrap();
        }

        delete_book_files(&books, Some(&images), "b1").unwrap();
        assert!(!books.join("b1").exists());
        assert!(!books.join("b1.json").exists());
        for name in [block, inline, pdf] {
            assert!(!images.join(name).exists(), "独占插图应被删除: {name}");
        }
        assert!(images.join(unrelated).exists(), "不能清理本书未引用的图片");
        // 重复删除不存在的书仍成功。
        delete_book_files(&books, Some(&images), "b1").unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_book_preserves_shared_images_until_last_reference_is_deleted() {
        let root = temp_dir("delete-shared");
        let books = root.join("books");
        let images = root.join("images");
        fs::create_dir_all(&books).unwrap();
        fs::create_dir_all(&images).unwrap();
        // 两种书籍布局、两种图片命名都要检查其他书的引用。
        for deleted_legacy in [false, true] {
            for remaining_legacy in [false, true] {
                for name in [
                    "1111111111111111111111111111111111111111.png",
                    "b1_1111111111111111111111111111111111111111.png",
                ] {
                    write_image_book(&books, "b1", &[name], deleted_legacy, false);
                    write_image_book(&books, "b2", &[name], remaining_legacy, true);
                    fs::write(images.join(name), b"shared image").unwrap();

                    delete_book_files(&books, Some(&images), "b1").unwrap();
                    assert_eq!(fs::read(images.join(name)).unwrap(), b"shared image");
                    delete_book_files(&books, Some(&images), "b2").unwrap();
                    assert!(!images.join(name).exists(), "最后一个引用删除后应清理插图");
                }
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_book_keeps_images_when_remaining_references_cannot_be_read() {
        let root = temp_dir("delete-corrupt");
        let books = root.join("books");
        let images = root.join("images");
        fs::create_dir_all(&books).unwrap();
        fs::create_dir_all(&images).unwrap();
        let name = "1111111111111111111111111111111111111111.png";
        write_image_book(&books, "b1", &[name], false, false);
        write_image_book(&books, "b2", &[name], false, true);
        fs::write(books.join("b2").join(CONTENT_FILE), "{broken").unwrap();
        fs::write(images.join(name), b"shared image").unwrap();

        delete_book_files(&books, Some(&images), "b1").unwrap();
        assert!(!books.join("b1").exists());
        assert!(books.join("b2").exists());
        assert!(images.join(name).exists(), "读取失败不能当成无人引用");
        fs::remove_dir_all(root).unwrap();
    }

    /// 元信息文件与 LocalBook 的字段必须一一对应：加了字段却忘记同步时在这里失败，
    /// 而不是等到用户发现磁盘上的字段没了。
    #[test]
    fn detail_round_trip_keeps_every_field() {
        let book = sample_book("b1");
        let json = serde_json::to_string(&BookDetail::from_book(&book)).unwrap();
        let detail: BookDetail = serde_json::from_str(&json).unwrap();
        let restored = detail.into_book(book.chapters.clone());
        assert_eq!(
            serde_json::to_value(&restored).unwrap(),
            serde_json::to_value(&book).unwrap()
        );
    }

    #[test]
    fn split_layout_round_trip() {
        let dir = temp_dir("roundtrip");
        let book = sample_book("b1");
        let paths = dir.join("b1");
        fs::create_dir_all(&paths).unwrap();
        write_book_files(&paths, book.clone()).unwrap();

        // 元信息与正文确实落在各自文件里
        assert!(paths.join(BOOKDETAIL_FILE).is_file());
        assert!(paths.join(CONTENT_FILE).is_file());
        let raw = fs::read_to_string(paths.join(BOOKDETAIL_FILE)).unwrap();
        assert!(!raw.contains("chapters"), "元信息文件不该带正文");

        let restored = read_book_from_dir(&paths).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&restored).unwrap(),
            serde_json::to_value(&book).unwrap()
        );

        // 列表元信息：章节头带字数（UTF-16 口径）
        let meta = read_meta_from_dir(&paths).unwrap().unwrap();
        assert_eq!(meta.chapters.len(), 1);
        assert_eq!(meta.chapters[0].cid, "c0001");
        assert_eq!(meta.chapters[0].chars, 2);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 同步视图：只读元信息，且能把同步结果写回来（封面 / 导入时间 / 色相不受影响）。
    #[test]
    fn sync_meta_round_trip_keeps_local_only_fields() {
        let dir = temp_dir("sync-meta");
        let paths = dir.join("b1");
        fs::create_dir_all(&paths).unwrap();
        write_book_files(&paths, sample_book("b1")).unwrap();

        let meta = sync_meta_from_dir(&paths).unwrap().unwrap();
        assert_eq!(meta.title, "测试书");
        assert_eq!(meta.tags, vec!["标签".to_string()]);
        assert_eq!(meta.source_tags, vec!["源标签".to_string()]);
        assert_eq!(meta.group_id, Some("g1".to_string()));
        assert_eq!(meta.book_source_id, Some("src1".to_string()));

        // 值完全相同 → 不写盘
        assert!(!apply_sync_meta_in_dir(&paths, &meta).unwrap());

        // 改书名 / 标签 / 分组 → 只有这些字段变
        let want = BookSyncMeta {
            title: "同步来的书名".to_string(),
            tags: vec!["科幻".to_string()],
            group_id: None,
            ..meta.clone()
        };
        assert!(apply_sync_meta_in_dir(&paths, &want).unwrap());
        let back = sync_meta_from_dir(&paths).unwrap().unwrap();
        assert_eq!(back.title, "同步来的书名");
        assert_eq!(back.tags, vec!["科幻".to_string()]);
        assert_eq!(back.group_id, None);
        // 本机字段原样保留：封面、色相、导入时间、书源 id 不参与同步
        let detail: BookDetail =
            read_json_file(&paths.join(BOOKDETAIL_FILE), "书籍元信息").unwrap();
        assert_eq!(detail.cover.as_deref(), Some("data:image/png;base64,AAAA"));
        assert_eq!(detail.hue, 7);
        assert_eq!(detail.imported_at, 1_700_000_000);
        assert_eq!(detail.book_source_id.as_deref(), Some("src1"));

        let _ = fs::remove_dir_all(&dir);
    }

    /// 书已经被删（目录里没有 bookdetail.json）时返回 false，不报错也不造空文件。
    #[test]
    fn sync_meta_missing_book_is_not_an_error() {
        let dir = temp_dir("sync-meta-missing");
        fs::create_dir_all(&dir).unwrap();
        assert!(sync_meta_from_dir(&dir).unwrap().is_none());
        assert!(!apply_sync_meta_in_dir(&dir, &BookSyncMeta::default()).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 目录落地：按 cid 复用正文，目录没变一个字节都不写。
    #[test]
    fn sync_structure_keeps_chapter_bodies() {
        let dir = temp_dir("sync-structure");
        let paths = dir.join("b1");
        fs::create_dir_all(&paths).unwrap();
        write_book_files(&paths, sample_book("b1")).unwrap();

        // 目录一致 → 不写盘（更不解析整本正文）
        let current = scan_chapter_refs(&paths.join(CONTENT_FILE)).unwrap();
        assert!(!apply_sync_structure_in_dir(&paths, &current).unwrap());

        // 改名 + 加一章：第一章正文留用，新章没有正文
        let want = vec![
            ChapterRef {
                cid: "c0001".to_string(),
                title: "第一章（改名）".to_string(),
                url: Some("https://example.com/c1".to_string()),
            },
            ChapterRef {
                cid: "c0002".to_string(),
                title: "第二章".to_string(),
                url: None,
            },
        ];
        assert!(apply_sync_structure_in_dir(&paths, &want).unwrap());
        let book = read_book_from_dir(&paths).unwrap().unwrap();
        assert_eq!(book.chapters.len(), 2);
        assert_eq!(book.chapters[0].title, "第一章（改名）");
        assert_eq!(
            book.chapters[0].url.as_deref(),
            Some("https://example.com/c1")
        );
        assert_eq!(book.chapters[0].paragraphs, vec!["正文".to_string()]);
        assert!(book.chapters[1].paragraphs.is_empty());

        // 去掉一章：目录以同步结果为准
        assert!(apply_sync_structure_in_dir(&paths, &want[..1]).unwrap());
        let book = read_book_from_dir(&paths).unwrap().unwrap();
        assert_eq!(book.chapters.len(), 1);
        assert_eq!(book.chapters[0].cid, "c0001");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_file_converts_and_is_removed() {
        let dir = temp_dir("legacy");
        let legacy = dir.join("b2.json");
        fs::write(&legacy, serde_json::to_string(&sample_book("b2")).unwrap()).unwrap();

        let target = dir.join("b2");
        convert_legacy_book(&target, &legacy, None).unwrap();

        assert!(!legacy.exists(), "迁移成功后旧文件应删除");
        let restored = read_book_from_dir(&target).unwrap().unwrap();
        assert_eq!(restored.title, "测试书");
        assert_eq!(restored.chapters.len(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_file_survives_failed_conversion() {
        let dir = temp_dir("legacy-bad");
        let legacy = dir.join("b3.json");
        fs::write(&legacy, "{ 不是 JSON").unwrap();

        let target = dir.join("b3");
        assert!(convert_legacy_book(&target, &legacy, None).is_err());
        assert!(legacy.is_file(), "迁移失败必须保留旧文件");
        assert!(!target.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn annotations_round_trip_and_corruption() {
        let dir = temp_dir("annotations");
        let path = dir.join(ANNOTATIONS_FILE);
        assert!(read_annotations_file(&path).unwrap().is_empty());
        let records = vec![
            serde_json::json!({"id": "p1", "chapterCid": "c1", "unitIndex": 2, "notes": [{"id": "n1", "text": "想法"}, {"id": "n2", "text": "说明"}]}),
        ];
        write_annotations_file(&path, &records).unwrap();
        assert_eq!(read_annotations_file(&path).unwrap(), records);
        write_annotations_file(&path, &[]).unwrap();
        assert!(read_annotations_file(&path).unwrap().is_empty());
        fs::write(&path, "{坏文件").unwrap();
        assert!(read_annotations_file(&path).is_err());
        fs::write(&path, r#"{"schemaVersion":99,"annotations":[]}"#).unwrap();
        assert!(read_annotations_file(&path).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn bookmarks_round_trip_and_missing_file() {
        let dir = temp_dir("bookmarks");
        let path = dir.join(BOOKMARKS_FILE);
        assert!(read_bookmarks_file(&path).unwrap().is_empty());

        let marks = vec![
            serde_json::json!({ "id": "bm-1", "charStart": 3, "text": "选中" }),
            serde_json::json!({ "id": "bm-2", "extra": { "未知字段": true } }),
        ];
        write_bookmarks_file(&path, &marks).unwrap();
        // 后端不认识记录结构，未知字段必须原样留着
        assert_eq!(read_bookmarks_file(&path).unwrap(), marks);

        write_bookmarks_file(&path, &[]).unwrap();
        assert!(read_bookmarks_file(&path).unwrap().is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_bookmarks_are_reported() {
        let dir = temp_dir("bookmarks-bad");
        let path = dir.join(BOOKMARKS_FILE);
        fs::write(&path, "{ 坏文件").unwrap();
        assert!(read_bookmarks_file(&path).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_books_dir_reads_both_layouts_without_duplicates() {
        let dir = temp_dir("scan");
        // 目录布局
        let one = dir.join("b1");
        fs::create_dir_all(&one).unwrap();
        write_book_files(&one, sample_book("b1")).unwrap();
        // 旧布局（迁移没成功留下的）
        let mut legacy = sample_book("b2");
        legacy.imported_at += 10;
        fs::write(dir.join("b2.json"), serde_json::to_string(&legacy).unwrap()).unwrap();
        // 两种布局同时存在：只认目录，不能列出两本 b1
        let mut both = sample_book("b3");
        both.imported_at += 20;
        fs::create_dir_all(dir.join("b3")).unwrap();
        write_book_files(&dir.join("b3"), both.clone()).unwrap();
        fs::write(
            dir.join("b3.json"),
            serde_json::to_string(&sample_book("b3")).unwrap(),
        )
        .unwrap();
        // 写入没完成的空目录：跳过
        fs::create_dir_all(dir.join("b4")).unwrap();

        let books = scan_books_dir(&dir).unwrap();
        let ids: Vec<&str> = books.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, vec!["b3", "b2", "b1"], "按导入时间倒序且不重复");
        assert_eq!(books[0].chapters.len(), 1);
        assert_eq!(books[0].chapters[0].chars, 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_bookmarks_split_per_book() {
        let dir = temp_dir("legacy-marks");
        let books = dir.join("books");
        fs::create_dir_all(books.join("b1")).unwrap();
        // b2 还是旧布局（它自己的迁移没成功）：书签这次不能迁，旧文件必须留着
        fs::write(books.join("b2.json"), "{}").unwrap();
        let legacy = dir.join("readerx.bookmarks.json");
        fs::write(
            &legacy,
            serde_json::json!({
                // 书已迁到目录布局：书签跟着落进它的目录
                "b1": [{ "id": "bm-1" }, { "id": "bm-2" }],
                // 书还没迁过来：这次跳过
                "b2": [{ "id": "bm-3" }],
                // 空列表不必建文件
                "b3": [],
                // 书早就删了：孤儿书签丢弃，不算「没迁完」
                "b9": [{ "id": "bm-9" }],
            })
            .to_string(),
        )
        .unwrap();

        let (migrated, pending) = split_legacy_bookmarks(&legacy, &books).unwrap();
        assert_eq!((migrated, pending), (1, 1));
        let marks = read_bookmarks_file(&books.join("b1").join(BOOKMARKS_FILE)).unwrap();
        assert_eq!(marks.len(), 2);
        assert!(!books.join("b9").exists(), "孤儿书签不该造出书籍目录");

        // 第二本书迁好后重跑一次：这次全部迁完，可以归档旧文件
        fs::create_dir_all(books.join("b2")).unwrap();
        let (migrated, pending) = split_legacy_bookmarks(&legacy, &books).unwrap();
        assert_eq!((migrated, pending), (2, 0));
        assert_eq!(
            read_bookmarks_file(&books.join("b2").join(BOOKMARKS_FILE))
                .unwrap()
                .len(),
            1
        );

        let _ = fs::remove_dir_all(&dir);
    }
}

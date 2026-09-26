//! 本地书存储：`books/<id>/` 目录布局（元信息 / 正文 / 书签分文件）。
//!
//! ```text
//! <应用数据目录>/books/<id>/
//!   bookdetail.json   元信息（书名、作者、封面、分组、标签…，不含正文）
//!   content.json      章节正文
//!   bookmarks.json    该书书签
//! ```
//!
//! **为什么拆开**：原先整本只有一个 `books/<id>.json`，改一个分组名也要把几百 MB 的
//! 正文读回来再整本写一遍；书签更是全库挤在一个 `state/readerx.bookmarks.json` 里，
//! 删一本书的书签得把所有书的书签重写一遍。拆开后每类数据各写各的文件，互不牵连：
//! 元信息补丁只动 `bookdetail.json`，逐章回写只动 `content.json`，书签只动 `bookmarks.json`。
//!
//! 三个文件都带 `schemaVersion` 信封，便于以后再改格式时识别版本；
//! 书签记录的结构由前端定义，这里只做信封与存取，不解析记录内容（免得以后加字段被后端丢弃）。
//!
//! **旧布局迁移**（[`migrate_legacy_layout`]，进程内只跑一次、幂等）：
//! - `books/<id>.json`（整本）→ `books/<id>/{bookdetail,content}.json`，成功后才删旧文件；
//! - `state/readerx.bookmarks.json`（全库书签一处）→ 各书 `bookmarks.json`，
//!   全部迁完后旧文件改名为 `.migrated` 留底。
//!
//! 迁移没成功的书仍可按旧布局读取（[`get_book`] / [`list_book_meta`] 留有回退），
//! 不会因为一次写盘失败就从书架上凭空消失。

use crate::models::{
    BookChapterPatch, BookMeta, BookMetaPatch, ChapterHead, LocalBook, LocalBookChapter,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

/// 元信息文件
const BOOKDETAIL_FILE: &str = "bookdetail.json";
/// 正文文件
const CONTENT_FILE: &str = "content.json";
/// 书签文件
const BOOKMARKS_FILE: &str = "bookmarks.json";
/// 当前文件格式版本（三个文件信封里的 `schemaVersion`）
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

/// `books/` 根目录（不存在则创建）
fn books_root<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = crate::storage::data_root(app)?.join("books");
    crate::storage::ensure_dir(&dir)?;
    Ok(dir)
}

/// 单本书的目录路径。**不创建目录**：读路径不该给不存在的书留下空目录。
fn book_dir<R: tauri::Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    if !crate::storage::valid_component(id) {
        return Err("非法的书籍 id".to_string());
    }
    Ok(crate::storage::data_root(app)?.join("books").join(id))
}

/// 旧布局的整书文件路径：`books/<id>.json`
fn legacy_book_file<R: tauri::Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    if !crate::storage::valid_component(id) {
        return Err("非法的书籍 id".to_string());
    }
    Ok(crate::storage::data_root(app)?.join("books").join(format!("{id}.json")))
}

/// 写路径用的书籍目录：不存在则建（旧布局的书先迁移过来）。
fn ensure_book_dir<R: tauri::Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    migrate_legacy_layout(app);
    let dir = book_dir(app, id)?;
    if dir.is_dir() {
        return Ok(dir);
    }
    if legacy_book_file(app, id)?.is_file() {
        // 旧文件还在说明这本没迁移成功（畸形文件 / 写盘失败）：不能当它不存在，
        // 否则会凭空造出一个没有正文的空书目录，把旧数据挡在外面
        return Err("书籍数据迁移失败，请查看应用日志".to_string());
    }
    crate::storage::ensure_dir(&dir)?;
    Ok(dir)
}

/// 原子写 JSON：先写临时文件再替换（中途失败 / 进程被杀不会留下半截文件）
fn write_json_atomic<T: Serialize>(path: &Path, value: &T, what: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    {
        let file = fs::File::create(&tmp).map_err(|e| format!("写入{what}失败: {e}"))?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer(&mut writer, value).map_err(|e| format!("序列化{what}失败: {e}"))?;
        std::io::Write::flush(&mut writer).map_err(|e| format!("写入{what}失败: {e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("写入{what}失败: {e}")
    })
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

/// 书籍文件较大时先做一次「流式图片迁移」：把旧数据里以 data URL 形式塞进章节的图片
/// 抽成本地文件（内存占用只与单张图片同级）。这样后续「读回整本再解析」不会为了
/// 几百 MB 的 base64 把内存打满 —— 旧版本正是因此在大图片书籍上直接闪退。
/// 迁移失败（畸形文件等）只记日志、不影响原路径读取。
fn stream_migrate_if_large<R: tauri::Runtime>(app: &AppHandle<R>, id: &str, path: &Path) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.len() < crate::book_images::STREAM_MIGRATE_MIN_BYTES {
        return;
    }
    // 没有内嵌图片（纯文本巨书）就不必整本重写一遍
    if !crate::book_images::file_has_data_image(path) {
        return;
    }
    let Ok(root) = crate::book_images::images_root(app) else {
        log::warn!("书籍图片迁移无法定位图片目录（{id}），本次跳过");
        return;
    };
    match crate::book_images::migrate_book_file(&root, id, path) {
        Ok(true) => log::info!("书籍图片迁移完成 id={id}（data URL 已抽成本地文件）"),
        Ok(false) => {}
        Err(error) => log::warn!("书籍图片迁移跳过（{id}）: {error}"),
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
fn write_book_files(dir: &Path, book: LocalBook) -> Result<(), String> {
    let detail = BookDetail::from_book(&book);
    let content = BookContent {
        schema_version: SCHEMA_VERSION,
        chapters: book.chapters,
    };
    write_json_atomic(&dir.join(CONTENT_FILE), &content, "书籍正文")?;
    write_json_atomic(&dir.join(BOOKDETAIL_FILE), &detail, "书籍元信息")
}

/// 只回写正文（逐章回写用）
fn write_book_content(dir: &Path, chapters: &[LocalBookChapter]) -> Result<(), String> {
    let content = BookContent {
        schema_version: SCHEMA_VERSION,
        chapters: chapters.to_vec(),
    };
    write_json_atomic(&dir.join(CONTENT_FILE), &content, "书籍正文")
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
        scan_json_file::<ContentScan>(&content_path)?
            .chapters
            .into_iter()
            .map(scan_chapter_head)
            .collect()
    } else {
        Vec::new()
    };
    Ok(Some(detail.into_meta(chapters)))
}

/// 旧布局整书文件 → 目录布局（幂等）：先写齐两个新文件，成功后才删旧文件。
/// 任何一步失败都保留旧文件，调用方下次仍能按旧布局读出来。
fn convert_legacy_book(dir: &Path, legacy: &Path, images_root: Option<&Path>) -> Result<(), String> {
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

/// 进程内迁移账本：串行化迁移，并记住这次已经试过的书
/// （迁移失败的书仍按旧布局读，但不反复重读同一个坏文件）。
#[derive(Default)]
struct LegacyMigration {
    done: bool,
    attempted: HashSet<String>,
}

fn legacy_migration() -> &'static Mutex<LegacyMigration> {
    static STATE: OnceLock<Mutex<LegacyMigration>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(LegacyMigration::default()))
}

/// 旧布局迁移（幂等）。每次运行最多走一遍：单本书失败只记日志并把旧文件留着
/// （该书的列表与阅读都留有旧布局回退），不在这次运行里反复重试 ——
/// 失败的书已记进账本，下次启动（新的账本）才会再试。
/// 各书籍 / 书签读写入口都会先调用它兜底，因此不必在别处手动触发。
pub(crate) fn migrate_legacy_layout<R: tauri::Runtime>(app: &AppHandle<R>) {
    let Ok(mut state) = legacy_migration().lock() else {
        // 锁中毒：别的线程在迁移中 panic 了，本次跳过（下次启动再来）
        return;
    };
    if state.done {
        return;
    }
    state.done = true;
    if let Err(error) = migrate_books(app, &mut state) {
        log::warn!("旧书籍布局迁移未完成（下次启动继续）: {error}");
    } else if let Err(error) = migrate_legacy_bookmarks(app) {
        log::warn!("旧书签迁移未完成（下次启动继续）: {error}");
    }
}

/// `books/<id>.json` → `books/<id>/{bookdetail,content}.json`
fn migrate_books<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &mut LegacyMigration,
) -> Result<(), String> {
    let dir = books_root(app)?;
    let images = crate::book_images::images_root(app).ok();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取书库失败: {e}"))?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if state.attempted.contains(id) {
            continue;
        }
        state.attempted.insert(id.to_string());
        // 大文件先流式抽图，避免整本 base64 进内存
        stream_migrate_if_large(app, id, &path);
        if let Err(error) = convert_legacy_book(&dir.join(id), &path, images.as_deref()) {
            log::warn!("书籍旧布局迁移失败（{id}），保留原文件: {error}");
            continue;
        }
        log::info!("书籍已迁移到目录布局 id={id}");
    }
    Ok(())
}

/// `state/readerx.bookmarks.json`（全库书签一处）→ 各书 `books/<id>/bookmarks.json`。
/// 全部能迁的都迁完之后，旧文件改名为 `.migrated` 留底（不再参与读取）。
fn migrate_legacy_bookmarks<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<u64, String> {
    let legacy = crate::storage::state_dir(app)?.join("readerx.bookmarks.json");
    if !legacy.is_file() {
        return Ok(0);
    }
    let books = crate::storage::data_root(app)?.join("books");
    let (migrated, pending) = split_legacy_bookmarks(&legacy, &books)?;
    if pending > 0 {
        // 有书还没迁过来（迁移失败）：整份旧文件留着，下次继续
        return Err(format!("还有 {pending} 本书未完成迁移"));
    }
    let backup = legacy.with_extension("json.migrated");
    fs::rename(&legacy, &backup).map_err(|e| format!("归档旧书签文件失败: {e}"))?;
    log::info!("书签已迁移为每本书独立文件 books={migrated}");
    Ok(migrated)
}

/// 把「全库一份」的旧书签按书拆开写进各自的 `books/<id>/bookmarks.json`（幂等）。
/// 返回（已写入的书数，因书籍目录还不存在而暂时跳过的书数）——调用方据此决定
/// 能否归档旧文件：只要还有书没迁过来，旧文件就不能动。
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

/// 读整本书。目录布局优先；迁移没成功的旧文件仍可读（内容不丢）。
pub(crate) fn get_book<R: tauri::Runtime>(
    app: &AppHandle<R>, id: &str,
) -> Result<Option<LocalBook>, String> {
    migrate_legacy_layout(app);
    let dir = book_dir(app, id)?;
    if let Some(mut book) = read_book_from_dir(&dir)? {
        // 图片自愈：本地副本不在了就清引用、旧数据里的 data URL 抽成文件（有改动才回写）
        if let Ok(root) = crate::book_images::images_root(app) {
            if crate::book_images::migrate_chapters(&root, id, &mut book.chapters) {
                log::info!("书籍图片旧数据迁移完成 id={id}");
                write_book_content(&dir, &book.chapters)?;
            }
        }
        return Ok(Some(book));
    }
    let legacy = legacy_book_file(app, id)?;
    if !legacy.is_file() {
        return Ok(None);
    }
    stream_migrate_if_large(app, id, &legacy);
    let book = read_json_file(&legacy, "书籍")?;
    log::debug!("按旧布局读取书籍 id={id}");
    Ok(Some(book))
}

/// 整本写入（导入 / 在线书整本替换）。
pub(crate) fn put_book<R: tauri::Runtime>(
    app: &AppHandle<R>, mut book: LocalBook,
) -> Result<(), String> {
    let dir = ensure_book_dir(app, &book.id)?;
    if let Ok(root) = crate::book_images::images_root(app) {
        crate::book_images::migrate_book(&root, &mut book);
    }
    write_book_files(&dir, book)
}

/// 只回写一本书的若干章节（在线书逐批下载正文用）：
/// 只读改 `content.json`，元信息一个字节都不碰（原先要把整本读回来再整本写）。
pub(crate) fn put_book_chapters<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    updates: &[BookChapterPatch],
) -> Result<(), String> {
    migrate_legacy_layout(app);
    let dir = book_dir(app, id)?;
    let path = dir.join(CONTENT_FILE);
    if !path.is_file() {
        return Err(missing_book_error(app, id)?);
    }
    stream_migrate_if_large(app, id, &path);
    let mut content: BookContent = read_json_file(&path, "书籍正文")?;
    for update in updates {
        if update.index >= content.chapters.len() {
            return Err(format!("章节下标越界: {}", update.index));
        }
        content.chapters[update.index] = update.chapter.clone();
    }
    // 迁移结果只在内存里，写盘时自然落定；写盘失败也不影响本次章节回写的数据
    if let Ok(root) = crate::book_images::images_root(app) {
        crate::book_images::migrate_chapters(&root, id, &mut content.chapters);
    }
    write_book_content(&dir, &content.chapters)
}

/// 只改元信息（分组 / 书名 / 封面 / 标签…）：只读写 `bookdetail.json`，
/// 几百 MB 的正文不必读回来，也不经过 IPC。
pub(crate) fn patch_book_meta<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    patch: &BookMetaPatch,
) -> Result<(), String> {
    migrate_legacy_layout(app);
    let path = book_dir(app, id)?.join(BOOKDETAIL_FILE);
    if !path.is_file() {
        return Err(missing_book_error(app, id)?);
    }
    let detail: BookDetail = read_json_file(&path, "书籍元信息")?;
    // 借用 LocalBook 的补丁语义，保证与旧实现逐字段一致（正文不参与）
    let mut book = detail.into_book(Vec::new());
    if !patch.apply_to(&mut book) {
        return Ok(());
    }
    write_json_atomic(&path, &BookDetail::from_book(&book), "书籍元信息")
}

/// 「书籍不存在」的具体原因：旧文件还在说明是迁移没成功（畸形文件 / 写盘失败），
/// 直接说「不存在」会让用户以为是书被删了。
fn missing_book_error<R: tauri::Runtime>(app: &AppHandle<R>, id: &str) -> Result<String, String> {
    if legacy_book_file(app, id)?.is_file() {
        return Ok("书籍数据迁移失败，请查看应用日志".to_string());
    }
    Ok("书籍不存在".to_string())
}

/// 读取某本书的书签（书不存在 / 没有书签都返回空列表）
pub(crate) fn get_bookmarks<R: tauri::Runtime>(
    app: &AppHandle<R>, id: &str,
) -> Result<Vec<Value>, String> {
    migrate_legacy_layout(app);
    let path = book_dir(app, id)?.join(BOOKMARKS_FILE);
    read_bookmarks_file(&path)
}

/// 覆盖式写入某本书的书签
pub(crate) fn put_bookmarks<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    bookmarks: &[Value],
) -> Result<(), String> {
    migrate_legacy_layout(app);
    let dir = book_dir(app, id)?;
    if !dir.is_dir() {
        // 书已经不在了（删书与写书签撞上）：不落盘，也不留下一个只有书签的孤儿目录
        log::debug!("书籍不存在，书签未写入 id={id}");
        return Ok(());
    }
    write_bookmarks_file(&dir.join(BOOKMARKS_FILE), bookmarks)
}

/// 删除一本书：整个书籍目录（含书签）连同听书缓存、章节插图一起清掉。
pub(crate) fn delete_book<R: tauri::Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    migrate_legacy_layout(app);
    if !crate::storage::valid_component(id) {
        return Err("非法的书籍 id".to_string());
    }
    let dir = book_dir(app, id)?;
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| format!("删除书籍失败: {e}"))?;
    }
    // 迁移没成功留下的旧文件同样要删（否则书会一直在书架上）
    let legacy = legacy_book_file(app, id)?;
    if legacy.is_file() {
        fs::remove_file(&legacy).map_err(|e| format!("删除书籍失败: {e}"))?;
    }
    crate::storage::remove_book_tts_cache(app, id)?;
    if let Ok(root) = crate::book_images::images_root(app) {
        crate::book_images::remove_book(&root, id);
    }
    log::info!("书籍已删除 id={id}（含书签、听书缓存与章节插图）");
    Ok(())
}

/// 书库元数据列表（不含任何章节正文）：应用启动 / 书架只拉这一份，
/// 避免把每本书的全文经 IPC 搬到 WebView（含在线书内嵌的 data URL 大图）。
/// 这里流式扫描正文、跳过图片载荷，内存占用与书库总字节数无关。
pub(crate) fn list_book_meta<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<BookMeta>, String> {
    migrate_legacy_layout(app);
    scan_books_dir(&books_root(app)?)
}

/// 扫描书库目录，**两种布局都认**：
/// - `books/<id>/`：目录布局（元信息来自 bookdetail.json，章节头扫 content.json）；
/// - `books/<id>.json`：旧布局文件，仅当同名目录还没迁出来时才读它 ——
///   迁移没成功的书因此仍能出现在书架上，而不是「书凭空少了」。
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

/// 可同步的书籍元信息（`bookdetail.json` 里参与同步的那些字段）。
///
/// **为什么不直接用 [`LocalBook`]**：同步对账在每次启动、每次改书标签时都要跑，
/// 而读整本要把 `content.json`（可能是几百 MB 的正文）解析一遍。同步只关心元信息，
/// 因此单独开一个只读 `bookdetail.json` 的视图。
///
/// 刻意不在这里的字段（不同步）：`cover`（data URL，会把操作日志撑爆）、
/// `imported_at` / `hue`（每台设备导入时各自生成的，同步过去只会制造无意义的差异）、
/// `book_source_id`（本机书源 id，跨设备没有意义）。
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

/// 读取一本书的可同步元信息（只读 `bookdetail.json`；旧布局回退同样支持）。
pub(crate) fn get_sync_meta<R: tauri::Runtime>(
    app: &AppHandle<R>, id: &str,
) -> Result<Option<BookSyncMeta>, String> {
    migrate_legacy_layout(app);
    if let Some(meta) = sync_meta_from_dir(&book_dir(app, id)?)? {
        return Ok(Some(meta));
    }
    let legacy = legacy_book_file(app, id)?;
    if !legacy.is_file() {
        return Ok(None);
    }
    let scan: BookScan = scan_json_file(&legacy)?;
    Ok(Some(BookSyncMeta::from_scan(&scan)))
}

/// 目录布局的可同步元信息（纯路径，便于单测）。
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
/// 与 [`scan_books_dir`] 的区别只有一个：**不读 `content.json`**，因此不会为了
/// 「这本书有几章」把整库正文解析一遍。
pub(crate) fn list_sync_meta<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<BookSyncMeta>, String> {
    migrate_legacy_layout(app);
    let dir = books_root(app)?;
    let mut books = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取书库失败: {e}"))?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let detail_path = path.join(BOOKDETAIL_FILE);
            if !detail_path.is_file() {
                continue;
            }
            match read_json_file::<BookDetail>(&detail_path, "书籍元信息") {
                Ok(detail) => books.push(BookSyncMeta::from_detail(&detail)),
                Err(error) => log::warn!("同步对账跳过无法解析的书籍 {}：{error}", path.display()),
            }
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        // 目录布局已经存在时不再看旧文件（与书架列表同一口径：同一本书不出现两次）
        if dir.join(id).join(BOOKDETAIL_FILE).is_file() {
            continue;
        }
        match scan_json_file::<BookScan>(&path) {
            Ok(scan) => books.push(BookSyncMeta::from_scan(&scan)),
            Err(error) => log::warn!("同步对账跳过无法解析的书籍文件 {}：{error}", path.display()),
        }
    }
    Ok(books)
}

/// 把同步合并后的元信息写回 `bookdetail.json`（只动 `want` 里的字段，
/// 封面 / 导入时间 / 色相 / 书源 id 原样保留）。返回是否真的改动了磁盘。
pub(crate) fn apply_sync_meta<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    want: &BookSyncMeta,
) -> Result<bool, String> {
    migrate_legacy_layout(app);
    apply_sync_meta_in_dir(&book_dir(app, id)?, want)
}

/// [`apply_sync_meta`] 的纯路径版本（便于单测）。
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
    detail.group_id = want.group_id.clone();
    detail.tags = if want.tags.is_empty() { None } else { Some(want.tags.clone()) };
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentRefScan {
    #[serde(default)]
    chapters: Vec<ChapterRefScan>,
}

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
/// 只读 `content.json` 的章节头，**不解析正文**，也不统计字数：这是「启动时把书库
/// 目录灌进引擎」的那一步，不能按读整本的代价来。
pub(crate) fn list_sync_structures<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<(String, Vec<ChapterRef>)>, String> {
    migrate_legacy_layout(app);
    let dir = books_root(app)?;
    let mut books = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取书库失败: {e}"))?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if !path.join(BOOKDETAIL_FILE).is_file() {
                continue;
            }
            let Some(id) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            match scan_chapter_refs(&path.join(CONTENT_FILE)) {
                Ok(chapters) if !chapters.is_empty() => books.push((id.to_string(), chapters)),
                Ok(_) => {}
                Err(error) => log::warn!("同步对账跳过无法解析的目录 {}：{error}", path.display()),
            }
            continue;
        }
        // 旧布局（迁移没成功）：整书文件里直接带 chapters
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if dir.join(id).join(BOOKDETAIL_FILE).is_file() {
            continue;
        }
        let scan: Result<BookScan, String> = scan_json_file(&path);
        match scan {
            Ok(scan) => {
                let chapters: Vec<ChapterRef> = scan
                    .chapters
                    .into_iter()
                    .map(|chapter| ChapterRef {
                        cid: chapter.cid,
                        title: chapter.title,
                        url: chapter.url,
                    })
                    .collect();
                if !chapters.is_empty() {
                    books.push((scan.id, chapters));
                }
            }
            Err(error) => log::warn!("同步对账跳过无法解析的目录 {}：{error}", path.display()),
        }
    }
    Ok(books)
}

/// 把同步来的目录落到本地 `content.json`：**按 cid 复用原有正文**，只更新标题 / 地址、
/// 增删章节并重排顺序。正文本身由内容通道单独搬运（见 docs/sync.md），这里一个字节
/// 都不改，因此「目录变了」不会顺带把谁读了一半的正文弄丢。
///
/// 返回是否真的改动了磁盘；目录（cid / 标题 / 地址）本来就一致时直接返回 false，
/// 连整本 `content.json` 都不解析。
pub(crate) fn apply_sync_structure<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    want: &[ChapterRef],
) -> Result<bool, String> {
    migrate_legacy_layout(app);
    let dir = book_dir(app, id)?;
    if !dir.join(BOOKDETAIL_FILE).is_file() {
        // 书已经不在本机了：目录跟着书的删除一起没了，不是错误
        return Ok(false);
    }
    apply_sync_structure_in_dir(&dir, want)
}

/// [`apply_sync_structure`] 的纯路径版本（便于单测）。
fn apply_sync_structure_in_dir(dir: &Path, want: &[ChapterRef]) -> Result<bool, String> {
    let content_path = dir.join(CONTENT_FILE);
    let current = scan_chapter_refs(&content_path)?;
    if current == want {
        return Ok(false);
    }
    let content: BookContent = if content_path.is_file() {
        read_json_file(&content_path, "书籍正文")?
    } else {
        BookContent { schema_version: SCHEMA_VERSION, chapters: Vec::new() }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ChapterBlock;

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
        assert_eq!(book.chapters[0].url.as_deref(), Some("https://example.com/c1"));
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
        fs::write(
            dir.join("b2.json"),
            serde_json::to_string(&legacy).unwrap(),
        )
        .unwrap();
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

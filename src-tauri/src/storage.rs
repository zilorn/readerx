//! 持久化层。
//! - 偏好 / 书架 / 分章规则等状态按 key 存为 JSON 文件；
//! - 本地书籍按 id 存为独立 JSON 文件。
//! 全部为同步磁盘 I/O，仅对 `commands` 暴露；WebView 侧只通过 command 访问。

use crate::models::{BookChapterPatch, BookMeta, BookSource, ChapterHead, LocalBook, TtsCacheStat};
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::{AppHandle, Manager};

fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    Ok(dir)
}

fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))
}

fn ensure_state_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_root(app)?.join("state");
    ensure_dir(&dir)?;
    Ok(dir)
}

fn ensure_books_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_root(app)?.join("books");
    ensure_dir(&dir)?;
    Ok(dir)
}


fn valid_state_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 80
        && !key.contains("..")
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn valid_component(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.len() <= 160
        && !name.contains(['/', '\\'])
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub(crate) fn read_state(app: &AppHandle, key: &str) -> Result<Option<Value>, String> {
    if !valid_state_key(key) {
        return Err("非法的状态 key".to_string());
    }
    let path = ensure_state_dir(app)?.join(format!("{key}.json"));
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取状态失败: {e}"))?;
    let value = serde_json::from_str(&text).map_err(|e| format!("解析状态失败: {e}"))?;
    Ok(Some(value))
}

pub(crate) fn write_state(app: &AppHandle, key: &str, value: &Value) -> Result<(), String> {
    if !valid_state_key(key) {
        return Err("非法的状态 key".to_string());
    }
    let path = ensure_state_dir(app)?.join(format!("{key}.json"));
    let text = serde_json::to_string_pretty(value).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("写入状态失败: {e}"))
}

pub(crate) fn remove_state(app: &AppHandle, key: &str) -> Result<(), String> {
    if !valid_state_key(key) {
        return Err("非法的状态 key".to_string());
    }
    let path = ensure_state_dir(app)?.join(format!("{key}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除状态失败: {e}"))?;
    }
    Ok(())
}

/// 整书写盘：先写临时文件再原子替换。
/// - 用流式序列化（不再先拼一个整本 JSON 字符串，大书能省一份完整拷贝）；
/// - 中途失败 / 进程被杀不会留下半截书文件（原文件仍在，下次读到的还是上一版）。
fn write_book_file(dir: &Path, id: &str, book: &LocalBook) -> Result<(), String> {
    let path = dir.join(format!("{id}.json"));
    let tmp = dir.join(format!("{id}.json.tmp"));
    {
        let file = fs::File::create(&tmp).map_err(|e| format!("写入书籍失败: {e}"))?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer(&mut writer, book).map_err(|e| format!("序列化失败: {e}"))?;
        std::io::Write::flush(&mut writer).map_err(|e| format!("写入书籍失败: {e}"))?;
    }
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("写入书籍失败: {e}")
    })
}

/// 读取整本书文件（流式解析：不把整份 JSON 文本读进内存）
fn read_book_file(path: &Path) -> Result<LocalBook, String> {
    let file = fs::File::open(path).map_err(|e| format!("读取书籍失败: {e}"))?;
    serde_json::from_reader(BufReader::new(file)).map_err(|e| format!("解析书籍失败: {e}"))
}

/// 书籍文件较大时先做一次「流式图片迁移」：把旧数据里以 data URL 形式塞进章节的图片
/// 抽成本地文件（内存占用只与单张图片同级）。这样后续「读回整本再解析」不会为了
/// 几百 MB 的 base64 把内存打满 —— 旧版本正是因此在大图片书籍上直接闪退。
/// 迁移失败（畸形文件等）只记日志、不影响原路径读取。
fn stream_migrate_if_large(app: &AppHandle, id: &str, path: &Path) {
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
        return;
    };
    if let Err(error) = crate::book_images::migrate_book_file(&root, id, path) {
        eprintln!("[readerx] 书籍图片迁移跳过（{id}）: {error}");
    }
}

pub(crate) fn put_book(app: &AppHandle, book: &LocalBook) -> Result<(), String> {
    if !valid_component(&book.id) {
        return Err("非法的书籍 id".to_string());
    }
    let dir = ensure_books_dir(app)?;
    write_book_file(&dir, &book.id, book)
}

/// 只回写一本书的若干章节（在线书逐批下载正文用）：
/// 读回书文件 → 按下标原位替换 → 整体落盘（文件 I/O 在调用方 blocking 线程池）。
/// 顺带做一次图片旧数据迁移（把章节里的 data URL 图片提取成文件，见 book_images）。
pub(crate) fn put_book_chapters(
    app: &AppHandle,
    id: &str,
    updates: &[BookChapterPatch],
) -> Result<(), String> {
    if !valid_component(id) {
        return Err("非法的书籍 id".to_string());
    }
    let dir = ensure_books_dir(app)?;
    let path = dir.join(format!("{id}.json"));
    if !path.exists() {
        return Err("书籍不存在".to_string());
    }
    stream_migrate_if_large(app, id, &path);
    let mut book = read_book_file(&path)?;
    for update in updates {
        if update.index >= book.chapters.len() {
            return Err(format!("章节下标越界: {}", update.index));
        }
        book.chapters[update.index] = update.chapter.clone();
    }
    // 迁移结果只在内存里，写盘时自然落定；写盘失败也不影响本次章节回写的数据
    if let Ok(root) = crate::book_images::images_root(app) {
        crate::book_images::migrate_book(&root, &mut book);
    }
    write_book_file(&dir, id, &book)
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

/// 书籍文件的元数据视图：与 `LocalBook` 同构，chapters 用上面的轻量扫描结构
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

/// 元数据扫描的上限：不超过它就把文件读进内存用 `from_slice`（快），
/// 超过则流式解析（慢，但内存占用与文件大小无关 —— 这种量级只可能是
/// 历史遗留的巨型书籍 JSON，且会在迁移 / 首次打开后瘦身）。
const META_SCAN_IN_MEMORY_LIMIT: u64 = 24 * 1024 * 1024;

/// 按文件体量选择解析方式扫描书籍元数据（图片载荷字段不参与解析，不会被分配）
fn scan_book_file(path: &Path) -> Result<BookScan, String> {
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

/// 书库元数据列表（不含任何章节正文）：应用启动 / 书架只拉这一份，
/// 避免把每本书的全文经 IPC 搬到 WebView（含在线书内嵌的 data URL 大图）。
/// 这里流式扫描书籍文件、跳过图片载荷，内存占用与书库总字节数无关；
/// 超大旧文件顺手做一次图片迁移（一次性瘦身，之后启动不再需要特殊处理）。
pub(crate) fn list_book_meta(app: &AppHandle) -> Result<Vec<BookMeta>, String> {
    let dir = ensure_books_dir(app)?;
    let mut books = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取书库失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Some(id) = path.file_stem().and_then(|s| s.to_str()) {
            stream_migrate_if_large(app, id, &path);
        }
        let Ok(scan) = scan_book_file(&path) else {
            continue;
        };
        books.push(BookMeta {
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
        });
    }
    books.sort_by_key(|book| std::cmp::Reverse(book.imported_at));
    Ok(books)
}

/// 读取单本书（含章节正文）。文件缺失返回 Ok(None)；阅读页打开时按需调用。
/// 顺带做图片旧数据迁移（books JSON 里残余的 data URL 图片提取成文件，只写一次盘），
/// 这样「打开一本含大量图片的旧书」不会再把几百 MB base64 经 IPC 送进 WebView。
pub(crate) fn get_book(app: &AppHandle, id: &str) -> Result<Option<LocalBook>, String> {
    if !valid_component(id) {
        return Err("非法的书籍 id".to_string());
    }
    let dir = ensure_books_dir(app)?;
    let path = dir.join(format!("{id}.json"));
    if !path.exists() {
        return Ok(None);
    }
    stream_migrate_if_large(app, id, &path);
    let mut book = read_book_file(&path)?;
    let migrated = crate::book_images::images_root(app)
        .map(|root| crate::book_images::migrate_book(&root, &mut book))
        .unwrap_or(false);
    if migrated {
        // 迁移后立刻落盘：下次读取就是瘦身后的正文
        write_book_file(&dir, id, &book)?;
    }
    Ok(Some(book))
}

/// 给某本书打「元信息补丁」（分组 / 书名 / 封面 / 标签…）。
/// 正文整体保留在磁盘文件里：只在 Rust 侧读回、改字段、写回，不经过 IPC 传全文。
/// 没有任何字段需要改动（changed=false）时也返回 Ok，不发不必要的写盘。
pub(crate) fn patch_book_meta(
    app: &AppHandle,
    id: &str,
    patch: &crate::models::BookMetaPatch,
) -> Result<(), String> {
    if !valid_component(id) {
        return Err("非法的书籍 id".to_string());
    }
    let dir = ensure_books_dir(app)?;
    let path = dir.join(format!("{id}.json"));
    if !path.exists() {
        return Err("书籍不存在".to_string());
    }
    stream_migrate_if_large(app, id, &path);
    let mut book = read_book_file(&path)?;
    let patched = patch.apply_to(&mut book);
    let migrated = crate::book_images::images_root(app)
        .map(|root| crate::book_images::migrate_book(&root, &mut book))
        .unwrap_or(false);
    if patched || migrated {
        write_book_file(&dir, id, &book)?;
    }
    Ok(())
}

pub(crate) fn delete_book(app: &AppHandle, id: &str) -> Result<(), String> {
    if !valid_component(id) {
        return Err("非法的书籍 id".to_string());
    }
    let dir = ensure_books_dir(app)?;
    let path = dir.join(format!("{id}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除书籍失败: {e}"))?;
    }
    // 顺带清掉该书的听书音频缓存（不存在则忽略）
    let cache_dir = tts_cache_dir(app, id)?;
    if cache_dir.exists() {
        fs::remove_dir_all(&cache_dir).map_err(|e| format!("清理听书缓存失败: {e}"))?;
    }
    // 顺带清掉该书的章节插图文件（不存在则忽略）
    if let Ok(root) = crate::book_images::images_root(app) {
        crate::book_images::remove_book(&root, id);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 听书音频缓存：按书籍独立目录存放（每句一个文件 + .mime 元数据）。
// WebView 不落盘：全部经 command 读写；文件数超上限时按修改时间淘汰最旧。
// ---------------------------------------------------------------------------

/// 每本书最多保留的音频条目数（超过后淘汰最旧的）
const TTS_CACHE_MAX_FILES: u64 = 1500;

fn valid_audio_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

fn tts_cache_dir(app: &AppHandle, book_id: &str) -> Result<PathBuf, String> {
    if !valid_component(book_id) {
        return Err("非法的书籍 id".to_string());
    }
    Ok(data_root(app)?.join("tts-audio").join(book_id))
}

/// 写入一句缓存音频；条目数超限时淘汰最旧（按修改时间）。
pub(crate) fn put_tts_audio(
    app: &AppHandle,
    book_id: &str,
    key: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<(), String> {
    if !valid_audio_key(key) {
        return Err("非法的音频缓存 key".to_string());
    }
    let dir = tts_cache_dir(app, book_id)?;
    ensure_dir(&dir)?;
    fs::write(dir.join(key), bytes).map_err(|e| format!("写入听书缓存失败: {e}"))?;
    fs::write(dir.join(format!("{key}.mime")), mime)
        .map_err(|e| format!("写入听书缓存元数据失败: {e}"))?;
    prune_tts_cache(&dir);
    Ok(())
}

/// 读取一句缓存音频；不存在返回 None。
pub(crate) fn get_tts_audio(
    app: &AppHandle,
    book_id: &str,
    key: &str,
) -> Result<Option<(String, Vec<u8>)>, String> {
    if !valid_audio_key(key) {
        return Err("非法的音频缓存 key".to_string());
    }
    let dir = tts_cache_dir(app, book_id)?;
    let data_path = dir.join(key);
    if !data_path.exists() {
        return Ok(None);
    }
    let mime = fs::read_to_string(dir.join(format!("{key}.mime"))).unwrap_or_else(|_| "audio/mpeg".to_string());
    let bytes = fs::read(&data_path).map_err(|e| format!("读取听书缓存失败: {e}"))?;
    Ok(Some((mime, bytes)))
}

/// 淘汰最旧的音频文件（保留 .mime 不参与计数；删除时连同元数据一起删）
fn prune_tts_cache(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut audios: Vec<(SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("mime") {
            continue;
        }
        if let Ok(meta) = fs::metadata(&path) {
            audios.push((meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), path));
        }
    }
    if audios.len() as u64 <= TTS_CACHE_MAX_FILES {
        return;
    }
    audios.sort_by_key(|(t, _)| *t);
    let excess = audios.len() as u64 - TTS_CACHE_MAX_FILES;
    for (_, path) in audios.into_iter().take(excess as usize) {
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("mime"));
    }
}

/// 各书籍的听书缓存统计（仅统计有缓存的书籍）
pub(crate) fn list_tts_cache(app: &AppHandle) -> Result<Vec<TtsCacheStat>, String> {
    let root = data_root(app)?.join("tts-audio");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut stats = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| format!("读取听书缓存目录失败: {e}"))?.flatten() {
        let dir_path = entry.path();
        if !dir_path.is_dir() {
            continue;
        }
        let mut files: u64 = 0;
        let mut bytes: u64 = 0;
        if let Ok(entries) = fs::read_dir(&dir_path) {
            for file in entries.flatten() {
                let path = file.path();
                if path.extension().and_then(|s| s.to_str()) == Some("mime") {
                    continue;
                }
                files += 1;
                if let Ok(meta) = fs::metadata(&path) {
                    bytes += meta.len();
                }
            }
        }
        if files > 0 {
            let book_id = entry.file_name().to_string_lossy().into_owned();
            stats.push(TtsCacheStat { book_id, files, bytes });
        }
    }
    stats.sort_by(|a, b| a.book_id.cmp(&b.book_id));
    Ok(stats)
}

/// 清除听书缓存：book_id 为 None 清空全部书籍
pub(crate) fn clear_tts_cache(app: &AppHandle, book_id: Option<&str>) -> Result<(), String> {
    match book_id {
        Some(id) => {
            let dir = tts_cache_dir(app, id)?;
            if dir.exists() {
                fs::remove_dir_all(&dir).map_err(|e| format!("清除听书缓存失败: {e}"))?;
            }
        }
        None => {
            let root = data_root(app)?.join("tts-audio");
            if root.exists() {
                fs::remove_dir_all(&root).map_err(|e| format!("清除听书缓存失败: {e}"))?;
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 书源：<appData>/book_sources/<id>.json（一个书源一个文件）
// ---------------------------------------------------------------------------

fn ensure_sources_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_root(app)?.join("book_sources");
    ensure_dir(&dir)?;
    Ok(dir)
}

pub(crate) fn put_book_source(app: &AppHandle, source: &BookSource) -> Result<(), String> {
    if !valid_component(&source.id) {
        return Err("非法的书源 id".to_string());
    }
    let dir = ensure_sources_dir(app)?;
    let path = dir.join(format!("{}.json", source.id));
    let text = serde_json::to_string_pretty(source).map_err(|e| format!("序列化书源失败: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("写入书源失败: {e}"))
}

/// 读取单个书源；不存在返回 Ok(None)
pub(crate) fn get_book_source(app: &AppHandle, id: &str) -> Result<Option<BookSource>, String> {
    if !valid_component(id) {
        return Err("非法的书源 id".to_string());
    }
    let dir = ensure_sources_dir(app)?;
    let path = dir.join(format!("{id}.json"));
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取书源失败: {e}"))?;
    let source = serde_json::from_str(&text).map_err(|e| format!("解析书源失败: {e}"))?;
    Ok(Some(source))
}

/// 列出全部书源（含 js，供引擎使用）；调用方需要摘要时再裁剪
pub(crate) fn list_book_sources(app: &AppHandle) -> Result<Vec<BookSource>, String> {
    let dir = ensure_sources_dir(app)?;
    let mut sources = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取书源目录失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(source) = serde_json::from_str::<BookSource>(&text) {
                sources.push(source);
            }
        }
    }
    sources.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    Ok(sources)
}

pub(crate) fn delete_book_source(app: &AppHandle, id: &str) -> Result<(), String> {
    if !valid_component(id) {
        return Err("非法的书源 id".to_string());
    }
    let dir = ensure_sources_dir(app)?;
    let path = dir.join(format!("{id}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除书源失败: {e}"))?;
    }
    // 顺带清掉该书源保存的网页登录 Cookie（独立文件，见 webview_login.rs）
    remove_source_login_cookie(app, id)?;
    Ok(())
}

/// 清除全部书源上指向该分组的归属（书源分组被删除时调用），返回受影响的书源数量。
/// 组清单存在前端偏好里，源文件里的 `groupId` 必须在删组时一并清掉，
/// 否则会留下指向已删分组的悬空引用。整批改写都在 Rust 侧完成，不走 IPC 往返。
pub(crate) fn clear_book_source_group(app: &AppHandle, group_id: &str) -> Result<u64, String> {
    let dir = ensure_sources_dir(app)?;
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取书源目录失败: {e}"))?;
    let mut cleared = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(mut source) = serde_json::from_str::<BookSource>(&text) else {
            continue;
        };
        if source.group_id.as_deref() != Some(group_id) {
            continue;
        }
        source.group_id = None;
        let text =
            serde_json::to_string_pretty(&source).map_err(|e| format!("序列化书源失败: {e}"))?;
        fs::write(&path, text).map_err(|e| format!("写入书源失败: {e}"))?;
        cleared += 1;
    }
    Ok(cleared)
}

// ---------------------------------------------------------------------------
// 书源网页登录 Cookie：<appData>/source_sessions/<id>.json
// 与书源 JSON 分开放，避免把用户私人 Cookie 带进书源导出/导入。
// ---------------------------------------------------------------------------

fn ensure_sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_root(app)?.join("source_sessions");
    ensure_dir(&dir)?;
    Ok(dir)
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SourceLoginCookie {
    /// 捕获时的最终 URL（信息用途）
    url: String,
    /// Cookie 文本（`k=v; k2=v2`，含 httpOnly），注入书源会话时整行使用
    cookie: String,
    updated_at: u64,
}

/// 读取书源已保存的网页登录 Cookie；没有返回 Ok(None)。
pub(crate) fn read_source_login_cookie(
    app: &AppHandle,
    id: &str,
) -> Result<Option<String>, String> {
    if !valid_component(id) {
        return Err("非法的书源 id".to_string());
    }
    let path = ensure_sessions_dir(app)?.join(format!("{id}.json"));
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取登录 Cookie 失败: {e}"))?;
    let data: SourceLoginCookie = serde_json::from_str(&text)
        .map_err(|e| format!("解析登录 Cookie 失败: {e}"))?;
    let cookie = data.cookie.trim().to_string();
    if cookie.is_empty() {
        return Ok(None);
    }
    Ok(Some(cookie))
}

/// 覆盖式保存书源最近一次网页登录捕获到的 Cookie。
pub(crate) fn write_source_login_cookie(
    app: &AppHandle,
    id: &str,
    url: &str,
    cookie: &str,
) -> Result<(), String> {
    if !valid_component(id) {
        return Err("非法的书源 id".to_string());
    }
    let dir = ensure_sessions_dir(app)?;
    let path = dir.join(format!("{id}.json"));
    let data = SourceLoginCookie {
        url: url.trim().to_string(),
        cookie: cookie.trim().to_string(),
        updated_at: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };
    let text = serde_json::to_string(&data).map_err(|e| format!("序列化登录 Cookie 失败: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("写入登录 Cookie 失败: {e}"))
}

/// 删除书源保存的登录 Cookie（存在与否均 Ok）。
pub(crate) fn remove_source_login_cookie(app: &AppHandle, id: &str) -> Result<(), String> {
    if !valid_component(id) {
        return Err("非法的书源 id".to_string());
    }
    let dir = ensure_sessions_dir(app)?;
    let path = dir.join(format!("{id}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除登录 Cookie 失败: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ChapterBlock, LocalBookChapter};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("readerx-storage-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn sample_book() -> LocalBook {
        LocalBook {
            id: "book-1".to_string(),
            title: "书".to_string(),
            author: "作者".to_string(),
            intro: None,
            format: "online".to_string(),
            file_name: "book".to_string(),
            size: 0,
            imported_at: 0,
            hue: 0,
            split_desc: "在线书".to_string(),
            cover: None,
            chapters: vec![LocalBookChapter {
                cid: "c0001".to_string(),
                title: "第一章".to_string(),
                paragraphs: vec!["正文".to_string()],
                blocks: Some(vec![
                    ChapterBlock {
                        kind: "p".to_string(),
                        text: Some("正文".to_string()),
                        level: None,
                        src: None,
                        alt: None,
                        remote: None,
                        local: None,
                    },
                    ChapterBlock {
                        kind: "img".to_string(),
                        text: None,
                        level: None,
                        src: Some("https://img/1.png".to_string()),
                        alt: None,
                        remote: Some("https://img/1.png".to_string()),
                        local: Some("book-1_abc.png".to_string()),
                    },
                ]),
                url: Some("https://example.com/1".to_string()),
            }],
            group_id: None,
            source: Some("online".to_string()),
            book_source_id: Some("src-1".to_string()),
            book_url: None,
            tags: None,
        }
    }

    /// 整书写盘 / 读回必须保住图片引用字段（早期 Rust 模型缺 remote，回写会把它们丢掉）
    #[test]
    fn book_round_trip_keeps_image_refs() {
        let dir = temp_dir("round-trip");
        let book = sample_book();
        write_book_file(&dir, &book.id, &book).expect("write");
        let back = read_book_file(&dir.join("book-1.json")).expect("read");
        let block = &back.chapters[0].blocks.as_ref().unwrap()[1];
        assert_eq!(block.remote.as_deref(), Some("https://img/1.png"));
        assert_eq!(block.local.as_deref(), Some("book-1_abc.png"));
        assert_eq!(block.src.as_deref(), Some("https://img/1.png"));
        // 原子写：不留下临时文件
        assert!(!dir.join("book-1.json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 启动扫描：图片载荷（旧数据的 data URL）不参与解析，只按正文算字数
    #[test]
    fn meta_scan_skips_image_payloads() {
        let json = r#"{
            "id":"b1","title":"t","author":"a","format":"online","fileName":"f",
            "size":0,"importedAt":1,"hue":0,"splitDesc":"在线书",
            "bookSourceId":"src-1","source":"online",
            "chapters":[{
                "cid":"c0001","title":"第一章","url":"https://example.com/1",
                "paragraphs":["旧段落"],
                "blocks":[
                    {"kind":"p","text":"正文"},
                    {"kind":"img","src":"data:image/png;base64,AAAAAAAA","remote":"https://img/1.png"},
                    {"kind":"h","level":3,"text":"小标题"}
                ]
            }]
        }"#;
        let scan: BookScan = serde_json::from_str(json).expect("parse");
        let head = scan_chapter_head(scan.chapters.into_iter().next().expect("chapter"));
        assert_eq!(head.cid, "c0001");
        assert_eq!(head.url.as_deref(), Some("https://example.com/1"));
        assert_eq!(head.chars, "正文小标题".encode_utf16().count() as u64);
    }

    /// 没有结构化 blocks 的旧章节：回退到段落字数（与前端 chapterMirrorCharsOf 同口径）
    #[test]
    fn meta_scan_falls_back_to_paragraphs() {
        let json = r#"{
            "id":"b1","title":"t","author":"a","format":"txt","fileName":"f",
            "size":0,"importedAt":1,"hue":0,"splitDesc":"按字数分章",
            "chapters":[{"cid":"c0001","title":"第一章","paragraphs":["中文","abcd"]}]
        }"#;
        let scan: BookScan = serde_json::from_str(json).expect("parse");
        let head = scan_chapter_head(scan.chapters.into_iter().next().expect("chapter"));
        assert_eq!(head.chars, 6);
    }
}

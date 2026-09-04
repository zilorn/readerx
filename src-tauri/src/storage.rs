//! 持久化层。
//! - 偏好 / 书架 / 分章规则等状态按 key 存为 JSON 文件；
//! - 本地书籍按 id 存为独立 JSON 文件。
//! 全部为同步磁盘 I/O，仅对 `commands` 暴露；WebView 侧只通过 command 访问。

use crate::models::{BookSource, LocalBook, TtsCacheStat};
use serde_json::Value;
use std::fs;
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

pub(crate) fn put_book(app: &AppHandle, book: &LocalBook) -> Result<(), String> {
    if !valid_component(&book.id) {
        return Err("非法的书籍 id".to_string());
    }
    let dir = ensure_books_dir(app)?;
    let path = dir.join(format!("{}.json", book.id));
    let text = serde_json::to_string(book).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("写入书籍失败: {e}"))
}

pub(crate) fn list_books(app: &AppHandle) -> Result<Vec<LocalBook>, String> {
    let dir = ensure_books_dir(app)?;
    let mut books = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取书库失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(book) = serde_json::from_str::<LocalBook>(&text) {
                books.push(book);
            }
        }
    }
    books.sort_by_key(|book| std::cmp::Reverse(book.imported_at));
    Ok(books)
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

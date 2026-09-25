//! 持久化层（App 侧）：偏好 / 书架 / 分章规则等状态、听书缓存、以及应用数据根目录。
//!
//! - 状态按 key 存为 JSON 文件（`state/<key>.json`）；
//! - **本地书籍**按 `books/<id>/` 目录存（元信息 / 正文 / 书签分文件，见 `book_store.rs`）；
//! - **书源与书源登录态**由 `readerx-source` crate 实现（见文件末尾的转发段）。
//!
//! 全部为同步磁盘 I/O，仅对 `commands` 暴露；WebView 侧只通过 command 访问。

use crate::models::{BookSource, TtsCacheStat};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::{AppHandle, Manager};

/// 应用数据根目录（书籍 / 状态 / 听书缓存 / 书源共用的那一层）
pub(crate) fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    Ok(dir)
}

pub(crate) fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))
}

/// 状态文件目录（`state/`，不存在时创建）
pub(crate) fn state_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_root(app)?.join("state");
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

pub(crate) fn valid_component(name: &str) -> bool {
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
    let path = state_dir(app)?.join(format!("{key}.json"));
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
    let path = state_dir(app)?.join(format!("{key}.json"));
    let text = serde_json::to_string_pretty(value).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("写入状态失败: {e}"))
}

pub(crate) fn remove_state(app: &AppHandle, key: &str) -> Result<(), String> {
    if !valid_state_key(key) {
        return Err("非法的状态 key".to_string());
    }
    let path = state_dir(app)?.join(format!("{key}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除状态失败: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 听书音频缓存：按书籍独立目录存放（每句一个文件 + .mime 元数据）。
// WebView 不落盘：全部经 command 读写；文件数超上限时按修改时间淘汰最旧。
// 上限是**每本书**的条目数，用户可在「设置 → 数据 → 管理听书缓存」里调整
// （`readerx.ttsCacheLimit`，0 = 不限）。
// ---------------------------------------------------------------------------

/// 每本书最多保留的音频条目数的默认值（未设置偏好时用它）
pub(crate) const TTS_CACHE_LIMIT_DEFAULT: u64 = 1500;
/// 上限：再大就没有「上限」的意义了，同时避免误配置吃掉整块磁盘
pub(crate) const TTS_CACHE_LIMIT_MAX: u64 = 200_000;
/// 用户偏好 key（与 `readerx.onlineConcurrency` 同口径：Rust 侧直接读这个文件）
const TTS_CACHE_LIMIT_KEY: &str = "readerx.ttsCacheLimit";
/// 「不限」在偏好里的取值（JSON 数字 0）；对外部传入的非法值一律回落到默认值
const TTS_CACHE_LIMIT_UNLIMITED: u64 = 0;

fn valid_audio_key(key: &str) -> bool {
    // 不含 `.`：音频文件与它的 `.mime` 元数据靠 `with_extension` 互相推导，
    // key 里出现点会让 `a.b` 的元数据被当成 `a.mime`（见 prune_tts_cache_files）。
    !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// 归一化偏好里的上限：非法 / 缺失 → 默认值；0 表示不限；其余截断到 [1, MAX]。
pub(crate) fn normalize_tts_cache_limit(raw: Option<u64>) -> u64 {
    match raw {
        None => TTS_CACHE_LIMIT_DEFAULT,
        Some(TTS_CACHE_LIMIT_UNLIMITED) => TTS_CACHE_LIMIT_UNLIMITED,
        Some(v) => v.min(TTS_CACHE_LIMIT_MAX),
    }
}

/// 生效的每本书音频条目上限（0 = 不限）。读不到偏好时用默认值。
/// 写入与「改设置后立即收敛」两处共用，保证两边的上限口径一致。
pub(crate) fn tts_cache_limit(app: &AppHandle) -> u64 {
    let raw = read_state(app, TTS_CACHE_LIMIT_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.as_u64());
    normalize_tts_cache_limit(raw)
}

fn tts_cache_dir(app: &AppHandle, book_id: &str) -> Result<PathBuf, String> {
    if !valid_component(book_id) {
        return Err("非法的书籍 id".to_string());
    }
    Ok(data_root(app)?.join("tts-audio").join(book_id))
}

/// 删除某本书的听书音频缓存目录（不存在也不报错）。删书时随书一起清理。
pub(crate) fn remove_book_tts_cache(app: &AppHandle, book_id: &str) -> Result<(), String> {
    let dir = tts_cache_dir(app, book_id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("清理听书缓存失败: {e}"))?;
    }
    Ok(())
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
    prune_tts_cache(&dir, tts_cache_limit(app));
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

/// 淘汰最旧的音频文件（保留 .mime 不参与计数；删除时连同元数据一起删）。
/// `limit` 为 0 表示不限，直接返回。
fn prune_tts_cache(dir: &Path, limit: u64) {
    if limit == TTS_CACHE_LIMIT_UNLIMITED {
        return;
    }
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
    prune_tts_cache_files(select_tts_cache_evictions(audios, limit));
}

/// 删除淘汰出来的音频文件，并连带删除同名 `.mime` 元数据。
/// key 不含点（见 `valid_audio_key`），所以 `with_extension` 能正确指向元数据。
fn prune_tts_cache_files(evicted: Vec<PathBuf>) {
    if evicted.is_empty() {
        return;
    }
    // 「整本预热完，前面章节的音频却被静默淘汰」曾经是个查不出来的问题：
    // 淘汰必须留痕，出问题时能对上「额度 / 实际句数」
    log::debug!("听书缓存淘汰 n={}", evicted.len());
    for path in evicted {
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("mime"));
    }
}

/// 淘汰决策的纯函数部分（便于单测）：按修改时间从旧到新，返回需要删除的路径。
/// 调用方负责真正删盘。
fn select_tts_cache_evictions(
    mut audios: Vec<(SystemTime, PathBuf)>,
    limit: u64,
) -> Vec<PathBuf> {
    if limit == TTS_CACHE_LIMIT_UNLIMITED || audios.len() as u64 <= limit {
        return Vec::new();
    }
    audios.sort_by_key(|(t, _)| *t);
    let excess = audios.len() as u64 - limit;
    audios.into_iter().take(excess as usize).map(|(_, path)| path).collect()
}

/// 按当前偏好上限收敛**全部**书籍的听书缓存（改设置后立即生效，不必等下一次写入）。
pub(crate) fn apply_tts_cache_limit(app: &AppHandle) -> Result<(), String> {
    let limit = tts_cache_limit(app);
    let root = data_root(app)?.join("tts-audio");
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&root).map_err(|e| format!("读取听书缓存目录失败: {e}"))?.flatten() {
        let dir_path = entry.path();
        if dir_path.is_dir() {
            prune_tts_cache(&dir_path, limit);
        }
    }
    Ok(())
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
    match book_id {
        Some(id) => log::info!("已清除听书缓存 book={id}"),
        None => log::info!("已清除全部听书缓存"),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 书源 / 书源登录态：实现在书源引擎 crate（readerx-source::store）
// ---------------------------------------------------------------------------
//
// 目录与文件格式由核心 crate 定义，App 与独立二进制（readerx-source CLI）共用同一份：
//   <appData>/book_sources/<id>.json      书源定义（BookSource）
//   <appData>/source_sessions/<id>.json   { url, cookie, updated_at }
//
// 这里只做一层薄转发：命令层签名不变，书源读写的唯一实现在核心 crate，
// 避免 App 与 CLI 各写一套格式而互相读不懂。

pub(crate) fn put_book_source(_app: &AppHandle, source: &BookSource) -> Result<(), String> {
    readerx_source::store::put_source(source)
}

/// 读取单个书源；不存在返回 Ok(None)
pub(crate) fn get_book_source(_app: &AppHandle, id: &str) -> Result<Option<BookSource>, String> {
    readerx_source::store::get_source(id)
}

/// 列出全部书源（含 js，供引擎使用）；调用方需要摘要时再裁剪
pub(crate) fn list_book_sources(_app: &AppHandle) -> Result<Vec<BookSource>, String> {
    readerx_source::store::list_sources()
}

pub(crate) fn delete_book_source(app: &AppHandle, id: &str) -> Result<(), String> {
    if !valid_component(id) {
        return Err("非法的书源 id".to_string());
    }
    readerx_source::store::delete_source(id)?;
    // 顺带清掉该书源保存的网页登录 Cookie（独立文件，见 webview_login.rs）
    remove_source_login_cookie(app, id)?;
    Ok(())
}

/// 清除全部书源上指向该分组的归属（书源分组被删除时调用），返回受影响的书源数量。
/// 组清单存在前端偏好里，源文件里的 `groupId` 必须在删组时一并清掉，
/// 否则会留下指向已删分组的悬空引用。整批改写都在 Rust 侧完成，不走 IPC 往返。
pub(crate) fn clear_book_source_group(_app: &AppHandle, group_id: &str) -> Result<u64, String> {
    let mut cleared = 0u64;
    for mut source in readerx_source::store::list_sources()? {
        if source.group_id.as_deref() != Some(group_id) {
            continue;
        }
        source.group_id = None;
        readerx_source::store::put_source(&source)?;
        cleared += 1;
    }
    Ok(cleared)
}

/// 读取书源已保存的网页登录 Cookie；没有返回 Ok(None)。
pub(crate) fn read_source_login_cookie(
    _app: &AppHandle,
    id: &str,
) -> Result<Option<String>, String> {
    readerx_source::store::read_login_cookie(id)
}

/// 覆盖式保存书源最近一次网页登录捕获到的 Cookie。
/// 覆盖式写入某书源的登录 Cookie（独立文件，与书源 JSON 分离）。
/// 当前写入由 `readerx_source::auth::persist_login_outcome` 统一完成（App 与 CLI 共用），
/// 这里保留同一入口供后续需要直接落盘的调用方使用，避免两处各写一套格式。
#[allow(dead_code)]
pub(crate) fn write_source_login_cookie(
    _app: &AppHandle,
    id: &str,
    url: &str,
    cookie: &str,
) -> Result<(), String> {
    readerx_source::store::write_login_cookie(id, url, cookie)
}

/// 删除书源保存的登录态（Cookie + 存储快照一并清掉；存在与否均 Ok）。
pub(crate) fn remove_source_login_cookie(_app: &AppHandle, id: &str) -> Result<(), String> {
    readerx_source::store::remove_login_cookie(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// 造 n 个条目，修改时间从旧到新递增（下标越大越新）
    fn audios(n: usize) -> Vec<(SystemTime, PathBuf)> {
        let base = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        (0..n)
            .map(|i| {
                (
                    base + Duration::from_secs(i as u64),
                    PathBuf::from(format!("/tmp/tts-audio/book/{i:04}")),
                )
            })
            .collect()
    }

    fn evicted_names(n: usize, limit: u64) -> Vec<String> {
        select_tts_cache_evictions(audios(n), limit)
            .into_iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn keeps_everything_under_limit() {
        assert!(evicted_names(10, 1500).is_empty());
        assert!(evicted_names(10, 10).is_empty());
    }

    #[test]
    fn evicts_oldest_first_and_only_the_excess() {
        // 12 条、上限 10 → 只淘汰最旧的 2 条，且顺序是从旧到新
        assert_eq!(
            evicted_names(12, 10),
            vec!["0000".to_string(), "0001".to_string()]
        );
    }

    #[test]
    fn limit_zero_means_unlimited() {
        assert!(evicted_names(5_000, TTS_CACHE_LIMIT_UNLIMITED).is_empty());
    }

    #[test]
    fn eviction_targets_the_mime_metadata_when_deleting() {
        // `with_extension` 必须落在 `<key>.mime` 上（前提：key 本身不含点）
        let audio = PathBuf::from("/tmp/tts-audio/book/00ab12cd");
        assert_eq!(
            audio.with_extension("mime"),
            PathBuf::from("/tmp/tts-audio/book/00ab12cd.mime")
        );
    }

    #[test]
    fn normalize_falls_back_to_default_and_clamps() {
        assert_eq!(normalize_tts_cache_limit(None), TTS_CACHE_LIMIT_DEFAULT);
        assert_eq!(normalize_tts_cache_limit(Some(3000)), 3000);
        assert_eq!(normalize_tts_cache_limit(Some(0)), TTS_CACHE_LIMIT_UNLIMITED);
        assert_eq!(
            normalize_tts_cache_limit(Some(TTS_CACHE_LIMIT_MAX + 1)),
            TTS_CACHE_LIMIT_MAX
        );
    }

    #[test]
    fn audio_key_rejects_dots() {
        // 含点的 key 会破坏 `.mime` 的推导，必须拒绝
        assert!(valid_audio_key("00ab12cd"));
        assert!(valid_audio_key("a-b_c9"));
        assert!(!valid_audio_key("a.b"));
        assert!(!valid_audio_key(""));
    }
}

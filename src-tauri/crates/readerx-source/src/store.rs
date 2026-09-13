//! 书源持久化：书源 JSON 与「每源登录 Cookie」。
//!
//! **格式与 App 完全一致**（同一份数据目录可被 App 与 CLI 交替读写）：
//!
//! ```text
//! <data_root>/book_sources/<id>.json     书源定义（BookSource）
//! <data_root>/source_sessions/<id>.json  { url, cookie, updated_at }
//! ```
//!
//! 数据根由宿主决定：App 在启动时用 Tauri 的应用数据目录调用 [`init_data_root`]，
//! 独立二进制用 `--data-dir` / `$READERX_SOURCE_HOME`（见 [`crate::default_data_root`]）。

use crate::models::BookSource;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

static DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// 设置数据根（进程内一次；重复调用忽略后续值并返回首次设定的路径）。
pub fn init_data_root(root: impl Into<PathBuf>) -> &'static Path {
    let _ = DATA_ROOT.set(root.into());
    data_root()
}

/// 当前数据根（未设置时为 [`crate::default_data_root`]）。
pub fn data_root() -> &'static Path {
    DATA_ROOT.get_or_init(crate::default_data_root)
}

/// 组件名（书源 id）是否可安全用作文件名。
pub fn valid_component(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.len() <= 160
        && !name.contains(['/', '\\'])
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建目录 {} 失败: {e}", dir.display()))
}

/// 书源目录（`<data_root>/book_sources`；与 App 的历史目录名保持一致）
pub fn sources_dir() -> Result<PathBuf, String> {
    let dir = data_root().join("book_sources");
    ensure_dir(&dir)?;
    Ok(dir)
}

/// 登录 Cookie 目录（`<data_root>/source_sessions`）
pub fn sessions_dir() -> Result<PathBuf, String> {
    let dir = data_root().join("source_sessions");
    ensure_dir(&dir)?;
    Ok(dir)
}

fn source_path(id: &str) -> Result<PathBuf, String> {
    if !valid_component(id) {
        return Err("非法的书源 id".to_string());
    }
    Ok(sources_dir()?.join(format!("{id}.json")))
}

fn session_path(id: &str) -> Result<PathBuf, String> {
    if !valid_component(id) {
        return Err("非法的书源 id".to_string());
    }
    Ok(sessions_dir()?.join(format!("{id}.json")))
}

/// 原子写：同目录临时文件 + rename（避免写一半被中断留下坏 JSON）。
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入 {} 失败: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("替换 {} 失败: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// 书源定义
// ---------------------------------------------------------------------------

/// 保存（覆盖）一个书源
pub fn put_source(source: &BookSource) -> Result<(), String> {
    if source.id.trim().is_empty() {
        return Err("书源 id 不能为空".to_string());
    }
    let text =
        serde_json::to_string_pretty(source).map_err(|e| format!("序列化书源失败: {e}"))?;
    write_atomic(&source_path(&source.id)?, &text)
}

/// 读取一个书源（不存在返回 Ok(None)）
pub fn get_source(id: &str) -> Result<Option<BookSource>, String> {
    let path = source_path(id)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取书源失败: {e}"))?;
    let source = serde_json::from_str(&text).map_err(|e| format!("解析书源失败: {e}"))?;
    Ok(Some(source))
}

/// 删除一个书源（不存在也 Ok）
pub fn delete_source(id: &str) -> Result<(), String> {
    let path = source_path(id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除书源失败: {e}"))?;
    }
    Ok(())
}

/// 列出全部书源（按文件名排序，解析失败的文件被跳过并返回告警）
pub fn list_sources() -> Result<Vec<BookSource>, String> {
    Ok(list_sources_with_warnings()?.0)
}

/// 无法解析的书源文件：`(文件名, 原因)`
pub type SourceFileWarning = (String, String);

/// 列出全部书源，同时返回解析失败的条目——CLI 需要把坏文件报出来，
/// 而不是安静地当作「没有这个书源」。
pub fn list_sources_with_warnings() -> Result<(Vec<BookSource>, Vec<SourceFileWarning>), String> {
    let dir = sources_dir()?;
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取书源目录失败: {e}"))?;
    let mut sources = Vec::new();
    let mut warnings = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|text| serde_json::from_str::<BookSource>(&text).map_err(|e| e.to_string()))
        {
            Ok(source) => sources.push(source),
            Err(err) => warnings.push((
                path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                err,
            )),
        }
    }
    sources.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    Ok((sources, warnings))
}

/// 按 id / 名称模糊匹配挑选书源：
/// - `selector` 命中 id 或名称（精确，忽略大小写）优先；
/// - 否则取名称包含该串的唯一结果；多条候选返回候选清单作为错误。
pub fn resolve_source(selector: &str) -> Result<BookSource, String> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err("书源选择器不能为空".to_string());
    }
    let sources = list_sources()?;
    if let Some(found) = sources.iter().find(|s| s.id == selector) {
        return Ok(found.clone());
    }
    let lower = selector.to_lowercase();
    if let Some(found) = sources
        .iter()
        .find(|s| s.name.to_lowercase() == lower || s.id.to_lowercase() == lower)
    {
        return Ok(found.clone());
    }
    let hits: Vec<&BookSource> = sources
        .iter()
        .filter(|s| s.name.to_lowercase().contains(&lower))
        .collect();
    match hits.len() {
        0 => Err(format!("未找到书源「{selector}」（共 {} 个已安装书源）", sources.len())),
        1 => Ok(hits[0].clone()),
        _ => {
            let names: Vec<String> = hits
                .iter()
                .map(|s| format!("{} [{}]", s.name, s.id))
                .collect();
            Err(format!(
                "书源「{selector}」匹配到多个，请用 id 精确指定：{}",
                names.join("、")
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// 每源登录 Cookie（网页登录 / 自动认证的产物）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct SourceLoginCookie {
    /// 捕获时的最终 URL（信息用途）
    url: String,
    /// Cookie 文本（`k=v; k2=v2`，含 httpOnly），注入书源会话时整行使用
    cookie: String,
    updated_at: u64,
}

/// 读取书源已保存的登录 Cookie；没有返回 Ok(None)。
pub fn read_login_cookie(id: &str) -> Result<Option<String>, String> {
    let path = session_path(id)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取登录 Cookie 失败: {e}"))?;
    let data: SourceLoginCookie =
        serde_json::from_str(&text).map_err(|e| format!("解析登录 Cookie 失败: {e}"))?;
    let cookie = data.cookie.trim().to_string();
    if cookie.is_empty() {
        return Ok(None);
    }
    Ok(Some(cookie))
}

/// 覆盖式保存书源最近一次认证捕获到的 Cookie。
pub fn write_login_cookie(id: &str, url: &str, cookie: &str) -> Result<(), String> {
    let data = SourceLoginCookie {
        url: url.trim().to_string(),
        cookie: cookie.trim().to_string(),
        updated_at: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };
    let text = serde_json::to_string(&data).map_err(|e| format!("序列化登录 Cookie 失败: {e}"))?;
    write_atomic(&session_path(id)?, &text)
}

/// 删除书源保存的登录 Cookie（存在与否均 Ok）。
pub fn remove_login_cookie(id: &str) -> Result<(), String> {
    let path = session_path(id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除登录 Cookie 失败: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::BookSourceCapabilities;

    fn sample_source(id: &str, name: &str) -> BookSource {
        BookSource {
            schema_version: 1,
            id: id.to_string(),
            name: name.to_string(),
            book_source_url: String::new(),
            author: String::new(),
            version: String::new(),
            comment: String::new(),
            enabled: true,
            capabilities: BookSourceCapabilities::default(),
            auto_auth: true,
            group_id: None,
            user_agent: String::new(),
            headers: Default::default(),
            update_time: 0,
            js: "function searchBook() { return []; }".to_string(),
        }
    }

    #[test]
    fn component_guard_rejects_traversal() {
        assert!(valid_component("abc-1_2.3"));
        assert!(!valid_component("../etc/passwd"));
        assert!(!valid_component("a/b"));
        assert!(!valid_component(""));
    }

    #[test]
    fn source_roundtrip_and_resolve() {
        let dir = std::env::temp_dir().join(format!("readerx-store-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        init_data_root(&dir);
        put_source(&sample_source("demo-1", "示例书源")).unwrap();
        let got = get_source("demo-1").unwrap().unwrap();
        assert_eq!(got.name, "示例书源");
        assert_eq!(resolve_source("示例").unwrap().id, "demo-1");
        assert_eq!(resolve_source("demo-1").unwrap().id, "demo-1");
        assert!(resolve_source("不存在").is_err());

        write_login_cookie("demo-1", "https://example.com", "a=1; b=2").unwrap();
        assert_eq!(
            read_login_cookie("demo-1").unwrap().as_deref(),
            Some("a=1; b=2")
        );
        remove_login_cookie("demo-1").unwrap();
        assert!(read_login_cookie("demo-1").unwrap().is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}

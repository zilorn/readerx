//! 书源持久化：书源 JSON 与「每源登录态」。
//!
//! **格式与 App 完全一致**（同一份数据目录可被 App 与 CLI 交替读写）：
//!
//! ```text
//! <data_root>/book_sources/<id>.json     书源定义（BookSource）
//! <data_root>/source_sessions/<id>.json  登录态（见下）
//! ```
//!
//! 登录态文件是**增量扩展**的（旧版本只写 `url` / `cookie` / `updated_at`，
//! 现在多一个可选的 `storage` 快照；缺字段一律按默认值读，文件格式没有版本号，
//! 因为所有新增字段都是可选的、旧读者会忽略它们）：
//!
//! ```json
//! {
//!   "url": "https://example.com/login",
//!   "cookie": "sid=…",
//!   "updated_at": 1730000000000,
//!   "storage": { "version": 1, "updatedAt": 1730000000000, "origins": [ … ] }
//! }
//! ```
//!
//! 数据根由宿主决定：App 在启动时用 Tauri 的应用数据目录调用 [`init_data_root`]，
//! 独立二进制用 `--data-dir` / `$READERX_SOURCE_HOME`（见 [`crate::default_data_root`]）。

use crate::models::BookSource;
use crate::storage::StorageSnapshot;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

static DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// 设置数据根（进程内一次；重复调用忽略后续值并返回首次设定的路径）。
pub fn init_data_root(root: impl Into<PathBuf>) -> &'static Path {
    // 只有真正生效的那一次才记：宿主可能先后调用多次（App 启动 + 命令层），
    // 重复刷屏会把「数据目录到底是哪个」这条关键信息淹掉
    if DATA_ROOT.set(root.into()).is_ok() {
        log::info!("书源数据根已初始化 path={}", data_root().display());
    }
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
    let path = source_path(&source.id)?;
    write_atomic(&path, &text)?;
    log::debug!(
        "书源已写入 id={} file={} bytes={}",
        source.id,
        path.display(),
        text.len()
    );
    Ok(())
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
        log::debug!("书源已删除 id={id} file={}", path.display());
    } else {
        log::debug!("书源无需删除（文件不存在） id={id} file={}", path.display());
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
            Err(err) => {
                // 坏文件不能静默：CLI 会把告警打给用户，日志里也留一份（事后排障只认日志）
                log::warn!("书源文件解析失败 file={} reason={err}", path.display());
                warnings.push((
                    path.file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    err,
                ))
            }
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
// 每源登录态（网页登录 / 自动认证的产物：Cookie + 非 Cookie 存储快照）
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Serialize, Deserialize)]
struct SourceLoginState {
    /// 捕获时的最终 URL（兼作 `webview.storage()` 判定主 origin 的依据）
    #[serde(default)]
    url: String,
    /// Cookie 文本（`k=v; k2=v2`，含 httpOnly），注入书源会话时整行使用
    #[serde(default)]
    cookie: String,
    updated_at: u64,
    /// 非 Cookie 登录信息（localStorage / sessionStorage / IndexedDB 快照）。
    /// 旧文件没有这一项 —— 缺省即「没有快照」，不是解析错误。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    storage: Option<StorageSnapshot>,
}

/// 读出来的登录态：Cookie / 登录地址 / 存储快照（三者都可缺）
#[derive(Debug, Clone, Default)]
pub struct LoginState {
    /// 整行 Cookie（含 httpOnly）
    pub cookie: Option<String>,
    /// 捕获时的最终地址（空 = 文件里没记）
    pub url: String,
    /// localStorage / sessionStorage / IndexedDB 快照（空 = 没采到）
    pub storage: Option<StorageSnapshot>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 整行 Cookie 的条数（`k=v; k2=v2` → 2）。**只用于日志**：Cookie 值本身绝不进日志。
fn cookie_pairs(cookie: &str) -> usize {
    cookie
        .split(';')
        .filter(|part| !part.trim().is_empty())
        .count()
}

fn read_login_state(id: &str) -> Result<Option<SourceLoginState>, String> {
    let path = session_path(id)?;
    if !path.exists() {
        log::debug!("读取登录态：文件不存在 id={id} file={}", path.display());
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取登录态失败: {e}"))?;
    let state: SourceLoginState =
        serde_json::from_str(&text).map_err(|e| format!("解析登录态失败: {e}"))?;
    // 只记条数与文件名：Cookie 值与存储快照内容都不写
    log::debug!(
        "读取登录态 id={id} file={} cookie={} storage_origins={}",
        path.display(),
        cookie_pairs(&state.cookie),
        state.storage.as_ref().map(|s| s.origins.len()).unwrap_or(0)
    );
    Ok(Some(state))
}

fn write_login_state(id: &str, state: &SourceLoginState) -> Result<(), String> {
    let text = serde_json::to_string_pretty(state).map_err(|e| format!("序列化登录态失败: {e}"))?;
    let path = session_path(id)?;
    match write_atomic(&path, &text) {
        Ok(()) => {
            // 只记条数与体积：登录态内容绝不进日志
            log::debug!(
                "登录态已写入 id={id} file={} cookie={} storage_origins={} bytes={}",
                path.display(),
                cookie_pairs(&state.cookie),
                state.storage.as_ref().map(|s| s.origins.len()).unwrap_or(0),
                text.len()
            );
            Ok(())
        }
        Err(err) => {
            // 写盘失败直接决定「重启后登录还在不在」，必须留痕（错误仍原样返回给调用方）
            log::warn!(
                "登录态写入失败 id={id} file={} reason={err}",
                path.display()
            );
            Err(err)
        }
    }
}

/// 读取书源已保存的登录 Cookie；没有返回 Ok(None)。
pub fn read_login_cookie(id: &str) -> Result<Option<String>, String> {
    let Some(state) = read_login_state(id)? else {
        return Ok(None);
    };
    let cookie = state.cookie.trim().to_string();
    if cookie.is_empty() {
        return Ok(None);
    }
    Ok(Some(cookie))
}

/// 已保存的登录态（Cookie + 登录地址 + 存储快照）；文件不存在或三者全空时返回 None。
///
/// 三个认证后端与引擎启动注入都从这一个入口读，避免各自拼一遍文件格式。
pub fn read_login_session(id: &str) -> Result<Option<LoginState>, String> {
    let Some(state) = read_login_state(id)? else {
        return Ok(None);
    };
    let cookie = state.cookie.trim().to_string();
    let storage = state.storage.filter(|snapshot| !snapshot.is_empty());
    if cookie.is_empty() && storage.is_none() {
        return Ok(None);
    }
    Ok(Some(LoginState {
        cookie: (!cookie.is_empty()).then_some(cookie),
        url: state.url.trim().to_string(),
        storage,
    }))
}

/// 覆盖式写入登录态。`storage` 为 `None` 表示**不动**已保存的快照。
///
/// 为什么区分「不动」与「清空」：Cookie-only 的认证方式（`auth cookie` 手工导入）不该
/// 顺手抹掉上一次浏览器登录抓到的 localStorage 快照 —— 两者是互补的登录信息。
pub fn write_login_session(
    id: &str,
    url: &str,
    cookie: &str,
    storage: Option<StorageSnapshot>,
) -> Result<(), String> {
    let previous = read_login_state(id)?;
    let previous_url = previous
        .as_ref()
        .map(|state| state.url.trim().to_string())
        .unwrap_or_default();
    let storage = match storage {
        Some(mut snapshot) => {
            snapshot.updated_at = now_millis();
            snapshot.normalize();
            if snapshot.is_empty() {
                previous.and_then(|state| state.storage)
            } else {
                Some(snapshot)
            }
        }
        None => previous.and_then(|state| state.storage),
    };
    let trimmed_url = url.trim();
    let state = SourceLoginState {
        url: if trimmed_url.is_empty() {
            previous_url
        } else {
            trimmed_url.to_string()
        },
        cookie: cookie.trim().to_string(),
        updated_at: now_millis(),
        storage,
    };
    write_login_state(id, &state)
}

/// 只更新存储快照（保留已保存的 Cookie 与登录地址）。
pub fn write_login_storage(id: &str, storage: &StorageSnapshot) -> Result<(), String> {
    let previous = read_login_state(id)?.unwrap_or_default();
    let mut snapshot = storage.clone();
    snapshot.updated_at = now_millis();
    snapshot.normalize();
    let state = SourceLoginState {
        url: previous.url,
        cookie: previous.cookie,
        updated_at: now_millis(),
        storage: if snapshot.is_empty() {
            previous.storage
        } else {
            Some(snapshot)
        },
    };
    write_login_state(id, &state)
}

/// 覆盖式保存书源最近一次认证捕获到的 Cookie（保留已保存的存储快照）。
pub fn write_login_cookie(id: &str, url: &str, cookie: &str) -> Result<(), String> {
    write_login_session(id, url, cookie, None)
}

/// 读取已保存的存储快照（没有返回 Ok(None)）。
pub fn read_login_storage(id: &str) -> Result<Option<StorageSnapshot>, String> {
    Ok(read_login_session(id)?.and_then(|state| state.storage))
}

/// 删除书源保存的登录态（Cookie 与存储快照一并清掉；存在与否均 Ok）。
pub fn remove_login_cookie(id: &str) -> Result<(), String> {
    let path = session_path(id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除登录态失败: {e}"))?;
        log::debug!("登录态已删除 id={id} file={}", path.display());
    } else {
        log::debug!(
            "登录态无需删除（文件不存在） id={id} file={}",
            path.display()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::BookSourceCapabilities;
    use crate::storage::{StorageEntry, StorageOrigin};

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

    /// 测试用的数据根 + 串行锁。
    ///
    /// `init_data_root` 是进程内一次的 `OnceLock`，所以三个测试只能共用同一个目录；而测试默认
    /// 并行执行，`list_sources` 之类的「读整个目录」会被别的测试写一半的文件干扰（曾偶发
    /// 「共 0 个已安装书源」）。这里用一把锁把整个测试体串起来，各测试再用自己独有的书源 id。
    fn test_root() -> (&'static Path, std::sync::MutexGuard<'static, ()>) {
        static ROOT: OnceLock<PathBuf> = OnceLock::new();
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let dir = ROOT.get_or_init(|| {
            let dir =
                std::env::temp_dir().join(format!("readerx-store-tests-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            init_data_root(&dir);
            dir
        });
        let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        (dir.as_path(), guard)
    }

    fn sample_snapshot(value: &str) -> StorageSnapshot {
        StorageSnapshot {
            version: 1,
            updated_at: 0,
            origins: vec![StorageOrigin {
                origin: "https://example.com".to_string(),
                url: "https://example.com/home".to_string(),
                local_storage: vec![StorageEntry {
                    key: "token".to_string(),
                    value: value.to_string(),
                    truncated: false,
                }],
                session_storage: Vec::new(),
                indexed_db: Vec::new(),
            }],
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
        let (_dir, _serial) = test_root();
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
    }

    #[test]
    fn login_session_roundtrip_keeps_cookie_and_storage() {
        let (_dir, _serial) = test_root();
        put_source(&sample_source("demo-2", "登录态")).unwrap();

        write_login_session(
            "demo-2",
            "https://example.com/login",
            "sid=1",
            Some(sample_snapshot("t1")),
        )
        .unwrap();
        let state = read_login_session("demo-2").unwrap().unwrap();
        assert_eq!(state.cookie.as_deref(), Some("sid=1"));
        assert_eq!(state.url, "https://example.com/login");
        let storage = state.storage.unwrap();
        assert_eq!(storage.origins[0].local_storage[0].value, "t1");
        assert!(storage.updated_at > 0, "写入时应补上采集时间");

        // Cookie-only 更新（手工导入 Cookie）不得抹掉已抓到的存储快照
        write_login_cookie("demo-2", "https://example.com/login", "sid=2").unwrap();
        let state = read_login_session("demo-2").unwrap().unwrap();
        assert_eq!(state.cookie.as_deref(), Some("sid=2"));
        assert_eq!(
            state.storage.unwrap().origins[0].local_storage[0].value,
            "t1",
            "只更新 Cookie 时应保留既有存储快照"
        );

        // 只更新快照时，Cookie 与登录地址也要保留
        write_login_storage("demo-2", &sample_snapshot("t2")).unwrap();
        let state = read_login_session("demo-2").unwrap().unwrap();
        assert_eq!(state.cookie.as_deref(), Some("sid=2"));
        assert_eq!(state.url, "https://example.com/login");
        assert_eq!(state.storage.unwrap().origins[0].local_storage[0].value, "t2");

        remove_login_cookie("demo-2").unwrap();
        assert!(read_login_session("demo-2").unwrap().is_none());
    }

    /// 旧版本只写了 `{url, cookie, updated_at}`：新代码必须照常读出来（数据迁移）。
    #[test]
    fn legacy_session_file_without_storage_still_reads() {
        let (_dir, _serial) = test_root();
        put_source(&sample_source("demo-3", "旧文件")).unwrap();
        let path = sessions_dir().unwrap().join("demo-3.json");
        fs::write(
            &path,
            r#"{"url":"https://example.com","cookie":"sid=old","updated_at":1}"#,
        )
        .unwrap();
        let state = read_login_session("demo-3").unwrap().unwrap();
        assert_eq!(state.cookie.as_deref(), Some("sid=old"));
        assert_eq!(state.url, "https://example.com");
        assert!(state.storage.is_none());
        // 旧文件被新代码改写后仍是同一份语义
        write_login_cookie("demo-3", "https://example.com", "sid=new").unwrap();
        assert_eq!(
            read_login_cookie("demo-3").unwrap().as_deref(),
            Some("sid=new")
        );
    }
}

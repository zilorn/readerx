//! 网页登录 / Cloudflare 认证的宿主抽象。
//!
//! 引擎（[`crate::host`]）在两类场景需要「真实浏览器」：
//! 1. `http.*` 命中 Cloudflare 挑战页时自动认证并重试一次（受书源 `autoAuth` 约束）；
//! 2. 书源 JS 显式调用 `webview.login(url)`。
//!
//! 核心 crate 不依赖任何 GUI：它只调用这里注册的 [`AuthProvider`]。
//! - App（Tauri）注册的是 Android 原生 WebView 浮层（见 `src-tauri/src/webview_login.rs`）；
//! - 独立二进制注册的是 webkit2gtk 窗口或 Chrome DevTools Protocol 后端
//!   （见 [`crate::backend_webkit`] / [`crate::backend_cdp`]，由 CLI 装配）；
//! - 都没注册时，认证请求返回 `unsupported`，规则代码照常拿到原响应。

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, OnceLock};

/// 一次网页认证的结果（字段与 App 侧 Android 插件一致，便于共用编排代码）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginOutcome {
    pub ok: bool,
    /// 捕获 Cookie 时的最终地址（信息用途）
    #[serde(default)]
    pub url: String,
    /// Cookie 文本（`k=v; k2=v2`，可含 httpOnly），注入书源会话时整行使用
    #[serde(default)]
    pub cookies: String,
    /// Cookie 条数
    #[serde(default)]
    pub count: usize,
    /// 失败 / 取消原因（成功时可为空）
    #[serde(default)]
    pub message: String,
}

impl LoginOutcome {
    /// 成功结果
    pub fn success(url: impl Into<String>, cookies: impl Into<String>, count: usize) -> Self {
        Self {
            ok: true,
            url: url.into(),
            cookies: cookies.into(),
            count,
            message: String::new(),
        }
    }

    /// 失败 / 不支持结果（不抛错，交由规则代码自行降级）
    pub fn failure(url: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            url: url.into(),
            cookies: String::new(),
            count: 0,
            message: message.into(),
        }
    }
}

/// 认证后端：由宿主（App / CLI）实现并注册。
///
/// 实现必须是 `Send + Sync`：引擎在工作线程上调用它，而认证窗口属于主线程。
pub trait AuthProvider: Send + Sync {
    /// 当前环境是否支持认证（Android 插件已就绪 / 有可用的浏览器内核）。
    fn supported(&self) -> bool;

    /// 阻塞式执行一次认证：打开 `url` 让用户完成验证，返回捕获到的 Cookie。
    /// 失败 / 取消返回 `ok: false`，不返回 `Err`（`Err` 仅保留给后端自身不可用）。
    fn authenticate(&self, source_id: &str, url: &str) -> Result<LoginOutcome, String>;
}

static PROVIDER: OnceLock<Mutex<Option<Arc<dyn AuthProvider>>>> = OnceLock::new();

fn provider_slot() -> &'static Mutex<Option<Arc<dyn AuthProvider>>> {
    PROVIDER.get_or_init(Default::default)
}

/// 注册认证后端（进程内一次；重复注册覆盖旧的）。
pub fn install_provider(provider: Arc<dyn AuthProvider>) {
    *provider_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(provider);
}

/// 当前认证后端（未注册返回 None）。
pub fn provider() -> Option<Arc<dyn AuthProvider>> {
    provider_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// 当前环境是否支持网页认证。
pub fn is_supported() -> bool {
    provider().map(|p| p.supported()).unwrap_or(false)
}

/// 阻塞执行一次网页认证（引擎线程 / spawn_blocking 内使用）。
pub fn perform(source_id: &str, url: &str) -> Result<LoginOutcome, String> {
    let provider = provider().ok_or_else(|| "网页认证后端尚未初始化".to_string())?;
    if !provider.supported() {
        return Ok(LoginOutcome::failure(
            url,
            "当前环境不支持网页认证（独立二进制请用 --auth webkit 或 --auth cdp）",
        ));
    }
    provider.authenticate(source_id, url)
}

/// 把该书源已保存的登录 Cookie 注入会话（幂等；进程内只注入一次）。
///
/// App 与 CLI 每次执行书源函数前调用：重启后已保存的登录态（`source_sessions/<id>.json`）
/// 也会被注入本次进程的书源会话。返回是否本次真正注入了新 Cookie。
pub fn seed_source_session(source_id: &str) -> Result<bool, String> {
    if seeded(source_id) {
        return Ok(false);
    }
    let cookie = crate::store::read_login_cookie(source_id)?;
    // 无论有没有已存 Cookie 都标记，避免反复读盘
    mark_seeded(source_id);
    if let Some(cookie) = cookie {
        if !cookie.trim().is_empty() {
            crate::host::http_set_cookie(source_id, &cookie);
            return Ok(true);
        }
    }
    Ok(false)
}

/// 清空该书源登录 Cookie 后重置注入标记（下次调用再按文件内容决定）。
pub fn unseed(source_id: &str) {
    if let Ok(mut guard) = seeded_slot().lock() {
        guard.remove(source_id);
    }
}

// ---------------------------------------------------------------------------
// 注入标记（进程内）
// ---------------------------------------------------------------------------

static SEEDED: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

fn seeded_slot() -> &'static Mutex<std::collections::HashSet<String>> {
    SEEDED.get_or_init(Default::default)
}

fn seeded(source_id: &str) -> bool {
    seeded_slot()
        .lock()
        .map(|guard| guard.contains(source_id))
        .unwrap_or(false)
}

fn mark_seeded(source_id: &str) {
    if let Ok(mut guard) = seeded_slot().lock() {
        guard.insert(source_id.to_string());
    }
}

// ---------------------------------------------------------------------------
// 认证结果落盘 + 注入会话（App 与 CLI 共用同一套编排）
// ---------------------------------------------------------------------------

/// 认证成功后的收尾：**覆盖式**持久化该书源的登录 Cookie 并立即注入会话。
///
/// - 旧的登录行按整行精确移除（避免同名 Cookie 新旧并存，见 docs/cloudflare.md）；
/// - 写盘失败时把原因追加进 `outcome.message`：本次会话可用但重启会掉登录态，
///   这是用户必须知道的事，不能静默。
pub fn persist_login_outcome(source_id: &str, outcome: &mut LoginOutcome) -> Result<(), String> {
    if !outcome.ok {
        return Ok(());
    }
    let cookies = outcome.cookies.trim().to_string();
    if cookies.is_empty() {
        return Ok(());
    }
    if let Ok(Some(previous)) = crate::store::read_login_cookie(source_id) {
        let previous = previous.trim();
        if !previous.is_empty() && previous != cookies {
            crate::host::http_remove_cookie(source_id, previous);
        }
    }
    if let Err(err) = crate::store::write_login_cookie(source_id, &outcome.url, &cookies) {
        outcome.message = format!("登录已完成，但 Cookie 保存失败（重启后需重新登录）：{err}");
    }
    crate::host::http_set_cookie(source_id, &cookies);
    mark_seeded(source_id);
    Ok(())
}

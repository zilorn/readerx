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

use crate::storage::{snapshot_view, StorageSnapshot};
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
    /// **非 Cookie 登录信息**：localStorage / sessionStorage / IndexedDB 快照。
    ///
    /// 站点把凭证写在 localStorage 而不是 Cookie 里时，只有 Cookie 的登录态等于没登录；
    /// 快照由各认证后端在用户点「完成」时用 `crate::storage::probe_script` 采集，
    /// 书源代码通过 `webview.storage()` 读取。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage: Option<StorageSnapshot>,
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
            storage: None,
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
            storage: None,
        }
    }

    /// 附上采集到的存储快照（空快照视为没有）
    pub fn with_storage(mut self, storage: Option<StorageSnapshot>) -> Self {
        self.storage = storage.filter(|snapshot| !snapshot.is_empty());
        self
    }
}

/// 宿主要求认证后端执行的存储探针（四段脚本，见 [`crate::storage::probe_script_parts`]）。
///
/// 后端只负责「原样执行」，不必知道探针内部实现：
/// - `init`：页面加载前注入（**所有框架**），只把探针装进页面、不采集；
/// - `run`：用户完成登录后求值一次，触发采集；
/// - `read`：求值读取结果，返回 `pending` 表示还没采完（IndexedDB 枚举是异步的）；
/// - `pending`：上面那个标记。
///
/// **必须在页面世界里跑**：WebKitGTK 上宿主的 `eval` 与初始化脚本都在隔离世界，
/// 那里有自己的 `localStorage`，读不到页面写下的登录凭证；只有 `initialization_script`
/// 注入的代码与页面脚本共享同一个世界，所以探针必须先注入、再调用。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProbeScript {
    /// 页面加载前注入的脚本（只定义，不执行；空 = 不注入）
    pub init: String,
    /// 触发一次采集的表达式
    pub run: String,
    /// 读取采集结果的表达式（`pending` 表示还没采完）
    pub read: String,
    /// `read` 的「还没采完」标记
    pub pending: String,
}

impl ProbeScript {
    /// 是否可用（四段脚本都要就位）
    pub fn is_ready(&self) -> bool {
        !self.init.is_empty() && !self.run.is_empty() && !self.read.is_empty()
    }
}

/// 一次认证的输入：除了起始地址，后端还需要宿主准备好的注入脚本与身份（UA）。
#[derive(Debug, Clone, Default)]
pub struct AuthRequest {
    /// 页面加载前注入的脚本（每次导航都重新注入，见 [`AuthProvider::initialization_scripts`]）
    pub scripts: Vec<String>,
    /// 认证窗口的 User-Agent（空串 = 内核默认值）
    pub user_agent: String,
    /// 非 Cookie 登录信息的采集探针（后端自己采存储时忽略）
    pub probe: Option<ProbeScript>,
    /// 书源 id：桌面端用它给登录窗口起标题 / label（同时开多个源时能分辨）
    pub source_id: String,
}

/// 认证后端：由宿主（App / CLI）实现并注册。
///
/// 实现必须是 `Send + Sync`：引擎在工作线程上调用它，而认证窗口属于主线程。
pub trait AuthProvider: Send + Sync {
    /// 当前环境是否支持认证（Android 插件已就绪 / 有可用的浏览器内核）。
    fn supported(&self) -> bool;

    /// 阻塞式执行一次认证：打开 `url` 让用户完成验证，返回捕获到的 Cookie。
    /// 失败 / 取消返回 `ok: false`，不返回 `Err`（`Err` 仅保留给后端自身不可用）。
    ///
    /// `request` 里的注入脚本 / UA / 存储探针都由宿主备好，后端原样使用即可
    /// （后端自己采存储时忽略探针，见 [`AuthRequest`]）。
    fn authenticate(
        &self,
        source_id: &str,
        url: &str,
        request: &AuthRequest,
    ) -> Result<LoginOutcome, String>;
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
///
/// 认证结果要落进「每源会话」，所以这里先把会话准备好（本进程还没调用过该书源时按定义建一份）：
/// 否则应用内「网页登录」这类入口（先登录、后调用书源）抓到的 Cookie / 存储快照只会写进文件，
/// 内存会话里没有，表现为**要重启才生效**。
pub fn perform(source_id: &str, url: &str) -> Result<LoginOutcome, String> {
    let state = crate::host::ensure_source_state(source_id)?;
    let provider = provider().ok_or_else(|| "网页认证后端尚未初始化".to_string())?;
    if !provider.supported() {
        return Ok(LoginOutcome::failure(
            url,
            "当前环境不支持网页认证（独立二进制请用 --auth webkit 或 --auth cdp）",
        ));
    }
    // 非 Cookie 登录信息（localStorage / sessionStorage / IndexedDB）只能由页面里的 JS 探针采集：
    // 这里连同登录地址的 origin 一起交给后端（后端自己采存储时按需忽略）。
    let extra: Vec<String> = crate::storage::origin_of(url).into_iter().collect();
    let (init, run, read, pending) = crate::storage::probe_script_parts(&extra);
    // 认证窗口的 UA 必须与书源请求实际发出的 UA 一致（cf_clearance 与 UA + IP 绑定）：
    // 书源没写 UA 时请求会用内置默认值，窗口也必须用同一个，否则验证过了之后的 http.* 仍被拦。
    let user_agent = {
        let configured = state.user_agent_text();
        if configured.is_empty() {
            crate::profile::DEFAULT_UA.to_string()
        } else {
            configured
        }
    };
    provider.authenticate(
        source_id,
        url,
        &AuthRequest {
            scripts: vec![init.clone()],
            user_agent,
            probe: Some(ProbeScript {
                init: init.clone(),
                run,
                read,
                pending,
            }),
            source_id: source_id.to_string(),
        },
    )
}

/// 把该书源已保存的登录态注入会话（幂等；进程内只注入一次）。
///
/// App 与 CLI 每次执行书源函数前调用：重启后已保存的登录态（`source_sessions/<id>.json`）
/// 也会被注入本次进程的书源会话——Cookie 进请求头，存储快照进
/// `webview.storage()` 的读取缓存。返回是否本次真正注入了新 Cookie。
pub fn seed_source_session(source_id: &str) -> Result<bool, String> {
    if seeded(source_id) {
        return Ok(false);
    }
    let session = crate::store::read_login_session(source_id)?;
    // 无论有没有已存登录态都标记，避免反复读盘
    mark_seeded(source_id);
    let Some(state) = session else {
        return Ok(false);
    };
    if let Some(storage) = state.storage {
        crate::host::set_storage_snapshot(source_id, storage, &state.url);
    }
    let Some(cookie) = state.cookie else {
        return Ok(false);
    };
    if cookie.trim().is_empty() {
        return Ok(false);
    }
    crate::host::http_set_cookie(source_id, &cookie);
    Ok(true)
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

/// 认证成功后的收尾：**立即注入会话**并**覆盖式持久化**该书源的登录态（Cookie + 存储快照）。
///
/// - 注入先做、落盘后做：登录后本进程马上要用的就是内存会话，写盘失败也不该影响这一点
///   （失败原因追加进 `outcome.message`：本次会话可用但重启会掉登录态，用户必须知道，不能静默）；
/// - 旧的登录行按整行精确移除（避免同名 Cookie 新旧并存，见 docs/cloudflare.md）；
/// - 存储快照交给 `store::write_login_session`，空快照不会抹掉上一次抓到的那一份。
pub fn persist_login_outcome(source_id: &str, outcome: &mut LoginOutcome) -> Result<(), String> {
    if !outcome.ok {
        return Ok(());
    }
    let cookies = outcome.cookies.trim().to_string();
    let storage = outcome.storage.clone();
    if cookies.is_empty() && storage.is_none() {
        return Ok(());
    }
    if let Ok(Some(previous)) = crate::store::read_login_cookie(source_id) {
        let previous = previous.trim();
        if !previous.is_empty() && !cookies.is_empty() && previous != cookies {
            crate::host::http_remove_cookie(source_id, previous);
        }
    }
    if !cookies.is_empty() {
        crate::host::http_set_cookie(source_id, &cookies);
    }
    if let Some(storage) = storage.clone() {
        crate::host::set_storage_snapshot(source_id, storage, &outcome.url);
    }
    mark_seeded(source_id);
    if let Err(err) = crate::store::write_login_session(source_id, &outcome.url, &cookies, storage) {
        outcome.message = format!("登录已完成，但登录态保存失败（重启后需重新登录）：{err}");
    }
    Ok(())
}

/// `webview.storage()` 的返回值：该书源登录时采集到的存储快照（没有则空视图）。
pub fn storage_view(source_id: &str) -> serde_json::Value {
    match crate::host::storage_snapshot(source_id) {
        Some((snapshot, url)) => snapshot_view(&snapshot, &url),
        None => crate::storage::empty_view(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{BookSource, BookSourceCapabilities};
    use crate::storage::{StorageEntry, StorageOrigin, StorageSnapshot};

    /// 一次登录的收尾必须在**本进程立即**生效，不能等重启。
    ///
    /// 回归场景：应用内「网页登录」常发生在「本进程还没调用过该书源」之前，
    /// 此时会话状态尚未建立，写入入口若「取不到就跳过」，Cookie 与存储快照就只落了盘
    /// —— 表现为 `webview.storage()` 与请求头都要重启后才对。
    #[test]
    fn login_takes_effect_without_restart() {
        let dir = std::env::temp_dir().join(format!("readerx-auth-live-{}", std::process::id()));
        crate::store::init_data_root(&dir);
        let source = BookSource {
            schema_version: 1,
            id: "live-login".to_string(),
            name: "即时生效".to_string(),
            book_source_url: "https://example.com".to_string(),
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
        };
        crate::store::put_source(&source).unwrap();
        // 故意**不**调用 `host::prepare_source`：模拟「登录是该源在本进程的第一次交互」
        assert!(
            crate::host::source_state(&source.id).is_err(),
            "测试前提：此时还没有会话状态"
        );

        // `perform` 会先把会话准备好（认证后端未注册时返回 Err，这里只验证会话已就绪）
        let _ = perform(&source.id, "https://example.com/login");
        assert!(
            crate::host::source_state(&source.id).is_ok(),
            "认证入口应先建立会话状态"
        );

        let mut outcome = LoginOutcome::success("https://example.com/login", "sid=1", 1).with_storage(
            Some(StorageSnapshot {
                version: 1,
                updated_at: 0,
                origins: vec![StorageOrigin {
                    origin: "https://example.com".to_string(),
                    url: "https://example.com/home".to_string(),
                    local_storage: vec![StorageEntry {
                        key: "token".to_string(),
                        value: "jwt-live".to_string(),
                        truncated: false,
                    }],
                    session_storage: Vec::new(),
                    indexed_db: Vec::new(),
                }],
            }),
        );
        persist_login_outcome(&source.id, &mut outcome).unwrap();

        // 内存会话立刻可用：`webview.storage()` 的视图与整行 Cookie 都在
        let view = storage_view(&source.id);
        assert_eq!(view["localStorage"]["token"], "jwt-live");
        assert!(crate::host::http_cookies(&source.id).contains("sid=1"));

        // 且此时已落盘（重启后仍能读回来的是同一份）
        let saved = crate::store::read_login_session(&source.id).unwrap().unwrap();
        assert_eq!(saved.cookie.as_deref(), Some("sid=1"));
        assert_eq!(
            saved.storage.unwrap().origins[0].local_storage[0].value,
            "jwt-live"
        );
    }
}

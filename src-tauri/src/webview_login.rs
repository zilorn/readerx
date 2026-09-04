//! 书源「网页登录」桥接层（主 crate 侧）。
//!
//! 把「插件（Android WebView 登录浮层）」与「书源会话 / 持久化」串起来：
//! - [`install`]：在 app setup 时安装一次性桥——插件调用完成后把 Cookie
//!   持久化到该书源独立的登录文件，并立即注入书源会话（后续 http.* 自动携带）；
//! - [`perform`]：Boa 引擎（`host::webview_login`）与界面命令共用的阻塞入口；
//! - [`seed_source_session`]：每次执行书源函数前调用，保证重启后已保存的登录态
//!   也会被注入本次进程的书源会话（幂等，进程内只注入一次）。

use crate::{host, storage};
use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::AppHandle;
use tauri_plugin_webview_login::LoginOutcome;

/// 执行器：`(source_id, url) -> outcome`；内部会做持久化 + 会话注入。
type LoginRunner = dyn Fn(&str, &str) -> Result<LoginOutcome, String> + Send + Sync;

static RUNNER: OnceLock<Mutex<Option<Arc<LoginRunner>>>> = OnceLock::new();
/// 已把持久化 Cookie 注入过会话的书源 id（避免重复追加）
static SEEDED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn runner_slot() -> &'static Mutex<Option<Arc<LoginRunner>>> {
    RUNNER.get_or_init(Default::default)
}

fn seeded_slot() -> &'static Mutex<HashSet<String>> {
    SEEDED.get_or_init(Default::default)
}

/// app setup 时调用。桌面/iOS 下插件不可用，调用会返回可读错误，不影响其它功能。
pub fn install(app: AppHandle) {
    let runner: Arc<LoginRunner> = Arc::new(move |source_id: &str, url: &str| {
        let outcome = tauri_plugin_webview_login::open_login(url).unwrap_or_else(|err| {
            LoginOutcome {
                ok: false,
                url: url.to_string(),
                cookies: String::new(),
                count: 0,
                message: err,
            }
        });
        if outcome.ok {
            let cookies = outcome.cookies.trim().to_string();
            if !cookies.is_empty() {
                // 旧的一次登录行按整行精确移除，避免同名 Cookie 新旧并存
                if let Ok(Some(previous)) =
                    storage::read_source_login_cookie(&app, source_id)
                {
                    let previous = previous.trim();
                    if !previous.is_empty() && previous != cookies {
                        host::http_remove_cookie(source_id, previous);
                    }
                }
                // 覆盖式持久化为该源最近一次网页登录的 Cookie（重启自动注入）
                if let Err(err) =
                    storage::write_source_login_cookie(&app, source_id, &outcome.url, &cookies)
                {
                    eprintln!("[webview-login] 持久化登录 Cookie 失败: {err}");
                }
                // 立即写入会话（相同文本会被 http_set_cookie 去重跳过）
                host::http_set_cookie(source_id, &cookies);
                if let Ok(mut guard) = seeded_slot().lock() {
                    guard.insert(source_id.to_string());
                }
            }
        }
        Ok(outcome)
    });
    *runner_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(runner);
}

/// 当前平台是否支持网页登录（Android + 插件已初始化）。
pub fn is_supported() -> bool {
    tauri_plugin_webview_login::is_supported()
}

/// 阻塞执行一次网页登录（引擎线程 / spawn_blocking 内使用）。
pub fn perform(source_id: &str, url: &str) -> Result<LoginOutcome, String> {
    let runner = runner_slot()
        .lock()
        .map_err(|_| "登录桥锁异常".to_string())?
        .clone()
        .ok_or_else(|| "登录桥尚未初始化".to_string())?;
    runner(source_id, url)
}

/// 把该书源已保存的登录 Cookie 注入会话（幂等；进程内只注入一次）。
/// 返回是否本次真正注入了新 Cookie。
pub fn seed_source_session(app: &AppHandle, source_id: &str) -> Result<bool, String> {
    let id = source_id.to_string();
    let already = seeded_slot()
        .lock()
        .map_err(|_| "登录桥锁异常".to_string())?
        .contains(&id);
    if already {
        return Ok(false);
    }
    let cookie = storage::read_source_login_cookie(app, source_id)?;
    // 无论有没有已存 Cookie 都标记，避免反复读盘
    let mut guard = seeded_slot().lock().unwrap_or_else(|e| e.into_inner());
    guard.insert(id.clone());
    drop(guard);
    if let Some(cookie) = cookie {
        if !cookie.trim().is_empty() {
            host::http_set_cookie(source_id, &cookie);
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

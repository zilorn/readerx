//! 书源「网页登录」桥接层（主 crate 侧）。
//!
//! 把「插件（Android WebView 登录浮层）」接到书源引擎的认证接口上：
//! - [`install`]：app setup 时注册一次认证后端——引擎命中 Cloudflare 挑战或书源 JS 调
//!   `webview.login(url)` 时，都会走这里拉起源码侧的登录浮层；
//! - [`perform`]：界面命令（编辑页「网页登录」按钮）用的阻塞入口；
//! - [`seed_source_session`] / [`unseed`]：转发核心 crate 的登录态注入（幂等）。
//!
//! 独立二进制（readerx-source CLI）注册的是另一套后端（webkit2gtk / CDP），
//! 编排、持久化与注入逻辑都在 `readerx_source::auth`，两侧完全一致。

use readerx_source::auth::{self, AuthProvider, LoginOutcome};
use std::sync::Arc;
use tauri_plugin_webview_login::LoginOutcome as PluginOutcome;

/// Android 插件后端：把插件的登录结果转成引擎的 [`LoginOutcome`]
struct AndroidProvider;

impl AndroidProvider {
    /// 平台是否支持（插件在桌面/iOS 上会返回 false）
    fn platform_supported() -> bool {
        tauri_plugin_webview_login::is_supported()
    }
}

impl AuthProvider for AndroidProvider {
    fn supported(&self) -> bool {
        Self::platform_supported()
    }

    fn authenticate(&self, _source_id: &str, url: &str) -> Result<LoginOutcome, String> {
        let outcome: PluginOutcome =
            tauri_plugin_webview_login::open_login(url).unwrap_or_else(|err| PluginOutcome {
                ok: false,
                url: url.to_string(),
                cookies: String::new(),
                count: 0,
                message: err,
            });
        Ok(LoginOutcome {
            ok: outcome.ok,
            url: outcome.url,
            cookies: outcome.cookies,
            count: outcome.count as usize,
            message: outcome.message,
        })
    }
}

/// app setup 时调用。桌面/iOS 下插件不可用，`supported()` 为 false，不影响其它功能。
pub fn install(_app: tauri::AppHandle) {
    auth::install_provider(Arc::new(AndroidProvider));
}

/// 当前平台是否支持网页登录（Android + 插件已初始化）。
pub fn is_supported() -> bool {
    AndroidProvider::platform_supported()
}

/// 阻塞执行一次网页登录（引擎线程 / spawn_blocking 内使用）。
///
/// 结果由核心 crate 统一收尾：覆盖式持久化为该书源的登录 Cookie（旧行精确移除）
/// 并立即注入会话；写盘失败会把原因写进 `message`，界面据此提示。
pub fn perform(source_id: &str, url: &str) -> Result<LoginOutcome, String> {
    let mut outcome = auth::perform(source_id, url)?;
    auth::persist_login_outcome(source_id, &mut outcome)?;
    Ok(outcome)
}

/// 把该书源已保存的登录 Cookie 注入会话（幂等；进程内只注入一次）。
/// 返回是否本次真正注入了新 Cookie。
pub fn seed_source_session(source_id: &str) -> Result<bool, String> {
    auth::seed_source_session(source_id)
}

/// 清空该书源登录 Cookie 后重置注入标记（下次调用再按文件内容决定）。
pub fn unseed(source_id: &str) {
    auth::unseed(source_id)
}

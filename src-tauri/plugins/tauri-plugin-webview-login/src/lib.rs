//! ReaderX 书源「网页登录」Tauri 插件。
//!
//! 目标平台：**仅 Android**（Tauri 多 WebView 窗口在移动端不受支持，
//! 本插件通过 Android 侧 Kotlin 在 Activity 上叠加一个原生 `WebView`
//! 浮层让用户完成登录，捕获含 httpOnly 的 Cookie 后原路返回）。
//!
//! 调用关系：
//! - ReaderX 主 crate（Boa 引擎线程 / 界面按钮）调用 [`open_login`]；
//! - 首次插件 setup 时经 [`tauri::plugin::PluginApi::register_android_plugin`]
//!   注册 Kotlin 的 `WebviewLoginPlugin`，并把 `PluginHandle` 存入静态注册表；
//! - [`open_login`] 通过 `run_mobile_plugin("openLogin", …)` 同步等待 Kotlin
//!   完成/取消/超时，得到统一的 [`LoginOutcome`]。

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{plugin::TauriPlugin, Runtime};

/// 一次网页登录的结果（由 Kotlin 侧 JSON 反序列化而来）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoginOutcome {
    /// 是否成功完成（false = 用户取消 / 等待超时 / 平台不支持）
    pub ok: bool,
    /// 最终停留的页面 URL（失败/取消时可能为空）
    #[serde(default)]
    pub url: String,
    /// 捕获到的 Cookie 文本（`k=v; k2=v2`），含 httpOnly
    #[serde(default)]
    pub cookies: String,
    /// Cookie 条数（仅统计非空）
    #[serde(default)]
    pub count: u64,
    /// 可读消息（取消/错误原因）
    #[serde(default)]
    pub message: String,
}

/// 注册表里的调用器：输入起始 URL，阻塞直到用户完成/取消/超时。
type LoginRunner = Arc<dyn Fn(&str) -> Result<LoginOutcome, String> + Send + Sync>;

static RUNNER: OnceLock<Mutex<Option<LoginRunner>>> = OnceLock::new();

fn runner_slot() -> &'static Mutex<Option<LoginRunner>> {
    RUNNER.get_or_init(Default::default)
}

/// 平台是否支持网页登录（Android 且插件已初始化）。
pub fn is_supported() -> bool {
    runner_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .is_some()
}

/// 打开网页登录浮层并阻塞等待结果。
///
/// - 返回 `LoginOutcome`：`ok=true` 时 `cookies` 为捕获到的 Cookie 文本。
/// - 平台不支持（桌面 / iOS / 未初始化）返回 `Err`。
pub fn open_login(url: &str) -> Result<LoginOutcome, String> {
    let runner = runner_slot()
        .lock()
        .map_err(|_| "登录注册表锁异常".to_string())?
        .clone()
        .ok_or_else(|| "网页登录尚未就绪（当前仅在 Android 端可用）".to_string())?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持 http/https 的登录地址".to_string());
    }
    runner(url)
}

/// 插件入口。
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("webview-login")
        .setup(|_app, api| {
            #[cfg(not(target_os = "android"))]
            let _ = &api;
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(
                    "com.readerx.webviewlogin",
                    "WebviewLoginPlugin",
                )?;
                let runner: LoginRunner = Arc::new(move |url: &str| {
                    let outcome: LoginOutcome = handle
                        .run_mobile_plugin(
                            "openLogin",
                            serde_json::json!({ "url": url, "timeoutSecs": 900 }),
                        )
                        .map_err(|e| format!("网页登录失败: {e}"))?;
                    Ok(outcome)
                });
                *runner_slot()
                    .lock()
                    .map_err(|_| std::io::Error::other("登录注册表锁异常"))? = Some(runner);
            }
            Ok(())
        })
        .build()
}

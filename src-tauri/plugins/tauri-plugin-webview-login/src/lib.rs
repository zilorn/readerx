//! ReaderX 书源「网页登录」Tauri 插件。
//!
//! 两端各有一套实现，对外是同一个 [`open_login`]：
//! - **Android**：Tauri 多 WebView 窗口在移动端不受支持，因此由 Kotlin 在 Activity 上叠加
//!   一个原生 `WebView` 浮层（见 `android/`），捕获含 httpOnly 的 Cookie 与
//!   localStorage / sessionStorage / IndexedDB 快照后原路返回；
//! - **桌面（Linux / Windows）**：开一个独立登录窗口（见 [`desktop`]），Cookie 读内核
//!   Cookie 库，存储按宿主给的探针脚本采集；用户点窗口里的「完成」或直接关窗即收尾。
//!
//! 调用关系：
//! - ReaderX 主 crate（Boa 引擎线程 / 界面按钮）调用 [`open_login`]；
//! - 插件 setup 时按平台注册 runner（Android 注册 Kotlin 插件、桌面注册窗口实现），
//!   并把可调用句柄存入静态注册表；
//! - [`open_login`] 阻塞等待用户完成/取消/超时，得到统一的 [`LoginOutcome`]。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::plugin::TauriPlugin;
// 插件对运行时不作假设：宿主用什么 runtime 就传什么（桌面是 wry，Android 是移动端 runtime）。
// 这里绝不能写死 `tauri::Wry` —— 它在 Android 上不存在，会直接把移动端编译拖死。
use tauri::Runtime;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod desktop;
#[cfg(target_os = "linux")]
pub mod desktop_main_world;

/// 一次网页登录的结果（Android 侧由 Kotlin JSON 反序列化，桌面侧由 Rust 直接构造）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoginOutcome {
    /// 是否成功完成（false = 用户取消 / 等待超时 / 平台不支持）
    pub ok: bool,
    /// 最终停留的页面 URL（失败/取消时可能为空）
    #[serde(default)]
    pub url: String,
    /// 捕获到的 Cookie 文本（`k=v; k=v2`），含 httpOnly
    #[serde(default)]
    pub cookies: String,
    /// Cookie 条数（仅统计非空）
    #[serde(default)]
    pub count: u64,
    /// 可读消息（取消/错误原因）
    #[serde(default)]
    pub message: String,
    /// 非 Cookie 登录信息：localStorage / sessionStorage / IndexedDB 探针快照。
    /// 这里只做**透传**（原样交给引擎侧的 `readerx_source::storage` 解析与持久化），
    /// 因此保持 `Value` 而不在本插件里再定义一份结构。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage: Option<Value>,
    /// 桌面端存储探针的原始读数（由主 crate 用 `storage::parse_probe_eval` 解析——
    /// 插件不认识探针的输出格式，只负责把它原样带回来）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe_result: Option<String>,
}

impl LoginOutcome {
    /// 失败结果（桌面端内部用；Android 侧的结果由 Kotlin 反序列化而来）
    pub fn failure(url: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            url: url.into(),
            cookies: String::new(),
            count: 0,
            message: message.into(),
            ..Default::default()
        }
    }

    /// 成功结果（Cookie 文本 + 条数）
    pub fn success(url: impl Into<String>, cookies: impl Into<String>, count: u64) -> Self {
        Self {
            ok: true,
            url: url.into(),
            cookies: cookies.into(),
            count,
            ..Default::default()
        }
    }
}

/// 一次登录调用的输入：桌面端窗口要用它设置注入脚本 / UA / 探针；
/// Android 浮层自己采存储，只用得到 `source_id`。
#[derive(Debug, Clone, Default)]
pub struct PlatformLoginRequest {
    /// 页面加载前注入的脚本（覆盖所有框架）
    pub scripts: Vec<String>,
    /// 登录窗口的 User-Agent（空串 = 内核默认值）
    pub user_agent: String,
    /// 非 Cookie 登录信息的采集探针（三段脚本，插件只原样执行）
    pub probe: Option<readerx_source::auth::ProbeScript>,
    /// 书源 id（窗口标题 / label）
    pub source_id: String,
    /// 最长等待秒数
    pub timeout_secs: u64,
    /// 桌面端登录窗口要用的 AppHandle（Android 浮层不需要，保持 None）
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub app: Option<tauri::AppHandle>,
}

/// 注册表里的调用器：输入起始 URL 与调用参数，阻塞直到用户完成/取消/超时。
type LoginRunner = Arc<dyn Fn(&str, &PlatformLoginRequest) -> Result<LoginOutcome, String> + Send + Sync>;

static RUNNER: OnceLock<Mutex<Option<LoginRunner>>> = OnceLock::new();

fn runner_slot() -> &'static Mutex<Option<LoginRunner>> {
    RUNNER.get_or_init(Default::default)
}

/// 平台是否支持网页登录（Android 浮层 / 桌面窗口已就绪）。
pub fn is_supported() -> bool {
    runner_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .is_some()
}

/// 打开网页登录界面并阻塞等待结果。
///
/// - 返回 `LoginOutcome`：`ok=true` 时 `cookies` 为捕获到的 Cookie 文本；
///   桌面端另有 `probe_result`（存储探针的原始读数）。
/// - 平台不支持（iOS / 未初始化）返回 `Err`。
pub fn open_login(url: &str, request: &PlatformLoginRequest) -> Result<LoginOutcome, String> {
    let runner = runner_slot()
        .lock()
        .map_err(|_| "登录注册表锁异常".to_string())?
        .clone()
        .ok_or_else(|| "网页登录尚未就绪（当前平台不支持）".to_string())?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持 http/https 的登录地址".to_string());
    }
    runner(url, request)
}

/// 插件入口：注册当前平台的登录 runner，并把插件挂到 app 上（Android 由 Kotlin 浮层实现）。
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    prepare();
    tauri::plugin::Builder::new("webview-login")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            register_android_runner(&api)?;
            #[cfg(not(target_os = "android"))]
            let _ = &api;
            Ok(())
        })
        .build()
}

/// 注册当前平台的登录 runner（幂等；重复调用覆盖旧 runner）。
///
/// 与「插件 setup」分开是为了让**没有 Tauri app 的调用方**也能用：桌面端 runner 只需要
/// 调用时传入的 `AppHandle`（见 [`PlatformLoginRequest::app`]），不必等插件 setup 跑完。
pub fn prepare() {
    let runner: LoginRunner = Arc::new(move |url: &str, request: &PlatformLoginRequest| {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            match request.app.as_ref() {
                Some(app) => desktop::authenticate(app, url, request),
                None => {
                    Err("桌面登录窗口需要 AppHandle（请通过 PlatformLoginRequest::app 传入）".into())
                }
            }
        }
        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            let _ = request;
            Err(format!("当前平台不支持网页登录：{url}"))
        }
    });
    if let Ok(mut guard) = runner_slot().lock() {
        *guard = Some(runner);
    }
}

/// Android：把 Kotlin 的 `WebviewLoginPlugin` 注册成 runner。
#[cfg(target_os = "android")]
fn register_android_runner<R: Runtime>(
    api: &tauri::plugin::PluginApi<R, ()>,
) -> Result<(), Box<dyn std::error::Error>> {
    let handle =
        api.register_android_plugin("com.readerx.webviewlogin", "WebviewLoginPlugin")?;
    let runner: LoginRunner = Arc::new(move |url: &str, request: &PlatformLoginRequest| {
        let outcome: LoginOutcome = handle
            .run_mobile_plugin(
                "openLogin",
                serde_json::json!({ "url": url, "timeoutSecs": request.timeout_secs }),
            )
            .map_err(|e| format!("网页登录失败: {e}"))?;
        Ok(outcome)
    });
    *runner_slot()
        .lock()
        .map_err(|_| std::io::Error::other("登录注册表锁异常"))? = Some(runner);
    Ok(())
}

//! 桌面端单实例。
//!
//! 用户重复启动（再点一次图标 / 双击快捷方式）不该开出第二个进程：两个实例会同时读写
//! 同一份书库、设置与听书缓存，最后落盘的一方覆盖另一方。插件（`tauri-plugin-single-instance`）
//! 保证同一时刻只有一个实例在跑 —— 后启动的进程把命令行交给已在运行的实例后自己退出，
//! 这里负责把已有窗口还原并聚焦，让「再点一次图标」得到用户预期的结果。
//!
//! 移动端（Android / iOS）由系统保证单实例，插件也不支持移动端，整个模块按 `desktop` 条件编译。

use tauri::{plugin::TauriPlugin, AppHandle, Manager, Runtime};

/// 主窗口 label：`tauri.conf.json` 的 `app.windows[0]` 未写 label，Tauri 给第一个窗口的默认
/// label 是 `main`（`capabilities/default.json` 也是按这个 label 授权的）。
const MAIN_WINDOW: &str = "main";

/// 单实例插件。**必须作为第一个插件注册**（插件按注册顺序初始化）。
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_single_instance::init(|app, argv, cwd| {
        log::info!("检测到重复启动，聚焦已有窗口");
        log::debug!("被拦截的实例：参数 {} 个，工作目录 {cwd}", argv.len());
        focus_main_window(app);
    })
}

/// 把主窗口拉回前台：最小化的先还原、隐藏的先显示，最后聚焦。
///
/// 三步都做全是有原因的：窗口处于最小化或隐藏状态时，单靠 `set_focus` 在 Windows 与
/// Linux 上都不会把它显示出来，用户会以为「点了图标没反应」。
fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("主窗口不存在，无法聚焦（已被拦截的实例照常退出）");
        return;
    };
    if window.is_minimized().unwrap_or(false) {
        if let Err(error) = window.unminimize() {
            log::warn!("还原最小化的主窗口失败: {error}");
        }
    }
    if !window.is_visible().unwrap_or(true) {
        if let Err(error) = window.show() {
            log::warn!("显示主窗口失败: {error}");
        }
    }
    if let Err(error) = window.set_focus() {
        log::warn!("聚焦主窗口失败: {error}");
    }
}

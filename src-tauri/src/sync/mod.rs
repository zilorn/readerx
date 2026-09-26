//! 局域网同步接入层：把 `readerx-sync` 框架接进 App。
//!
//! ```text
//! sync/
//!   settings.rs  设备本地的同步设置（开关 / 自动同步 / 落地游标）
//!   identity.rs  跨设备身份（书 / 分组 / 书源在两台设备上算出同一个 id）
//!   bridge.rs    本地数据 ↔ 引擎实体（发布本地改动 / 落地远端结果）
//!   lan.rs       本机对外的局域网地址（界面「本机地址」展示用）
//!   service.rs   引擎与网络的生命周期、自动同步线程、事件推送
//!   commands.rs  供 WebView 调用的 Tauri command
//! ```
//!
//! 数据目录是 `<应用数据目录>/sync`（与 `books/`、`state/`、`book_sources/` 并列），
//! 也就是 CLI 运行器 `readerx-sync --data-dir <该目录>` 能直接查看同一份数据。
//!
//! 同步的范围与边界见 `docs/sync.md`：书籍**元信息**、阅读进度、书签、分组、书源；
//! 正文 / 封面 / 听书缓存不在同步范围内（局域网里搬几百兆文件不是同步该干的事）。

// 本地数据 ↔ 引擎实体的桥接。对外可见**只为让集成测试**（tests/sync_bridge.rs）
// 能直接验证双向搬运的落盘结果；应用代码请走 SyncService（它有引擎与生命周期）。
#[doc(hidden)]
pub mod bridge;
#[doc(hidden)]
pub mod identity;
mod lan;
mod service;
mod settings;

// 命令层公开一层模块路径：`generate_handler!` 要在同一路径下找到
// `#[tauri::command]` 生成的处理项（`sync::commands::readerx_sync_*`）。
pub mod commands;

pub use bridge::PublishMode;
pub use lan::local_addresses;
pub use service::SyncService;

/// Tauri 全局状态：同步服务句柄。
pub struct SyncState(pub std::sync::Arc<SyncService>);

/// 服务句柄（命令层用）。
pub type SharedService = std::sync::Arc<SyncService>;

/// 取同步服务（本地写路径上的同步钩子用）。
///
/// 同步从未启用时服务也在，只是没有引擎 —— 钩子函数自己会空操作，
/// 因此本地写路径可以无条件调用，不必到处判断「同步开没开」。
pub fn service_hook(app: &tauri::AppHandle) -> std::sync::Arc<SyncService> {
    use tauri::Manager;
    app.try_state::<SyncState>()
        .map(|state| state.0.clone())
        .unwrap_or_else(|| SyncService::new(app.clone()))
}

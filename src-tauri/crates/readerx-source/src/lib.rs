//! # readerx-source —— ReaderX 书源引擎（可脱离应用独立编译）
//!
//! 本 crate 是书源运行时的**全部核心**，不依赖 Tauri / GUI / 前端：
//!
//! - [`engine`]：Boa 0.22 沙箱，按入口函数（searchBook / bookToc / …）执行书源 JS；
//! - [`host`]：宿主能力层（HTTP 会话、Cookie、HTML 选择器、文本清洗、base64 / 摘要 / HMAC / AES-GCM）；
//! - [`auth`]：网页登录 / Cloudflare 认证的**可插拔后端**——App 侧接 Android WebView 插件，
//!   独立二进制侧接 webkit2gtk 或 Chrome DevTools Protocol（见 `backend` 模块）；
//! - [`store`]：书源 JSON、书源登录 Cookie、认证配置（profile）的磁盘读写，
//!   格式与 App 完全一致（同一份数据目录可被 App 与 CLI 交替使用）；
//! - [`profile`]：浏览器身份（User-Agent / 请求头 / Cookie 文件导入），用于带登录态离线测试。
//!
//! 编译产物：
//! - 作为库：`cargo build -p readerx-source`；
//! - 作为独立二进制：`cargo build -p readerx-source --features cli --bin readerx-source`。

pub mod auth;
pub mod engine;
pub mod host;
pub mod models;
pub mod panic_guard;
pub mod store;

#[cfg(all(feature = "cli", any(feature = "cdp", feature = "webkit")))]
pub mod cli;
#[cfg(feature = "webkit")]
pub mod backend_webkit;
#[cfg(feature = "cdp")]
pub mod backend_cdp;
#[cfg(any(feature = "cdp", feature = "webkit"))]
pub mod profile;

pub use models::{
    BookItem, BookSource, BookSourceCapabilities, BookSourceSummary, ChapterContentResult,
    ChapterItem, FetchedImage, SourceCallResult,
};

/// 默认数据目录：`$READERX_SOURCE_HOME` > `$XDG_DATA_HOME/readerx-source` > `~/.local/share/readerx-source`。
///
/// App（Tauri）不依赖这个默认值——它在启动时用应用自己的数据目录调用
/// [`store::init_data_root`]，从而与 CLI 共用同一份书源与登录态文件。
pub fn default_data_root() -> std::path::PathBuf {
    if let Some(dir) = std::env::var_os("READERX_SOURCE_HOME") {
        if !dir.is_empty() {
            return std::path::PathBuf::from(dir);
        }
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|v| !v.is_empty())
                .map(|home| std::path::PathBuf::from(home).join(".local/share"))
        })
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    base.join("readerx-source")
}

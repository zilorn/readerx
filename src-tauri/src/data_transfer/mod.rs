//! 全量数据导出 / 导入（备份与换机迁移）。
//!
//! 与「同步」（`src/sync/`，见 `docs/sync.md`）的分工是清楚的：
//!
//! - **同步**解决「两台设备各自离线改数据，联网后自动合并」，为了不让操作日志爆掉，
//!   只同步元信息 / 进度 / 书签 / 分组 / 书源，**不搬正文与插图**；
//! - **这里**解决「把整台设备的数据变成一个文件，换机 / 重装后搬回来」：**包含正文、
//!   书签、插图、书源的完整数据**，代价是由用户显式导出与导入，且没有增量与冲突裁决 ——
//!   导入的语义只有「合并」与「覆盖恢复」两种（见 [`ImportMode`]）。
//!
//! 归档就是一个 **zip 文件**（后缀 `.zip`，正文体积大必须压缩；同时用户能自己解开检查），
//! 内部路径与应用数据目录一一对应：
//!
//! ```text
//! readerx-backup.json          清单：格式版本、导出版本、时间、是否含登录信息、各类条目数
//! state/<key>.json             readerx.* 状态（书架进度、分组、替换 / 分章规则、偏好…）
//! books/<id>/bookdetail.json   书籍元信息
//! books/<id>/content.json      章节正文
//! books/<id>/bookmarks.json    书签
//! books/<id>/annotations.json  段落注释
//! images/<name>                章节插图 / PDF 页面图（文件名前缀就是它所属的书籍 id）
//! book_sources/<id>.json       书源定义
//! source_sessions/<id>.json    书源登录态（**仅当导出时勾选「包含登录信息」**）
//! ```
//!
//! **不导出**：`sync/`（设备身份、操作日志 —— 跟着设备走，搬过去只会制造两个同 id 的设备）、
//! `tts-audio/`（能从正文重新生成的听书缓存）、`logs/`（应用日志）。
//!
//! 目录分工：
//!
//! ```text
//! archive.rs    归档的读写（zip 封装、清单、目标 / 来源文件句柄）
//! export.rs     采集本地数据 → 写成归档
//! plan.rs       导入的规划：认书 / 认分组、算 id 换算表（只读，不写盘）
//! import.rs     读归档 → 合并 / 覆盖写回本地（先写后删）
//! merge.rs      状态文件与分组的合并规则（纯函数，可单测）
//! commands.rs   供 WebView 调用的 Tauri command（含系统文件选择器）
//! ```
//!
//! **凭据**：书源登录态与 WebDAV 密码属于凭据，默认**不导出**；用户显式勾选后才写进归档，
//! 界面与文档都要说清「这份文件里有账号登录信息，别随手分享」。日志里永远只有数量，
//! 没有内容（与全项目口径一致）。

mod archive;
mod export;
mod import;
mod merge;
mod plan;
// 端到端回归（真实磁盘 + 真实 zip）：库内单元测试，因此能直接用上面这些内部模块
#[cfg(test)]
mod round_trip;
// 命令模块对外可见：`generate_handler!` 要在同一路径下找到命令宏生成的隐藏项
// （re-export 不带它们），因此 lib.rs 直接用 `data_transfer::commands::*`。
pub(crate) mod commands;

use serde::{Deserialize, Serialize};

/// 清单文件名（归档内路径）
pub(crate) const MANIFEST_NAME: &str = "readerx-backup.json";
/// 归档格式标识；读到更高版本直接报错，而不是按旧语义读坏新数据
pub(crate) const BACKUP_FORMAT: &str = "readerx-backup/1";
/// 归档内的顶层目录名（与数据目录同名，一一对应）
pub(crate) const STATE_DIR: &str = "state";
pub(crate) const BOOKS_DIR: &str = "books";
pub(crate) const IMAGES_DIR: &str = "images";
pub(crate) const SOURCES_DIR: &str = "book_sources";
pub(crate) const SESSIONS_DIR: &str = "source_sessions";

/// 归档清单（`readerx-backup.json`）。
///
/// 放在归档最前面：导入前只读它就能给出「这份备份里有什么」的预览，
/// 不必把几百兆正文解一遍。计数在导出时算好，导入时与预览一起展示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// 格式版本（[`BACKUP_FORMAT`]）
    pub format: String,
    /// 导出时的应用版本
    pub app_version: String,
    /// 导出时间（毫秒时间戳）
    pub created_at: u64,
    /// 是否包含书源登录态 / WebDAV 密码
    pub credentials: bool,
    pub books: u64,
    pub images: u64,
    pub sources: u64,
    pub state_keys: u64,
}

/// 导出选项
#[derive(Debug, Clone, Copy, Default)]
pub struct ExportOptions {
    /// 是否把书源登录态与 WebDAV 密码一并写进归档（默认否）
    pub include_credentials: bool,
}

/// 导入语义
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportMode {
    /// 合并（默认）：补齐本机没有的，同 id 覆盖，书签 / 进度 / 规则按身份取并集，
    /// 本机多出来的书与书源**一个都不动**。
    Merge,
    /// 覆盖恢复：先写归档里的数据，再把归档里没有的本地书 / 书源删掉；
    /// 内容类状态文件（书架 / 分组 / 规则）与归档完全一致。
    Replace,
}

impl ImportMode {
    /// 前端传入的语义串（`merge` / `replace`），非法值报错而不是猜一个
    pub(crate) fn parse(raw: &str) -> Result<ImportMode, String> {
        match raw {
            "merge" => Ok(ImportMode::Merge),
            "replace" => Ok(ImportMode::Replace),
            other => Err(format!("未知的导入方式: {other}")),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ImportMode::Merge => "merge",
            ImportMode::Replace => "replace",
        }
    }
}

/// 导入前的预览（只读清单与文件大小，不解压正文）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub app_version: String,
    pub created_at: u64,
    pub credentials: bool,
    pub books: u64,
    pub images: u64,
    pub sources: u64,
    pub state_keys: u64,
    /// 归档文件字节数（读文件元信息，清单里不记 —— 写清单时还算不出它）
    pub bytes: u64,
}

/// 选中的归档：路径由前端持有，确认导入时**原样传回**（无隐藏状态，也就不怕并发）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedArchive {
    pub path: String,
    pub preview: ImportPreview,
}

/// 导出结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub file_name: String,
    pub bytes: u64,
    pub books: u64,
    pub images: u64,
    pub sources: u64,
    pub state_keys: u64,
    pub credentials: bool,
}

/// 导入结果（界面按它给一句「做了什么」）
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub mode: String,
    pub books_added: u64,
    pub books_updated: u64,
    /// 本机已有同一本书（按跨设备身份对上，本机 id 不同）→ 不重复导入，只并书签
    pub books_skipped: u64,
    /// 覆盖恢复时删掉的本地书
    pub books_removed: u64,
    pub images_added: u64,
    pub sources_added: u64,
    pub sources_updated: u64,
    pub sources_skipped: u64,
    pub sources_removed: u64,
    /// 合并 / 覆盖了哪些状态 key（供界面与排障展示）
    pub state_keys: Vec<String>,
}

/// 归档条目名是否安全：只接受 `目录/文件` 形态的 POSIX 相对路径。
///
/// 导入的是用户给的文件，**绝不能**凭它写到数据目录之外：绝对路径、盘符、反斜杠、
/// `.` / `..` 一律拒绝（与 `book_images` / `storage` 的组件校验同一口径）。
pub(crate) fn is_safe_entry(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 512
        && !name.starts_with('/')
        && !name.contains('\\')
        && !name.contains(':')
        && name
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// 清单里的格式版本是否本程序读得懂
pub(crate) fn format_supported(format: &str) -> bool {
    match format.strip_prefix("readerx-backup/") {
        Some(version) => version.parse::<u32>().map(|v| v <= 1).unwrap_or(false),
        None => false,
    }
}

/// 当前时间（毫秒时间戳）
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 备份文件默认名：`readerx-backup-2026-09-26.zip`（本地日期，取不到时区按 UTC）。
///
/// 时区实现与 `readerx-log` 同源（`time` 的 local-offset），为了不给备份功能引入
/// chrono 这类额外依赖。
pub(crate) fn default_file_name() -> String {
    use time::OffsetDateTime;
    let offset = time::UtcOffset::current_local_offset().unwrap_or(time::UtcOffset::UTC);
    let now = OffsetDateTime::now_utc().to_offset(offset);
    format!(
        "readerx-backup-{:04}-{:02}-{:02}.zip",
        now.year(),
        u8::from(now.month()),
        now.day()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_names_cannot_escape_the_data_dir() {
        assert!(is_safe_entry("books/local-1/content.json"));
        assert!(is_safe_entry("state/readerx.shelf.json"));
        assert!(!is_safe_entry("/etc/passwd"));
        assert!(!is_safe_entry("books/../../etc/passwd"));
        assert!(!is_safe_entry("books\\local-1\\content.json"));
        assert!(!is_safe_entry("C:/Windows/system32"));
        assert!(!is_safe_entry("books//content.json"));
        assert!(!is_safe_entry("books/./content.json"));
        assert!(!is_safe_entry(""));
    }

    #[test]
    fn only_known_backup_formats_are_accepted() {
        assert!(format_supported(BACKUP_FORMAT));
        assert!(format_supported("readerx-backup/1"));
        assert!(!format_supported("readerx-backup/2"));
        assert!(!format_supported("readerx-backup/x"));
        assert!(!format_supported("其它工具/1"));
    }

    #[test]
    fn import_mode_parsing_is_strict() {
        assert_eq!(ImportMode::parse("merge").unwrap(), ImportMode::Merge);
        assert_eq!(ImportMode::parse("replace").unwrap(), ImportMode::Replace);
        assert!(ImportMode::parse("Merge").is_err());
        assert!(ImportMode::parse("").is_err());
    }

    #[test]
    fn default_file_name_is_a_zip_named_backup() {
        let name = default_file_name();
        assert!(name.starts_with("readerx-backup-"), "{name}");
        assert!(name.ends_with(".zip"), "{name}");
        assert_eq!(name.len(), "readerx-backup-2026-09-26.zip".len());
    }
}

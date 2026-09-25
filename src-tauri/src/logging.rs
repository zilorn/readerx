//! App 侧日志接线：安装 logger、把日志目录挂到应用数据目录、给前端提供读写日志的 command。
//!
//! 分两步安装，原因是「进程一开始要能记日志」与「数据目录要先拿到 AppHandle 才知道」
//! 这两件事的时机不同：
//!
//! 1. [`init_early`] 在 `run()` 最开头调用：先只打标准错误（Android 走 logcat），
//!    此时若启动早期就崩，日志照样看得见；
//! 2. [`attach_app_dir`] 在 Tauri `setup` 里调用：拿到应用数据目录后挂上文件目标
//!    （`<数据目录>/logs/readerx.log`），并把用户设置里的日志级别应用上去。
//!
//! 级别、目录、轮转等实现细节都在 `readerx-log` crate：书源引擎与独立二进制
//! 用的是同一份代码，这里只负责「App 的数据目录与用户偏好」这一段。

use crate::storage;
use log::{Level, LevelFilter};
use readerx_log::{LogConfig, Logger, LOG_DIR_NAME};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 日志级别偏好的状态键（设置页可改，重启后仍生效）
pub const LOG_LEVEL_KEY: &str = "readerx.logLevel";

/// 前端回传日志时用的 target（`log::log!(target: "web", …)`），
/// 级别规格里可以写 `web=debug` 单独调 WebView 侧的详单
pub const WEB_TARGET: &str = "web";

/// 日志尾巴一次最多返回的行数
const MAX_TAIL_LINES: usize = 20_000;

fn config() -> LogConfig {
    LogConfig::new("readerx")
}

/// 进程启动时安装 logger（文件目标等 setup 阶段再挂）。
///
/// 只在第一次真正安装：`readerx_log::init` 会把传入配置里的级别重新应用一遍，
/// 而这个函数在很多地方被调用（读日志、切级别、写启动横幅），
/// 每次都重放默认级别会把用户刚切到的「详细」冲掉。
pub fn init_early() -> &'static Logger {
    if let Some(logger) = readerx_log::logger() {
        return logger;
    }
    readerx_log::init(config())
}

/// 拿到应用数据目录后：挂文件目标 + 应用用户设置的级别 + 记一条启动信息
pub fn attach_app_dir(app: &AppHandle) {
    let logger = init_early();
    match log_dir(app) {
        Ok(dir) => {
            if let Err(error) = logger.attach_dir(&dir) {
                log::warn!("文件日志不可用：{error}");
            }
        }
        Err(error) => log::warn!("无法定位应用数据目录，本次运行只输出到控制台：{error}"),
    }
    apply_saved_level(app);
    log_startup_banner(app);
}

/// 日志目录：`<应用数据目录>/logs`
pub fn log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(LOG_DIR_NAME))
        .map_err(|e| format!("无法定位应用数据目录: {e}"))
}

/// 读取用户保存的日志级别并应用（读不到就用内置默认值，不打扰用户）
pub fn apply_saved_level(app: &AppHandle) {
    let spec = storage::read_state(app, LOG_LEVEL_KEY)
        .ok()
        .flatten()
        .and_then(|value| value.as_str().map(|text| text.trim().to_string()))
        .filter(|text| !text.is_empty());
    if let Some(spec) = spec {
        if let Err(error) = init_early().set_level(&spec) {
            log::warn!("日志级别设置无效（{spec}）：{error}");
        }
    }
}

/// 启动横幅：版本、平台、数据目录、日志文件、生效级别 —— 用户报问题时先要的就是这几行
fn log_startup_banner(app: &AppHandle) {
    let logger = init_early();
    let file = logger
        .file_path()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "（未启用文件日志）".to_string());
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|dir| dir.display().to_string())
        .unwrap_or_else(|_| "（未知）".to_string());
    log::info!(
        "ReaderX {} 启动 os={} arch={} 级别={} 日志={file}",
        app.package_info().version,
        std::env::consts::OS,
        std::env::consts::ARCH,
        logger.level_spec()
    );
    log::info!("应用数据目录 {data_dir}");
    if let Some(reason) = logger.file_disabled_reason() {
        log::warn!("文件日志未启用：{reason}");
    }
}

// ---------------------------------------------------------------------------
// 前端可调用的日志 command
// ---------------------------------------------------------------------------

/// 日志设施当前状态（前端展示 + 切换级别后回传）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogInfo {
    /// 日志文件路径；未启用文件日志为空串
    pub path: String,
    /// 当前生效的级别规格
    pub level: String,
    /// 是否在写文件日志
    pub file_enabled: bool,
    /// 文件日志不可用时的原因
    pub file_error: String,
}

/// 一次日志读取的结果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogTail {
    /// 按时间从旧到新的日志文本（空串 = 还没有日志）
    pub text: String,
    #[serde(flatten)]
    pub info: LogInfo,
}

fn log_info(logger: &Logger) -> LogInfo {
    LogInfo {
        path: logger
            .file_path()
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
        level: logger.level_spec(),
        file_enabled: logger.file_enabled(),
        file_error: logger.file_disabled_reason().unwrap_or_default(),
    }
}

/// 读取日志尾巴；文件日志不可用时也返回正常结构（把原因放在 `fileError` 里），
/// 让设置页能显示「为什么没有日志」，而不是抛一个用户看不懂的错误。
fn tail_payload(max_lines: usize, min_level: Option<LevelFilter>) -> LogTail {
    let logger = init_early();
    let mut info = log_info(logger);
    let text = match logger.read_tail(max_lines, min_level.unwrap_or(LevelFilter::Trace)) {
        Ok(text) => text,
        Err(error) => {
            info.file_enabled = false;
            if info.file_error.is_empty() {
                info.file_error = error;
            }
            String::new()
        }
    };
    LogTail { text, info }
}

/// 前端回传的一条日志
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebLogRecord {
    /// `error` / `warn` / `info` / `debug` / `trace`（认不出按 info 处理）
    pub level: String,
    /// 前端模块名，写进正文的 `[scope]` 前缀
    pub scope: String,
    pub message: String,
}

/// 写入一批前端日志（warn / error 会连 WebView 的上下文一起留在同一个文件里）。
///
/// 攒批 + async：前端 400 ms 一批回传，一次 IPC 写完一批；同步命令跑在主线程上，
/// 而这里要做文件 I/O —— 主线程绝不能被日志拖住。
#[tauri::command]
pub async fn readerx_log_write(records: Vec<WebLogRecord>) -> Result<(), String> {
    for record in records {
        let level = match record.level.trim().to_ascii_lowercase().as_str() {
            "error" => Level::Error,
            "warn" | "warning" => Level::Warn,
            "debug" => Level::Debug,
            "trace" => Level::Trace,
            // 认不出的级别按 info 处理：日志本身不该因为一个字符串把调用方打断
            _ => Level::Info,
        };
        let scope = record.scope.trim();
        // 前端报错里常带原始地址（WebDAV / 图片下载），统一过一道脱敏再落盘：
        // 日志文件是要给用户复制出来贴进 issue 的，URL 里的凭据不能跟着出门
        let message = readerx_log::redact::urls_in_text(&record.message);
        let message = if scope.is_empty() {
            message
        } else {
            format!("[{scope}] {message}")
        };
        log::log!(target: WEB_TARGET, level, "{message}");
    }
    Ok(())
}

/// 读取日志尾巴；`min_level` 为 `info` / `warn` / `error` 时只返回该级别以上的记录
#[tauri::command]
pub async fn readerx_log_tail(
    max_lines: Option<usize>,
    min_level: Option<String>,
) -> Result<LogTail, String> {
    let min_level = match min_level.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(spec) => Some(
            readerx_log::Filter::parse(spec)
                .map_err(|e| format!("无法识别的日志级别: {e}"))?
                .global(),
        ),
    };
    Ok(tail_payload(
        max_lines.unwrap_or(2_000).min(MAX_TAIL_LINES),
        min_level,
    ))
}

/// 清空日志文件（当前 + 历史）
#[tauri::command]
pub async fn readerx_log_clear() -> Result<(), String> {
    init_early().clear()
}

/// 修改日志级别并记住（设置页「详细日志」开关 / 排障时临时开 debug）
#[tauri::command]
pub async fn readerx_log_set_level(app: AppHandle, level: String) -> Result<LogInfo, String> {
    let spec = level.trim().to_string();
    // 先校验再落盘：非法级别不该被记住，否则下次启动还得再报一次错
    readerx_log::Filter::parse(&spec).map_err(|e| format!("无法识别的日志级别: {e}"))?;
    init_early().set_level(&spec)?;
    storage::write_state(&app, LOG_LEVEL_KEY, &serde_json::json!(spec))?;
    log::info!("日志级别已切换为 {spec}");
    Ok(log_info(init_early()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// IPC 返回值不做字段名转换，前端按 camelCase 取值（与 PickedBookFile 同一约定）
    #[test]
    fn log_tail_wire_format_is_camel_case() {
        let value = serde_json::to_value(LogTail {
            text: "line".to_string(),
            info: LogInfo {
                path: "/tmp/readerx.log".to_string(),
                level: "info".to_string(),
                file_enabled: true,
                file_error: String::new(),
            },
        })
        .expect("序列化 LogTail 失败");
        assert_eq!(value["fileEnabled"], true);
        assert_eq!(value["fileError"], "");
        assert_eq!(value["path"], "/tmp/readerx.log");
        assert_eq!(value["level"], "info");
        assert_eq!(value["text"], "line");
    }
}

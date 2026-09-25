//! # readerx-log —— ReaderX 统一日志设施
//!
//! 一个进程只装一个 logger（[`init`]），App、书源引擎、独立二进制共用它；
//! 业务代码一律用 `log` 门面的宏写日志（`log::info!` / `log::warn!` …），
//! 输出目标与级别由这里统一决定，代码里不再出现散落的 `println!` / `eprintln!`。
//!
//! ## 输出目标
//!
//! | 目标 | 开关 | 用途 |
//! | ---- | ---- | ---- |
//! | 文件 | [`LogConfig::dir`] | **主要目标**：Android 上用户拿不到标准输出，出问题要能事后翻日志 |
//! | 标准错误 | [`LogConfig::stderr`] | 桌面 / CLI 直接看；Android 上由 logcat 目标接管 |
//! | logcat | [`LogConfig::logcat`] | Android 真机 `adb logcat -s readerx` 实时看 |
//!
//! ## 文件布局与轮转
//!
//! ```text
//! <数据目录>/logs/2026-09-25/readerx-150405.log
//!                            └── 当天 15:04:05 启动的那一次运行
//! ```
//!
//! **一天一个目录、一次运行一个文件**（布局与命名见 [`layout`]，写入见 [`file`]）：
//! 用户报问题时先要确定的是「哪天、哪一次启动」，路径本身就把这两件事说清楚了。
//! 单文件超过 [`DEFAULT_MAX_BYTES`] 仍在本次运行内轮转（`.log.1` / `.log.2`…），
//! 目录整体按 [`DEFAULT_KEEP_DAYS`] 天 + [`DEFAULT_MAX_TOTAL_BYTES`] 总量淘汰（见 [`retention`]）。
//!
//! ## 级别
//!
//! 级别规格按 `READERX_LOG` 风格的字符串解析（见 [`Filter`]）：
//! `info`、`debug`、`off`、`readerx_source=debug,warn`。环境变量 `READERX_LOG`
//! 优先于传入的规格 —— 不改代码、不改配置就能临时开详单，是排障时最省事的一条路。
//!
//! ## 不要写进日志的东西
//!
//! Cookie、token、密码、localStorage 快照一律只记**数量**或用 [`redact::secret`]
//! 打码；URL 走 [`redact::url`]。日志会被用户导出、贴进 issue，泄了就收不回来。

mod file;
mod filter;
mod layout;
mod read;
mod record;
mod retention;

mod android;

pub use file::{
    FileLimits, DEFAULT_KEEP_DAYS, DEFAULT_KEEP_FILES, DEFAULT_MAX_BYTES, DEFAULT_MAX_TOTAL_BYTES,
};
pub use filter::{level_name as level_filter_name, Filter};
pub use record::{level_name, level_of_line, timestamp};
pub use retention::LogRun;

pub mod redact;

use file::FileSink;
use log::{Level, LevelFilter, Log, Metadata, Record};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

/// 环境变量：覆盖调用方传入的级别规格（`READERX_LOG=debug`）
pub const LEVEL_ENV: &str = "READERX_LOG";

/// 日志文件所在目录名（相对数据目录）
pub const LOG_DIR_NAME: &str = "logs";

/// 写盘连续失败多少次后放弃文件目标（避免每写一条都做一次失败的 syscall）
const MAX_WRITE_FAILURES: u32 = 3;

static LOGGER: OnceLock<Logger> = OnceLock::new();

/// 日志配置
#[derive(Debug, Clone)]
pub struct LogConfig {
    /// 应用名：日志文件名与 logcat tag 都用它（`readerx` / `readerx-source`）
    pub app: String,
    /// 级别规格（会被 `READERX_LOG` 覆盖）
    pub level: String,
    /// 文件日志目录；`None` = 只打标准错误 / logcat
    pub dir: Option<PathBuf>,
    /// 是否写标准错误
    pub stderr: bool,
    /// 是否写 Android logcat（非 Android 平台无效果）
    pub logcat: bool,
    /// 单文件体积、轮转份数、保留天数与总量上限
    pub limits: FileLimits,
}

impl LogConfig {
    /// 默认配置：级别取 `READERX_LOG`，否则 debug 构建 debug / release 构建 info
    pub fn new(app: impl Into<String>) -> Self {
        Self {
            app: app.into(),
            level: default_level_spec().to_string(),
            dir: None,
            stderr: true,
            logcat: true,
            limits: FileLimits::default(),
        }
    }

    /// 指定日志目录（`<数据目录>/logs`）
    pub fn with_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.dir = Some(dir.into());
        self
    }

    /// 指定级别规格
    pub fn with_level(mut self, spec: impl Into<String>) -> Self {
        self.level = spec.into();
        self
    }

    /// 关闭标准错误输出（例如 Android 上只想要 logcat + 文件）
    pub fn without_stderr(mut self) -> Self {
        self.stderr = false;
        self
    }
}

/// 安装（或复用）全局 logger，返回它的句柄。
///
/// 可重复调用：第二次起只把本次配置里能改的部分（级别 / 目录 / 输出开关）应用上去。
/// 这样 App 可以「进程一开始先装标准错误，拿到应用数据目录后再挂文件目标」，
/// 启动早期（还不知道数据目录时）的日志也不会丢。
pub fn init(config: LogConfig) -> &'static Logger {
    let logger = LOGGER.get_or_init(|| Logger::new(&config));
    logger.apply(&config);
    // 第二次 set_logger 会失败（已安装），忽略即可；max_level 每次都要跟上
    let _ = log::set_logger(logger);
    log::set_max_level(logger.max_level());
    logger
}

/// 已安装的 logger（未安装时 `None`）
pub fn logger() -> Option<&'static Logger> {
    LOGGER.get()
}

/// 是否已安装
pub fn is_initialized() -> bool {
    LOGGER.get().is_some()
}

/// 进程级日志器
pub struct Logger {
    app: String,
    inner: Mutex<Inner>,
}

struct Inner {
    filter: Filter,
    sink: Option<FileSink>,
    stderr: bool,
    logcat: bool,
    /// 写盘失败计数：连续失败到 [`MAX_WRITE_FAILURES`] 就关掉文件目标并说明一次
    write_failures: u32,
    /// 文件目标被放弃的原因（只提示一次）
    file_disabled_reason: Option<String>,
}

impl Inner {
    /// 是不是已经挂在这个「目录 + 应用名」上：是的话重复 init / 重复挂载都继续写同一份文件
    /// （日志文件按启动时间分，每次 init 都换一份会把同一次运行的日志劈成两半）
    fn attached_to(&self, dir: &Path, app: &str) -> bool {
        self.sink
            .as_ref()
            .map(|sink| sink.root() == dir && sink.app() == layout::sanitize_app(app))
            .unwrap_or(false)
    }
}

impl Logger {
    fn new(config: &LogConfig) -> Self {
        let mut inner = Inner {
            filter: Filter::parse(&config.level).unwrap_or_default(),
            sink: None,
            stderr: config.stderr,
            logcat: config.logcat,
            write_failures: 0,
            file_disabled_reason: None,
        };
        if let Some(dir) = &config.dir {
            attach(&mut inner, dir, &config.app, config.limits);
        }
        Self {
            app: config.app.clone(),
            inner: Mutex::new(inner),
        }
    }

    /// 应用一份新配置（可重复调用）
    fn apply(&self, config: &LogConfig) {
        let mut inner = self.lock();
        inner.stderr = config.stderr;
        inner.logcat = config.logcat;
        if let Some(dir) = &config.dir {
            if !inner.attached_to(dir, &config.app) {
                attach(&mut inner, dir, &config.app, config.limits);
            }
        }
        let spec = effective_spec(&config.level);
        match Filter::parse(&spec) {
            Ok(filter) => inner.filter = filter,
            // 规格写错（`READERX_LOG=chatty` 这类）必须说明，否则用户只会觉得「设置没生效」
            Err(error) => eprintln!("[readerx-log] 忽略无法解析的级别规格 {spec:?}：{error}"),
        }
    }

    /// 应用名（日志文件名 / logcat tag）
    pub fn app(&self) -> &str {
        &self.app
    }

    /// 挂载（或切换）文件日志目录，返回本次运行的日志文件完整路径。
    ///
    /// 已经挂在同一个目录上就直接返回当前文件，不会另开一份。
    pub fn attach_dir(&self, dir: impl Into<PathBuf>) -> Result<PathBuf, String> {
        let dir = dir.into();
        let mut inner = self.lock();
        let app = self.app.clone();
        if !inner.attached_to(&dir, &app) {
            attach(&mut inner, &dir, &app, FileLimits::default());
        }
        inner
            .sink
            .as_ref()
            .map(|sink| sink.path().to_path_buf())
            .ok_or_else(|| {
                inner
                    .file_disabled_reason
                    .clone()
                    .unwrap_or_else(|| "文件日志不可用".to_string())
            })
    }

    /// 设置级别规格（写盘失败等情形不影响级别切换）
    pub fn set_level(&self, spec: &str) -> Result<(), String> {
        let effective = effective_spec(spec);
        let filter = Filter::parse(&effective)?;
        let mut inner = self.lock();
        inner.filter = filter;
        let max = inner.filter.max_level();
        drop(inner);
        log::set_max_level(max);
        Ok(())
    }

    /// 当前生效的级别规格
    pub fn level_spec(&self) -> String {
        self.lock().filter.spec()
    }

    /// 记一条来自日志门面之外的文本（前端回传的日志、外部进程输出）。
    ///
    /// 格式与 `log` 门面的记录完全一致（同一份格式化代码），因此多行正文照样缩进成续行。
    pub fn write_line(&self, level: Level, target: &str, message: &str) {
        if !self.enabled_for(level, target) {
            return;
        }
        self.write_formatted(level, &record::format_line(level, target, message));
    }

    /// 日志目录（未挂载文件目标时 `None`）：日期目录都在它下面，跨天也不变
    pub fn dir(&self) -> Option<PathBuf> {
        self.lock()
            .sink
            .as_ref()
            .map(|sink| sink.root().to_path_buf())
    }

    /// 当前写入的日志文件路径（跨天后是新的那一份）
    pub fn file_path(&self) -> Option<PathBuf> {
        self.lock().sink.as_ref().map(|sink| sink.path().to_path_buf())
    }

    /// 是否在写文件日志
    pub fn file_enabled(&self) -> bool {
        self.lock().sink.is_some()
    }

    /// 文件目标被放弃的原因（写了很久却看不到日志时，这个原因就是答案）
    pub fn file_disabled_reason(&self) -> Option<String> {
        self.lock().file_disabled_reason.clone()
    }

    /// 最近若干份日志（新 → 旧，含正在写的这一份）；文件日志不可用时为空
    pub fn runs(&self, limit: usize) -> Vec<LogRun> {
        match self.lock().sink.as_ref() {
            Some(sink) => sink.runs(limit),
            None => Vec::new(),
        }
    }

    /// 读本次运行的日志尾巴（含它的轮转备份，从旧到新），只保留 `min_level` 以上的记录
    pub fn read_tail(&self, max_lines: usize, min_level: LevelFilter) -> Result<String, String> {
        let mut inner = self.lock();
        match inner.sink.as_mut() {
            Some(sink) => Ok(sink.read_current(max_lines.clamp(1, 20_000), min_level)),
            None => Err(inner
                .file_disabled_reason
                .clone()
                .unwrap_or_else(|| "当前未启用文件日志".to_string())),
        }
    }

    /// 读指定的一次运行（[`Logger::runs`] 给出的路径）；路径不在本应用的日志目录下时报错
    pub fn read_run(
        &self,
        path: impl AsRef<Path>,
        max_lines: usize,
        min_level: LevelFilter,
    ) -> Result<String, String> {
        let mut inner = self.lock();
        match inner.sink.as_mut() {
            Some(sink) => sink.read_run(path.as_ref(), max_lines.clamp(1, 20_000), min_level),
            None => Err(inner
                .file_disabled_reason
                .clone()
                .unwrap_or_else(|| "当前未启用文件日志".to_string())),
        }
    }

    /// 清空日志（所有日期的文件 + 历史文件）
    pub fn clear(&self) -> Result<(), String> {
        let mut inner = self.lock();
        match inner.sink.as_mut() {
            Some(sink) => sink.clear(),
            None => Err("当前未启用文件日志".to_string()),
        }
    }

    /// 立即落盘
    pub fn flush(&self) {
        if let Some(sink) = self.lock().sink.as_mut() {
            sink.flush();
        }
    }

    /// 门面上限（`log::set_max_level` 用）
    pub fn max_level(&self) -> LevelFilter {
        self.lock().filter.max_level()
    }

    fn enabled_for(&self, level: Level, target: &str) -> bool {
        self.lock().filter.enabled(level, target)
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // 日志内部出过 panic 也不能把后续日志全部卡死
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 已经格式化好的一行：写标准错误 / logcat / 文件
    fn write_formatted(&self, level: Level, line: &str) {
        let mut inner = self.lock();
        if inner.stderr && !cfg!(target_os = "android") {
            eprintln!("{line}");
        }
        if inner.logcat {
            android::write(level, &self.app, line);
        }
        let Some(sink) = inner.sink.as_mut() else {
            return;
        };
        if let Err(error) = sink.write_line(line) {
            inner.write_failures += 1;
            if inner.write_failures >= MAX_WRITE_FAILURES {
                inner.sink = None;
                inner.file_disabled_reason = Some(error.clone());
                // 直接写标准错误：日志系统自己坏了，不能只告诉日志
                eprintln!("[readerx-log] 文件日志已停用：{error}");
            }
        } else {
            inner.write_failures = 0;
        }
    }
}

impl Log for Logger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        self.enabled_for(metadata.level(), metadata.target())
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = record::format_record(record);
        self.write_formatted(record.level(), &line);
    }

    fn flush(&self) {
        Logger::flush(self);
    }
}

fn attach(inner: &mut Inner, dir: &Path, app: &str, limits: FileLimits) {
    match FileSink::open(dir, app, limits) {
        Ok(sink) => {
            inner.sink = Some(sink);
            inner.write_failures = 0;
            inner.file_disabled_reason = None;
        }
        Err(error) => {
            inner.sink = None;
            inner.file_disabled_reason = Some(error.clone());
            eprintln!("[readerx-log] 文件日志不可用：{error}");
        }
    }
}

/// 环境变量优先于传入规格（`READERX_LOG` 是排障时的最高优先级开关）
fn effective_spec(spec: &str) -> String {
    match std::env::var(LEVEL_ENV) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => spec.to_string(),
    }
}

fn default_level_spec() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "info"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("readerx-log-lib-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    /// 直接构造 logger（不装全局：一个进程只能装一个，测试里各造各的更方便）
    fn test_logger(dir: &Path, level: &str) -> Logger {
        Logger::new(&LogConfig::new("readerx-test").with_dir(dir).with_level(level))
    }

    #[test]
    fn logger_writes_records_to_file_and_respects_level() {
        let dir = temp_dir("level");
        let logger = test_logger(&dir, "info");
        assert!(!logger.enabled_for(Level::Debug, "t"), "info 级别不应放行 debug");
        assert!(logger.enabled_for(Level::Warn, "t"));
        logger.set_level("debug").unwrap();
        assert!(logger.enabled_for(Level::Debug, "t"));
        logger.write_line(Level::Info, "web", "[books] 导入完成");
        logger.set_level("warn").unwrap();
        logger.write_line(Level::Info, "web", "这条应被过滤");
        let tail = logger.read_tail(50, LevelFilter::Trace).unwrap();
        assert!(tail.contains("[books] 导入完成"), "{tail}");
        assert!(!tail.contains("这条应被过滤"), "{tail}");
        assert_eq!(logger.level_spec(), "warn");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 日志落在「日期目录 / 以时刻命名的文件」里，目录与文件路径都能报给界面
    #[test]
    fn attach_dir_reports_a_dated_run_file_and_clear_empties_it() {
        let dir = temp_dir("attach");
        let logger = Logger::new(&LogConfig::new("readerx-attach").without_stderr());
        assert!(!logger.file_enabled());
        let path = logger.attach_dir(&dir).unwrap();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        assert!(
            name.starts_with("readerx-attach-") && name.ends_with(".log"),
            "{}",
            path.display()
        );
        // 日期目录名就是文件所在的上一级目录，且形如 2026-09-25
        let day = path
            .parent()
            .and_then(|dir| dir.file_name())
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(layout::is_day_name(&day), "{day}");
        assert_eq!(logger.dir().unwrap(), dir);
        // 重复挂载同一个目录不该另开一份文件：同一次运行的日志不能被劈成两半
        assert_eq!(logger.attach_dir(&dir).unwrap(), path);
        logger.write_line(Level::Error, "test", "先写一条");
        assert!(logger.read_tail(10, LevelFilter::Trace).unwrap().contains("先写一条"));
        // 运行列表里能选中本次运行，并按它的路径读回同一份日志
        let runs = logger.runs(10);
        assert_eq!(runs.len(), 1);
        assert!(runs[0].current);
        assert_eq!(runs[0].path, path);
        let text = logger.read_run(&runs[0].path, 10, LevelFilter::Trace).unwrap();
        assert!(text.contains("先写一条"), "{text}");
        assert!(
            logger.read_run("/etc/passwd", 10, LevelFilter::Trace).is_err(),
            "目录之外的路径不该被读取"
        );
        logger.clear().unwrap();
        assert!(logger.read_tail(10, LevelFilter::Trace).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_tail_without_file_target_gives_a_readable_reason() {
        let logger = Logger::new(&LogConfig::new("readerx-nofile").without_stderr());
        let error = logger.read_tail(10, LevelFilter::Trace).unwrap_err();
        assert!(error.contains("文件日志"), "{error}");
        assert!(logger.runs(10).is_empty());
    }
}

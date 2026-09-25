//! 文件落盘：一次运行一个文件、一天一个目录，单文件写满体积上限后轮转。
//!
//! 布局与命名见 [`crate::layout`]，为什么这么分见那里的模块注释。这里只管三件事：
//!
//! - **开**：确定本次运行属于哪一天、文件名里的时刻是什么（日期取本地时间）；
//! - **写**：追加一行；发现这一行的日期和当前文件不一致（跨天）就换目录换文件，
//!   发现当前文件要超上限就轮转成 `.1` / `.2`；
//! - **读 / 清**：读交给 [`crate::read`]，清空交给 [`crate::retention`]。
//!
//! 为什么自己写而不引依赖：需求只有「一行一行追加 + 跨天换文件 + 超限改名 + 读尾巴 + 清空」，
//! 必须能在 Android / Windows / Linux 上一致工作；引 `tracing-appender` 之类反而要把日志门面
//! 再包一层，而那些库也大多只做「按天」或「按体积」其中一件。

use crate::layout;
use crate::read;
use crate::record;
use crate::retention;
use log::LevelFilter;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

/// 单个日志文件默认上限（超出即轮转）
pub const DEFAULT_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// 一次运行默认保留的轮转备份份数（连同主文件，最多占 `(keep + 1) * max_bytes`）
pub const DEFAULT_KEEP_FILES: usize = 3;
/// 默认保留最近多少天（含今天）
pub const DEFAULT_KEEP_DAYS: usize = 7;
/// 日志目录默认总量上限：按天保留挡不住详细日志的量，再加一道总量兜底
pub const DEFAULT_MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

/// 文件与保留策略
#[derive(Debug, Clone, Copy)]
pub struct FileLimits {
    /// 单个文件体积上限
    pub max_bytes: u64,
    /// 一次运行内保留的轮转备份份数
    pub keep_files: usize,
    /// 保留最近多少天（含今天）
    pub keep_days: usize,
    /// 日志目录总量上限
    pub max_total_bytes: u64,
}

impl Default for FileLimits {
    fn default() -> Self {
        Self {
            max_bytes: DEFAULT_MAX_BYTES,
            keep_files: DEFAULT_KEEP_FILES,
            keep_days: DEFAULT_KEEP_DAYS,
            max_total_bytes: DEFAULT_MAX_TOTAL_BYTES,
        }
    }
}

impl FileLimits {
    /// 夹进安全区间：配置写错不该让日志把磁盘写满，也不该把保留天数抹成 0
    /// （`keep_files` 下限是 1：0 会让轮转变成「删掉当前文件再新建」，等于白丢日志）
    fn sanitized(self) -> Self {
        let max_bytes = self.max_bytes.max(64 * 1024);
        Self {
            max_bytes,
            keep_files: self.keep_files.clamp(1, 20),
            keep_days: self.keep_days.clamp(1, 90),
            max_total_bytes: self.max_total_bytes.max(max_bytes),
        }
    }
}

pub(crate) struct FileSink {
    /// 日志根目录（`<数据目录>/logs`）：日期目录都在它下面
    root: PathBuf,
    /// 净化过的应用名（文件名前缀）
    app: String,
    /// 当前日期目录
    dir: PathBuf,
    /// 当前写入的文件
    path: PathBuf,
    file: Option<File>,
    /// 当前文件已写入字节数（避免每次写前 `metadata()`，日志热路径只做加法）
    written: u64,
    limits: FileLimits,
    /// 当前文件属于哪一天（`2026-09-25`），跨天时换文件
    day: String,
}

impl FileSink {
    /// 打开本次运行的日志文件；目录不可写时返回可读错误，由调用方降级为只打标准错误
    pub(crate) fn open(root: &Path, app: &str, limits: FileLimits) -> Result<Self, String> {
        let app = layout::sanitize_app(app);
        let limits = limits.sanitized();
        fs::create_dir_all(root).map_err(|e| format!("创建日志目录 {} 失败: {e}", root.display()))?;
        // 顺序要紧：先淘汰过期日志，再迁移旧版扁平文件 ——
        // 反过来会把刚搬进来、按修改时间算早已过期的历史日志在同一次启动里删掉
        if let Err(error) = retention::prune(root, &app, &limits, None) {
            eprintln!("[readerx-log] 清理过期日志失败：{error}");
        }
        retention::migrate_legacy(root, &app);

        let (day, clock) = record::local_stamp();
        let dir = root.join(&day);
        let path = dir.join(layout::run_file_name(&app, &clock));
        fs::create_dir_all(&dir)
            .map_err(|e| format!("创建日志目录 {} 失败: {e}", dir.display()))?;
        let (file, written) = open_append(&path)?;
        Ok(Self {
            root: root.to_path_buf(),
            app,
            dir,
            path,
            file: Some(file),
            written,
            limits,
            day,
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn app(&self) -> &str {
        &self.app
    }

    /// 当前写入的文件（跨天后会变）
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// 追加一行（自动补换行）；写失败只报错不 panic —— 日志挂掉不能带崩业务
    pub(crate) fn write_line(&mut self, line: &str) -> Result<(), String> {
        // 跨天：换日期目录、换一份新文件。日期直接读这一行的前缀（写入时间的本地日期），
        // 不再取一次系统时钟，也就不会出现「记录写着 09-25、文件落在 09-26」的错位。
        // 日期必须是日期形状：万一某行「看着像记录行」却不是（续行正好凑出同样的分隔符），
        // 宁可不换文件，也不去建一个扫描与淘汰都认不出的目录
        if let Some((day, clock)) = record::stamp_of_line(line) {
            if day != self.day && layout::is_day_name(&day) {
                self.start_day(&day, &clock)?;
            }
        }
        let bytes = line.len() as u64 + 1;
        if self.written + bytes > self.limits.max_bytes {
            self.rotate()?;
        }
        let file = self.ensure_open()?;
        file.write_all(line.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|e| format!("写入日志失败: {e}"))?;
        self.written += bytes;
        Ok(())
    }

    /// 立即落盘（崩溃 / 退出前调用，保证最后几条记录不留在内核缓冲里）
    pub(crate) fn flush(&mut self) {
        if let Some(file) = self.file.as_mut() {
            let _ = file.flush();
        }
    }

    /// 清空全部日志（所有日期目录 + 历史文件），随后继续往当前这份写
    pub(crate) fn clear(&mut self) -> Result<(), String> {
        self.file = None;
        retention::clear(&self.root, &self.app)?;
        // 清空会把空掉的日期目录一并删掉（包括当前这一天），重新建回来再打开当前文件
        fs::create_dir_all(&self.dir)
            .map_err(|e| format!("创建日志目录 {} 失败: {e}", self.dir.display()))?;
        let (file, written) = open_append(&self.path)?;
        self.file = Some(file);
        self.written = written;
        Ok(())
    }

    /// 读取本次运行的日志（当前文件 + 它自己的轮转备份）
    pub(crate) fn read_current(&mut self, max_lines: usize, min_level: LevelFilter) -> String {
        self.flush();
        read::read_run(&self.path, self.limits.keep_files, max_lines, min_level)
    }

    /// 读取指定的一次运行；路径不属于本应用的日志目录时报错（读取入口不接受任意路径）
    pub(crate) fn read_run(
        &self,
        path: &Path,
        max_lines: usize,
        min_level: LevelFilter,
    ) -> Result<String, String> {
        if !retention::is_run_path(&self.root, &self.app, path) {
            return Err(format!("不是本应用的日志文件: {}", path.display()));
        }
        Ok(read::read_run(
            path,
            self.limits.keep_files,
            max_lines,
            min_level,
        ))
    }

    /// 最近若干份日志（新 → 旧，含本次运行）
    pub(crate) fn runs(&self, limit: usize) -> Vec<retention::LogRun> {
        retention::list_runs(&self.root, &self.app, Some(&self.path), limit)
    }

    /// 换到新的一天：新日期目录 + 以当前时刻命名的新文件，并顺手清理过期日志
    fn start_day(&mut self, day: &str, clock: &str) -> Result<(), String> {
        self.flush();
        self.file = None;
        let dir = self.root.join(day);
        fs::create_dir_all(&dir)
            .map_err(|e| format!("创建日志目录 {} 失败: {e}", dir.display()))?;
        self.dir = dir;
        self.path = self.dir.join(layout::run_file_name(&self.app, clock));
        self.day = day.to_string();
        let (file, written) = open_append(&self.path)?;
        self.file = Some(file);
        self.written = written;
        if let Err(error) = retention::prune(&self.root, &self.app, &self.limits, Some(&self.path)) {
            eprintln!("[readerx-log] 清理过期日志失败：{error}");
        }
        Ok(())
    }

    /// 当前文件写满：`log` → `log.1` → `log.2` …，最旧的一份丢弃
    fn rotate(&mut self) -> Result<(), String> {
        self.flush();
        self.file = None;
        let keep = self.limits.keep_files;
        let _ = fs::remove_file(layout::rotated_path(&self.path, keep));
        for index in (1..keep).rev() {
            rename(
                &layout::rotated_path(&self.path, index),
                &layout::rotated_path(&self.path, index + 1),
            )?;
        }
        rename(&self.path, &layout::rotated_path(&self.path, 1))?;
        let (file, written) = open_append(&self.path)?;
        self.file = Some(file);
        self.written = written;
        Ok(())
    }

    fn ensure_open(&mut self) -> Result<&mut File, String> {
        if self.file.is_none() {
            let (file, written) = open_append(&self.path)?;
            self.file = Some(file);
            self.written = written;
        }
        self.file
            .as_mut()
            .ok_or_else(|| "日志文件句柄不可用".to_string())
    }
}

/// 以追加方式打开，并返回当前体积。
///
/// 目录不在时建一次再试：日期目录可能刚被另一个进程当作空目录清掉（清理过期日志会删空目录），
/// 此时这一次写入不该白白丢掉。
fn open_append(path: &Path) -> Result<(File, u64), String> {
    match append(path) {
        Ok(opened) => Ok(opened),
        Err(first) => {
            let Some(dir) = path.parent() else {
                return Err(first);
            };
            if fs::create_dir_all(dir).is_err() {
                return Err(first);
            }
            append(path).map_err(|_| first)
        }
    }
}

fn append(path: &Path) -> Result<(File, u64), String> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("打开日志文件 {} 失败: {e}", path.display()))?;
    let written = file.metadata().map(|m| m.len()).unwrap_or(0);
    Ok((file, written))
}

/// 改名；源文件不存在不算失败（轮转链本来就可能缺几份）
fn rename(from: &Path, to: &Path) -> Result<(), String> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("轮转日志文件失败: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// 每个用例一个独立临时目录（不引 tempfile：只是拼个唯一名字）
    fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "readerx-log-test-{}-{}-{}",
            std::process::id(),
            tag,
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn limits(max_bytes: u64, keep_files: usize) -> FileLimits {
        FileLimits {
            max_bytes: max_bytes.max(64 * 1024),
            keep_files,
            ..FileLimits::default()
        }
    }

    /// 指定日期的记录行（跨天用例要能伪造日期，不能只靠系统时钟）
    fn line_on(day: &str, message: &str) -> String {
        format!("{day} 03:04:05.006 INFO  test: {message}")
    }

    fn line(message: &str) -> String {
        line_on(&record::local_stamp().0, message)
    }

    #[test]
    fn writes_into_a_day_directory_named_after_the_record() {
        let root = temp_dir("append");
        let mut sink = FileSink::open(&root, "readerx", FileLimits::default()).unwrap();
        let (day, clock) = record::local_stamp();
        assert_eq!(
            sink.path(),
            root.join(&day).join(format!("readerx-{clock}.log"))
        );
        sink.write_line(&line("one")).unwrap();
        sink.write_line(&line("two")).unwrap();
        let tail = sink.read_current(10, LevelFilter::Trace);
        assert!(tail.contains("one") && tail.contains("two"), "{tail}");
        let _ = fs::remove_dir_all(&root);
    }

    /// 跨天：新的一天用新目录 + 新文件，两边内容各归各的
    #[test]
    fn crossing_midnight_opens_a_file_in_the_new_day() {
        let root = temp_dir("midnight");
        let mut sink = FileSink::open(&root, "readerx", FileLimits::default()).unwrap();
        let today = record::local_stamp().0;
        let yesterday = record::day_before(1);
        sink.write_line(&line_on(&yesterday, "昨天的")).unwrap();
        sink.write_line(&line_on(&today, "今天的")).unwrap();
        assert_eq!(
            sink.path().parent(),
            Some(root.join(&today).as_path()),
            "换天后当前文件应落在新的一天"
        );
        let yesterday_text =
            fs::read_to_string(root.join(&yesterday).join("readerx-030405.log")).unwrap();
        assert!(yesterday_text.contains("昨天的"), "{yesterday_text}");
        assert!(
            sink.read_current(10, LevelFilter::Trace).contains("今天的"),
            "跨天前的记录不该混进新文件"
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// 轮转仍按体积在同一份日志内进行，历史文件可读回
    #[test]
    fn rotates_when_exceeding_max_bytes_and_keeps_history() {
        let root = temp_dir("rotate");
        let mut sink = FileSink::open(&root, "readerx", limits(64 * 1024, 2)).unwrap();
        // 每行 ~200 字节：写满 400 行必然跨过 64 KiB
        for index in 0..400 {
            let padding = "x".repeat(150);
            sink.write_line(&line(&format!("line-{index} {padding}"))).unwrap();
        }
        sink.flush();
        assert!(
            layout::rotated_path(sink.path(), 1).exists(),
            "应产生第 1 份历史日志"
        );
        let tail = sink.read_current(5, LevelFilter::Trace);
        assert!(tail.contains("line-399"), "{tail}");
        // 历史文件里能找到更早的记录，说明轮转没有直接丢掉
        let tail_all = sink.read_current(2000, LevelFilter::Trace);
        assert!(tail_all.contains("line-0 "), "历史记录应可从备份文件读回");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clear_removes_every_day_and_keeps_writing() {
        let root = temp_dir("clear");
        let mut sink = FileSink::open(&root, "readerx", FileLimits::default()).unwrap();
        sink.write_line(&line("gone")).unwrap();
        let yesterday = record::day_before(1);
        fs::create_dir_all(root.join(&yesterday)).unwrap();
        fs::write(root.join(&yesterday).join("readerx-080000.log"), "old day").unwrap();
        sink.clear().unwrap();
        assert!(!root.join(&yesterday).exists(), "其它日期的日志应被清掉");
        assert!(sink.read_current(10, LevelFilter::Trace).is_empty());
        // 清空后仍可继续写入
        sink.write_line(&line("after")).unwrap();
        assert!(sink.read_current(10, LevelFilter::Trace).contains("after"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_flat_log_is_migrated_on_open() {
        let root = temp_dir("legacy");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("readerx.log"), line("升级前的日志")).unwrap();
        let sink = FileSink::open(&root, "readerx", FileLimits::default()).unwrap();
        drop(sink);
        assert!(!root.join("readerx.log").exists(), "旧文件应被搬进日期目录");
        // 迁移的目标名按修改时间取：与本次运行同一秒时会并进本次的文件，
        // 因此这里断言的是「扫描到的日志里能找到旧内容」，而不是具体落在哪个文件
        let merged: String = retention::scan(&root, "readerx")
            .iter()
            .map(|file| fs::read_to_string(&file.path).unwrap_or_default())
            .collect();
        assert!(merged.contains("升级前的日志"), "{merged}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_run_rejects_paths_outside_the_log_directory() {
        let root = temp_dir("reject");
        let sink = FileSink::open(&root, "readerx", FileLimits::default()).unwrap();
        let error = sink
            .read_run(Path::new("/etc/passwd"), 10, LevelFilter::Trace)
            .unwrap_err();
        assert!(error.contains("/etc/passwd"), "{error}");
        let own = sink.path().to_path_buf();
        assert!(sink.read_run(&own, 10, LevelFilter::Trace).is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_directory_is_created_on_open() {
        let root = temp_dir("mkdir").join("nested").join("logs");
        assert!(!root.exists());
        let sink = FileSink::open(&root, "readerx", FileLimits::default()).unwrap();
        assert!(sink.path().parent().unwrap().is_dir());
        let _ = fs::remove_dir_all(root.parent().unwrap().parent().unwrap());
    }

    /// 目录在两次写入之间被删掉（清理空目录 / 用户手动删）：这一次打开要能把目录建回来
    #[test]
    fn opening_recreates_a_missing_day_directory_once() {
        let root = temp_dir("reopen").join("2026-09-25");
        let path = root.join("readerx-150405.log");
        assert!(!root.exists());
        let (_file, written) = open_append(&path).unwrap();
        assert_eq!(written, 0);
        assert!(path.is_file());
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    /// 续行凑巧凑出记录行的分隔符、日期却不是日期：不换目录，也不留下扫描不认的怪目录
    #[test]
    fn a_line_with_a_non_date_prefix_does_not_switch_days() {
        let root = temp_dir("junk-day");
        let mut sink = FileSink::open(&root, "readerx", FileLimits::default()).unwrap();
        let before = sink.path().to_path_buf();
        sink.write_line("    -12345 67:89012.中中").unwrap();
        assert_eq!(sink.path(), before, "不该为一个怪行换文件");
        let days: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(days.len(), 1, "{days:?}");
        assert!(layout::is_day_name(&days[0]), "{days:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn limits_are_clamped_to_safe_values() {
        let limits = FileLimits {
            max_bytes: 1,
            keep_files: 0,
            keep_days: 0,
            max_total_bytes: 0,
        }
        .sanitized();
        assert_eq!(limits.keep_files, 1, "0 份备份会让轮转变成截断，夹到 1");
        assert_eq!(limits.keep_days, 1);
        assert!(limits.max_bytes >= 64 * 1024, "{}", limits.max_bytes);
        assert_eq!(limits.max_total_bytes, limits.max_bytes);
    }
}

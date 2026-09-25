//! 文件落盘：单文件按体积轮转 + 保留若干历史文件。
//!
//! 布局（`<数据目录>/logs/`）：
//!
//! ```text
//! readerx.log      当前写入
//! readerx.log.1    上一份（数字越大越旧）
//! readerx.log.2
//! ```
//!
//! 为什么自己写而不引依赖：需求只有「一行一行追加 + 超限改名 + 读尾巴 + 清空」，
//! 几十行就能写完，且必须能在 Android / Windows / Linux 上一致工作；
//! 引 `tracing-appender` 之类反而要把日志门面再包一层。

use crate::record;
use log::LevelFilter;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

/// 单个日志文件默认上限（超出即轮转）
pub const DEFAULT_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// 默认保留的历史文件份数（连同当前文件，最多占 `(keep + 1) * max_bytes`）
pub const DEFAULT_KEEP_FILES: usize = 3;

pub(crate) struct FileSink {
    dir: PathBuf,
    path: PathBuf,
    file: Option<File>,
    /// 当前文件已写入字节数（避免每次写前 `metadata()`，日志热路径只做加法）
    written: u64,
    max_bytes: u64,
    keep: usize,
}

impl FileSink {
    /// 打开（必要时创建）日志文件；目录不可写时返回可读错误，由调用方降级为只打标准错误
    pub(crate) fn open(
        dir: &Path,
        file_name: &str,
        max_bytes: u64,
        keep: usize,
    ) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|e| format!("创建日志目录 {} 失败: {e}", dir.display()))?;
        let path = dir.join(file_name);
        let (file, written) = open_append(&path)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            path,
            file: Some(file),
            written,
            max_bytes: max_bytes.max(64 * 1024),
            keep: keep.min(20),
        })
    }

    pub(crate) fn dir(&self) -> &Path {
        &self.dir
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// 追加一行（自动补换行）；写失败只报错不 panic —— 日志挂掉不能带崩业务
    pub(crate) fn write_line(&mut self, line: &str) -> Result<(), String> {
        let bytes = line.len() as u64 + 1;
        if self.written + bytes > self.max_bytes {
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

    /// 清空全部日志（当前文件截断 + 删除历史文件）
    pub(crate) fn clear(&mut self) -> Result<(), String> {
        self.file = None;
        for path in self.all_paths() {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => return Err(format!("删除日志文件 {} 失败: {e}", path.display())),
            }
        }
        let (file, written) = open_append(&self.path)?;
        self.file = Some(file);
        self.written = written;
        Ok(())
    }

    /// 读取日志尾巴（跨轮转文件，按时间从旧到新）。
    /// `min_level` 以上的记录才保留，续行跟随其上一条记录一起取舍。
    pub(crate) fn read_tail(&mut self, max_lines: usize, min_level: LevelFilter) -> String {
        self.flush();
        let mut collected: Vec<String> = Vec::new();
        for path in self.all_paths() {
            if collected.len() >= max_lines {
                break;
            }
            let text = match fs::read_to_string(&path) {
                Ok(text) => text,
                Err(e) if e.kind() == ErrorKind::NotFound => continue,
                Err(_) => continue,
            };
            let mut pending: Vec<&str> = Vec::new();
            for line in text.lines().rev() {
                match record::level_of_line(line) {
                    Some(level) => {
                        let keep = level_allowed(level, min_level);
                        if keep {
                            collected.push(line.to_string());
                            // 反向遍历先遇到续行，这里翻回去再压入，保持行序
                            for continuation in pending.drain(..).rev() {
                                collected.push(continuation.to_string());
                            }
                        } else {
                            pending.clear();
                        }
                    }
                    // 续行 / 表头：属于「正向看的下一条记录」，先存着等它出现
                    None => pending.push(line),
                }
                if collected.len() >= max_lines {
                    break;
                }
            }
        }
        collected.reverse();
        collected.join("\n")
    }

    /// 当前文件 + 全部历史文件（新 → 旧）
    fn all_paths(&self) -> Vec<PathBuf> {
        let mut paths = vec![self.path.clone()];
        for index in 1..=self.keep {
            paths.push(backup_path(&self.path, index));
        }
        paths
    }

    /// 轮转：`log` → `log.1` → `log.2` …，最旧的一份丢弃
    fn rotate(&mut self) -> Result<(), String> {
        self.flush();
        self.file = None;
        let oldest = backup_path(&self.path, self.keep);
        let _ = fs::remove_file(&oldest);
        for index in (1..self.keep).rev() {
            let from = backup_path(&self.path, index);
            let to = backup_path(&self.path, index + 1);
            match fs::rename(&from, &to) {
                Ok(()) => {}
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => return Err(format!("轮转日志文件失败: {e}")),
            }
        }
        match fs::rename(&self.path, backup_path(&self.path, 1)) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => return Err(format!("轮转日志文件失败: {e}")),
        }
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

/// `log` → `log.1`
fn backup_path(path: &Path, index: usize) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{index}"));
    path.with_file_name(name)
}

/// 以追加方式打开，并返回当前体积
fn open_append(path: &Path) -> Result<(File, u64), String> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("打开日志文件 {} 失败: {e}", path.display()))?;
    let written = file.metadata().map(|m| m.len()).unwrap_or(0);
    Ok((file, written))
}

fn level_allowed(level: log::Level, min: LevelFilter) -> bool {
    min >= level.to_level_filter()
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn info_line(message: &str) -> String {
        format!("2026-01-02 03:04:05.006 INFO  test: {message}")
    }

    #[test]
    fn writes_appends_and_reads_back() {
        let dir = temp_dir("append");
        let mut sink = FileSink::open(&dir, "readerx.log", DEFAULT_MAX_BYTES, 2).unwrap();
        sink.write_line(&info_line("one")).unwrap();
        sink.write_line(&info_line("two")).unwrap();
        let tail = sink.read_tail(10, LevelFilter::Trace);
        assert!(tail.contains("one") && tail.contains("two"), "{tail}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_when_exceeding_max_bytes_and_keeps_history() {
        let dir = temp_dir("rotate");
        // 下限 64 KiB 会把过小的上限抬回去，这里用合法的小上限
        let mut sink = FileSink::open(&dir, "readerx.log", 64 * 1024, 2).unwrap();
        // 每行 ~200 字节：写满 400 行必然跨过 64 KiB
        for index in 0..400 {
            let padding = "x".repeat(150);
            sink.write_line(&info_line(&format!("line-{index} {padding}")))
                .unwrap();
        }
        sink.flush();
        assert!(backup_path(sink.path(), 1).exists(), "应产生第 1 份历史日志");
        let tail = sink.read_tail(5, LevelFilter::Trace);
        assert!(tail.contains("line-399"), "{tail}");
        // 历史文件里能找到更早的记录，说明轮转没有直接丢掉
        let tail_all = sink.read_tail(2000, LevelFilter::Trace);
        assert!(tail_all.contains("line-0 "), "历史记录应可从备份文件读回");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn level_filter_drops_lower_records_and_keeps_continuations() {
        let dir = temp_dir("filter");
        let mut sink = FileSink::open(&dir, "readerx.log", DEFAULT_MAX_BYTES, 1).unwrap();
        sink.write_line(&info_line("忽略我")).unwrap();
        sink.write_line("2026-01-02 03:04:05.007 ERROR test: 保留我\n    续行")
            .unwrap();
        let tail = sink.read_tail(50, LevelFilter::Warn);
        assert!(!tail.contains("忽略我"), "{tail}");
        assert!(tail.contains("保留我") && tail.contains("续行"), "{tail}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_removes_current_and_backups() {
        let dir = temp_dir("clear");
        let mut sink = FileSink::open(&dir, "readerx.log", DEFAULT_MAX_BYTES, 3).unwrap();
        sink.write_line(&info_line("gone")).unwrap();
        fs::write(backup_path(sink.path(), 1), "old").unwrap();
        sink.clear().unwrap();
        assert!(!backup_path(sink.path(), 1).exists(), "备份文件应被删除");
        assert!(sink.read_tail(10, LevelFilter::Trace).is_empty());
        // 清空后仍可继续写入
        sink.write_line(&info_line("after")).unwrap();
        assert!(sink.read_tail(10, LevelFilter::Trace).contains("after"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_directory_is_created_on_open() {
        let dir = temp_dir("mkdir").join("nested").join("logs");
        assert!(!dir.exists());
        let _sink = FileSink::open(&dir, "readerx.log", DEFAULT_MAX_BYTES, 1).unwrap();
        assert!(dir.is_dir());
        let _ = fs::remove_dir_all(dir.parent().unwrap().parent().unwrap());
    }
}

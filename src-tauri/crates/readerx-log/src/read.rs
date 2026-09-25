//! 读取已落盘的日志：一份日志 = 主文件 + 同一次运行的轮转备份。
//!
//! 读取方向与写入相反：从最新的一份、最后一行往前收，凑够行数就停，更旧的文件根本不会打开
//! —— 界面要的是「最近的 N 行」，不是整段历史。当前这一份仍是整体读进内存再取尾部
//! （单文件上限 2 MB，且只有用户打开日志查看器时才读），换来的是不必为「按行倒着读」
//! 另写一套分块逻辑。收完再整体翻回正序，因此调用方拿到的永远是从旧到新的文本。
//!
//! 续行（多行消息的后续行，以 4 空格缩进、没有级别列）跟着它上面那条记录一起取舍：
//! 记录被级别过滤掉，它的续行也不该露出来。

use crate::layout;
use crate::record;
use log::LevelFilter;
use std::fs;
use std::path::Path;

/// 读取一份日志（从旧到新），只保留 `min_level` 以上的记录，最多 `max_lines` 行文本
pub(crate) fn read_run(
    path: &Path,
    keep_files: usize,
    max_lines: usize,
    min_level: LevelFilter,
) -> String {
    let mut collected: Vec<String> = Vec::new();
    // 0 = 主文件（最新的内容），数字越大越旧
    'files: for rotation in 0..=keep_files {
        let file = layout::rotated_path(path, rotation);
        let Ok(text) = fs::read_to_string(&file) else {
            continue;
        };
        // 反向遍历时先遇到的是续行，它们属于「正向的下一条记录」，先存着
        let mut pending: Vec<&str> = Vec::new();
        for line in text.lines().rev() {
            match record::level_of_line(line) {
                Some(level) if allowed(level, min_level) => {
                    // collected 最后会整体翻转，所以这里按反向遇到的顺序压：
                    // 先续行，再记录行 —— 翻转回来才是「记录行 + 它的续行」
                    collected.extend(pending.drain(..).map(str::to_string));
                    collected.push(line.to_string());
                    if collected.len() >= max_lines {
                        break 'files;
                    }
                }
                // 记录被过滤：它的续行也不该出现
                Some(_) => pending.clear(),
                None => pending.push(line),
            }
        }
    }
    collected.reverse();
    collected.join("\n")
}

fn allowed(level: log::Level, min: LevelFilter) -> bool {
    min >= level.to_level_filter()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "readerx-log-read-{}-{}-{}",
            std::process::id(),
            tag,
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn record_line(level: &str, message: &str) -> String {
        format!("2026-09-25 15:04:05.006 {level:<5} test: {message}")
    }

    #[test]
    fn reads_newest_lines_across_rotation_chain() {
        let dir = temp_dir("chain");
        let base = dir.join("readerx-150405.log");
        // .1 是更早的内容，主文件是最新的
        fs::write(layout::rotated_path(&base, 1), format!("{}\n", record_line("INFO", "旧"))).unwrap();
        fs::write(&base, format!("{}\n", record_line("INFO", "新"))).unwrap();
        let text = read_run(&base, 3, 50, LevelFilter::Trace);
        assert_eq!(text, format!("{}\n{}", record_line("INFO", "旧"), record_line("INFO", "新")));
        let _ = fs::remove_dir_all(&dir);
    }

    /// 续行必须跟在它上面那条记录之后（读取方向与写入相反，最容易在这里写反）
    #[test]
    fn continuation_lines_follow_their_record() {
        let dir = temp_dir("continuation");
        let base = dir.join("readerx-150405.log");
        fs::write(
            &base,
            format!("{}\n    第一行续\n    第二行续\n", record_line("ERROR", "错误详情")),
        )
        .unwrap();
        let text = read_run(&base, 1, 50, LevelFilter::Trace);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3, "{text}");
        assert!(lines[0].contains("错误详情"), "{text}");
        assert_eq!(lines[1], "    第一行续", "{text}");
        assert_eq!(lines[2], "    第二行续", "{text}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn level_filter_drops_records_with_their_continuations() {
        let dir = temp_dir("filter");
        let base = dir.join("readerx-150405.log");
        fs::write(
            &base,
            format!(
                "{}\n    忽略我的续行\n{}\n",
                record_line("INFO", "忽略我"),
                record_line("ERROR", "保留我")
            ),
        )
        .unwrap();
        let text = read_run(&base, 1, 50, LevelFilter::Warn);
        assert!(!text.contains("忽略我"), "{text}");
        assert!(text.contains("保留我"), "{text}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn max_lines_stops_at_the_newest_records() {
        let dir = temp_dir("limit");
        let base = dir.join("readerx-150405.log");
        let body: String = (0..20)
            .map(|index| format!("{}\n", record_line("INFO", &format!("line-{index}"))))
            .collect();
        fs::write(&base, body).unwrap();
        let text = read_run(&base, 1, 3, LevelFilter::Trace);
        assert_eq!(text.lines().count(), 3, "{text}");
        assert!(text.contains("line-19"), "{text}");
        assert!(!text.contains("line-16"), "{text}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let dir = temp_dir("missing");
        let text = read_run(&dir.join("readerx-150405.log"), 3, 50, LevelFilter::Trace);
        assert!(text.is_empty(), "{text}");
        let _ = fs::remove_dir_all(&dir);
    }
}

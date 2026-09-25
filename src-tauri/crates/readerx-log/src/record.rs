//! 日志行的格式化与解析。
//!
//! 落盘格式固定为（便于按列筛级别，也便于人眼扫读）：
//!
//! ```text
//! 2026-09-25 15:04:05.123 INFO  readerx_source::host: 书源会话已建立 source=…
//! ```
//!
//! 时间戳宽度固定 23 字符 + 1 空格，级别固定 5 字符 + 1 空格，
//! 因此 [`level_of_line`] 无需正则即可取级别；多行消息的续行以 4 空格缩进，
//! 看上去仍属于上一条记录。

use log::{Level, Record};
use time::{OffsetDateTime, UtcOffset};

/// 时间戳列宽：`YYYY-MM-DD HH:MM:SS.mmm` + 1 空格
const TIMESTAMP_WIDTH: usize = 24;
/// 级别列宽：`ERROR` / `WARN ` / `INFO ` / `DEBUG` / `TRACE` + 1 空格
const LEVEL_WIDTH: usize = 6;

/// 把一条记录格式化成一行文本（多行消息自带缩进、以 `\n` 分隔）
pub(crate) fn format_record(record: &Record) -> String {
    format!(
        "{} {:<5} {}: {}",
        timestamp(),
        level_name(record.level()),
        record.target(),
        indent_continuation(&record.args().to_string())
    )
}

/// 当前本地时间戳（`record` 与「没走 log 门面的输出」共用同一套格式）
pub fn timestamp() -> String {
    let now = OffsetDateTime::now_utc().to_offset(local_offset());
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond(),
    )
}

/// 级别的固定宽度名称（写进日志行 / logcat）
pub fn level_name(level: Level) -> &'static str {
    match level {
        Level::Error => "ERROR",
        Level::Warn => "WARN",
        Level::Info => "INFO",
        Level::Debug => "DEBUG",
        Level::Trace => "TRACE",
    }
}

/// 从一行已落盘的日志里解析级别；不是记录行（续行 / 表头）返回 `None`
pub fn level_of_line(line: &str) -> Option<Level> {
    let bytes = line.as_bytes();
    if bytes.len() < TIMESTAMP_WIDTH + LEVEL_WIDTH {
        return None;
    }
    // 时间戳必须长这样，否则判定为续行 / 表头
    if bytes.get(4) != Some(&b'-') || bytes.get(10) != Some(&b' ') || bytes.get(13) != Some(&b':') {
        return None;
    }
    match line[TIMESTAMP_WIDTH..TIMESTAMP_WIDTH + LEVEL_WIDTH].trim() {
        "ERROR" => Some(Level::Error),
        "WARN" => Some(Level::Warn),
        "INFO" => Some(Level::Info),
        "DEBUG" => Some(Level::Debug),
        "TRACE" => Some(Level::Trace),
        _ => None,
    }
}

/// 多行消息的续行缩进，保持「一条记录一行开头」的列结构
fn indent_continuation(message: &str) -> String {
    if !message.contains('\n') {
        return message.to_string();
    }
    message.lines().collect::<Vec<_>>().join("\n    ")
}

/// 本地时区偏移；受限环境（取不到本地时区）退回 UTC，日志照常可读。
///
/// 每条记录都现取：系统时区 / 夏令时变化会立刻反映到时间戳上，
/// 相比缓存一分钟省下的那点开销，日志时间对不上才是真的难查。
fn local_offset() -> UtcOffset {
    UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formatted_line_starts_with_timestamp_and_level() {
        let record = log::Record::builder()
            .level(Level::Warn)
            .target("readerx_source::host")
            .args(format_args!("请求失败 status=503"))
            .build();
        let line = format_record(&record);
        assert_eq!(level_of_line(&line), Some(Level::Warn), "{line}");
        assert!(
            line.contains("readerx_source::host: 请求失败 status=503"),
            "{line}"
        );
        assert_eq!(&line[4..5], "-");
        assert_eq!(&line[10..11], " ");
        assert_eq!(&line[19..20], ".");
    }

    #[test]
    fn continuation_lines_are_indented_and_do_not_look_like_records() {
        let record = log::Record::builder()
            .level(Level::Error)
            .target("web")
            .args(format_args!("第一行\n第二行"))
            .build();
        let line = format_record(&record);
        let mut lines = line.lines();
        assert_eq!(level_of_line(lines.next().unwrap()), Some(Level::Error));
        assert_eq!(lines.next(), Some("    第二行"));
    }

    #[test]
    fn header_and_garbage_lines_have_no_level() {
        assert_eq!(level_of_line("--- readerx 0.2.0 启动 ---"), None);
        assert_eq!(level_of_line(""), None);
    }

    #[test]
    fn every_level_round_trips_through_a_line() {
        for level in [
            Level::Error,
            Level::Warn,
            Level::Info,
            Level::Debug,
            Level::Trace,
        ] {
            let record = log::Record::builder()
                .level(level)
                .target("t")
                .args(format_args!("x"))
                .build();
            assert_eq!(level_of_line(&format_record(&record)), Some(level));
        }
    }
}

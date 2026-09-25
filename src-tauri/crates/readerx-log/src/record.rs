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
    format_line(record.level(), record.target(), &record.args().to_string())
}

/// 与 [`format_record`] 同一套格式：给级别 / target / 正文，拼出一行
/// （[`crate::Logger::write_line`] 那些不走 `log` 门面的记录也用它，格式只有一处定义）
pub(crate) fn format_line(level: Level, target: &str, message: &str) -> String {
    format!(
        "{} {:<5} {}: {}",
        timestamp(),
        level_name(level),
        target,
        indent_continuation(message)
    )
}

/// 当前本地时间戳（`record` 与「没走 log 门面的输出」共用同一套格式）
pub fn timestamp() -> String {
    format_stamp(local_now())
}

/// 本地时间戳的另一种取法：给一个时刻，按同一格式打印
pub(crate) fn format_stamp(now: OffsetDateTime) -> String {
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

/// 本地的「日期 + 时刻」：目录名（`2026-09-25`）与文件名里的时刻（`150405`）
pub(crate) fn local_stamp() -> (String, String) {
    day_and_clock(local_now())
}

/// 文件修改时间（旧日志迁移用）→ 本地「日期 + 时刻」
pub(crate) fn local_stamp_of(time: std::time::SystemTime) -> (String, String) {
    day_and_clock(OffsetDateTime::from(time).to_offset(local_offset()))
}

/// 截止日期：本地今天往前 `days` 天（保留策略用，`0` = 今天）
pub(crate) fn day_before(days: i64) -> String {
    day_of(local_now().date() - time::Duration::days(days))
}

/// 从一行已落盘的日志里取它属于哪一天、哪个时刻（`2026-09-25`, `150405`）。
///
/// 跨天换文件时不必再取一次系统时钟：日志行的前缀就是写这条记录时的本地时间，
/// 直接用它既省一次时区查询，也让「记录时间」与「落在哪个文件」永远一致。
/// 不是记录行（续行 / 表头）时返回 `None`，由调用方沿用当前日期。
///
/// 这里只按形状切出日期串，是不是一个真日期由调用方判定（见 `layout::is_day_name`）：
/// 续行凑巧凑出同样的分隔符时，日期会是一段普通正文。
pub(crate) fn stamp_of_line(line: &str) -> Option<(String, String)> {
    let bytes = line.as_bytes();
    if bytes.len() < TIMESTAMP_WIDTH
        || bytes[4] != b'-'
        || bytes[10] != b' '
        || bytes[13] != b':'
        || bytes[19] != b'.'
    {
        return None;
    }
    // 一律用 `get` 取片段：续行是任意正文，按字节下标硬切可能落在多字节字符中间
    let day = line.get(0..10)?;
    let hour = line.get(11..13)?;
    let minute = line.get(14..16)?;
    let second = line.get(17..19)?;
    let clock = format!("{hour}{minute}{second}");
    if !clock.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((day.to_string(), clock))
}

fn local_now() -> OffsetDateTime {
    OffsetDateTime::now_utc().to_offset(local_offset())
}

/// `2026-09-25`
fn day_of(date: time::Date) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

/// `150405`
fn clock_of(time: time::Time) -> String {
    format!("{:02}{:02}{:02}", time.hour(), time.minute(), time.second())
}

fn day_and_clock(now: OffsetDateTime) -> (String, String) {
    (day_of(now.date()), clock_of(now.time()))
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

/// 从一行已落盘的日志里解析级别；不是记录行（续行 / 表头）返回 `None`。
///
/// 续行是任意正文：这里只按字节位置取分隔符，切片一律走 `get`
/// ——按下标硬切可能落在多字节字符中间，直接 panic（读日志不该把查看器带崩）。
pub fn level_of_line(line: &str) -> Option<Level> {
    let bytes = line.as_bytes();
    if bytes.len() < TIMESTAMP_WIDTH + LEVEL_WIDTH {
        return None;
    }
    // 时间戳必须长这样，否则判定为续行 / 表头
    if bytes.get(4) != Some(&b'-') || bytes.get(10) != Some(&b' ') || bytes.get(13) != Some(&b':') {
        return None;
    }
    match line.get(TIMESTAMP_WIDTH..TIMESTAMP_WIDTH + LEVEL_WIDTH)?.trim() {
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
    fn record_lines_yield_their_day_and_clock() {
        let line = "2026-09-25 15:04:05.006 INFO  readerx::host: 请求完成";
        assert_eq!(
            stamp_of_line(line),
            Some(("2026-09-25".to_string(), "150405".to_string()))
        );
    }

    #[test]
    fn continuation_and_garbage_lines_have_no_stamp() {
        assert_eq!(stamp_of_line("    续行 2026-09-25 15:04:05.006"), None);
        assert_eq!(stamp_of_line("--- readerx 0.2.0 启动 ---"), None);
        assert_eq!(stamp_of_line(""), None);
    }

    /// 续行是任意正文：长得像记录行、但第 24 字节落在多字节字符中间的那一行，
    /// 只能判定为「不是记录行」，绝不能按字节下标硬切（会 panic）
    #[test]
    fn a_poisoned_continuation_line_is_just_not_a_record() {
        let poisoned = "    -bbbbb cc:ddddddddd中xyzww";
        assert!(poisoned.len() >= TIMESTAMP_WIDTH + LEVEL_WIDTH);
        assert_eq!(level_of_line(poisoned), None);
        assert_eq!(stamp_of_line(poisoned), None);
    }

    /// 保留策略的截止日期：往前 0 天 = 今天，回退要跨月、跨年都算得对
    #[test]
    fn day_before_counts_calendar_days_back() {
        let today = local_stamp().0;
        assert_eq!(day_before(0), today);
        assert!(day_before(6) < today, "{} !< {today}", day_before(6));
        assert_eq!(day_before(400).len(), today.len());
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

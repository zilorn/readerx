//! 日志目录布局与文件命名：一天一个目录，一次运行一个文件。
//!
//! ```text
//! <数据目录>/logs/
//!   2026-09-25/                 一天一个目录（本地日期）
//!     readerx-150405.log        当天 15:04:05 启动的那一次运行
//!     readerx-150405.log.1      同一次运行内写满体积上限后的轮转（数字越大越旧）
//!     readerx-090012.log        当天更早的一次启动
//!   2026-09-24/
//!     readerx-180230.log
//! ```
//!
//! 为什么这样分：**日期在目录名上、这一份文件开始的时刻在文件名上**。看日志的人先关心「哪天」，
//! 再关心「哪一次运行」；文件名只有 6 位时刻，一天之内的多份日志按名字排序即按启动先后排序，
//! 而跨天的顺序由目录名给出 —— 路径本身就是排序键，不需要读文件或看修改时间。
//!
//! 这里只做纯字符串的命名与识别（不碰文件系统），目录扫描与淘汰见 [`crate::retention`]。

use std::path::{Path, PathBuf};

/// 应用名净化：只留安全字符，避免拼出目录穿越的文件名
pub(crate) fn sanitize_app(app: &str) -> String {
    app.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// 一次运行的日志文件名：`readerx-150405.log`
pub(crate) fn run_file_name(app: &str, clock: &str) -> String {
    format!("{app}-{clock}.log")
}

/// 主文件 + 第 `rotation` 份轮转备份的路径（`0` = 主文件本身）
pub(crate) fn rotated_path(path: &Path, rotation: usize) -> PathBuf {
    if rotation == 0 {
        return path.to_path_buf();
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{rotation}"));
    path.with_file_name(name)
}

/// 文件名 → 轮转序号（`0` = 主文件）；不属于该应用的文件返回 `None`
pub(crate) fn rotation_of(file_name: &str, app: &str) -> Option<usize> {
    run_name_parts(file_name, app).map(|(_, rotation)| rotation)
}

/// 升级前的扁平文件名 → 轮转序号（`readerx.log` = 0，`readerx.log.2` = 2）
pub(crate) fn legacy_rotation(file_name: &str, app: &str) -> Option<usize> {
    let rest = file_name.strip_prefix(&format!("{app}.log"))?;
    if rest.is_empty() {
        return Some(0);
    }
    rest.strip_prefix('.')?.parse().ok()
}

/// 文件名 → （时刻, 轮转序号），主文件与轮转备份都认
pub(crate) fn run_name_parts<'a>(file_name: &'a str, app: &str) -> Option<(&'a str, usize)> {
    let rest = file_name.strip_prefix(&format!("{app}-"))?;
    let (clock, suffix) = rest.split_once(".log")?;
    if !is_clock(clock) {
        return None;
    }
    if suffix.is_empty() {
        return Some((clock, 0));
    }
    let rotation = suffix.strip_prefix('.')?.parse().ok()?;
    Some((clock, rotation))
}

/// 目录名是不是本地日期（`2026-09-25`）
pub(crate) fn is_day_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

/// `150405`
fn is_clock(value: &str) -> bool {
    value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_name_is_sanitized() {
        assert_eq!(sanitize_app("readerx"), "readerx");
        assert_eq!(sanitize_app("readerx-source"), "readerx-source");
        assert_eq!(sanitize_app("../etc/passwd"), "---etc-passwd");
    }

    #[test]
    fn run_file_names_are_recognized_and_sorted_by_start_time() {
        let early = run_file_name("readerx", "090012");
        let late = run_file_name("readerx", "150405");
        assert_eq!(early, "readerx-090012.log");
        assert_eq!(run_name_parts(&late, "readerx"), Some(("150405", 0)));
        // 文件名排序 = 启动先后，且不会把别的应用或轮转备份认成一次运行
        assert!(early < late, "{early} !< {late}");
        assert_eq!(run_name_parts("readerx-source-150405.log", "readerx"), None);
        assert_eq!(run_name_parts("readerx-150405.log.1", "readerx"), Some(("150405", 1)));
        assert_eq!(run_name_parts("readerx-abc.log", "readerx"), None);
    }

    #[test]
    fn rotation_index_covers_main_and_backups() {
        assert_eq!(rotation_of("readerx-150405.log", "readerx"), Some(0));
        assert_eq!(rotation_of("readerx-150405.log.2", "readerx"), Some(2));
        assert_eq!(rotation_of("readerx-150405.log.x", "readerx"), None);
        assert_eq!(rotation_of("readerx-150405.logx", "readerx"), None);
        assert_eq!(rotation_of("readerx-source-150405.log.2", "readerx"), None);
    }

    #[test]
    fn name_parts_cover_backups_too() {
        assert_eq!(
            run_name_parts("readerx-150405.log.3", "readerx"),
            Some(("150405", 3))
        );
        assert_eq!(run_name_parts("readerx-150405.log", "readerx"), Some(("150405", 0)));
        assert_eq!(run_name_parts("readerx.log", "readerx"), None);
    }

    #[test]
    fn legacy_flat_names_are_recognized() {
        assert_eq!(legacy_rotation("readerx.log", "readerx"), Some(0));
        assert_eq!(legacy_rotation("readerx.log.3", "readerx"), Some(3));
        assert_eq!(legacy_rotation("readerx-source.log", "readerx"), None);
        assert_eq!(legacy_rotation("readerx-150405.log", "readerx"), None);
    }

    #[test]
    fn day_directory_names_are_validated() {
        assert!(is_day_name("2026-09-25"));
        assert!(!is_day_name("2026-9-25"));
        assert!(!is_day_name("20260925"));
        assert!(!is_day_name("readerx"));
        assert!(!is_day_name("2026-09-25x"));
    }

    #[test]
    fn rotated_paths_append_the_index() {
        let base = Path::new("/tmp/logs/2026-09-25/readerx-150405.log");
        assert_eq!(rotated_path(base, 0), base);
        assert_eq!(
            rotated_path(base, 1),
            Path::new("/tmp/logs/2026-09-25/readerx-150405.log.1")
        );
    }
}

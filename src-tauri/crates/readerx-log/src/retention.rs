//! 日志目录的扫描、淘汰与旧版布局迁移。
//!
//! 保留策略（由 [`FileLimits`] 给出）：
//!
//! 1. **按天**：最近 `keep_days` 天（含今天）的日志全留，更早的日期目录整份删掉；
//! 2. **按总量**：仍然超过 `max_total_bytes` 就从最旧的开始删 —— 详细级别下一天能写出几十兆，
//!    只按天淘汰挡不住这种量，而磁盘写满的后果比丢旧日志严重得多。
//!
//! 当前正在写的那份永远不删（Windows 上删打开着的文件本来也会失败）。
//!
//! 另外负责把**升级前的扁平布局**（`logs/readerx.log` + `.1` / `.2`）搬进日期目录：
//! 不搬的话，老日志既不会被淘汰（目录扫描只认日期目录）、在应用内也看不到，成了孤儿文件。
//!
//! [`FileLimits`]: crate::FileLimits

use crate::layout;
use crate::record;
use crate::FileLimits;
use std::cmp::Reverse;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// 目录里的一份日志文件
pub(crate) struct LogFile {
    /// 本地日期（目录名）
    pub(crate) day: String,
    /// 这一份文件开始写的时刻（文件名里的 6 位数字）
    pub(crate) clock: String,
    /// 轮转序号：0 = 主文件，数字越大越旧
    pub(crate) rotation: usize,
    pub(crate) path: PathBuf,
    pub(crate) bytes: u64,
}

/// 一次运行写下的日志（同一天、同一时刻的一组文件）
pub struct LogRun {
    /// 本地日期 `2026-09-25`
    pub day: String,
    /// 这一份文件开始写的时刻 `150405`
    pub clock: String,
    /// 主文件路径（读取时它的 `.1` / `.2` 也会一起读）
    pub path: PathBuf,
    /// 是不是当前正在写的这一次运行
    pub current: bool,
}

/// 扫描该应用的日志文件，按时间从旧到新（同一次运行内序号大的在前 —— 那是更早的内容）
pub(crate) fn scan(root: &Path, app: &str) -> Vec<LogFile> {
    let mut files = Vec::new();
    let Ok(days) = fs::read_dir(root) else {
        return files;
    };
    for day in days.flatten() {
        let Some(day_name) = day.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !layout::is_day_name(&day_name) {
            continue;
        }
        let Ok(entries) = fs::read_dir(day.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let Some(file_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Some((clock, rotation)) = layout::run_name_parts(&file_name, app) else {
                continue;
            };
            files.push(LogFile {
                day: day_name.clone(),
                clock: clock.to_string(),
                rotation,
                path: day.path().join(&file_name),
                bytes: entry.metadata().map(|meta| meta.len()).unwrap_or(0),
            });
        }
    }
    files.sort_by(|a, b| {
        (&a.day, &a.clock, Reverse(a.rotation)).cmp(&(&b.day, &b.clock, Reverse(b.rotation)))
    });
    files
}

/// 列出最近若干次运行（新 → 旧），供应用内查看器选文件
pub(crate) fn list_runs(
    root: &Path,
    app: &str,
    active: Option<&Path>,
    limit: usize,
) -> Vec<LogRun> {
    let mut runs: Vec<LogRun> = Vec::new();
    for file in scan(root, app) {
        let same_run = runs
            .last()
            .map(|last| last.day == file.day && last.clock == file.clock)
            .unwrap_or(false);
        if !same_run {
            runs.push(LogRun {
                day: file.day.clone(),
                clock: file.clock.clone(),
                path: root
                    .join(&file.day)
                    .join(layout::run_file_name(app, &file.clock)),
                current: false,
            });
        }
    }
    runs.reverse();
    for run in &mut runs {
        run.current = active == Some(run.path.as_path());
    }
    runs.truncate(limit.max(1));
    runs
}

/// 淘汰过期日志；返回第一个失败原因（已经尽力删了其余的，不该因为一个删不掉就全放弃）
pub(crate) fn prune(
    root: &Path,
    app: &str,
    limits: &FileLimits,
    active: Option<&Path>,
) -> Result<(), String> {
    let cutoff = record::day_before(limits.keep_days.saturating_sub(1) as i64);
    let files = scan(root, app);
    let mut first_error = None;
    let mut kept = Vec::new();
    for file in files {
        if file.day.as_str() < cutoff.as_str() && Some(file.path.as_path()) != active {
            remove(&file.path, &mut first_error);
        } else {
            kept.push(file);
        }
    }
    let mut total: u64 = kept.iter().map(|file| file.bytes).sum();
    for file in &kept {
        if total <= limits.max_total_bytes {
            break;
        }
        if Some(file.path.as_path()) == active {
            continue;
        }
        if remove(&file.path, &mut first_error) {
            total = total.saturating_sub(file.bytes);
        }
    }
    remove_empty_days(root);
    first_error.map_or(Ok(()), Err)
}

/// 清空该应用的全部日志（所有日期目录 + 升级前的扁平文件）
pub(crate) fn clear(root: &Path, app: &str) -> Result<(), String> {
    let mut first_error = None;
    for file in scan(root, app) {
        remove(&file.path, &mut first_error);
    }
    for (_, path) in legacy_paths(root, app) {
        remove(&path, &mut first_error);
    }
    remove_empty_days(root);
    first_error.map_or(Ok(()), Err)
}

/// 把升级前的扁平日志按**修改时间**搬进对应的日期目录（尽力而为：搬不动就留着，下次再试）
pub(crate) fn migrate_legacy(root: &Path, app: &str) {
    let files = legacy_paths(root, app);
    // 主文件的时间就是旧布局最后一次写入的时间；主文件不在（被手工删过）就用最旧的那一份
    let Some((_, base)) = files.first() else {
        return;
    };
    let Ok(modified) = fs::metadata(base).and_then(|meta| meta.modified()) else {
        return;
    };
    let (day, clock) = record::local_stamp_of(modified);
    let dir = root.join(&day);
    if let Err(error) = fs::create_dir_all(&dir) {
        eprintln!(
            "[readerx-log] 创建日志目录 {} 失败，旧日志暂不迁移：{error}",
            dir.display()
        );
        return;
    }
    let target = dir.join(layout::run_file_name(app, &clock));
    for (rotation, from) in files {
        if !from.is_file() {
            continue;
        }
        let to = layout::rotated_path(&target, rotation);
        // 同名目标已存在（极少见：那一天的同一秒已经有一份日志）：宁可留下旧文件，也不覆盖
        // 已经写好的日志 —— 它不会被当成孤儿，下次启动会再试
        if to.exists() {
            eprintln!(
                "[readerx-log] 旧日志 {} 暂不迁移：目标 {} 已存在",
                from.display(),
                to.display()
            );
            continue;
        }
        if let Err(error) = fs::rename(&from, &to) {
            eprintln!(
                "[readerx-log] 旧日志迁移失败 {} → {}：{error}",
                from.display(),
                to.display()
            );
        }
    }
}

/// `path` 是不是这个应用写出来的一次运行（读取入口只认自己目录下的路径，防止越界读文件）。
///
/// 文件必须真的在：路径可能是界面选的，而那一份日志刚被淘汰 / 清空 —— 这时候要报错，
/// 让调用方退回本次运行，而不是当成一份「空日志」把界面停在读不到的路径上。
pub(crate) fn is_run_path(root: &Path, app: &str, path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if layout::rotation_of(file_name, app) != Some(0) {
        return false;
    }
    let Some(day) = path
        .parent()
        .and_then(|dir| dir.file_name())
        .and_then(|name| name.to_str())
    else {
        return false;
    };
    layout::is_day_name(day) && path.parent().and_then(Path::parent) == Some(root) && path.is_file()
}

/// 升级前的扁平日志：`readerx.log`、`readerx.log.1` …（按轮转序号从新到旧，主文件在前）
fn legacy_paths(root: &Path, app: &str) -> Vec<(usize, PathBuf)> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut files: Vec<(usize, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if let Some(rotation) = layout::legacy_rotation(&name, app) {
            files.push((rotation, entry.path()));
        }
    }
    files.sort_by_key(|(rotation, _)| *rotation);
    files
}

/// 删一个文件；返回是否已经不在了（本来就不存在也算）
fn remove(path: &Path, first_error: &mut Option<String>) -> bool {
    match fs::remove_file(path) {
        Ok(()) => true,
        Err(error) if error.kind() == ErrorKind::NotFound => true,
        Err(error) => {
            if first_error.is_none() {
                *first_error = Some(format!("删除日志文件 {} 失败: {error}", path.display()));
            }
            false
        }
    }
}

/// 删掉空出来的日期目录（别的应用的文件还在里面时删不掉，忽略即可）
fn remove_empty_days(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !layout::is_day_name(name) {
            continue;
        }
        let empty = fs::read_dir(entry.path())
            .map(|mut dir| dir.next().is_none())
            .unwrap_or(false);
        if empty {
            let _ = fs::remove_dir(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "readerx-log-retention-{}-{}-{}",
            std::process::id(),
            tag,
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 造一份日志文件（内容多少无关紧要，淘汰看的是路径与体积）
    fn write_file(root: &Path, day: &str, name: &str, bytes: usize) -> PathBuf {
        let dir = root.join(day);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, "x".repeat(bytes)).unwrap();
        path
    }

    fn limits(keep_days: usize, max_total_bytes: u64) -> FileLimits {
        FileLimits {
            keep_days,
            max_total_bytes,
            ..FileLimits::default()
        }
    }

    #[test]
    fn scan_is_ordered_from_oldest_to_newest() {
        let root = temp_dir("scan");
        write_file(&root, "2026-09-25", "readerx-150405.log", 1);
        write_file(&root, "2026-09-25", "readerx-090012.log", 1);
        write_file(&root, "2026-09-24", "readerx-080000.log", 1);
        // 别的应用、别的目录、怪名字都不该被算进来
        write_file(&root, "2026-09-25", "readerx-source-150405.log", 1);
        write_file(&root, "notes", "readerx-150405.log", 1);
        let names: Vec<String> = scan(&root, "readerx")
            .into_iter()
            .map(|file| format!("{}/{}", file.day, file.path.file_name().unwrap().to_string_lossy()))
            .collect();
        assert_eq!(
            names,
            vec![
                "2026-09-24/readerx-080000.log",
                "2026-09-25/readerx-090012.log",
                "2026-09-25/readerx-150405.log",
            ]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_drops_days_older_than_the_window() {
        let root = temp_dir("days");
        let old = record::day_before(10);
        let recent = record::day_before(1);
        let stale = write_file(&root, &old, "readerx-150405.log", 10);
        let kept = write_file(&root, &recent, "readerx-150405.log", 10);
        prune(&root, "readerx", &limits(7, u64::MAX), None).unwrap();
        assert!(!stale.exists(), "超过保留天数的日志应被删除");
        assert!(kept.exists(), "保留期内的日志应留着");
        assert!(!root.join(&old).exists(), "空掉的日期目录应一并删除");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_shrinks_to_the_total_size_budget_from_the_oldest() {
        let root = temp_dir("total");
        let today = record::day_before(0);
        let old = write_file(&root, &today, "readerx-090012.log", 400);
        let fresh = write_file(&root, &today, "readerx-150405.log", 400);
        prune(&root, "readerx", &limits(7, 500), None).unwrap();
        assert!(!old.exists(), "总量超限时最旧的先删");
        assert!(fresh.exists(), "最新的留着");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_never_deletes_the_active_file() {
        let root = temp_dir("active");
        let old = record::day_before(30);
        let active = write_file(&root, &old, "readerx-150405.log", 400);
        prune(&root, "readerx", &limits(1, 0), Some(&active)).unwrap();
        assert!(active.exists(), "正在写的日志不能被删掉");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_runs_groups_a_run_and_marks_the_current_one() {
        let root = temp_dir("runs");
        write_file(&root, "2026-09-25", "readerx-090012.log", 100);
        write_file(&root, "2026-09-25", "readerx-150405.log", 100);
        write_file(&root, "2026-09-25", "readerx-150405.log.1", 50);
        let current = root
            .join("2026-09-25")
            .join("readerx-150405.log");
        let runs = list_runs(&root, "readerx", Some(&current), 10);
        assert_eq!(runs.len(), 2, "同一次运行的轮转备份应合成一条");
        assert_eq!(runs[0].clock, "150405", "最新的排在最前");
        assert!(runs[0].current);
        assert_eq!(runs[0].path, current);
        assert_eq!(runs[1].clock, "090012");
        assert!(!runs[1].current);
        let _ = fs::remove_dir_all(&root);
    }

    /// 界面选中的那一份可能刚被清空 / 淘汰：路径形状再对也不算数
    #[test]
    fn a_deleted_run_file_is_no_longer_a_valid_path() {
        let root = temp_dir("vanished");
        let path = write_file(&root, "2026-09-25", "readerx-150405.log", 10);
        assert!(is_run_path(&root, "readerx", &path));
        fs::remove_file(&path).unwrap();
        assert!(!is_run_path(&root, "readerx", &path));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clear_removes_every_day_and_legacy_files() {
        let root = temp_dir("clear");
        write_file(&root, "2026-09-25", "readerx-150405.log", 10);
        write_file(&root, "2026-09-24", "readerx-080000.log", 10);
        fs::write(root.join("readerx.log"), "legacy").unwrap();
        clear(&root, "readerx").unwrap();
        assert!(scan(&root, "readerx").is_empty());
        assert!(!root.join("readerx.log").exists());
        assert!(!root.join("2026-09-25").exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// 升级前的扁平日志按修改时间搬进日期目录，并且不覆盖已有同名文件
    #[test]
    fn legacy_flat_files_move_into_a_day_directory() {
        let root = temp_dir("legacy");
        fs::write(root.join("readerx.log"), "旧的当前日志").unwrap();
        fs::write(root.join("readerx.log.1"), "旧的历史日志").unwrap();
        migrate_legacy(&root, "readerx");
        assert!(!root.join("readerx.log").exists(), "旧文件应被搬走");
        let days: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .collect();
        assert_eq!(days.len(), 1, "应剩下一个日期目录");
        let moved: Vec<String> = fs::read_dir(days[0].path())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(moved.len(), 2, "{moved:?}");
        assert!(moved.iter().all(|name| name.starts_with("readerx-")));
        assert!(moved.iter().any(|name| name.ends_with(".log")));
        assert!(moved.iter().any(|name| name.ends_with(".log.1")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn run_paths_from_outside_the_log_directory_are_rejected() {
        let root = temp_dir("validate");
        let ok = write_file(&root, "2026-09-25", "readerx-150405.log", 1);
        assert!(is_run_path(&root, "readerx", &ok));
        assert!(!is_run_path(&root, "readerx", Path::new("/etc/passwd")));
        assert!(!is_run_path(
            &root,
            "readerx",
            Path::new("/tmp/2026-09-25/readerx-150405.log")
        ));
        assert!(!is_run_path(
            &root,
            "readerx",
            &root.join("2026-09-25").join("readerx-source-150405.log")
        ));
        assert!(!is_run_path(
            &root,
            "readerx",
            &root.join("2026-09-25").join("readerx-150405.log.1")
        ));
        let _ = fs::remove_dir_all(&root);
    }
}

//! 逐章正文拉取的**运行注册表**（run_id → 运行句柄）。
//!
//! 一次「窗口预取 / 批量下载」在前端是一个运行 id：引擎侧按 id 建一条章节任务队列
//! （见 `readerx_source::engine::ChapterRun`），前端据此做两件用户操作：
//!
//! - **停止**：`cancel` 之后 worker 不再领取新章节（已取回的照常交付）；
//! - **插队**：`promote` 把「正在读的那一章」提到队首 —— 用户读到哪一章就先取哪一章，
//!   不必排在几百章的下载队列后面。
//!
//! 注册表只保存运行句柄，不保存正文；运行结束（命令返回）时用 [`RunGuard`] 注销，
//! 因此前端即使丢掉本次调用的结果也不会在这里留下垃圾。

use readerx_source::engine::ChapterRun;
use readerx_source::models::{ChapterPromoteResult, ChapterTaskItem};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

fn registry() -> &'static Mutex<HashMap<u64, Arc<ChapterRun>>> {
    static RUNS: OnceLock<Mutex<HashMap<u64, Arc<ChapterRun>>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 登记一次运行并建好任务队列；同一 id 已在跑时返回 Err（前端的 id 单调递增，正常不会撞）。
pub(crate) fn begin(run_id: u64, tasks: Vec<ChapterTaskItem>) -> Result<Arc<ChapterRun>, String> {
    let run = ChapterRun::new(tasks);
    let mut runs = registry().lock().map_err(|_| "章节任务注册表锁异常".to_string())?;
    if runs.contains_key(&run_id) {
        return Err(format!("章节任务 {run_id} 已在运行"));
    }
    runs.insert(run_id, run.clone());
    Ok(run)
}

/// 注销一次运行（运行结束 / 命令异常退出都要走到这里）
pub(crate) fn finish(run_id: u64) {
    if let Ok(mut runs) = registry().lock() {
        runs.remove(&run_id);
    }
}

/// 停止一次运行；返回是否有这次运行（前端可能发来得太晚：任务已经跑完了）
pub(crate) fn cancel(run_id: u64) -> bool {
    let run = registry()
        .lock()
        .ok()
        .and_then(|runs| runs.get(&run_id).cloned());
    match run {
        Some(run) => {
            run.cancel();
            true
        }
        None => false,
    }
}

/// 把章节地址对应的任务提到队首；没有这次运行 / 章节不在队列里时返回全 0
/// （调用方据此决定要不要为这一章单独发一次请求）
pub(crate) fn promote(run_id: u64, urls: &[String]) -> ChapterPromoteResult {
    let run = registry()
        .lock()
        .ok()
        .and_then(|runs| runs.get(&run_id).cloned());
    run.map(|run| run.promote(urls))
        .unwrap_or_default()
}

/// 运行期间持有：无论命令怎么结束（正常 / 报错 / panic 兜底）都会注销这次运行
pub(crate) struct RunGuard {
    run_id: u64,
}

impl RunGuard {
    pub(crate) fn new(run_id: u64) -> Self {
        Self { run_id }
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        finish(self.run_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use readerx_source::models::ChapterItem;

    fn tasks(names: &[&str]) -> Vec<ChapterTaskItem> {
        names
            .iter()
            .enumerate()
            .map(|(index, name)| ChapterTaskItem {
                index,
                chapter: ChapterItem {
                    chapter_name: (*name).to_string(),
                    chapter_url: format!("https://example.com/{name}"),
                },
            })
            .collect()
    }

    /// 注册表：登记 / 插队 / 停止 / 注销，以及「运行已结束时插队与停止都安全返回」。
    /// `RunGuard` 掉出作用域即注销（命令无论怎么结束都不会在这里留下悬挂的运行）。
    #[test]
    fn registry_tracks_run_lifecycle() {
        let run_id = 900_001;
        assert_eq!(promote(run_id, &["https://example.com/a".to_string()]), Default::default());
        assert!(!cancel(run_id), "没登记过的运行：停止返回 false");

        let run = begin(run_id, tasks(&["a", "b"])).expect("首次登记应当成功");
        assert_eq!(run.total(), 2);
        assert!(begin(run_id, tasks(&["a"])).is_err(), "同一个 id 不能重复登记");

        let promoted = promote(run_id, &["https://example.com/b".to_string()]);
        assert_eq!((promoted.promoted, promoted.running), (1, 0));
        assert!(cancel(run_id), "已登记的运行：停止返回 true");
        assert!(run.is_cancelled(), "停止要落到引擎侧的运行句柄上");

        {
            let _guard = RunGuard::new(run_id);
        }
        assert_eq!(
            promote(run_id, &["https://example.com/b".to_string()]),
            Default::default(),
            "注销之后插队不再命中"
        );
    }
}

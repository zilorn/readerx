//! 页面启动后的数据迁移。
//!
//! 旧书库 / 稳定 ID 迁移可能扫描并改写大量文件。之前在 Tauri `setup` 里同步执行，
//! 会占住主线程，Android 覆盖安装后的首次启动可能因此迟迟无法完成 WebView 装配与首帧；
//! 前端页面也还没有机会运行。现在由前端在页面启动后调用
//! [`readerx_startup_migrate`]，迁移仍保证在界面读取书库、同步线程访问本地数据之前完成。
//!
//! 迁移本身可重跑：失败时保留旧数据与待办，下一次启动会继续；成功后同步服务才启动。

use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Manager};

use crate::{commands, storage, sync};

/// 本进程是否已经完成启动迁移。迁移运行在 blocking 线程池，重复调用会等待同一把锁。
static STARTUP: OnceLock<Mutex<bool>> = OnceLock::new();

/// 页面启动后执行一次本地数据迁移，然后启动同步服务。
///
/// 前端必须在读取书库 / 分组 / 规则等依赖稳定 ID 的数据之前 `await` 此命令。
/// 迁移失败会返回错误且不启动同步；原数据保留，下次启动可重试。
#[tauri::command]
pub async fn readerx_startup_migrate(app: AppHandle) -> Result<(), String> {
    commands::blocking("启动数据迁移", move || migrate(&app)).await
}

fn migrate(app: &AppHandle) -> Result<(), String> {
    let done = STARTUP.get_or_init(|| Mutex::new(false));
    let mut done = done.lock().unwrap_or_else(|error| error.into_inner());
    if *done {
        return Ok(());
    }
    // 本地书的旧布局（整本 books/<id>.json、全库一份的 state/readerx.bookmarks.json）
    // 逐本迁入 SQLite，再统一书籍 ID；必须早于界面与同步线程访问书库。
    sync::book_ids::migrate(app)?;
    sync::data_ids::migrate(&storage::data_root(app)?)?;
    start_sync(app);
    *done = true;
    Ok(())
}

/// 迁移完成后才拉起同步：对账会读写书库，不能与迁移并发。
fn start_sync(app: &AppHandle) {
    let Some(state) = app.try_state::<sync::SyncState>() else {
        log::warn!("同步服务未初始化，跳过同步启动");
        return;
    };
    let bootstrap = Arc::clone(&state.0);
    if let Err(error) = std::thread::Builder::new()
        .name("readerx-sync-boot".to_string())
        .spawn(move || bootstrap.bootstrap())
    {
        log::warn!("启动同步线程失败：{error}");
    }
}

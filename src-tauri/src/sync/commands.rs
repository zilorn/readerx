//! 同步相关的 Tauri command。
//!
//! 与其它命令同一套约定：不直接碰磁盘与网络，全部丢进 blocking 线程池，
//! 内部 panic 由 [`crate::panic_guard`] 收敛成可读错误（见 `commands.rs` 的说明）。

use tauri::AppHandle;
use tauri::Manager;

use super::service::{ConflictDto, DiscoveredDto, PeerDto, SyncOutcome, SyncStatus};
use super::{SharedService, SyncState};

/// 取同步服务句柄（setup 时已经 manage 过）。
fn service(app: &AppHandle) -> Result<SharedService, String> {
    app.try_state::<SyncState>()
        .map(|state| state.0.clone())
        .ok_or_else(|| "同步服务未初始化".to_string())
}

/// 统一的 blocking 任务入口（与 `commands::blocking` 同样的错误 / 日志口径）。
async fn blocking<F, T>(what: &'static str, task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let started = std::time::Instant::now();
    let result =
        tauri::async_runtime::spawn_blocking(move || crate::panic_guard::catch_result(what, task))
            .await
        .map_err(|e| format!("{what}任务失败: {e}"))?;
    let elapsed = started.elapsed().as_millis();
    match &result {
        Ok(_) => log::debug!("{what}完成 {elapsed} ms"),
        Err(error) => log::warn!("{what}失败（{elapsed} ms）：{error}"),
    }
    result
}

/// 当前同步状态（开关 / 设备身份 / 冲突数 / 上次同步时间）。
#[tauri::command]
pub async fn readerx_sync_status(app: AppHandle) -> Result<SyncStatus, String> {
    blocking("同步状态读取", move || Ok(service(&app)?.status())).await
}

/// 开启 / 关闭同步。关闭后本地改动仍会记账，重新开启时一起同步出去。
#[tauri::command]
pub async fn readerx_sync_enable(app: AppHandle, enabled: bool) -> Result<SyncStatus, String> {
    blocking("同步开关", move || service(&app)?.set_enabled(enabled)).await
}

/// 自动同步开关与间隔（秒）。
#[tauri::command]
pub async fn readerx_sync_set_auto(
    app: AppHandle,
    enabled: bool,
    interval_secs: u64,
) -> Result<SyncStatus, String> {
    blocking("自动同步设置", move || {
        service(&app)?.set_auto(enabled, interval_secs)
    })
    .await
}

/// 改本机设备名（对端在局域网里看到的名称）。
#[tauri::command]
pub async fn readerx_sync_set_device_name(
    app: AppHandle,
    name: String,
) -> Result<SyncStatus, String> {
    blocking("设备名修改", move || service(&app)?.set_device_name(&name)).await
}

/// 本机配对码（把它交给另一台设备即可加入同一同步群组）。
#[tauri::command]
pub async fn readerx_sync_pairing_code(app: AppHandle) -> Result<String, String> {
    blocking("配对码读取", move || service(&app)?.pairing_code()).await
}

/// 用配对码加入群组。
#[tauri::command]
pub async fn readerx_sync_join(app: AppHandle, code: String) -> Result<SyncStatus, String> {
    blocking("加入同步群组", move || service(&app)?.join_group(&code)).await
}

/// 立即同步（先试已知设备，没有就扫局域网）。
#[tauri::command]
pub async fn readerx_sync_now(app: AppHandle) -> Result<SyncOutcome, String> {
    blocking("同步", move || service(&app)?.sync_now()).await
}

/// 与指定地址（`ip:port`）同步一次。
#[tauri::command]
pub async fn readerx_sync_sync_addr(app: AppHandle, addr: String) -> Result<SyncOutcome, String> {
    blocking("同步", move || service(&app)?.sync_with_addr_now(&addr)).await
}

/// 扫描局域网里同群组的设备。
#[tauri::command]
pub async fn readerx_sync_discover(app: AppHandle) -> Result<Vec<DiscoveredDto>, String> {
    blocking("局域网扫描", move || service(&app)?.discover_peers()).await
}

/// 已同步过的设备列表（含本机）。
#[tauri::command]
pub async fn readerx_sync_peers(app: AppHandle) -> Result<Vec<PeerDto>, String> {
    blocking("设备列表读取", move || Ok(service(&app)?.peers())).await
}

/// 本机对外的局域网地址（同步界面「本机地址」展示用）。
///
/// 刻意**不放进 SyncStatus**：网卡地址会随 Wi-Fi / 有线切换、VPN 起落而变，
/// 界面每次要显示时现取一次，才不会有「状态里那份是旧的」这种坑。
#[tauri::command]
pub async fn readerx_sync_lan_addrs() -> Result<Vec<String>, String> {
    blocking("本机地址读取", move || Ok(crate::sync::local_addresses())).await
}

/// 移除一台已配对设备：本机不再与它同步，并拒绝它连进来（直到重新接受）。
#[tauri::command]
pub async fn readerx_sync_remove_peer(
    app: AppHandle,
    device_id: String,
) -> Result<Vec<PeerDto>, String> {
    blocking("设备移除", move || service(&app)?.remove_peer(&device_id)).await
}

/// 重新接受一台被删除的设备（撤销拒绝）。
#[tauri::command]
pub async fn readerx_sync_accept_peer(
    app: AppHandle,
    device_id: String,
) -> Result<SyncStatus, String> {
    blocking("设备重新接受", move || service(&app)?.accept_peer(&device_id)).await
}

/// 冲突队列；`includeSettled` 为真时连已裁决的一起返回。
#[tauri::command]
pub async fn readerx_sync_conflicts(
    app: AppHandle,
    include_settled: bool,
) -> Result<Vec<ConflictDto>, String> {
    blocking("冲突列表读取", move || {
        Ok(service(&app)?.conflicts(include_settled))
    })
    .await
}

/// 裁决一条冲突：`keep` 为 `local` / `remote` / `dismiss`。
#[tauri::command]
pub async fn readerx_sync_resolve(
    app: AppHandle,
    id: String,
    keep: String,
) -> Result<SyncStatus, String> {
    blocking("冲突裁决", move || service(&app)?.resolve_conflict(&id, &keep)).await
}

/// 清空同步数据（换群组 / 排障）。本地书库、书源、进度都不受影响。
#[tauri::command]
pub async fn readerx_sync_reset(app: AppHandle) -> Result<SyncStatus, String> {
    blocking("同步数据清空", move || service(&app)?.reset()).await
}

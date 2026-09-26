//! 同步服务：引擎生命周期、局域网服务、自动同步线程与事件推送。
//!
//! ```text
//! SyncService（Tauri 全局状态）
//!   ├─ 引擎（SharedEngine）：本地记账 + 同步语义，就是 readerx-sync crate
//!   ├─ PeerServer           ：监听局域网对端的同步请求（开启同步时才有）
//!   ├─ DiscoveryService     ：回应同群组的 UDP 发现（开启同步时才有）
//!   └─ 自动同步线程          ：按设置里的间隔发起同步，带抖动，避免两台设备对撞
//! ```
//!
//! **「关闭同步」不等于「不记账」**：只要启用过一次（`SyncSettings::activated`），
//! 本地改动就持续记进操作日志，关掉的只是网络与自动同步。否则「关掉 → 本地读了几本书
//! → 再打开」这段历史会凭空消失。从未启用过的用户完全不受影响：不建引擎、不写日志。
//!
//! 锁的顺序（避免死锁）：
//!
//! ```text
//! Inner 锁（只做短操作）→ 取出引擎 Arc → 放掉 Inner 锁 → 引擎锁（同步会话会长时间持有）
//! ```
//!
//! 一次同步会话会**一直持有引擎锁**（`session::sync_with` 需要 `&mut SyncEngine`），
//! 所以自动同步带随机抖动，并且默认只由「设备 id 较大」的一方发起：两边同时向对方
//! 发起会话时，各自都在等对方的引擎锁，会一直耗到超时。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use readerx_sync::net::{
    self, lock_engine, DiscoveryService, PeerServer, ServerOptions, SharedEngine,
};
use readerx_sync::{Conflict, ConflictStatus, SyncEngine, SyncError};

use crate::storage;

use super::bridge::{self, AppliedChanges, BookIndex, PublishMode};
use super::settings::{self, SyncSettings};

/// 前端监听的事件名：同步状态变化（开关、同步结果、冲突数…）。
pub const SYNC_EVENT: &str = "readerx-sync-status";
/// 前端监听的事件名：同步结果改了本地数据（前端据此重载缓存）。
pub const SYNC_APPLIED_EVENT: &str = "readerx-sync-applied";

/// 同步数据目录名（`<应用数据目录>/sync`）
const SYNC_DIR: &str = "sync";
/// 单次同步会话的连接 / 读写超时
const SYNC_TIMEOUT: Duration = Duration::from_secs(8);
/// 发现扫描的等待时间
const DISCOVER_TIMEOUT: Duration = Duration::from_secs(2);
/// 自动同步线程的检查节拍
const TICK: Duration = Duration::from_secs(15);
/// 连续多少轮没同步成功后，「设备 id 较小」的一方也开始主动发起
const INITIATIVE_FALLBACK_ROUNDS: u32 = 3;

/// 同步运行状态（前端展示用）。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// 是否启用过同步（决定界面显示「开启同步」引导还是完整面板）
    pub activated: bool,
    /// 是否已开启（监听 + 自动同步在跑）
    pub enabled: bool,
    pub auto_sync: bool,
    pub auto_interval_secs: u64,
    pub device_name: String,
    pub device_id: String,
    pub group_id: String,
    /// 本机监听地址（未开启时为 None）
    pub listen_addr: Option<String>,
    /// 正在同步
    pub syncing: bool,
    /// 上次成功同步时间（毫秒）
    pub last_sync_ms: u64,
    /// 上次失败原因（成功一次后清空）
    pub last_error: Option<String>,
    /// 待裁决的冲突数
    pub pending_conflicts: usize,
    /// 已入库的实体数（书 / 进度 / 书签 / 分组 / 书源）
    pub entities: usize,
    /// 操作日志条数
    pub ops: usize,
    /// 已知对端数（不含本机）
    pub peers: usize,
}

/// 一台已知对端。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerDto {
    pub device_id: String,
    pub name: String,
    pub addr: Option<String>,
    pub last_sync_ms: u64,
    pub sync_count: u64,
    pub last_error: Option<String>,
    /// 是否是本机
    pub is_self: bool,
}

/// 扫描到的局域网设备。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDto {
    pub device_id: String,
    pub name: String,
    pub addr: String,
    /// 是否已经同步过
    pub known: bool,
}

/// 一次同步的结果。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    /// 成功同步的设备名
    pub synced: Vec<String>,
    /// 失败信息（设备名 + 原因）
    pub failed: Vec<String>,
    pub pulled: usize,
    pub pushed: usize,
    /// 新产生的冲突数
    pub conflicts: usize,
    pub applied: Option<AppliedChanges>,
}

/// 冲突记录 → 界面形状（带上「是哪本书 / 哪个字段」）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDto {
    pub id: String,
    pub kind: String,
    pub field: String,
    /// 冲突涉及对象的名字（书名 / 分组名 / 书源名）
    pub title: String,
    /// 原因码（前端翻文案）
    pub reason: String,
    /// 本地一方
    pub local: Option<String>,
    /// 对端一方
    pub remote: Option<String>,
    pub detected_at_ms: u64,
    pub note: Option<String>,
    /// 对端设备名
    pub peer: Option<String>,
}

/// 自动同步一轮的结果（决定下一次什么时候再试）。
#[derive(Debug)]
enum AutoRound {
    /// 与已配对设备同步成功
    Synced,
    /// 还没有已配对的设备：安静等待，不记日志
    NoPeers,
    /// 上一轮还在跑（手动同步撞上了）：等一会儿再看，不算失败
    Busy,
    /// 有已配对设备，但一台都没连上
    Failed(String),
}

/// 服务内部状态（只放短操作）。
struct Inner {
    settings: SyncSettings,
    engine: Option<SharedEngine>,
    server: Option<PeerServer>,
    discovery: Option<DiscoveryService>,
    index: BookIndex,
    syncing: bool,
    last_error: Option<String>,
    /// 下一次自动同步的**最早**时刻（毫秒时间戳）。
    /// 失败时往后推（退避），成功后再排到下一次间隔 —— 不能从 `last_sync_ms` 反推：
    /// 「一直没成功」会让「距上次成功已超过一个间隔」永远成立，循环就会空转。
    next_auto_ms: u64,
    /// 连续失败轮数（退避用）
    auto_failures: u32,
    /// 上次发布给引擎的 `readerx.shelf` 快照（用来只发布真正变了的条目）
    last_shelf: Option<Value>,
}

/// 同步服务。
///
/// 对运行时泛型：生产代码一律是默认的 Wry，泛型参数只为让集成 / 单元测试
/// 用 mock 运行时构造一个真实的服务实例（见文件末尾的测试与 `tests/sync_bridge.rs`）。
pub struct SyncService<R: tauri::Runtime = tauri::Wry> {
    app: AppHandle<R>,
    inner: Mutex<Inner>,
    wake: Condvar,
    stop: AtomicBool,
    auto_started: AtomicBool,
}

impl<R: tauri::Runtime> SyncService<R> {
    /// 建服务（不启动任何线程 / 端口，[`SyncService::bootstrap`] 才启动）。
    pub fn new(app: AppHandle<R>) -> Arc<SyncService<R>> {
        Arc::new(SyncService {
            app,
            inner: Mutex::new(Inner {
                settings: SyncSettings::default(),
                engine: None,
                server: None,
                discovery: None,
                index: BookIndex::default(),
                syncing: false,
                last_error: None,
                next_auto_ms: 0,
                auto_failures: 0,
                last_shelf: None,
            }),
            wake: Condvar::new(),
            stop: AtomicBool::new(false),
            auto_started: AtomicBool::new(false),
        })
    }

    /// 同步数据目录：`<应用数据目录>/sync`（与 `books/`、`state/`、`book_sources/` 并列）。
    pub fn data_dir(&self) -> Result<std::path::PathBuf, String> {
        Ok(storage::data_root(&self.app)?.join(SYNC_DIR))
    }

    // ------------------------------------------------------------ 生命周期

    /// 启动：启用过就开引擎、补齐落地、与本地对账，再按需拉起网络服务与自动同步。
    pub fn bootstrap(self: &Arc<Self>) {
        let Ok(root) = self.data_dir() else {
            log::warn!("无法定位同步数据目录，本次不启动同步");
            return;
        };
        let settings = settings::load(&root);
        self.lock().settings = settings.clone();
        if !settings.activated {
            log::debug!("同步从未启用过，本次不建引擎");
            return;
        }
        if let Err(error) = self.open_engine(&root, &settings) {
            log::error!("同步引擎启动失败：{error}");
            self.lock().last_error = Some(error);
            return;
        }
        // 上次运行可能在「同步完成」与「写回本地」之间被杀：先补齐落地。
        // 顺序不能反 —— 与本地对账会把落地游标推到日志末尾，
        // 先对账就等于把还没落地的那一段远端操作跳过去了。
        match self.materialize_pending() {
            Ok(changes) => self.emit_applied(&changes),
            Err(error) => log::warn!("补齐同步落地失败：{error}"),
        }
        if let Err(error) = self.reconcile_local() {
            log::warn!("同步对账未完成（下次启动会继续）：{error}");
        }
        if settings.enabled {
            self.start_network();
            self.start_auto_thread();
        }
        self.emit_status();
    }

    /// 退出：停线程、停服务、把引擎快照刷盘。
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::Relaxed);
        self.wake.notify_all();
        self.stop_network();
        if let Some(engine) = self.engine() {
            if let Err(error) = lock_engine(&engine).flush() {
                log::warn!("同步数据刷盘失败：{error}");
            }
        }
        self.persist_settings();
    }

    /// 打开引擎（幂等）。
    fn open_engine(&self, root: &std::path::Path, settings: &SyncSettings) -> Result<(), String> {
        if self.lock().engine.is_some() {
            return Ok(());
        }
        let engine = SyncEngine::open(
            root,
            readerx_sync::EngineOptions::new(default_device_name()),
        )
        .map_err(|e| e.to_string())?;
        let shared = net::shared(engine);
        let ops = lock_engine(&shared).op_count();
        {
            let mut inner = self.lock();
            inner.index = BookIndex::default();
            inner.engine = Some(shared);
            // 保留上次的落地游标（clamp 到当前日志长度）：进程在「同步完成」与
            // 「写回本地」之间被杀时，要靠它找出还没落地的那一段远端操作
            inner.settings.materialized_ops = settings.materialized_ops.min(ops);
            inner.settings.activated = true;
            inner.settings.enabled = settings.enabled;
            inner.settings.auto_sync = settings.auto_sync;
            inner.settings.auto_interval_secs = settings.auto_interval_secs;
        }
        self.persist_settings();
        Ok(())
    }

    /// 与本地数据对账：把书库 / 进度 / 书签 / 分组 / 书源里引擎还没有的记录补进去。
    ///
    /// 首次启用时这一步要写几百条操作（每条都要 fsync），因此**放在后台线程**：
    /// 用户点开关必须立刻有反应，而不是等整个书库灌完。
    pub fn reconcile_local(&self) -> Result<(), String> {
        let engine = self.engine().ok_or("同步未启用")?;
        let mut index = {
            let mut inner = self.lock();
            std::mem::take(&mut inner.index)
        };
        let result = bridge::reconcile(&self.app, &engine, &mut index);
        let ops = lock_engine(&engine).op_count();
        {
            let mut inner = self.lock();
            inner.index = index;
            inner.settings.materialized_ops = ops;
        }
        self.persist_settings();
        self.emit_status();
        result.map_err(|e| e.to_string())
    }

    // ------------------------------------------------------------ 开关与设置

    /// 开启 / 关闭同步。
    pub fn set_enabled(self: &Arc<Self>, on: bool) -> Result<SyncStatus, String> {
        let root = self.data_dir()?;
        let mut settings = settings::load(&root);
        if on {
            if let Err(error) = self.open_engine(&root, &settings) {
                self.lock().last_error = Some(error.clone());
                self.emit_status();
                return Err(error);
            }
            settings.activated = true;
            settings.enabled = true;
            settings::save(&root, &settings).map_err(|e| e.to_string())?;
            {
                let mut inner = self.lock();
                inner.settings.enabled = true;
                inner.settings.activated = true;
            }
            self.start_network();
            self.start_auto_thread();
            self.schedule_auto_soon();
            log::info!("同步已开启");
            // 对账 + 首轮同步都放后台：把现有书库灌进引擎是几百条落盘操作，
            // 开关本身要立刻响应（用户也不必干等第一次自动同步）。首轮只与
            // **已配对设备**同步，不扫局域网。
            let service = Arc::clone(self);
            std::thread::Builder::new()
                .name("readerx-sync-first".to_string())
                .spawn(move || {
                    if let Err(error) = service.reconcile_local() {
                        log::warn!("同步对账未完成：{error}");
                    }
                    if let Err(error) = service.sync_now() {
                        log::debug!("开启同步后的首轮同步未完成：{error}");
                    }
                })
                .ok();
        } else {
            settings.enabled = false;
            settings::save(&root, &settings).map_err(|e| e.to_string())?;
            self.stop_network();
            self.lock().settings.enabled = false;
            if let Some(engine) = self.engine() {
                let _ = lock_engine(&engine).flush();
            }
            self.wake.notify_all();
            log::info!("同步已关闭（本地改动继续记账，重新开启后会一起同步出去）");
        }
        self.emit_status();
        Ok(self.status())
    }

    /// 自动同步开关与间隔。
    pub fn set_auto(self: &Arc<Self>, on: bool, interval_secs: u64) -> Result<SyncStatus, String> {
        let root = self.data_dir()?;
        let mut settings = settings::load(&root);
        settings.auto_sync = on;
        settings.set_interval(interval_secs);
        settings::save(&root, &settings).map_err(|e| e.to_string())?;
        {
            let mut inner = self.lock();
            inner.settings.auto_sync = settings.auto_sync;
            inner.settings.auto_interval_secs = settings.auto_interval_secs;
        }
        if settings.enabled && on {
            self.start_auto_thread();
        }
        self.schedule_auto_soon();
        self.emit_status();
        Ok(self.status())
    }

    /// 改本机设备名（对端看到的名字）。
    pub fn set_device_name(self: &Arc<Self>, name: &str) -> Result<SyncStatus, String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 40 {
            return Err("设备名应为 1–40 个字符".to_string());
        }
        let engine = self.ensure_engine()?;
        {
            let mut guard = lock_engine(&engine);
            guard.rename_device(name).map_err(|e| e.to_string())?;
        }
        // 设备名参与发现应答与握手：监听端要用新名字重新应答
        if self.lock().settings.enabled {
            self.stop_network();
            self.start_network();
        }
        log::info!("同步设备名已改为 {name}");
        self.emit_status();
        Ok(self.status())
    }

    /// 配对码（交给另一台设备即可加入同一同步群组）。
    ///
    /// 刻意不在这里现开引擎：同步页在「未开启」时也会拉一次配对码，
    /// 而建引擎意味着把整个书库灌进操作日志 —— 那是用户按下开关才该付的代价。
    pub fn pairing_code(&self) -> Result<String, String> {
        let engine = self.engine().ok_or("同步未开启")?;
        let code = lock_engine(&engine).pairing_code();
        Ok(code)
    }

    /// 用配对码加入群组（本地已有数据会在下次同步时发出去）。
    pub fn join_group(self: &Arc<Self>, code: &str) -> Result<SyncStatus, String> {
        let root = self.data_dir()?;
        let mut settings = settings::load(&root);
        settings.activated = true;
        settings.enabled = true;
        if self.engine().is_none() {
            self.open_engine(&root, &settings)?;
            self.reconcile_local()?;
        }
        let engine = self.engine().ok_or("同步引擎未就绪")?;
        {
            let mut guard = lock_engine(&engine);
            guard.join_group(code.trim()).map_err(|e| e.to_string())?;
        }
        settings::save(&root, &settings).map_err(|e| e.to_string())?;
        {
            let mut inner = self.lock();
            inner.settings.activated = true;
            inner.settings.enabled = true;
        }
        self.start_network();
        self.start_auto_thread();
        self.emit_status();
        log::info!("已加入同步群组");
        self.schedule_auto_soon();
        let service = Arc::clone(self);
        std::thread::Builder::new()
            .name("readerx-sync-join".to_string())
            .spawn(move || {
                // 刚刚配对：这时**需要**扫一次局域网把对方找出来（也就这一次）
                if let Err(error) = service.sync_round(true) {
                    log::debug!("配对后的首轮同步未完成：{error}");
                }
            })
            .ok();
        Ok(self.status())
    }

    /// 清空同步数据（换群组 / 排障）：删掉整个同步目录，回到「从未启用」。
    /// 本地书库、书源、进度都不受影响。
    pub fn reset(self: &Arc<Self>) -> Result<SyncStatus, String> {
        self.stop_network();
        {
            let mut inner = self.lock();
            inner.engine = None;
            inner.index = BookIndex::default();
            inner.last_shelf = None;
            inner.settings = SyncSettings::default();
            inner.last_error = None;
        }
        let root = self.data_dir()?;
        if root.exists() {
            std::fs::remove_dir_all(&root).map_err(|e| format!("清理同步数据失败: {e}"))?;
        }
        log::info!("同步数据已清空（本地书库与书源不受影响）");
        self.emit_status();
        Ok(self.status())
    }

    // ------------------------------------------------------------ 同步

    /// 立即同步一次：**只与已配对的设备同步**。
    ///
    /// 不扫局域网：配对是显式动作（填配对码 / 在查找结果里选设备），
    /// 「找到谁就和谁同步」既不是用户的预期，也让数据去向变得不可控。
    pub fn sync_now(self: &Arc<Self>) -> Result<SyncOutcome, String> {
        self.sync_round(false)
    }

    /// 一轮同步；`allow_discovery` 只给「刚配对完」用（见 [`SyncService::join_group`]）。
    fn sync_round(self: &Arc<Self>, allow_discovery: bool) -> Result<SyncOutcome, String> {
        let engine = self.ensure_engine()?;
        self.begin_sync()?;
        let outcome = self.run_sync(&engine, allow_discovery);
        let synced = outcome.as_ref().map(|o| o.synced.len()).unwrap_or(0);
        let failure = outcome.as_ref().err().cloned();
        self.finish_sync(synced, failure);
        outcome
    }

    /// 与指定地址同步一次（用户在设备列表里点某台设备）。
    /// 成功即把对方记为已配对设备（引擎在同步过程中已经这样记了）。
    pub fn sync_with_addr_now(self: &Arc<Self>, addr: &str) -> Result<SyncOutcome, String> {
        let engine = self.ensure_engine()?;
        self.begin_sync()?;
        let result = self.sync_with(&engine, addr);
        let mut outcome = match &result {
            Ok(report) => SyncOutcome {
                synced: vec![addr.to_string()],
                pulled: report.pulled,
                pushed: report.pushed,
                conflicts: report.conflicts,
                ..SyncOutcome::default()
            },
            Err(error) => SyncOutcome {
                failed: vec![error.to_string()],
                ..SyncOutcome::default()
            },
        };
        let applied = self.materialize_pending()?;
        if !applied.is_empty() {
            self.emit_applied(&applied);
        }
        outcome.applied = Some(applied);
        self.finish_sync(outcome.synced.len(), result.as_ref().err().map(|e| e.to_string()));
        if result.is_ok() {
            // 刚配对上的设备：让自动同步按正常节奏接管
            self.schedule_auto_soon();
        }
        result.map(|_| outcome).map_err(|e| e.to_string())
    }

    /// 一轮同步（只打已知地址；`allow_discovery` 时才退一步扫局域网）。
    fn run_sync(&self, engine: &SharedEngine, allow_discovery: bool) -> Result<SyncOutcome, String> {
        let mut outcome = SyncOutcome::default();
        let mut targets = self.known_targets(engine);
        if targets.is_empty() && allow_discovery {
            match self.discover_peers_inner(engine) {
                Ok(found) => {
                    for peer in found {
                        targets.push((peer.device_id, peer.name, peer.addr));
                    }
                }
                Err(error) => log::debug!("局域网发现失败：{error}"),
            }
        }
        let had_targets = !targets.is_empty();
        self.sync_targets(engine, &targets, &mut outcome);
        // 一台都没连上：多半是对端换了 IP（DHCP）或记的地址已经失效。
        // 用一次发现刷新**已配对设备**的地址，地址真的变了就再给一次机会 ——
        // 手动同步不该让用户「再点一次才成功」。
        if outcome.synced.is_empty() && had_targets {
            let refreshed = self.refresh_paired_addrs(engine);
            if !refreshed.is_empty() {
                log::info!("已刷新 {} 台对端的地址，重试同步", refreshed.len());
                outcome.failed.clear();
                self.sync_targets(engine, &refreshed, &mut outcome);
            }
        }
        let applied = self.materialize_pending()?;
        if !applied.is_empty() {
            self.emit_applied(&applied);
        }
        outcome.applied = Some(applied);
        if outcome.synced.is_empty() && outcome.failed.is_empty() {
            return Err("还没有已配对的设备：先用配对码加入，或在「查找局域网设备」里选一台".to_string());
        }
        Ok(outcome)
    }

    /// 依次与这些地址同步，把结果累加进 [`SyncOutcome`]。
    fn sync_targets(
        &self,
        engine: &SharedEngine,
        targets: &[(String, String, String)],
        outcome: &mut SyncOutcome,
    ) {
        for (device, name, addr) in targets {
            match self.sync_with(engine, addr) {
                Ok(report) => {
                    outcome.pulled += report.pulled;
                    outcome.pushed += report.pushed;
                    outcome.conflicts += report.conflicts;
                    outcome
                        .synced
                        .push(if name.is_empty() { device.clone() } else { name.clone() });
                }
                Err(error) => {
                    log::debug!("与对端同步失败 addr={addr}: {error}");
                    outcome.failed.push(format!("{name}：{error}"));
                }
            }
        }
    }

    fn known_targets(&self, engine: &SharedEngine) -> Vec<(String, String, String)> {
        let guard = lock_engine(engine);
        guard
            .peers()
            .values()
            .filter_map(|peer| {
                peer.addr
                    .as_ref()
                    .map(|addr| (peer.device_id.clone(), peer.name.clone(), addr.clone()))
            })
            .collect()
    }

    /// 与一个地址同步一次（引擎锁在这里被持有整个会话）。
    fn sync_with(
        &self,
        engine: &SharedEngine,
        addr: &str,
    ) -> Result<readerx_sync::SyncReport, SyncError> {
        let mut guard = lock_engine(engine);
        readerx_sync::sync_with_addr(&mut guard, addr, SYNC_TIMEOUT)
    }

    fn begin_sync(&self) -> Result<(), String> {
        let mut inner = self.lock();
        if inner.syncing {
            return Err("正在同步中".to_string());
        }
        inner.syncing = true;
        drop(inner);
        self.emit_status();
        Ok(())
    }

    fn finish_sync(&self, synced: usize, error: Option<String>) {
        {
            let mut inner = self.lock();
            inner.syncing = false;
            if synced > 0 {
                inner.settings.last_sync_ms = now_ms();
                inner.last_error = None;
                inner.auto_failures = 0;
            } else if let Some(error) = error {
                inner.last_error = Some(error);
            }
        }
        self.persist_settings();
        self.emit_status();
    }

    /// 把 `materialized_ops` 之后的操作落地到本地文件，并推进游标。
    fn materialize_pending(&self) -> Result<AppliedChanges, String> {
        let engine = self.engine().ok_or("同步尚未启用")?;
        let from = self.lock().settings.materialized_ops;
        let mut index = {
            let mut inner = self.lock();
            std::mem::take(&mut inner.index)
        };
        let result = bridge::materialize(&self.app, &engine, from, &mut index);
        let (ops, conflicts) = {
            let guard = lock_engine(&engine);
            (guard.op_count(), guard.pending_conflict_count())
        };
        {
            let mut inner = self.lock();
            inner.index = index;
            inner.settings.materialized_ops = ops;
        }
        self.persist_settings();
        if conflicts > 0 {
            log::debug!("同步有 {conflicts} 条待裁决冲突");
        }
        result.map_err(|e| e.to_string())
    }

    /// 落地指定实体（冲突裁决后用，见 [`SyncService::resolve_conflict`]）。
    fn materialize_ids(&self, ids: &[String]) -> Result<AppliedChanges, String> {
        let engine = self.engine().ok_or("同步尚未启用")?;
        let mut index = {
            let mut inner = self.lock();
            std::mem::take(&mut inner.index)
        };
        let result = bridge::materialize_entities(&self.app, &engine, &mut index, ids);
        self.lock().index = index;
        result.map_err(|e| e.to_string())
    }

    /// 扫描局域网里同群组的设备。
    pub fn discover_peers(&self) -> Result<Vec<DiscoveredDto>, String> {
        let engine = self.ensure_engine()?;
        self.discover_peers_inner(&engine)
    }

    fn discover_peers_inner(&self, engine: &SharedEngine) -> Result<Vec<DiscoveredDto>, String> {
        let (secret, group, device, name, known) = {
            let guard = lock_engine(engine);
            (
                guard.secret_bytes().map_err(|e| e.to_string())?,
                guard.group_id().to_string(),
                guard.device_id().to_string(),
                guard.device_name().to_string(),
                guard.peers().keys().cloned().collect::<Vec<String>>(),
            )
        };
        let found = readerx_sync::net::discovery::scan(
            &secret,
            &group,
            &device,
            &name,
            DISCOVER_TIMEOUT,
            readerx_sync::DEFAULT_DISCOVERY_PORT,
        )
        .map_err(|e| e.to_string())?;
        Ok(found
            .into_iter()
            .map(|peer| DiscoveredDto {
                known: known.iter().any(|id| id == &peer.device),
                device_id: peer.device,
                name: peer.name,
                addr: peer.addr.to_string(),
            })
            .collect())
    }

    // ------------------------------------------------------------ 查询

    /// 当前状态。
    pub fn status(&self) -> SyncStatus {
        let inner = self.lock();
        let settings = &inner.settings;
        let mut status = SyncStatus {
            activated: settings.activated,
            enabled: settings.enabled,
            auto_sync: settings.auto_sync,
            auto_interval_secs: settings.auto_interval_secs,
            syncing: inner.syncing,
            last_sync_ms: settings.last_sync_ms,
            last_error: inner.last_error.clone(),
            listen_addr: inner.server.as_ref().map(|s| s.local_addr().to_string()),
            ..SyncStatus::default()
        };
        if let Some(engine) = &inner.engine {
            let guard = lock_engine(engine);
            let engine_status = guard.status();
            status.device_id = engine_status.device_id;
            status.device_name = engine_status.device_name;
            status.group_id = engine_status.group_id;
            status.pending_conflicts = engine_status.pending_conflicts;
            status.entities = engine_status.live_entities;
            status.ops = engine_status.ops;
            status.peers = engine_status.peers;
        }
        status
    }

    /// 已知对端（含本机，本机排最前）。
    pub fn peers(&self) -> Vec<PeerDto> {
        let Some(engine) = self.engine() else {
            return Vec::new();
        };
        let guard = lock_engine(&engine);
        let mut list: Vec<PeerDto> = guard
            .peers()
            .values()
            .map(|peer| PeerDto {
                device_id: peer.device_id.clone(),
                name: peer.name.clone(),
                addr: peer.addr.clone(),
                last_sync_ms: peer.last_sync_ms,
                sync_count: peer.sync_count,
                last_error: peer.last_error.clone(),
                is_self: false,
            })
            .collect();
        list.push(PeerDto {
            device_id: guard.device_id().to_string(),
            name: guard.device_name().to_string(),
            addr: guard
                .peers()
                .get(guard.device_id())
                .and_then(|peer| peer.addr.clone()),
            last_sync_ms: 0,
            sync_count: 0,
            last_error: None,
            is_self: true,
        });
        list.sort_by(|a, b| b.is_self.cmp(&a.is_self).then(a.name.cmp(&b.name)));
        list
    }

    /// 冲突队列（默认只看待裁决的）。
    pub fn conflicts(&self, include_settled: bool) -> Vec<ConflictDto> {
        let Some(engine) = self.engine() else {
            return Vec::new();
        };
        let guard = lock_engine(&engine);
        let filter = (!include_settled).then_some(ConflictStatus::Pending);
        let mut list: Vec<ConflictDto> = guard
            .conflicts(filter)
            .into_iter()
            .map(|conflict| conflict_dto(&guard, conflict))
            .collect();
        // 待裁决的排前面，其次按检测时间倒序
        list.sort_by_key(|conflict| std::cmp::Reverse(conflict.detected_at_ms));
        list
    }

    /// 裁决一条冲突。
    pub fn resolve_conflict(self: &Arc<Self>, id: &str, keep: &str) -> Result<SyncStatus, String> {
        let engine = self.ensure_engine()?;
        let resolution = match keep {
            "local" => readerx_sync::Resolution::KeepLocal,
            "remote" => readerx_sync::Resolution::KeepRemote,
            "dismiss" => readerx_sync::Resolution::Dismiss,
            other => return Err(format!("未知的裁决方式：{other}")),
        };
        let entity_id = {
            let mut guard = lock_engine(&engine);
            let conflict = guard
                .conflicts(None)
                .into_iter()
                .find(|conflict| conflict.id == id)
                .map(|conflict| conflict.entity_id.clone())
                .ok_or_else(|| "冲突记录已不存在".to_string())?;
            guard.resolve_conflict(id, resolution).map_err(|e| e.to_string())?;
            guard.flush().map_err(|e| e.to_string())?;
            conflict
        };
        // 裁决结果也要落回本地文件：裁决写的是一次**本地**写入（比如采用了对端那一份），
        // 按操作来源过滤的常规落地会跳过它，这里点名落地这一个实体。
        let mut changes = self.materialize_pending().unwrap_or_default();
        let extra = match self.materialize_ids(&[entity_id]) {
            Ok(applied) => applied,
            Err(error) => {
                log::warn!("裁决后的落地失败：{error}");
                AppliedChanges::default()
            }
        };
        changes.books |= extra.books;
        changes.progress |= extra.progress;
        changes.groups |= extra.groups;
        changes.sources |= extra.sources;
        changes.bookmarks.extend(extra.bookmarks);
        changes.deleted_books.extend(extra.deleted_books);
        self.emit_applied(&changes);
        self.emit_status();
        Ok(self.status())
    }

    // ------------------------------------------------------------ 本地写入钩子
    //
    // 未启用同步时全部是空操作（引擎都没建），因此本地写路径可以无条件调用。

    /// 书籍元信息变了（导入 / 改名 / 换分组 / 改标签）。
    pub fn on_book_changed(&self, book_id: &str, mode: PublishMode) {
        let Some(engine) = self.engine() else {
            return;
        };
        if let Err(error) = bridge::publish_book(&self.app, &engine, book_id, mode) {
            log::warn!("同步发布书籍失败（{book_id}）：{error}");
            return;
        }
        let mut inner = self.lock();
        let uid = bridge::local_uid(&self.app, book_id);
        inner.index.insert(book_id, &uid);
    }

    /// 书籍被删除（**必须在本地删文件之前调用**：定位书身份要读 `bookdetail.json`）。
    pub fn on_book_deleted(&self, book_id: &str) {
        let Some(engine) = self.engine() else {
            return;
        };
        if let Err(error) = bridge::publish_book_delete(&self.app, &engine, book_id) {
            log::warn!("同步发布书籍删除失败（{book_id}）：{error}");
        }
        self.lock().index.remove(book_id);
    }

    /// 书签整表被写入。
    pub fn on_bookmarks_changed(&self, book_id: &str, bookmarks: &[Value]) {
        let Some(engine) = self.engine() else {
            return;
        };
        let mut index = {
            let mut inner = self.lock();
            std::mem::take(&mut inner.index)
        };
        let result = bridge::publish_bookmarks(&self.app, &engine, &mut index, book_id, bookmarks);
        self.lock().index = index;
        if let Err(error) = result {
            log::warn!("同步发布书签失败（{book_id}）：{error}");
        }
    }

    /// 阅读进度整表被写入（`readerx.shelf`）：只发布真正变了的条目。
    pub fn on_shelf_changed(&self, shelf: &Value) {
        let Some(engine) = self.engine() else {
            return;
        };
        let changed: Vec<(String, Value)> = {
            let inner = self.lock();
            let previous = inner.last_shelf.as_ref().and_then(Value::as_object);
            let mut changed = Vec::new();
            for (book_id, entry) in shelf.as_object().into_iter().flatten() {
                let same = previous
                    .and_then(|map| map.get(book_id))
                    .map(|old| old == entry)
                    .unwrap_or(false);
                if !same {
                    changed.push((book_id.clone(), entry.clone()));
                }
            }
            changed
        };
        if changed.is_empty() {
            return;
        }
        let mut index = {
            let mut inner = self.lock();
            std::mem::take(&mut inner.index)
        };
        let mut failed = false;
        for (book_id, entry) in &changed {
            if let Err(error) =
                bridge::publish_progress(&self.app, &engine, &mut index, book_id, entry)
            {
                log::warn!("同步发布阅读进度失败（{book_id}）：{error}");
                failed = true;
                break;
            }
        }
        {
            let mut inner = self.lock();
            inner.index = index;
            if !failed {
                inner.last_shelf = Some(shelf.clone());
            }
        }
    }

    /// 分组清单被写入。
    pub fn on_groups_changed(&self, groups: &Value) {
        let Some(engine) = self.engine() else {
            return;
        };
        if let Err(error) = bridge::publish_groups(&self.app, &engine, groups) {
            log::warn!("同步发布分组失败：{error}");
        }
    }

    /// 书源被写入。
    pub fn on_source_changed(&self, source: &crate::models::BookSource) {
        let Some(engine) = self.engine() else {
            return;
        };
        if let Err(error) = bridge::publish_source(&self.app, &engine, source) {
            log::warn!("同步发布书源失败：{error}");
        }
    }

    /// 书源被删除（要在真正删文件之前拿到地址）。
    pub fn on_source_deleted(&self, book_source: &crate::models::BookSource) {
        let Some(engine) = self.engine() else {
            return;
        };
        if let Err(error) =
            bridge::publish_source_delete(&self.app, &engine, &book_source.book_source_url)
        {
            log::warn!("同步发布书源删除失败：{error}");
        }
    }

    // ------------------------------------------------------------ 内部

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn engine(&self) -> Option<SharedEngine> {
        self.lock().engine.clone()
    }

    /// 取引擎；没有（同步从未启用）时按设置里的目录现开一个并进入记账状态。
    fn ensure_engine(&self) -> Result<SharedEngine, String> {
        if let Some(engine) = self.engine() {
            return Ok(engine);
        }
        let root = self.data_dir()?;
        let mut settings = settings::load(&root);
        settings.activated = true;
        self.open_engine(&root, &settings)?;
        self.engine().ok_or_else(|| "同步引擎未就绪".to_string())
    }

    fn persist_settings(&self) {
        let settings = self.lock().settings.clone();
        if let Ok(root) = self.data_dir() {
            if let Err(error) = settings::save(&root, &settings) {
                log::warn!("同步设置写盘失败：{error}");
            }
        }
    }

    /// 拉起 TCP 监听与 UDP 发现（幂等）。
    fn start_network(&self) {
        let Some(engine) = self.engine() else {
            return;
        };
        {
            let mut inner = self.lock();
            if inner.server.is_some() {
                return;
            }
            let (options, secret, group, device, name) = {
                let guard = lock_engine(&engine);
                let options = match ServerOptions::from_engine(&guard) {
                    Ok(options) => options,
                    Err(error) => {
                        log::warn!("同步服务无法启动：{error}");
                        return;
                    }
                };
                (
                    options,
                    guard.secret_bytes().unwrap_or_default(),
                    guard.group_id().to_string(),
                    guard.device_id().to_string(),
                    guard.device_name().to_string(),
                )
            };
            match PeerServer::start(engine.clone(), options) {
                Ok(server) => {
                    let port = server.local_addr().port();
                    match DiscoveryService::start(
                        secret,
                        group,
                        device,
                        name,
                        port,
                        readerx_sync::DEFAULT_DISCOVERY_PORT,
                        std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
                    ) {
                        Ok(discovery) => inner.discovery = Some(discovery),
                        // 发现服务起不来不影响同步（还能按上次地址直连），只提示
                        Err(error) => log::warn!("同步发现服务未启动（不影响直连同步）：{error}"),
                    }
                    log::info!("同步服务已监听 {}", server.local_addr());
                    inner.server = Some(server);
                    drop(inner);
                    // 让引擎知道自己在监听哪个端口：握手时告诉对端，
                    // 对端才能记住怎么主动连回来（连接的源端口是临时的，不能用）
                    lock_engine(&engine).set_listen_port(port);
                }
                Err(error) => {
                    log::warn!("同步服务启动失败：{error}");
                    inner.last_error = Some(error.to_string());
                }
            }
        }
    }

    fn stop_network(&self) {
        let engine = {
            let mut inner = self.lock();
            inner.server = None;
            inner.discovery = None;
            inner.engine.clone()
        };
        // 停止监听后不能再对外宣称「可以连我」：握手时会告诉对端端口 0，
        // 对端据此清掉地址，不再往一个已经关掉的端口上重试
        if let Some(engine) = engine {
            lock_engine(&engine).set_listen_port(0);
        }
    }

    /// 启动自动同步线程（只起一次；要不要干活由设置决定）。
    fn start_auto_thread(self: &Arc<Self>) {
        if self.auto_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let service = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("readerx-sync-auto".to_string())
            .spawn(move || service.auto_loop());
        if let Err(error) = spawned {
            self.auto_started.store(false, Ordering::SeqCst);
            log::warn!("自动同步线程创建失败：{error}");
        }
    }

    /// 自动同步循环：到点才发起，成功按间隔、失败按退避排下一次。
    fn auto_loop(self: Arc<Self>) {
        log::debug!("自动同步线程已启动");
        while !self.stop.load(Ordering::Relaxed) {
            let wait = self.auto_wait();
            if wait > Duration::ZERO {
                let (guard, _) = self
                    .wake
                    .wait_timeout(self.lock(), wait)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                drop(guard);
                continue;
            }
            let round = self.auto_round();
            self.schedule_next_auto(round);
        }
        log::debug!("自动同步线程已退出");
    }

    /// 距离下一次自动同步还有多久（未开启 / 关掉自动同步时按 [`TICK`] 醒来查看设置）。
    fn auto_wait(&self) -> Duration {
        let inner = self.lock();
        if !inner.settings.enabled || !inner.settings.auto_sync {
            return TICK;
        }
        let now = now_ms();
        if inner.next_auto_ms <= now {
            return Duration::ZERO;
        }
        // 最多睡一个 TICK：设置变化 / 手动同步会唤醒它，这里再兜一层
        Duration::from_millis(inner.next_auto_ms - now).min(TICK)
    }

    /// 排下一次自动同步（成功与失败都要排，否则就是空转）。
    fn schedule_next_auto(&self, round: AutoRound) {
        let mut inner = self.lock();
        let now = now_ms();
        let interval = inner.settings.auto_interval_secs.max(1) * 1000;
        let step = TICK.as_millis() as u64;
        let delay = match round {
            // 成功 / 还没有已配对设备：按设置的间隔再来
            AutoRound::Synced | AutoRound::NoPeers => {
                inner.auto_failures = 0;
                interval
            }
            AutoRound::Busy => step,
            // 有已配对设备但都没连上：从 TICK 起翻倍退避，最多到一个间隔
            AutoRound::Failed(error) => {
                inner.auto_failures = inner.auto_failures.saturating_add(1);
                inner.last_error = Some(error);
                step.saturating_mul(1u64 << inner.auto_failures.min(4))
                    .min(interval)
                    .max(step)
            }
        };
        inner.next_auto_ms = now + delay + jitter_ms();
    }

    /// 立即安排一次自动同步（开关打开 / 刚配对完 / 改过设置时用）。
    fn schedule_auto_soon(&self) {
        {
            let mut inner = self.lock();
            inner.next_auto_ms = 0;
            inner.auto_failures = 0;
        }
        self.wake.notify_all();
    }

    /// 自动同步一轮：**只与已配对的设备同步**，不认识的设备一概不碰。
    fn auto_round(self: &Arc<Self>) -> AutoRound {
        let Some(engine) = self.engine() else {
            return AutoRound::NoPeers;
        };
        let targets: Vec<(String, String, String)> = {
            let guard = lock_engine(&engine);
            let self_id = guard.device_id().to_string();
            let failures = self.lock().auto_failures;
            guard
                .peers()
                .values()
                .filter_map(|peer| {
                    let addr = peer.addr.clone()?;
                    // 默认只由「设备 id 较大」的一方发起：两边同时发起会互相等对方的
                    // 引擎锁，直到双双超时。连续几轮都没成功时，这一侧也主动起来。
                    let initiative = self_id > peer.device_id || failures >= INITIATIVE_FALLBACK_ROUNDS;
                    initiative.then(|| (peer.device_id.clone(), peer.name.clone(), addr))
                })
                .collect()
        };
        if targets.is_empty() {
            // 没有任何已配对的设备：安静等着（配对是显式动作，不扫局域网找陌生人）
            return AutoRound::NoPeers;
        }
        if self.begin_sync().is_err() {
            // 手动同步正好在跑：等一会儿再看，不当成失败（不该在界面上报错）
            return AutoRound::Busy;
        }
        let mut synced = 0usize;
        let mut last_error = None;
        for (_, name, addr) in &targets {
            match self.sync_with(&engine, addr) {
                Ok(report) => {
                    synced += 1;
                    // 有实际动静才记 info：后台每 15 分钟一条「什么都没发生」只会淹没日志
                    if report.pulled + report.pushed + report.conflicts > 0 {
                        log::info!("自动同步完成 peer={name} {}", report.summary());
                    } else {
                        log::debug!("自动同步完成（无变化）peer={name}");
                    }
                }
                Err(error) => {
                    log::debug!("自动同步失败 peer={name}: {error}");
                    last_error = Some(error.to_string());
                }
            }
        }
        {
            let mut inner = self.lock();
            inner.syncing = false;
            if synced > 0 {
                inner.settings.last_sync_ms = now_ms();
                inner.last_error = None;
            }
        }
        self.persist_settings();
        match self.materialize_pending() {
            Ok(applied) if !applied.is_empty() => self.emit_applied(&applied),
            Ok(_) => {}
            Err(error) => log::warn!("自动同步后的落地失败：{error}"),
        }
        if synced == 0 {
            // 全都没连上（换网 / 换 IP 很常见）：用发现**刷新已配对设备的地址**，
            // 下一轮就能连上。发现结果里不认识的设备一律忽略。
            let _ = self.refresh_paired_addrs(&engine);
            return AutoRound::Failed(
                last_error.unwrap_or_else(|| "没有连上任何已配对的设备".to_string()),
            );
        }
        self.emit_status();
        AutoRound::Synced
    }

    /// 用一次发现扫描刷新**已配对设备**的地址（DHCP 换 IP / 换网卡后用）。
    ///
    /// 只更新已知设备的地址，绝不与陌生设备同步：配对是显式动作，
    /// 发现只用来让已配对的连接重新连上。
    fn refresh_paired_addrs(&self, engine: &SharedEngine) -> Vec<(String, String, String)> {
        let known: Vec<String> = {
            let guard = lock_engine(engine);
            guard.peers().keys().cloned().collect()
        };
        if known.is_empty() {
            return Vec::new();
        }
        let Ok(found) = self.discover_peers_inner(engine) else {
            return Vec::new();
        };
        let mut updated = Vec::new();
        let mut guard = lock_engine(engine);
        for peer in found {
            if !known.iter().any(|device| device == &peer.device_id) {
                continue; // 不认识的设备：配对是显式动作，发现只服务于已配对的连接
            }
            let addr = peer.addr.to_string();
            let changed = guard
                .peers()
                .get(&peer.device_id)
                .and_then(|known| known.addr.clone())
                .as_deref()
                != Some(addr.as_str());
            guard.update_peer_addr(&peer.device_id, &addr);
            if changed {
                updated.push((peer.device_id, peer.name, addr));
            }
        }
        updated
    }

    fn emit_status(&self) {
        let status = self.status();
        if let Err(error) = self.app.emit(SYNC_EVENT, &status) {
            log::debug!("同步状态事件发送失败：{error}");
        }
    }

    fn emit_applied(&self, changes: &AppliedChanges) {
        if changes.is_empty() {
            return;
        }
        log::info!(
            "同步落地: 书籍={} 进度={} 分组={} 书源={} 书签={} 删除={}",
            changes.books,
            changes.progress,
            changes.groups,
            changes.sources,
            changes.bookmarks.len(),
            changes.deleted_books.len()
        );
        if let Err(error) = self.app.emit(SYNC_APPLIED_EVENT, changes) {
            log::debug!("同步落地事件发送失败：{error}");
        }
    }
}

impl<R: tauri::Runtime> Drop for SyncService<R> {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.wake.notify_all();
    }
}

/// 冲突记录 → 界面形状。
fn conflict_dto(engine: &SyncEngine, conflict: &Conflict) -> ConflictDto {
    ConflictDto {
        id: conflict.id.clone(),
        kind: conflict.kind.clone(),
        field: conflict.field.clone(),
        title: entity_title(engine, &conflict.entity_id, &conflict.kind),
        reason: reason_code(conflict),
        local: conflict.local.value.as_ref().map(display_value),
        remote: conflict.remote.value.as_ref().map(display_value),
        detected_at_ms: conflict.detected_at_ms,
        note: conflict.note.clone(),
        peer: conflict
            .peer_device
            .as_ref()
            .and_then(|device| engine.peers().get(device))
            .map(|peer| peer.name.clone())
            .filter(|name| !name.is_empty()),
    }
}

/// 冲突原因 → 稳定短码（前端翻成文案；枚举本身就是 snake_case 序列化）。
fn reason_code(conflict: &Conflict) -> String {
    serde_json::to_value(conflict.reason)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

/// 冲突涉及对象的显示名：书 / 分组 / 书源都尽量给出人看得懂的名字。
fn entity_title(engine: &SyncEngine, entity_id: &str, kind: &str) -> String {
    let named = |field: &str| {
        engine
            .field(entity_id, field)
            .and_then(|v| v.as_str().map(str::to_string))
    };
    match kind {
        "group" | "book_source" => named("name"),
        "book" => named("title"),
        "reading_progress" | "bookmark" => {
            let book = engine
                .field(entity_id, "book_id")
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
            engine
                .field(&book, "title")
                .and_then(|v| v.as_str().map(str::to_string))
        }
        _ => None,
    }
    .unwrap_or_else(|| entity_id.to_string())
}

/// 冲突里的值 → 一行可读文本（长文本截断，别让一段正文撑爆界面）。
fn display_value(value: &Value) -> String {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Null => "(空)".to_string(),
        other => other.to_string(),
    };
    let mut chars = text.chars();
    let short: String = chars.by_ref().take(120).collect();
    if chars.next().is_some() {
        format!("{short}…")
    } else {
        short
    }
}

/// 默认设备名：`READERX_DEVICE_NAME` > 主机名 > 按平台给一个。
fn default_device_name() -> String {
    if let Ok(name) = std::env::var("READERX_DEVICE_NAME") {
        if !name.trim().is_empty() {
            return name;
        }
    }
    let host = std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|name| !name.is_empty());
    match host {
        Some(host) => host,
        None if cfg!(target_os = "android") => "手机".to_string(),
        None => "桌面".to_string(),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 抖动：0–9 秒。两台设备各算各的，足以让自动同步错开。
fn jitter_ms() -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    (nanos % 8_000) + (std::process::id() as u64 % 1_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个不碰磁盘的服务实例：调度逻辑只动内存状态。
    fn service() -> Arc<SyncService<tauri::test::MockRuntime>> {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock 应用应能构建");
        let handle = app.handle().clone();
        std::mem::forget(app);
        SyncService::new(handle)
    }

    fn armed(service: &Arc<SyncService<tauri::test::MockRuntime>>, interval_secs: u64) {
        let mut inner = service.lock();
        inner.settings.enabled = true;
        inner.settings.auto_sync = true;
        inner.settings.auto_interval_secs = interval_secs;
        inner.next_auto_ms = 0;
        inner.auto_failures = 0;
    }

    /// 回归：**每一轮都必须把下一次尝试往后排**。
    ///
    /// 曾经的写法是从 `last_sync_ms` 反推「距上次成功是否超过一个间隔」，
    /// 而失败轮不更新它 —— 于是「没有对端 / 一直连不上」时判定永远成立，
    /// 循环变成「到点了 → 试 → 失败 → 到点了」的空转：CPU 跑满、日志每秒几千行。
    #[test]
    fn every_round_schedules_the_next_attempt() {
        let service = service();
        armed(&service, 60);
        assert_eq!(service.auto_wait(), Duration::ZERO, "刚安排过就允许立刻尝试");

        service.schedule_next_auto(AutoRound::NoPeers);
        assert!(
            service.auto_wait() > Duration::ZERO,
            "没有已配对设备时也要等一个间隔，不能立刻重试"
        );

        let mut delays = Vec::new();
        for _ in 0..6 {
            let before = now_ms();
            service.schedule_next_auto(AutoRound::Failed("连不上".to_string()));
            delays.push(service.lock().next_auto_ms.saturating_sub(before));
            assert!(service.auto_wait() > Duration::ZERO, "失败后必须往后排：{delays:?}");
        }
        let tick = TICK.as_millis() as u64;
        assert!(delays.iter().all(|delay| *delay >= tick), "退避至少一个 TICK：{delays:?}");
        assert!(
            delays.iter().all(|delay| *delay <= 60_000 + 9_000),
            "退避最多到一个同步间隔（含抖动）：{delays:?}"
        );
        assert!(delays[0] < delays[3], "连续失败要退避得更久：{delays:?}");
        assert_eq!(service.lock().last_error.as_deref(), Some("连不上"));

        // 成功一轮：退避清零，回到正常间隔
        service.schedule_next_auto(AutoRound::Synced);
        assert_eq!(service.lock().auto_failures, 0);
        assert!(service.auto_wait() > Duration::ZERO);
    }

    /// 没有已配对设备时，自动同步什么都不做（既不扫局域网，也不进"正在同步"状态）。
    #[test]
    fn auto_round_without_paired_peers_does_nothing() {
        let service = service();
        armed(&service, 60);
        assert!(matches!(service.auto_round(), AutoRound::NoPeers));
        assert!(!service.lock().syncing, "没有对端时不该占用同步状态");
        assert!(service.lock().last_error.is_none(), "「还没配对」不是错误");
    }

    /// 关闭同步 / 关掉自动同步时，循环只是按 TICK 醒来看看设置。
    #[test]
    fn disabled_service_idles_on_tick() {
        let service = service();
        assert_eq!(service.auto_wait(), TICK, "未开启时按节拍醒来检查设置");
        armed(&service, 60);
        service.lock().settings.auto_sync = false;
        assert_eq!(service.auto_wait(), TICK, "关掉自动同步后同样只是空转检查");
    }
}

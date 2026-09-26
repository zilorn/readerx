//! 同步会话：一次「和对端把两边拉平」的完整过程。
//!
//! 局域网 P2P 没有中心服务端，两台设备谁先连谁都不一定，因此一次同步是**双向**的：
//!
//! ```text
//! 1. 拉：把我的版本向量发给对端 → 对端回「我没有而你有」的操作 → 合并（可能要多轮）
//! 2. 推：对端在应答里带上它的版本向量 → 我算出「它没有而我有」的操作 → 分批推送
//! 3. 记录：更新对端状态（地址 / 上次同步时间 / 对方已知版本）并落盘
//! ```
//!
//! 用**版本向量求差**而不是「已发送队列」的好处：
//!
//! - 断点续传天然成立（进程重启后版本向量还在，差集重新算即可，见场景 22 / 29）；
//! - 中继天然成立（A 的操作经 B 传给 C，C 的向量里就有 A 的进度，不需要额外记账）；
//! - 幂等：就算重复发，接收端按 op_id 去重（场景 19）。
//!
//! 一轮里如果什么都没变（既没拉到新操作、也没有可推的），就结束——避免两端
//! 因为「我缺一条永远到不了的操作」互相空转（场景 20 的停滞保护）。

use std::collections::HashSet;

use crate::engine::SyncEngine;
use crate::error::{Result, SyncError};
use crate::id::now_ms;
use crate::net::{PeerInfo, Transport};
use crate::proto::{Request, Response, DEFAULT_BATCH};
use crate::version::VersionVector;

/// 一次同步的轮数上限（防御：对端一直说「还有更多」也不能无限循环）。
pub const MAX_ROUNDS: usize = 64;

/// 同步结果（CLI 输出 / 日志 / 状态页）。
#[derive(Clone, Debug, Default)]
pub struct SyncReport {
    pub peer_device: String,
    pub peer_name: String,
    pub peer_addr: Option<String>,
    /// 从对端拉取并合并的操作数
    pub pulled: usize,
    /// 推送给对端并被接受的操作数
    pub pushed: usize,
    /// 重复操作（去重命中，说明之前同步过）
    pub duplicates: usize,
    /// 进了因果缓冲、等后续操作
    pub deferred: usize,
    /// 被对端拒绝的操作数
    pub rejected: usize,
    /// 本次同步新产生的冲突数
    pub conflicts: usize,
    pub rounds: usize,
    /// 对端同步后的版本向量
    pub peer_knowledge: VersionVector,
    pub finished_at_ms: u64,
}

impl SyncReport {
    fn new(peer: &PeerInfo) -> SyncReport {
        SyncReport {
            peer_device: peer.device_id.clone(),
            peer_name: peer.name.clone(),
            peer_addr: peer.addr.clone(),
            finished_at_ms: now_ms(),
            ..SyncReport::default()
        }
    }

    /// 一行摘要（日志 / CLI 输出）。
    pub fn summary(&self) -> String {
        format!(
            "拉取 {} 推送 {}（重复 {} 缓冲 {} 拒绝 {}）冲突 {} 轮次 {}",
            self.pulled, self.pushed, self.duplicates, self.deferred, self.rejected, self.conflicts, self.rounds
        )
    }
}

/// 用给定传输与对端同步一次。
pub fn sync_with(engine: &mut SyncEngine, transport: &mut dyn Transport) -> Result<SyncReport> {
    let peer = transport.peer();
    let mut report = SyncReport::new(&peer);
    log::info!(
        "开始同步 peer={} name={}",
        crate::version::short_device(&peer.device_id),
        peer.name
    );

    match run_session(engine, transport, &mut report) {
        Ok(()) => {
            engine.record_peer_sync(
                &peer.device_id,
                &peer.name,
                peer.addr.clone(),
                report.peer_knowledge.clone(),
                None,
            );
            let _ = engine.flush();
            log::info!("同步完成 peer={} {}", crate::version::short_device(&peer.device_id), report.summary());
            Ok(report)
        }
        Err(error) => {
            // 失败也要落盘：已经合并进来的操作不能白拉
            engine.record_peer_sync(
                &peer.device_id,
                &peer.name,
                peer.addr.clone(),
                report.peer_knowledge.clone(),
                Some(error.to_string()),
            );
            let _ = engine.flush();
            log::warn!("同步失败 peer={} err={error}", crate::version::short_device(&peer.device_id));
            Err(error)
        }
    }
}

fn run_session(
    engine: &mut SyncEngine,
    transport: &mut dyn Transport,
    report: &mut SyncReport,
) -> Result<()> {
    let peer_device = report.peer_device.clone();

    // ---- 1) 拉：我缺的操作 ----
    let mut since = engine.knowledge();
    loop {
        if report.rounds >= MAX_ROUNDS {
            log::warn!("同步轮数达到上限（{MAX_ROUNDS}），提前结束");
            break;
        }
        report.rounds += 1;

        let response = transport.request(&Request::Pull { since: since.clone(), limit: DEFAULT_BATCH })?;
        let (ops, peer_knowledge, has_more) = match response {
            Response::Ops { ops, knowledge, has_more } => (ops, knowledge, has_more),
            Response::Error { code, message } => {
                return Err(SyncError::Protocol(format!("对端拒绝拉取（{code}）：{message}")))
            }
            other => {
                return Err(SyncError::Protocol(format!(
                    "拉取期望 ops，收到 {}",
                    other.kind()
                )))
            }
        };
        report.peer_knowledge = peer_knowledge;

        if ops.is_empty() {
            break;
        }
        let before_ops = engine.op_count();
        let batch = engine.apply_many(&ops, Some(&peer_device))?;
        report.pulled += batch.applied;
        report.duplicates += batch.duplicates;
        report.deferred += batch.deferred;
        report.rejected += batch.rejected;
        report.conflicts += batch.conflicts;
        since = engine.knowledge();

        if !has_more {
            break;
        }
        if engine.op_count() == before_ops {
            // 一条都没合并进去：要么全在因果缓冲里等前序操作，要么全被拒绝。
            // 继续拉只会拿到同一批，交给推送阶段（对方可能正好缺我手里的前序操作）。
            log::debug!("本轮没有新操作合并，转入推送阶段");
            break;
        }
    }

    // ---- 2) 推：对端缺的操作 ----
    let mut peer_knowledge = report.peer_knowledge.clone();
    let mut rejected_ids: HashSet<String> = HashSet::new();
    loop {
        if report.rounds >= MAX_ROUNDS {
            break;
        }
        let (ops, has_more) = engine.ops_for_peer(&peer_knowledge, DEFAULT_BATCH);
        let ops: Vec<_> = ops.into_iter().filter(|op| !rejected_ids.contains(&op.op_id)).collect();
        if ops.is_empty() {
            break;
        }
        report.rounds += 1;
        let response = transport.request(&Request::Push { ops })?;
        match response {
            Response::Ack { accepted, rejected, conflicts, knowledge } => {
                report.pushed += accepted;
                report.conflicts += conflicts;
                for item in rejected {
                    // 记录被拒的操作：这一轮不再重发（否则会死循环），
                    // 但不落盘丢弃——对端升级 schema 后下次同步还能成功。
                    log::warn!(
                        "对端拒绝操作 op={} code={} message={}",
                        item.op_id,
                        item.code,
                        item.message
                    );
                    if item.code == "deferred" {
                        // 对方进了因果缓冲（缺前序操作）：不算失败，下次同步会重发
                        report.deferred += 1;
                    } else {
                        report.rejected += 1;
                    }
                    rejected_ids.insert(item.op_id);
                }
                peer_knowledge = knowledge.clone();
                report.peer_knowledge = knowledge;
                if !has_more {
                    break;
                }
            }
            Response::Error { code, message } => {
                return Err(SyncError::Protocol(format!("对端拒绝推送（{code}）：{message}")))
            }
            other => {
                return Err(SyncError::Protocol(format!(
                    "推送期望 ack，收到 {}",
                    other.kind()
                )))
            }
        }
    }

    // 一次会话只拉一轮：局域网里对端的数据在一次会话内不会变（它要么在等我们，
    // 要么自己在跟第三台设备同步——那种情况下下一轮定时同步会补齐）。
    // 一次会话只拉一轮：局域网里对端的数据在一次会话内不会变（它要么在等我们，
    // 要么自己在跟第三台设备同步——那种情况下下一轮定时同步会补齐）。
    report.finished_at_ms = now_ms();
    Ok(())
}

/// 连接指定地址并同步一次（CLI / 定时任务用）。
pub fn sync_with_addr(
    engine: &mut SyncEngine,
    addr: &str,
    timeout: std::time::Duration,
) -> Result<SyncReport> {
    let secret = engine.secret_bytes()?;
    let knowledge = engine.knowledge();
    let device = engine.device_id().to_string();
    let name = engine.device_name().to_string();
    let group = engine.group_id().to_string();
    let mut transport = crate::net::TcpTransport::connect(
        addr, &secret, &group, &device, &name, knowledge, timeout,
    )?;
    sync_with(engine, &mut transport)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{EngineOptions, SyncEngine};
    use crate::net::{shared, LoopbackTransport, PeerServer, ServerOptions};
    use crate::schema::{MergeKind, Schema, SchemaRegistry};
    use std::fs;
    use std::net::SocketAddr;
    use std::path::PathBuf;
    use std::time::Duration;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("readerx-sync-session-{tag}-{}", crate::new_id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn schemas() -> SchemaRegistry {
        let mut registry = SchemaRegistry::new();
        registry.register(
            Schema::new("book")
                .field("title", MergeKind::Lww)
                .field("author", MergeKind::Lww)
                .field("tags", MergeKind::set()),
        );
        registry
    }

    fn engine(tag: &str) -> SyncEngine {
        SyncEngine::open(temp_dir(tag), EngineOptions::new(tag).with_schemas(schemas())).unwrap()
    }

    /// 让 B 与 A 同群组（真实场景是扫配对码；测试里直接抄密钥）。
    fn pair(a: &SyncEngine, b: &mut SyncEngine) {
        let code = a.pairing_code();
        b.join_group(&code).unwrap();
    }

    #[test]
    fn loopback_sync_pulls_and_pushes() {
        let mut a = engine("lb-a");
        let mut b = engine("lb-b");
        pair(&a, &mut b);

        // A 有一条记录，B 还没有
        let id = a.create_entity("book", Some("b1".into()), [("title", serde_json::json!("三体"))]).unwrap();
        a.flush().unwrap();

        let shared_b = shared(b);
        let mut transport = LoopbackTransport::new(shared_b.clone());
        let report = sync_with(&mut a, &mut transport).unwrap();
        assert_eq!(report.pulled, 0);
        assert_eq!(report.pushed, 1);
        assert_eq!(report.rejected, 0);

        // B 拿到了记录；再同步一次没有新东西
        {
            let b = crate::net::lock_engine(&shared_b);
            assert_eq!(b.field(&id, "title"), Some(serde_json::json!("三体")));
        }
        let mut transport = LoopbackTransport::new(shared_b.clone());
        let report = sync_with(&mut a, &mut transport).unwrap();
        assert_eq!((report.pulled, report.pushed), (0, 0), "第二次同步不应重复推送");

        // 反向：B 改了字段，A 拉回来
        {
            let mut b = crate::net::lock_engine(&shared_b);
            b.set_field(&id, "author", serde_json::json!("刘慈欣")).unwrap();
            b.flush().unwrap();
        }
        let mut transport = LoopbackTransport::new(shared_b.clone());
        let report = sync_with(&mut a, &mut transport).unwrap();
        assert_eq!(report.pulled, 1);
        assert_eq!(a.field(&id, "author"), Some(serde_json::json!("刘慈欣")));
    }

    #[test]
    fn concurrent_edits_converge_with_conflict_on_both_sides() {
        let mut a = engine("cc-a");
        let mut b = engine("cc-b");
        pair(&a, &mut b);
        let id = a.create_entity("book", Some("b1".into()), [("title", serde_json::json!("原名"))]).unwrap();
        a.flush().unwrap();

        // 两个引擎都放进共享句柄：直连传输需要一个「对端句柄」
        let shared_a = shared(a);
        let shared_b = shared(b);
        {
            let mut transport = LoopbackTransport::new(shared_b.clone());
            sync_with(&mut crate::net::lock_engine(&shared_a), &mut transport).unwrap();
        }

        // 之后各自离线改同一个字段
        crate::net::lock_engine(&shared_a)
            .set_field(&id, "title", serde_json::json!("甲"))
            .unwrap();
        crate::net::lock_engine(&shared_b)
            .set_field(&id, "title", serde_json::json!("乙"))
            .unwrap();

        // 双向各同步一次（真实场景是 A 连 B、B 连 A，或任一方主动连对方后再互推）
        {
            let mut transport = LoopbackTransport::new(shared_b.clone());
            sync_with(&mut crate::net::lock_engine(&shared_a), &mut transport).unwrap();
        }
        {
            let mut transport = LoopbackTransport::new(shared_a.clone());
            sync_with(&mut crate::net::lock_engine(&shared_b), &mut transport).unwrap();
        }

        let a = crate::net::lock_engine(&shared_a);
        let b = crate::net::lock_engine(&shared_b);
        assert_eq!(a.field(&id, "title"), b.field(&id, "title"), "两边必须收敛到同一个值");
        assert!(a.pending_conflict_count() >= 1, "并发写要进冲突队列");
        assert!(b.pending_conflict_count() >= 1);
        // 败方数据留在冲突记录里（不静默丢数据）
        let conflict = b
            .conflicts(None)
            .into_iter()
            .find(|c| c.field == "title")
            .cloned()
            .unwrap();
        assert!(conflict.local.value.is_some() && conflict.remote.value.is_some());
    }

    #[test]
    fn tcp_peer_server_roundtrip() {
        let mut a = engine("tcp-a");
        let mut b = engine("tcp-b");
        pair(&a, &mut b);

        let id = a
            .create_entity("book", Some("b1".into()), [("title", serde_json::json!("三体")), ("tags", serde_json::json!(["科幻"]))])
            .unwrap();
        a.flush().unwrap();

        // B 起服务端（端口 0 让系统分配）
        let shared_b = shared(b);
        let options = {
            let b = crate::net::lock_engine(&shared_b);
            ServerOptions::from_engine(&b).unwrap().with_bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        };
        let server = PeerServer::start(shared_b.clone(), options).unwrap();
        let addr = server.local_addr().to_string();

        // A 连过去同步
        let report = sync_with_addr(&mut a, &addr, Duration::from_secs(5)).unwrap();
        assert_eq!(report.pushed, 1);
        assert!(!report.peer_name.is_empty());
        {
            let b = crate::net::lock_engine(&shared_b);
            assert_eq!(b.field(&id, "title"), Some(serde_json::json!("三体")));
            assert_eq!(b.set_elements(&id, "tags"), vec!["科幻".to_string()]);
        }

        // 群组不一致：直接拒绝（场景 25 多租户隔离）
        let mut stranger = engine("tcp-stranger");
        let err = sync_with_addr(&mut stranger, &addr, Duration::from_secs(5)).unwrap_err();
        assert!(matches!(err, SyncError::Auth(_)), "跨群组应被拒绝：{err}");

        drop(server);
    }

    #[test]
    fn tcp_sync_is_resumable_after_reopen() {
        let mut a = engine("resume-a");
        let mut b = engine("resume-b");
        pair(&a, &mut b);
        let dir_a = a.data_dir().to_path_buf();
        a.create_entity("book", Some("b1".into()), [("title", serde_json::json!("一"))]).unwrap();
        a.flush().unwrap();

        let shared_b = shared(b);
        let options = {
            let b = crate::net::lock_engine(&shared_b);
            ServerOptions::from_engine(&b).unwrap().with_bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        };
        let server = PeerServer::start(shared_b.clone(), options).unwrap();
        let addr = server.local_addr().to_string();
        sync_with_addr(&mut a, &addr, Duration::from_secs(5)).unwrap();

        // 重启 A（重新打开同一个数据目录）→ 游标（版本向量）还在，不会重复推送
        drop(a);
        let mut a = SyncEngine::open(&dir_a, EngineOptions::new("resume-a").with_schemas(schemas()))
            .unwrap();
        let report = sync_with_addr(&mut a, &addr, Duration::from_secs(5)).unwrap();
        assert_eq!((report.pulled, report.pushed), (0, 0), "重启后应能接着上次的进度：{report:?}");

        drop(server);
        fs::remove_dir_all(&dir_a).ok();
    }
}

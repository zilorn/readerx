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

use std::collections::{HashMap, HashSet};

use crate::content::ChapterContent;
use crate::engine::SyncEngine;
use crate::error::{Result, SyncError};
use crate::id::now_ms;
use crate::net::{PeerInfo, Transport};
use crate::proto::{
    Request, Response, CONTENT_BATCH_BYTES, CONTENT_BATCH_CHAPTERS, DEFAULT_BATCH,
};
use crate::version::VersionVector;

/// 一次同步的轮数上限（防御：对端一直说「还有更多」也不能无限循环）。
pub const MAX_ROUNDS: usize = 64;

/// 一次会话最多搬运的**正文**章节数。
///
/// 正文通道要抱着引擎锁走（同步会话整体持锁），长时间占用会让本机的进度 / 书签
/// 写入排队。大书库因此在多次同步里慢慢搬完 —— 差集每次重算，断点续传天然成立。
pub const MAX_CONTENT_CHAPTERS: usize = 200;

/// 一次会话最多搬运的**正文字节数**（约 32 MiB，与章节数上限取先到者）。
pub const MAX_CONTENT_BYTES: u64 = 32 * 1024 * 1024;

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
    /// 本次会话推给对端的正文章节数
    pub content_pushed: usize,
    /// 本次会话从对端取回并存进暂存区的正文章节数
    pub content_pulled: usize,
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
            "拉取 {} 推送 {}（重复 {} 缓冲 {} 拒绝 {}）冲突 {} 轮次 {} 正文推 {} 取 {}",
            self.pulled,
            self.pushed,
            self.duplicates,
            self.deferred,
            self.rejected,
            self.conflicts,
            self.rounds,
            self.content_pushed,
            self.content_pulled
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

    // ---- 3) 正文：指纹对账 + 按章搬运（不参与操作日志，见 crate::content）----
    // 失败不算整次同步失败：操作已经合并完毕，正文下次同步还能继续搬。
    // （旧对端握手时 content=false，这一步直接跳过，不会向它发未知请求。）
    if let Err(error) = content_pass(engine, transport, report) {
        log::warn!("正文同步未完成（下次同步继续）：{error}");
    }

    // 一次会话只拉一轮：局域网里对端的数据在一次会话内不会变（它要么在等我们，
    // 要么自己在跟第三台设备同步——那种情况下下一轮定时同步会补齐）。
    report.finished_at_ms = now_ms();
    Ok(())
}

/// 正文对账与搬运（见 [`crate::content`]）。
///
/// 只在**双方都参与正文同步**时进行：本机要注册了正文来源（不然拿不到也放不下），
/// 对端要在握手时自报 `content`（旧版本会把未知请求当协议错误断连接）。
///
/// 方向规则：两边同一章指纹不同时，**设备 id 大的一方**为准。这样无论谁发起会话、
/// 谁先谁后，收敛到的是同一份内容，不会你推我我推你地来回换。
fn content_pass(
    engine: &mut SyncEngine,
    transport: &mut dyn Transport,
    report: &mut SyncReport,
) -> Result<()> {
    let peer = transport.peer();
    if !engine.has_content_source() || !peer.content {
        return Ok(());
    }

    // 本机的逐本总览：只列有正文的书
    let books: Vec<String> = engine
        .entities_of_kind("book", false)
        .into_iter()
        .map(|entity| entity.id.clone())
        .collect();
    let my_index: Vec<_> = books
        .iter()
        .map(|book| engine.content_index(book))
        .filter(|digest| digest.chapters > 0)
        .collect();

    let response = transport.request(&Request::ContentIndex { books: my_index })?;
    let theirs = match response {
        Response::ContentIndex { books } => books,
        Response::Error { code, message } => {
            return Err(SyncError::Protocol(format!("对端拒绝正文对账（{code}）：{message}")))
        }
        other => {
            return Err(SyncError::Protocol(format!(
                "正文对账期望 content_index，收到 {}",
                other.kind()
            )))
        }
    };
    let mut their_map: HashMap<String, crate::content::BookDigest> = theirs
        .into_iter()
        .map(|digest| (digest.book.clone(), digest))
        .collect();

    let i_win = engine.device_id() > peer.device_id.as_str();
    let mut chapters = 0usize;
    let mut bytes = 0u64;

    for book in books {
        if chapters >= MAX_CONTENT_CHAPTERS || bytes >= MAX_CONTENT_BYTES {
            log::debug!("本次会话的正文预算用尽，剩余章节下次同步继续");
            break;
        }
        let mine = engine.content_index(&book);
        let theirs = their_map.remove(&book);
        let same = match (&theirs, mine.chapters) {
            (Some(their), _) if their == &mine => true,
            (None, 0) => true,
            _ => false,
        };
        if same {
            continue;
        }

        let response = transport.request(&Request::ChapterDigests { book: book.clone() })?;
        let (known, peer_chapters) = match response {
            Response::ChapterDigests { known, chapters, .. } => (known, chapters),
            Response::Error { code, message } => {
                return Err(SyncError::Protocol(format!("对端拒绝正文清单（{code}）：{message}")))
            }
            other => {
                return Err(SyncError::Protocol(format!(
                    "正文清单期望 chapter_digests，收到 {}",
                    other.kind()
                )))
            }
        };
        // 对端还没有这本书（元信息都没到）：正文推过去也无处可落，下一轮再说
        if !known {
            continue;
        }

        let mine_digests = engine.content_digests(&book);
        let mine_map: HashMap<&str, &str> = mine_digests
            .iter()
            .filter(|digest| !digest.hash.is_empty())
            .map(|digest| (digest.cid.as_str(), digest.hash.as_str()))
            .collect();
        let peer_map: HashMap<&str, &str> = peer_chapters
            .iter()
            .filter(|digest| !digest.hash.is_empty())
            .map(|digest| (digest.cid.as_str(), digest.hash.as_str()))
            .collect::<HashMap<_, _>>();

        // 推：对端没有的章；两边都有但指纹不同时只有「我赢」才推
        if chapters < MAX_CONTENT_CHAPTERS && bytes < MAX_CONTENT_BYTES {
            let mut wanted: Vec<String> = Vec::new();
            for digest in engine.content_digests(&book) {
                if digest.hash.is_empty() {
                    continue;
                }
                match peer_map.get(digest.cid.as_str()) {
                    None => wanted.push(digest.cid.clone()),
                    Some(hash) if hash != &digest.hash.as_str() && i_win => {
                        wanted.push(digest.cid.clone())
                    }
                    Some(_) => {}
                }
            }
            for batch in wanted.chunks(CONTENT_BATCH_CHAPTERS) {
                if chapters >= MAX_CONTENT_CHAPTERS || bytes >= MAX_CONTENT_BYTES {
                    break;
                }
                let items = engine.content_bodies(&book, batch);
                let (items, size) = fit_batch(items);
                if items.is_empty() {
                    continue;
                }
                let count = items.len();
                match transport.request(&Request::PushChapters { book: book.clone(), items })? {
                    Response::ContentAck { stored } => {
                        chapters += count;
                        bytes += size;
                        report.content_pushed += stored;
                    }
                    Response::Error { code, message } => {
                        return Err(SyncError::Protocol(format!(
                            "对端拒绝正文推送（{code}）：{message}"
                        )))
                    }
                    other => {
                        return Err(SyncError::Protocol(format!(
                            "正文推送期望 content_ack，收到 {}",
                            other.kind()
                        )))
                    }
                }
            }
        }

        // 取：本机没有的章；两边都有但指纹不同时只有「对端赢」才取
        let mut wanted: Vec<String> = Vec::new();
        for digest in &peer_chapters {
            if digest.hash.is_empty() {
                continue;
            }
            match mine_map.get(digest.cid.as_str()) {
                None => wanted.push(digest.cid.clone()),
                Some(hash) if hash != &digest.hash.as_str() && !i_win => {
                    wanted.push(digest.cid.clone())
                }
                Some(_) => {}
            }
        }
        for batch in wanted.chunks(CONTENT_BATCH_CHAPTERS) {
            if chapters >= MAX_CONTENT_CHAPTERS || bytes >= MAX_CONTENT_BYTES {
                break;
            }
            let response = transport.request(&Request::PullChapters {
                book: book.clone(),
                cids: batch.to_vec(),
            })?;
            let items = match response {
                Response::Chapters { items, .. } => items,
                Response::Error { code, message } => {
                    return Err(SyncError::Protocol(format!("对端拒绝正文拉取（{code}）：{message}")))
                }
                other => {
                    return Err(SyncError::Protocol(format!(
                        "正文拉取期望 chapters，收到 {}",
                        other.kind()
                    )))
                }
            };
            if items.is_empty() {
                continue;
            }
            let size: u64 = items.iter().map(ChapterContent::body_bytes).sum();
            let count = items.len();
            match engine.stage_content(&book, &items) {
                Ok(_) => {
                    chapters += count;
                    bytes += size;
                    report.content_pulled += count;
                }
                Err(error) => {
                    log::warn!("正文暂存失败（{book}）：{error}");
                    return Err(error);
                }
            }
        }
    }

    if report.content_pushed > 0 || report.content_pulled > 0 {
        log::info!(
            "正文同步完成：推送 {} 章 / 取回 {} 章",
            report.content_pushed,
            report.content_pulled
        );
    }
    Ok(())
}

/// 按帧预算装箱：返回（装得下的章节, 它们的正文字节数）。
fn fit_batch(items: Vec<ChapterContent>) -> (Vec<ChapterContent>, u64) {
    let mut out = Vec::new();
    let mut bytes = 0u64;
    for item in items {
        let size = item.body_bytes();
        if size > CONTENT_BATCH_BYTES as u64 {
            log::warn!("章节正文超过单帧预算，跳过 cid={}", item.cid);
            continue;
        }
        if out.len() >= CONTENT_BATCH_CHAPTERS || bytes + size > CONTENT_BATCH_BYTES as u64 {
            break;
        }
        bytes += size;
        out.push(item);
    }
    (out, bytes)
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
        addr,
        &secret,
        &crate::net::client::ClientIdentity {
            group: &group,
            device: &device,
            name: &name,
            knowledge,
            listen_port: engine.listen_port(),
            content: engine.has_content_source(),
        },
        timeout,
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
        assert!(
            matches!(err, SyncError::Coded(crate::error::Code::GroupMismatch, _)),
            "跨群组应被拒绝：{err}"
        );

        drop(server);
    }

    /// 群组不一致必须带上**稳定错误码**：界面按码给出「用配对码重新加入」这类引导，
    /// 而不是把一句中文提示原样端给英语用户（见 `error::Code` 与 `src/lib/sync.ts`）。
    #[test]
    fn group_mismatch_carries_the_actionable_error_code() {
        let a = engine("code-a");
        let mut stranger = engine("code-stranger");

        let shared_a = shared(a);
        let options = {
            let a = crate::net::lock_engine(&shared_a);
            ServerOptions::from_engine(&a).unwrap().with_bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        };
        let server = PeerServer::start(shared_a.clone(), options).unwrap();
        let addr = server.local_addr().to_string();

        let error = sync_with_addr(&mut stranger, &addr, Duration::from_secs(5)).unwrap_err();
        assert_eq!(error.code(), "group_mismatch", "错误码要稳定：{error}");
        assert!(
            error.to_string().starts_with("group_mismatch|"),
            "错误串要带码前缀：{error}"
        );
        assert_eq!(SyncError::code_of(&error.to_string()), "group_mismatch");
        drop(server);
    }


    /// 服务端记下的对端地址必须是**对端自报的监听端口**。
    ///
    /// 回归：曾经把这条 TCP 连接的 `peer_addr()`（内核临时分配的源端口）当成对端地址记下来，
    /// 连接一断那个端口就回收了 —— 下次主动连它必然「连接被拒绝」。
    #[test]
    fn server_records_the_advertised_listen_port_not_the_source_port() {
        let a = engine("addr-a");
        let mut b = engine("addr-b");
        pair(&a, &mut b);

        // B 声称自己在监听这个端口（真实场景由 App / CLI 在起 PeerServer 后写入）
        b.set_listen_port(47_899);
        assert_eq!(b.listen_port(), 47_899);

        // A 起服务端
        let shared_a = shared(a);
        let options = {
            let a = crate::net::lock_engine(&shared_a);
            ServerOptions::from_engine(&a).unwrap().with_bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        };
        let server = PeerServer::start(shared_a.clone(), options).unwrap();
        let addr = server.local_addr().to_string();

        // B 连过去同步
        sync_with_addr(&mut b, &addr, Duration::from_secs(5)).unwrap();

        let recorded = {
            let a = crate::net::lock_engine(&shared_a);
            let peer = a
                .peers()
                .get(b.device_id())
                .expect("服务端应记下这台对端")
                .clone();
            peer.addr.expect("对端在监听，就该记下可回连的地址")
        };
        assert!(
            recorded.ends_with(":47899"),
            "地址应是「来源 IP + 对端自报的监听端口」，实际 {recorded}"
        );
        // 端口一定不是这条连接的临时源端口（临时端口不会等于我们指定的 47899）
        assert!(!recorded.contains(":0"), "{recorded}");
        drop(server);
    }

    /// 对端连进来并记入设备列表时，服务端要通知宿主（界面据此立刻刷新设备列表，
    /// 不用等用户重进页面）。
    #[test]
    fn server_notifies_the_host_when_it_records_a_peer() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let a = engine("notify-a");
        let mut b = engine("notify-b");
        pair(&a, &mut b);

        let seen = Arc::new(AtomicUsize::new(0));
        let counter = seen.clone();
        let shared_a = shared(a);
        let options = {
            let a = crate::net::lock_engine(&shared_a);
            ServerOptions::from_engine(&a)
                .unwrap()
                .with_bind(SocketAddr::from(([127, 0, 0, 1], 0)))
                .with_peer_seen(Arc::new(move |_peer| {
                    counter.fetch_add(1, Ordering::Relaxed);
                }))
        };
        let server = PeerServer::start(shared_a.clone(), options).unwrap();
        let addr = server.local_addr().to_string();

        b.set_listen_port(47_877);
        sync_with_addr(&mut b, &addr, Duration::from_secs(5)).unwrap();

        assert!(seen.load(Ordering::Relaxed) > 0, "记下对端后要通知宿主");
        drop(server);
    }

    /// 对端没在监听时不留地址：留着只会让对方一直往一个死端口上重试。
    #[test]
    fn server_drops_the_address_when_the_peer_is_not_listening() {
        let a = engine("nolisten-a");
        let mut b = engine("nolisten-b");
        pair(&a, &mut b);

        let shared_a = shared(a);
        let options = {
            let a = crate::net::lock_engine(&shared_a);
            ServerOptions::from_engine(&a).unwrap().with_bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        };
        let server = PeerServer::start(shared_a.clone(), options).unwrap();
        let addr = server.local_addr().to_string();

        // 先让 A 记下一个（此时是错的）地址：模拟历史数据 / 换过网络
        {
            let mut a = crate::net::lock_engine(&shared_a);
            a.update_peer_addr(b.device_id(), "192.168.0.101:40010");
        }
        // B 没在监听（listen_port 仍是 0）→ 同步之后那个地址必须被清掉
        b.set_listen_port(0);
        sync_with_addr(&mut b, &addr, Duration::from_secs(5)).unwrap();

        let a = crate::net::lock_engine(&shared_a);
        let peer = a.peers().get(b.device_id()).expect("设备本身仍要留着");
        assert!(
            peer.addr.is_none(),
            "对端没在监听：不该留着连不上的地址，实际 {:?}",
            peer.addr
        );
        assert!(peer.sync_count > 0, "同步计数与地址是两回事，仍要记下同步过");
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

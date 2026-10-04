//! 正文通道的端到端回归：两台设备用进程内直连互相同步**书籍正文**。
//!
//! 覆盖引擎侧最容易出错的那层：正文不进操作日志（指纹对账 + 按章搬运）、
//! 收到先落暂存区、差集在第二次同步时归零（不会来回换），以及
//! 双方同一章指纹不同时按设备 id 定胜负。

use readerx_sync::content::{ChapterContent, ChapterDigest, ContentSource};
use readerx_sync::net::{shared, LoopbackTransport, SharedEngine};
use readerx_sync::{EngineOptions, SchemaRegistry, SyncEngine};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// 内存版正文来源（真实 App 里读 `books/<id>/content.json`）。
#[derive(Default)]
struct MemContent {
    books: Mutex<HashMap<String, BTreeMap<String, ChapterContent>>>,
}

impl MemContent {
    fn put(&self, book: &str, cid: &str, text: &str) {
        let chapter = ChapterContent {
            cid: cid.to_string(),
            title: format!("第 {cid} 章"),
            url: Some(format!("https://example.com/{cid}")),
            paragraphs: vec![text.to_string()],
            blocks: None,
        };
        self.books
            .lock()
            .unwrap()
            .entry(book.to_string())
            .or_default()
            .insert(cid.to_string(), chapter);
    }

    fn all(&self, book: &str) -> Vec<ChapterContent> {
        self.books
            .lock()
            .unwrap()
            .get(book)
            .map(|chapters| chapters.values().cloned().collect())
            .unwrap_or_default()
    }
}

impl ContentSource for MemContent {
    fn digests(&self, book: &str) -> Vec<ChapterDigest> {
        self.all(book)
            .into_iter()
            .map(|chapter| ChapterDigest { cid: chapter.cid.clone(), hash: chapter.fingerprint() })
            .collect()
    }

    fn load(&self, book: &str, cids: &[String]) -> Vec<ChapterContent> {
        let all = self.all(book);
        cids.iter()
            .filter_map(|cid| all.iter().find(|chapter| &chapter.cid == cid).cloned())
            .collect()
    }
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("readerx-sync-content-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn engine(tag: &str, content: Arc<MemContent>) -> SharedEngine {
    let options = EngineOptions::new(tag)
        .with_schemas(SchemaRegistry::readerx_defaults())
        .with_content(content);
    shared(SyncEngine::open(temp_dir(tag), options).unwrap())
}

fn sync_once(client: &SharedEngine, server: &SharedEngine) -> readerx_sync::SyncReport {
    let mut transport = LoopbackTransport::new(server.clone());
    let mut guard = readerx_sync::net::lock_engine(client);
    readerx_sync::sync_with(&mut guard, &mut transport).expect("同步应成功")
}

/// 引擎当前**有效**的正文视图：本地来源 + 暂存区（暂存优先，与引擎的对账口径一致）。
fn effective(engine: &SharedEngine, book: &str) -> BTreeMap<String, String> {
    let guard = readerx_sync::net::lock_engine(engine);
    let cids: Vec<String> = guard
        .content_digests(book)
        .into_iter()
        .map(|digest| digest.cid)
        .collect();
    guard
        .content_bodies(book, &cids)
        .into_iter()
        .map(|chapter| (chapter.cid, chapter.paragraphs.join("\n")))
        .collect()
}

/// 对端还没有这本书时正文不会被推过去（推过去也无处可落）。
#[test]
fn content_waits_until_the_peer_knows_the_book() {
    let a_content = Arc::new(MemContent::default());
    let b_content = Arc::new(MemContent::default());
    let a = engine("wait-a", a_content.clone());
    let b = engine("wait-b", b_content.clone());
    a_content.put("b-1", "c1", "正文一");
    {
        let mut guard = readerx_sync::net::lock_engine(&a);
        guard
            .create_entity("book", Some("b-1".into()), [("title", serde_json::json!("三体"))])
            .unwrap();
        guard.flush().unwrap();
    }
    // 对端一开始连这本书的元信息都没有；同一轮会话里操作先走、正文后走
    let report = sync_once(&a, &b);
    assert_eq!(report.content_pushed, 1, "书元信息到了之后同一轮就会搬正文：{report:?}");
    assert!(
        readerx_sync::net::lock_engine(&b)
            .entity("b-1")
            .is_some_and(|entity| !entity.is_deleted()),
        "操作也要一起同步过去"
    );

    let staged = readerx_sync::net::lock_engine(&b).staged_bodies("b-1");
    assert_eq!(staged.len(), 1);
    assert_eq!(staged[0].cid, "c1");
    assert_eq!(staged[0].paragraphs, vec!["正文一".to_string()]);
}

/// 双向对账：各自缺的章互相补，同一章指纹不同按设备 id 大的一方为准，且**不会来回换**。
#[test]
fn content_converges_without_ping_pong() {
    let a_content = Arc::new(MemContent::default());
    let b_content = Arc::new(MemContent::default());
    let a = engine("converge-a", a_content.clone());
    let b = engine("converge-b", b_content.clone());

    // 两边都有这本书，但正文各有一份不同的集合
    for engine in [&a, &b] {
        let mut guard = readerx_sync::net::lock_engine(engine);
        guard.create_entity("book", Some("b-1".into()), [("title", serde_json::json!("三体"))]).unwrap();
        guard.flush().unwrap();
    }
    a_content.put("b-1", "c1", "甲的正文");
    a_content.put("b-1", "c2", "只有甲有");
    b_content.put("b-1", "c1", "乙改过的正文");
    b_content.put("b-1", "c3", "只有乙有");

    let first = sync_once(&a, &b);
    assert!(first.content_pushed > 0 && first.content_pulled > 0, "两边都该有东西搬：{first:?}");
    assert_eq!(effective(&a, "b-1"), effective(&b, "b-1"), "一轮之后两边正文应一致");

    // 第二轮（反向发起）：差集已经归零，不该再搬
    let second = sync_once(&b, &a);
    assert_eq!(
        (second.content_pushed, second.content_pulled),
        (0, 0),
        "收敛之后不该再来回换：{second:?}"
    );
    assert_eq!(effective(&a, "b-1").len(), 3, "三章最终都在（c2 与 c3 互相补过）");
}

/// 两边都注册了正文来源才谈正文；对端没有（旧版本 / CLI）时直接跳过。
#[test]
fn content_is_skipped_when_the_peer_has_no_source() {
    let a_content = Arc::new(MemContent::default());
    let a = engine("skip-a", a_content.clone());
    let b = shared(
        SyncEngine::open(
            temp_dir("skip-b-plain"),
            EngineOptions::new("skip-b-plain").with_schemas(SchemaRegistry::readerx_defaults()),
        )
        .unwrap(),
    );
    a_content.put("b-1", "c1", "正文一");
    {
        let mut guard = readerx_sync::net::lock_engine(&a);
        guard.create_entity("book", Some("b-1".into()), [("title", serde_json::json!("三体"))]).unwrap();
        guard.flush().unwrap();
    }

    let report = sync_once(&a, &b);
    assert_eq!((report.content_pushed, report.content_pulled), (0, 0));
    assert!(readerx_sync::net::lock_engine(&b).staged_bodies("b-1").is_empty());
}

/// 空设备主动发起时也要点名没有正文的书，不能只同步元信息。
#[test]
fn empty_device_pulls_the_peers_book() {
    let a_content = Arc::new(MemContent::default());
    let b_content = Arc::new(MemContent::default());
    let a = engine("empty-pull-a", a_content);
    let b = engine("empty-pull-b", b_content.clone());
    b_content.put("b-1", "c1", "正文一");
    readerx_sync::net::lock_engine(&b)
        .create_entity("book", Some("b-1".into()), [("title", serde_json::json!("三体"))])
        .unwrap();
    let report = sync_once(&a, &b);
    assert_eq!((report.content_pulled, report.content_pushed), (1, 0));
    assert_eq!(effective(&a, "b-1"), effective(&b, "b-1"));
    let again = sync_once(&a, &b);
    assert_eq!((again.content_pulled, again.content_pushed), (0, 0));
}

/// 总量超过旧 32 MiB 会话预算，且每个百章清单需要拆成多帧时，不能丢掉后半清单。
#[test]
fn large_content_difference_drains_in_one_session() {
    let source = Arc::new(MemContent::default());
    let target = Arc::new(MemContent::default());
    let a = engine("large-a", source.clone());
    let b = engine("large-b", target);
    readerx_sync::net::lock_engine(&a).create_entity("book", Some("b-large".into()),
        [("title", serde_json::json!("大书"))]).unwrap();
    let text = "x".repeat(900 * 1024);
    for index in 0..40 { source.put("b-large", &format!("c{index:03}"), &text); }
    let report = sync_once(&a, &b);
    assert_eq!(report.content_pushed, 40);
    assert!(report.bytes > 32 * 1024 * 1024);
    assert!(!report.more_content);
    assert_eq!(readerx_sync::net::lock_engine(&b).content_digests("b-large").len(), 40);
    let again = sync_once(&a, &b);
    assert_eq!(again.content_pushed + again.content_pulled, 0);
}

/// 清单返回后，模拟另一条连接已经暂存相同数据。
struct DuplicatePush {
    inner: LoopbackTransport,
    server: SharedEngine,
    reject: bool,
}
impl readerx_sync::net::Transport for DuplicatePush {
    fn peer(&self) -> readerx_sync::net::PeerInfo {
        readerx_sync::net::Transport::peer(&self.inner)
    }
    fn request(&mut self, request: &readerx_sync::proto::Request) -> readerx_sync::Result<readerx_sync::proto::Response> {
        if let readerx_sync::proto::Request::PushChapters { book, items } = request {
            if self.reject {
                return Ok(readerx_sync::proto::Response::ContentAck { stored: 0 });
            }
            readerx_sync::net::lock_engine(&self.server).stage_content(book, items)?;
        }
        readerx_sync::net::Transport::request(&mut self.inner, request)
    }
}
#[test]
fn duplicate_push_is_confirmed_but_missing_data_still_fails() {
    for reject in [false, true] {
        let source = Arc::new(MemContent::default());
        let a = engine(&format!("ack-a-{reject}"), source.clone());
        let b = engine(&format!("ack-b-{reject}"), Arc::new(MemContent::default()));
        source.put("b-race", "c1", "重复正文");
        readerx_sync::net::lock_engine(&a).create_entity("book", Some("b-race".into()), [("title", serde_json::json!("竞态回归"))]).unwrap();
        let mut transport = DuplicatePush { inner: LoopbackTransport::new(b.clone()), server: b.clone(), reject };
        let result = readerx_sync::sync_with(&mut readerx_sync::net::lock_engine(&a), &mut transport);
        if reject {
            assert!(result.unwrap_err().to_string().contains("未完整确认"));
        } else {
            let report = result.unwrap();
            assert_eq!(report.content_pushed, 1);
            assert!(!report.more_content && !report.more_assets);
        }
        drop(transport);
        drop(a);
        drop(b);
        for side in ["a", "b"] {
            let dir = std::env::temp_dir().join(format!("readerx-sync-content-ack-{side}-{reject}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// Assert actual wire size even with loopback, so escaping and chunk envelopes are covered.
struct BoundedTransport {
    inner: LoopbackTransport,
    chunks: usize,
    legacy: bool,
}
impl readerx_sync::net::Transport for BoundedTransport {
    fn peer(&self) -> readerx_sync::net::PeerInfo {
        let mut peer = self.inner.peer();
        peer.chapter_chunks = !self.legacy;
        peer
    }
    fn request(&mut self, request: &readerx_sync::proto::Request) -> readerx_sync::Result<readerx_sync::proto::Response> {
        use readerx_sync::proto::*;
        assert!(serde_json::to_vec(request).unwrap().len() < MAX_FRAME_BYTES - 128);
        if matches!(request, Request::PushChapterChunk { .. } | Request::PullChapterChunk { .. }) {
            assert!(!self.legacy, "旧端不能收到新请求");
            self.chunks += 1;
        }
        let response = self.inner.request(request)?;
        assert!(serde_json::to_vec(&response).unwrap().len() < MAX_FRAME_BYTES - 128);
        Ok(response)
    }
}

#[test]
fn oversized_chapters_push_and_pull_with_bounded_frames_and_converge() {
    let ac = Arc::new(MemContent::default());
    let bc = Arc::new(MemContent::default());
    let a = engine("oversize-a", ac.clone());
    let b = engine("oversize-b", bc.clone());
    readerx_sync::net::lock_engine(&a).create_entity("book", Some("large-book".into()),
        [("title", serde_json::json!("大章节"))]).unwrap();
    // Bigger than both the old chapter budget and the wire frame limit.
    let big = "中文🙂".repeat(900_000);
    ac.put("large-book", "push-large", &big);
    // Small raw body but JSON control-character escaping exceeds 8 MiB.
    let escaped = format!("正文{}", "\u{0001}".repeat(1_500_000));
    bc.put("large-book", "pull-escaped", &escaped);
    ac.put("large-book", "small-a", "普通章节甲");
    bc.put("large-book", "small-b", "普通章节乙");
    let mut transport = BoundedTransport { inner: LoopbackTransport::new(b.clone()), chunks: 0, legacy: false };
    let report = readerx_sync::sync_with(&mut readerx_sync::net::lock_engine(&a), &mut transport).unwrap();
    assert_eq!((report.content_pushed, report.content_pulled), (2, 2));
    assert!(!report.more_content);
    assert!(transport.chunks > 4);
    assert_eq!(effective(&a, "large-book"), effective(&b, "large-book"));
    assert_eq!(effective(&b, "large-book")["push-large"], big);
    assert_eq!(effective(&a, "large-book")["pull-escaped"], escaped);
    let again = sync_once(&a, &b);
    assert_eq!((again.content_pushed, again.content_pulled), (0, 0));
}

#[test]
fn legacy_peer_keeps_large_chapters_pending_and_transfers_small_ones() {
    let ac = Arc::new(MemContent::default());
    let bc = Arc::new(MemContent::default());
    let a = engine("legacy-large-a", ac.clone());
    let b = engine("legacy-large-b", bc.clone());
    readerx_sync::net::lock_engine(&a).create_entity("book", Some("legacy-book".into()),
        [("title", serde_json::json!("大章节"))]).unwrap();
    let big = "x".repeat(readerx_sync::proto::CONTENT_BATCH_BYTES + 1);
    ac.put("legacy-book", "large-a", &big);
    bc.put("legacy-book", "large-b", &big);
    ac.put("legacy-book", "small-a", "普通章节甲");
    bc.put("legacy-book", "small-b", "普通章节乙");
    let mut transport = BoundedTransport { inner: LoopbackTransport::new(b.clone()), chunks: 0, legacy: true };
    let error = readerx_sync::sync_with(&mut readerx_sync::net::lock_engine(&a), &mut transport).unwrap_err();
    assert!(error.to_string().contains("升级"));
    assert_eq!(effective(&a, "legacy-book")["small-b"], "普通章节乙");
    assert_eq!(effective(&b, "legacy-book")["small-a"], "普通章节甲");
    assert_eq!(transport.chunks, 0);
    assert!(!effective(&a, "legacy-book").contains_key("large-b"));
    assert!(!effective(&b, "legacy-book").contains_key("large-a"));
    // Upgrading the peer resumes all outstanding content.
    let report = sync_once(&a, &b);
    assert_eq!((report.content_pushed, report.content_pulled), (1, 1));
    assert!(!report.more_content);
}

struct InterruptedChapter(LoopbackTransport, usize);
impl readerx_sync::net::Transport for InterruptedChapter {
    fn peer(&self) -> readerx_sync::net::PeerInfo { self.0.peer() }
    fn request(&mut self, request: &readerx_sync::proto::Request) -> readerx_sync::Result<readerx_sync::proto::Response> {
        use readerx_sync::proto::Request;
        if matches!(request, Request::PushChapterChunk { .. } | Request::PullChapterChunk { .. }) {
            self.1 += 1;
            if self.1 == 2 { return Err(readerx_sync::SyncError::Cancelled); }
        }
        self.0.request(request)
    }
}

#[test]
fn interrupted_chapter_is_not_staged_and_retries_in_both_directions() {
    for pull in [false, true] {
        let ac = Arc::new(MemContent::default());
        let bc = Arc::new(MemContent::default());
        let a = engine(&format!("chapter-stop-a-{pull}"), ac.clone());
        let b = engine(&format!("chapter-stop-b-{pull}"), bc.clone());
        readerx_sync::net::lock_engine(&a).create_entity("book", Some("stop-book".into()),
            [("title", serde_json::json!("停止"))]).unwrap();
        let text = "a".repeat(readerx_sync::proto::CONTENT_BATCH_BYTES + 1);
        (if pull { bc } else { ac }).put("stop-book", "c1", &text);
        let mut transport = InterruptedChapter(LoopbackTransport::new(b.clone()), 0);
        let error = readerx_sync::sync_with(&mut readerx_sync::net::lock_engine(&a), &mut transport).unwrap_err();
        assert_eq!(error, readerx_sync::SyncError::Cancelled);
        let target = if pull { &a } else { &b };
        assert!(readerx_sync::net::lock_engine(target).staged_bodies("stop-book").is_empty());
        drop(transport);
        let report = sync_once(&a, &b);
        assert_eq!(report.content_pushed + report.content_pulled, 1);
        assert_eq!(effective(target, "stop-book")["c1"], text);
    }
}

#[test]
fn oversized_chapter_crosses_authenticated_tcp_in_both_directions() {
    use readerx_sync::net::{PeerServer, ServerOptions};
    for pull in [false, true] {
        let ac = Arc::new(MemContent::default());
        let bc = Arc::new(MemContent::default());
        let a = engine(&format!("chapter-tcp-a-{pull}"), ac.clone());
        let b = engine(&format!("chapter-tcp-b-{pull}"), bc.clone());
        let code = readerx_sync::net::lock_engine(&a).pairing_code();
        readerx_sync::net::lock_engine(&b).join_group(&code).unwrap();
        readerx_sync::net::lock_engine(&a).create_entity("book", Some("tcp-book".into()),
            [("title", serde_json::json!("大章节"))]).unwrap();
        let text = "中文🙂".repeat(850_000);
        (if pull { bc } else { ac }).put("tcp-book", "c1", &text);
        let options = ServerOptions::from_engine(&readerx_sync::net::lock_engine(&b)).unwrap()
            .with_bind(([127, 0, 0, 1], 0).into());
        let server = PeerServer::start(b.clone(), options).unwrap();
        let report = readerx_sync::sync_with_addr(&mut readerx_sync::net::lock_engine(&a),
            &server.local_addr().to_string(), std::time::Duration::from_secs(15)).unwrap();
        assert_eq!(report.content_pushed + report.content_pulled, 1);
        assert_eq!(effective(if pull { &a } else { &b }, "tcp-book")["c1"], text);
    }
}

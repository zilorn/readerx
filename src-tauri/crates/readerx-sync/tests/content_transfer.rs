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

//! 资源通道（封面 / 章节插图）的端到端回归：两台设备用进程内直连互相同步**二进制资源**。
//!
//! 覆盖引擎侧最容易出错的那层：资源不进操作日志（指纹对账 + 按需搬运）、
//! 收到的先落暂存区、双方都有但内容不同时按设备 id 定胜负，以及
//! **插图只朝正文的赢家那一侧搬**（否则败方会推出正文根本不引用的孤儿图）。

use readerx_sync::assets::{Asset, AssetDigest, AssetKind, COVER_ASSET};
use readerx_sync::content::{image_asset_name, AssetRef, ChapterContent, ChapterDigest, ContentSource};
use readerx_sync::net::{shared, LoopbackTransport, SharedEngine};
use readerx_sync::{EngineOptions, SchemaRegistry, SyncEngine};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// 内存版来源（真实 App 里读 `books/<id>/content.json` 与 `images/`）。
///
/// `host` 是「本机已经落地的资源」（模拟宿主书库），`chapters` 是正文块 ——
/// 引擎从这里算出「本机引用了哪些资源」，因此插图的名字来自正文块而不是 `host`。
#[derive(Default)]
struct MemContent {
    host: Mutex<HashMap<String, BTreeMap<String, Asset>>>,
    chapters: Mutex<HashMap<String, BTreeMap<String, ChapterContent>>>,
}

impl MemContent {
    /// 给某本书放一份已经落地的资源（相当于宿主书库里已经有这张图）。
    fn put(&self, book: &str, asset: Asset) {
        self.host
            .lock()
            .unwrap()
            .entry(book.to_string())
            .or_default()
            .insert(asset.name.clone(), asset);
    }

    /// 给某本书放一章节正文（块里带着插图引用）。
    fn put_chapter(&self, book: &str, chapter: ChapterContent) {
        self.chapters
            .lock()
            .unwrap()
            .entry(book.to_string())
            .or_default()
            .insert(chapter.cid.clone(), chapter);
    }

    fn chapters_of(&self, book: &str) -> Vec<ChapterContent> {
        self.chapters
            .lock()
            .unwrap()
            .get(book)
            .map(|items| items.values().cloned().collect())
            .unwrap_or_default()
    }

    fn host_of(&self, book: &str) -> BTreeMap<String, Asset> {
        self.host.lock().unwrap().get(book).cloned().unwrap_or_default()
    }
}

impl ContentSource for MemContent {
    fn digests(&self, book: &str) -> Vec<ChapterDigest> {
        self.chapters_of(book)
            .into_iter()
            .map(|chapter| ChapterDigest { cid: chapter.cid.clone(), hash: chapter.fingerprint() })
            .collect()
    }

    fn load(&self, book: &str, cids: &[String]) -> Vec<ChapterContent> {
        let all = self.chapters_of(book);
        cids.iter()
            .filter_map(|cid| all.iter().find(|chapter| &chapter.cid == cid).cloned())
            .collect()
    }

    fn assets(&self, book: &str) -> Vec<AssetDigest> {
        self.host_of(book)
            .into_iter()
            .map(|(name, asset)| AssetDigest {
                hash: readerx_sync::content::asset_digest(&asset.bytes),
                name,
            })
            .collect()
    }

    fn load_assets(&self, book: &str, names: &[String]) -> Vec<Asset> {
        let host = self.host_of(book);
        names
            .iter()
            .filter_map(|name| host.get(name).cloned())
            .collect()
    }

    fn names(&self, book: &str) -> Vec<String> {
        let mut names: Vec<String> = self
            .chapters_of(book)
            .iter()
            .flat_map(readerx_sync::content::chapter_asset_refs)
            .map(|entry: AssetRef| entry.name)
            .collect();
        names.sort();
        names.dedup();
        names
    }
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("readerx-sync-assets-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn engine(tag: &str, content: Arc<MemContent>) -> SharedEngine {
    let options = EngineOptions::new(tag)
        .with_schemas(SchemaRegistry::readerx_defaults())
        .with_content(content);
    shared(SyncEngine::open(temp_dir(tag), options).unwrap())
}

/// 建一本书（两边都要有这本书，资源才谈得起来）。
fn create_book(engine: &SharedEngine, book: &str) {
    let mut guard = readerx_sync::net::lock_engine(engine);
    guard
        .create_entity("book", Some(book.into()), [("title", serde_json::json!("三体"))])
        .unwrap();
    guard.flush().unwrap();
}

fn sync_once(client: &SharedEngine, server: &SharedEngine) -> readerx_sync::SyncReport {
    let mut transport = LoopbackTransport::new(server.clone());
    let mut guard = readerx_sync::net::lock_engine(client);
    readerx_sync::sync_with(&mut guard, &mut transport).expect("同步应成功")
}

fn device_id(engine: &SharedEngine) -> String {
    readerx_sync::net::lock_engine(engine).device_id().to_string()
}

/// 引擎当前**有效**的资源清单（引用 + 内容，与对账口径一致）。
fn effective(engine: &SharedEngine, book: &str) -> BTreeMap<String, String> {
    readerx_sync::net::lock_engine(engine)
        .asset_index_full(book)
        .into_iter()
        .map(|digest| (digest.name, digest.hash))
        .collect()
}

/// 一份插图资源 / 它的引用名（按「地址 → 名字」的同一套口径算）。
fn illustration(url: &str, bytes: &[u8]) -> (String, Asset) {
    let name = image_asset_name(url);
    let asset = Asset::new(
        &name,
        AssetKind::Illustration,
        "image/png",
        name.rsplit_once('.').map(|(_, ext)| ext).unwrap_or(""),
        bytes.to_vec(),
    );
    (name, asset)
}

fn chapter_with(cid: &str, text: &str, images: &[&str]) -> ChapterContent {
    ChapterContent {
        cid: cid.to_string(),
        title: format!("第 {cid} 章"),
        url: None,
        paragraphs: vec![text.to_string()],
        blocks: Some(serde_json::json!(
            images
                .iter()
                .map(|url| serde_json::json!({ "kind": "img", "remote": url }))
                .collect::<Vec<_>>()
        )),
    }
}

/// 封面：只有一边有时，「有」的一方推给「没有」的一方。
#[test]
fn cover_moves_to_the_peer_that_has_none() {
    let a_content = Arc::new(MemContent::default());
    let b_content = Arc::new(MemContent::default());
    let a = engine("cover-a", a_content.clone());
    let b = engine("cover-b", b_content.clone());
    create_book(&a, "b-1");
    create_book(&b, "b-1");

    let cover = Asset::new(COVER_ASSET, AssetKind::Cover, "image/jpeg", "", b"cover-bytes".to_vec());
    a_content.put("b-1", cover.clone());

    // 单向：A → B（封面不依赖正文赢家，因此谁发起都会搬过去）
    let report = sync_once(&a, &b);
    assert_eq!(report.assets_pushed, 1, "本机有封面，应推过去：{report:?}");
    assert_eq!(report.assets_pulled, 0, "封面只朝一个方向走：{report:?}");
    let staged = readerx_sync::net::lock_engine(&b).staged_assets("b-1");
    assert_eq!(staged.len(), 1);
    assert_eq!(staged[0].name, COVER_ASSET);
    assert_eq!(staged[0].bytes, b"cover-bytes");

    // 收敛之后第二轮不该再搬
    let again = sync_once(&a, &b);
    assert_eq!((again.assets_pushed, again.assets_pulled), (0, 0), "不该反复搬同一份封面");
}

/// 封面：两边内容不同时按**设备 id 大的一方**为准，两个方向都收敛到同一份。
#[test]
fn conflicting_covers_converge_on_the_bigger_device() {
    let a_content = Arc::new(MemContent::default());
    let b_content = Arc::new(MemContent::default());
    let a = engine("conflict-a", a_content.clone());
    let b = engine("conflict-b", b_content.clone());
    create_book(&a, "b-1");
    create_book(&b, "b-1");

    a_content.put("b-1", Asset::new(COVER_ASSET, AssetKind::Cover, "image/jpeg", "", "甲".as_bytes().to_vec()));
    b_content.put("b-1", Asset::new(COVER_ASSET, AssetKind::Cover, "image/jpeg", "", "乙".as_bytes().to_vec()));

    let winner_is_a = device_id(&a) > device_id(&b);
    // 由「设备 id 小」的一方发起：它才是要取封面的那一边
    let (client_content, server_content, client, server) = if winner_is_a {
        (b_content.clone(), a_content.clone(), &b, &a)
    } else {
        (a_content.clone(), b_content.clone(), &a, &b)
    };

    let report = sync_once(client, server);
    assert_eq!(report.assets_pulled, 1, "败方应取回赢家的封面：{report:?}");
    assert_eq!(report.assets_pushed, 0, "败方不该把自己的封面推出去：{report:?}");

    // 败方把自己的封面就地替换成赢家那一份（宿主落地时做，这里手动模拟）
    let staged = readerx_sync::net::lock_engine(client).staged_assets("b-1");
    assert_eq!(staged.len(), 1);
    let winner_bytes = server_content.host_of("b-1")[COVER_ASSET].bytes.clone();
    assert_eq!(staged[0].bytes, winner_bytes, "收下的必须是赢家那一份");
    let _ = client_content;

    // 反向再同步一轮：赢家那边不该被败方的封面改写
    let back = sync_once(server, client);
    assert_eq!(back.assets_pulled, 0, "赢家不该回头取败方的封面：{back:?}");
}

/// 插图：正文赢家的图会被搬到另一侧，败方自己的图**不会被推出去**（不留孤儿）。
#[test]
fn illustrations_follow_the_body_winner_only() {
    let a_content = Arc::new(MemContent::default());
    let b_content = Arc::new(MemContent::default());
    let a = engine("illus-a", a_content.clone());
    let b = engine("illus-b", b_content.clone());
    create_book(&a, "b-1");
    create_book(&b, "b-1");

    // 两边各有一张**不同的**插图，正文块也各引用自己那张
    let (a_name, a_asset) = illustration("https://img.example.com/a.png", "图甲".as_bytes());
    let (b_name, b_asset) = illustration("https://img.example.com/b.png", "图乙".as_bytes());
    assert_ne!(a_name, b_name);
    a_content.put("b-1", a_asset);
    b_content.put("b-1", b_asset);
    a_content.put_chapter("b-1", chapter_with("c1", "甲的正文", &["https://img.example.com/a.png"]));
    b_content.put_chapter("b-1", chapter_with("c1", "乙的正文", &["https://img.example.com/b.png"]));

    let winner_is_a = device_id(&a) > device_id(&b);
    let (winner_content, loser_content, winner, loser) = if winner_is_a {
        (a_content.clone(), b_content.clone(), &a, &b)
    } else {
        (b_content.clone(), a_content.clone(), &b, &a)
    };
    let (winner_name, loser_name) = if winner_is_a {
        (a_name.clone(), b_name.clone())
    } else {
        (b_name.clone(), a_name.clone())
    };

    // 一轮：正文与插图都收敛
    let report = sync_once(loser, winner);
    assert!(report.content_pulled > 0, "正文该跟着走：{report:?}");
    assert!(report.assets_pulled > 0, "插图该跟着正文一起走：{report:?}");
    assert_eq!(
        report.assets_pushed, 0,
        "败方不该把自己的图推给赢家（那会留下正文不引用的孤儿）：{report:?}"
    );

    // 败方收到了赢家那张图（暂存区里），而且它引用的名字已经是赢家那个
    let staged = readerx_sync::net::lock_engine(loser).staged_assets("b-1");
    assert_eq!(staged.len(), 1);
    assert_eq!(staged[0].name, winner_name);
    assert_eq!(staged[0].bytes, winner_content.host_of("b-1")[&winner_name].bytes);

    // 败方原来那张图（如果有）没有名字冲突，但赢家那边**一个字节都没多**
    assert!(
        !winner_content.host_of("b-1").contains_key(&loser_name),
        "赢家不该收到败方那张孤儿图"
    );
    let _ = loser_content;

    // 败方的对账视图里，赢家那张图已经「有内容」（暂存区里），不会再去搬第二次
    let view = effective(loser, "b-1");
    assert_eq!(view[&winner_name], readerx_sync::content::asset_digest(&staged[0].bytes));

    // 第二轮（反向发起）：差集归零，不再搬运
    let again = sync_once(winner, loser);
    assert_eq!(
        (again.assets_pushed, again.assets_pulled),
        (0, 0),
        "收敛之后不该再来回搬：{again:?}"
    );
}

/// 对端完全没有这本书时资源不搬（搬过去也无处可落）。
#[test]
fn assets_wait_until_the_peer_knows_the_book() {
    let a_content = Arc::new(MemContent::default());
    let b_content = Arc::new(MemContent::default());
    let a = engine("wait-assets-a", a_content.clone());
    let b = engine("wait-assets-b", b_content.clone());
    // 只有 A 有这本书
    create_book(&a, "b-1");
    let (name, asset) = illustration("https://img.example.com/a.png", "图甲".as_bytes());
    a_content.put("b-1", asset);
    a_content.put_chapter("b-1", chapter_with("c1", "正文", &["https://img.example.com/a.png"]));

    let report = sync_once(&a, &b);
    // 元信息在同一轮里先同步过去，因此这一轮插图就能落地（与正文通道同一时序）
    assert_eq!(report.assets_pushed, 1, "独有书籍的插图应同一轮传输：{report:?}");
    let staged = readerx_sync::net::lock_engine(&b).staged_assets("b-1");
    assert!(
        staged.iter().all(|item| item.name == name),
        "只该推引用到的那张图：{staged:?}"
    );

    // 再向一台空设备同步：元信息、正文与图都应在同一轮到达
    let c_content = Arc::new(MemContent::default());
    let c = engine("wait-assets-c", c_content);
    let report = sync_once(&a, &c);
    assert_eq!((report.assets_pushed, report.assets_pulled), (1, 0), "空设备应收到书籍插图：{report:?}");
}

/// 没注册来源的一方（旧版本 / CLI）完全不参与资源通道：既不推也不收。
#[test]
fn assets_are_skipped_when_the_peer_has_no_source() {
    let a_content = Arc::new(MemContent::default());
    let a = engine("skip-assets-a", a_content.clone());
    create_book(&a, "b-1");
    a_content.put(
        "b-1",
        Asset::new(COVER_ASSET, AssetKind::Cover, "image/jpeg", "", b"cover".to_vec()),
    );

    let b = shared(
        SyncEngine::open(
            temp_dir("skip-assets-b"),
            EngineOptions::new("skip-assets-b").with_schemas(SchemaRegistry::readerx_defaults()),
        )
        .unwrap(),
    );

    let report = sync_once(&a, &b);
    assert_eq!((report.assets_pushed, report.assets_pulled), (0, 0));
    assert!(readerx_sync::net::lock_engine(&b).staged_assets("b-1").is_empty());
}

/// 双方各自独有章节的插图都应搬运，不能按全局设备 id 丢掉其中一侧。
#[test]
fn illustrations_of_unique_chapters_move_in_both_directions() {
    let a_content = Arc::new(MemContent::default());
    let b_content = Arc::new(MemContent::default());
    let a = engine("unique-images-a", a_content.clone());
    let b = engine("unique-images-b", b_content.clone());
    create_book(&a, "b-1");
    let (a_name, a_asset) = illustration("https://img.example.com/unique-a.png", b"image-a");
    let (b_name, b_asset) = illustration("https://img.example.com/unique-b.png", b"image-b");
    a_content.put("b-1", a_asset);
    b_content.put("b-1", b_asset);
    a_content.put_chapter("b-1", chapter_with("c1", "甲独有章节", &["https://img.example.com/unique-a.png"]));
    b_content.put_chapter("b-1", chapter_with("c2", "乙独有章节", &["https://img.example.com/unique-b.png"]));
    let report = sync_once(&a, &b);
    assert_eq!((report.content_pushed, report.content_pulled), (1, 1));
    assert_eq!((report.assets_pushed, report.assets_pulled), (1, 1));
    assert!(effective(&a, "b-1").contains_key(&b_name));
    assert!(effective(&b, "b-1").contains_key(&a_name));
    let again = sync_once(&b, &a);
    assert_eq!((again.assets_pushed, again.assets_pulled), (0, 0));
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
        if let readerx_sync::proto::Request::ExchangeAssets { book, push: items, .. } = request {
            if self.reject {
                return Ok(readerx_sync::proto::Response::Assets { book: book.clone(), stored: 0, items: vec![] });
            }
            readerx_sync::net::lock_engine(&self.server).stage_assets(book, items)?;
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
        source.put("b-race", Asset::new(COVER_ASSET, AssetKind::Cover, "image/png", "png", vec![1, 2, 3]));
        readerx_sync::net::lock_engine(&a).create_entity("book", Some("b-race".into()), [("title", serde_json::json!("竞态回归"))]).unwrap();
        let mut transport = DuplicatePush { inner: LoopbackTransport::new(b.clone()), server: b.clone(), reject };
        let result = readerx_sync::sync_with(&mut readerx_sync::net::lock_engine(&a), &mut transport);
        if reject {
            assert!(result.unwrap_err().to_string().contains("未完整确认"));
        } else {
            let report = result.unwrap();
            assert_eq!(report.assets_pushed, 1);
            assert!(!report.more_content && !report.more_assets);
        }
        drop(transport);
        drop(a);
        drop(b);
        for side in ["a", "b"] {
            let dir = std::env::temp_dir().join(format!("readerx-sync-assets-ack-{side}-{reject}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

#[test]
fn oversized_cover_transfers_losslessly_in_both_directions() {
    for push in [false, true] {
        let a_source = Arc::new(MemContent::default());
        let b_source = Arc::new(MemContent::default());
        let a = engine(&format!("oversize-a-{push}"), a_source.clone());
        let b = engine(&format!("oversize-b-{push}"), b_source.clone());
        create_book(&a, "b-large");
        let source = if push { &a_source } else { &b_source };
        source.put("b-large", Asset::new(COVER_ASSET, AssetKind::Cover, "image/png", "png",
            vec![1; readerx_sync::proto::MAX_FRAME_BYTES + 1]));
        let mut transport = LoopbackTransport::new(b.clone());
        let report = readerx_sync::sync_with(&mut readerx_sync::net::lock_engine(&a), &mut transport).unwrap();
        assert_eq!(report.assets_pushed + report.assets_pulled, 1);
        let target = if push { &b } else { &a };
        let staged = readerx_sync::net::lock_engine(target).staged_assets("b-large");
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].bytes, vec![1; readerx_sync::proto::MAX_FRAME_BYTES + 1]);
        let report = sync_once(&a, &b);
        assert_eq!(report.assets_pushed + report.assets_pulled, 0);
        assert!(!report.more_assets);
        drop(transport);
        drop(a);
        drop(b);
        for side in ["a", "b"] {
            let dir = std::env::temp_dir().join(format!("readerx-sync-assets-oversize-{side}-{push}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// 真 TCP + MAC 信封：字节与封面原文加起来远超单帧上限，仍可完成传输。
#[test]
fn large_cover_and_illustration_cross_real_tcp_losslessly_in_both_directions() {
    use readerx_sync::net::{PeerServer, ServerOptions};
    use std::time::Duration;
    for push in [false, true] {
        let a_source = Arc::new(MemContent::default());
        let b_source = Arc::new(MemContent::default());
        let a = engine(&format!("tcp-large-a-{push}"), a_source.clone());
        let b = engine(&format!("tcp-large-b-{push}"), b_source.clone());
        let code = readerx_sync::net::lock_engine(&a).pairing_code();
        readerx_sync::net::lock_engine(&b).join_group(&code).unwrap();
        create_book(&a, "b-tcp-large");
        let source = if push { a_source } else { b_source };
        let bytes = vec![0x42; readerx_sync::proto::MAX_FRAME_BYTES + 1];
        let data_url = format!("data:image/png;base64,{}", readerx_sync::content::encode_base64(&bytes));
        source.put("b-tcp-large", Asset::new(COVER_ASSET, AssetKind::Cover, "image/png", "png", bytes.clone())
            .with_data_url(Some(data_url.clone())));
        let image_bytes = vec![0x43; readerx_sync::proto::ASSET_BATCH_BYTES + 1];
        let url = "https://img.example.com/large.png";
        let (image_name, image) = illustration(url, &image_bytes);
        source.put("b-tcp-large", image);
        source.put_chapter("b-tcp-large", chapter_with("c1", "图文", &[url]));
        let options = ServerOptions::from_engine(&readerx_sync::net::lock_engine(&b)).unwrap()
            .with_bind(([127, 0, 0, 1], 0).into());
        let server = PeerServer::start(b.clone(), options).unwrap();
        let report = readerx_sync::sync_with_addr(&mut readerx_sync::net::lock_engine(&a),
            &server.local_addr().to_string(), Duration::from_secs(15)).unwrap();
        assert_eq!(if push { report.assets_pushed } else { report.assets_pulled }, 2);
        let target = if push { &b } else { &a };
        let staged = readerx_sync::net::lock_engine(target).staged_assets("b-tcp-large");
        let cover = staged.iter().find(|asset| asset.name == COVER_ASSET).unwrap();
        assert_eq!(cover.bytes, bytes);
        assert_eq!(cover.data_url.as_deref(), Some(data_url.as_str()));
        let image = staged.iter().find(|asset| asset.name == image_name).unwrap();
        assert_eq!(image.bytes, image_bytes);
        assert_eq!(image.kind, AssetKind::Illustration);
        drop(server);
        drop(a);
        drop(b);
        for side in ["a", "b"] {
            let dir = std::env::temp_dir().join(format!("readerx-sync-assets-tcp-large-{side}-{push}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

struct InterruptedChunks {
    inner: LoopbackTransport,
    pull: bool,
    chunks: usize,
}
impl readerx_sync::net::Transport for InterruptedChunks {
    fn peer(&self) -> readerx_sync::net::PeerInfo {
        readerx_sync::net::Transport::peer(&self.inner)
    }
    fn request(&mut self, request: &readerx_sync::proto::Request) -> readerx_sync::Result<readerx_sync::proto::Response> {
        let is_chunk = if self.pull {
            matches!(request, readerx_sync::proto::Request::PullAssetChunk { .. })
        } else {
            matches!(request, readerx_sync::proto::Request::PushAssetChunk { .. })
        };
        if is_chunk {
            self.chunks += 1;
            if self.chunks == 2 { return Err(readerx_sync::SyncError::Cancelled); }
        }
        readerx_sync::net::Transport::request(&mut self.inner, request)
    }
}

#[test]
fn interrupted_resource_is_not_staged_and_retries_successfully() {
    for pull in [false, true] {
        let a_source = Arc::new(MemContent::default());
        let b_source = Arc::new(MemContent::default());
        let a = engine(&format!("interrupted-a-{pull}"), a_source.clone());
        let b = engine(&format!("interrupted-b-{pull}"), b_source.clone());
        create_book(&a, "b-interrupted");
        let source = if pull { b_source } else { a_source };
        source.put("b-interrupted", Asset::new(COVER_ASSET, AssetKind::Cover, "image/png", "png",
            vec![1; readerx_sync::proto::ASSET_BATCH_BYTES + 1]));
        let mut transport = InterruptedChunks { inner: LoopbackTransport::new(b.clone()), pull, chunks: 0 };
        let error = readerx_sync::sync_with(&mut readerx_sync::net::lock_engine(&a), &mut transport).unwrap_err();
        assert_eq!(error, readerx_sync::SyncError::Cancelled);
        let target = if pull { &a } else { &b };
        assert!(readerx_sync::net::lock_engine(target).staged_assets("b-interrupted").is_empty());
        drop(transport);
        let report = sync_once(&a, &b);
        assert_eq!(report.assets_pushed + report.assets_pulled, 1);
        assert_eq!(readerx_sync::net::lock_engine(target).staged_assets("b-interrupted").len(), 1);
        drop(a);
        drop(b);
        for side in ["a", "b"] {
            let dir = std::env::temp_dir().join(format!("readerx-sync-assets-interrupted-{side}-{pull}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

struct MissingCover;
impl ContentSource for MissingCover {
    fn digests(&self, _: &str) -> Vec<ChapterDigest> { vec![] }
    fn load(&self, _: &str, _: &[String]) -> Vec<ChapterContent> { vec![] }
    fn assets(&self, _: &str) -> Vec<AssetDigest> {
        vec![AssetDigest { name: COVER_ASSET.into(), hash: "advertised-but-unreadable".into() }]
    }
}

#[test]
fn unreadable_resource_reports_its_name_without_claiming_a_size_failure() {
    let a = engine("missing-a", Arc::new(MemContent::default()));
    let root = temp_dir("missing-b");
    let b = shared(SyncEngine::open(&root, EngineOptions::new("missing-b")
        .with_schemas(SchemaRegistry::readerx_defaults()).with_content(Arc::new(MissingCover))).unwrap());
    create_book(&a, "b-unreadable");
    let mut transport = LoopbackTransport::new(b.clone());
    let error = readerx_sync::sync_with(&mut readerx_sync::net::lock_engine(&a), &mut transport).unwrap_err().to_string();
    assert!(error.contains("资源无法读取") && error.contains("b-unreadable") && error.contains("cover"), "{error}");
    assert!(!error.contains("超过"));
    drop(transport);
    drop(a);
    drop(b);
    for side in ["a", "b"] {
        let dir = std::env::temp_dir().join(format!("readerx-sync-assets-missing-{side}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(dir);
    }
}

struct WithoutChunkCapability(LoopbackTransport);
impl readerx_sync::net::Transport for WithoutChunkCapability {
    fn peer(&self) -> readerx_sync::net::PeerInfo {
        let mut peer = readerx_sync::net::Transport::peer(&self.0);
        peer.asset_chunks = false;
        peer
    }
    fn request(&mut self, request: &readerx_sync::proto::Request) -> readerx_sync::Result<readerx_sync::proto::Response> {
        assert!(!matches!(request, readerx_sync::proto::Request::PullAssetChunk { .. }
            | readerx_sync::proto::Request::PushAssetChunk { .. }), "不能给旧构建发送分片请求");
        readerx_sync::net::Transport::request(&mut self.0, request)
    }
}

#[test]
fn older_peer_gets_no_unknown_requests() {
    let source = Arc::new(MemContent::default());
    let a = engine("old-cap-a", source.clone());
    let b = engine("old-cap-b", Arc::new(MemContent::default()));
    create_book(&a, "b-old-cap");
    source.put("b-old-cap", Asset::new(COVER_ASSET, AssetKind::Cover, "image/png", "png", vec![1]));
    let mut transport = WithoutChunkCapability(LoopbackTransport::new(b.clone()));
    assert_eq!(readerx_sync::sync_with(&mut readerx_sync::net::lock_engine(&a), &mut transport).unwrap().assets_pushed, 1);
    source.put("b-old-cap", Asset::new(COVER_ASSET, AssetKind::Cover, "image/png", "png",
        vec![2; readerx_sync::proto::ASSET_BATCH_BYTES + 1]));
    // 清掉接收端的旧封面，保证下一轮必须推送大资源，不受冲突赢家影响。
    readerx_sync::net::lock_engine(&b).clear_staged_assets("b-old-cap", &[(AssetKind::Cover, COVER_ASSET.into())]).unwrap();
    let error = readerx_sync::sync_with(&mut readerx_sync::net::lock_engine(&a), &mut transport).unwrap_err().to_string();
    assert!(error.contains("更新两端应用"), "{error}");
    drop(transport);
    drop(a);
    drop(b);
    for side in ["a", "b"] {
        let dir = std::env::temp_dir().join(format!("readerx-sync-assets-old-cap-{side}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(dir);
    }
}

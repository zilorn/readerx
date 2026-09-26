//! 同步桥接的端到端回归：**真实磁盘布局 + 真实引擎**，只把窗口换成 mock。
//!
//! 验证的是最容易出错、单元测试又覆盖不到的那一层：App 的本地文件
//! （`books/<id>/bookdetail.json`、`books/<id>/bookmarks.json`、`state/readerx.*.json`、
//! `book_sources/<id>.json`）与同步引擎实体之间的**双向搬运**。
//!
//! ```text
//! 本地文件 --reconcile--> 引擎实体        （首次启用 / 每次启动对账）
//! 引擎实体 --materialize--> 本地文件      （一次同步之后）
//! ```
//!
//! 两台「设备」用进程内直连互相同步（不需要网卡 / 端口），因此这个测试是确定性的。
//!
//! **串行执行**：应用数据目录由进程级的 `XDG_DATA_HOME` 决定，书源引擎的数据根更是
//! 一次性初始化（`init_data_root`），所以用例之间必须错开 —— 共用一个临时目录，
//! 每个用例开始时清空它。

use readerx_lib::sync::bridge::{self, BookIndex, PublishMode};
use readerx_lib::sync::content as tcontent;
use readerx_lib::sync::identity;
use readerx_lib::sync::SyncService;
use readerx_sync::net::{
    lock_engine, shared, LoopbackTransport, PeerServer, ServerOptions, SharedEngine,
};
use readerx_sync::{EngineOptions, SchemaRegistry, SyncEngine};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

/// 用例串行锁（见文件头说明）。
static SERIAL: Mutex<()> = Mutex::new(());
/// mock 应用与它的数据目录（整个测试进程共用一份）。
static SHARED: OnceLock<(tauri::AppHandle<tauri::test::MockRuntime>, PathBuf)> = OnceLock::new();

/// 取共享的 mock 应用，并清掉上一个用例留下的数据。
fn setup() -> (tauri::AppHandle<tauri::test::MockRuntime>, PathBuf) {
    let (handle, data_root) = SHARED
        .get_or_init(|| {
            let root =
                std::env::temp_dir().join(format!("readerx-sync-e2e-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            // Tauri 的 app_data_dir = $XDG_DATA_HOME/<identifier>
            std::env::set_var("XDG_DATA_HOME", &root);
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .expect("mock 应用应能构建");
            let handle = app.handle().clone();
            let data = handle.path().app_data_dir().unwrap();
            // 书源引擎的数据根是进程级一次性初始化：整个测试进程共用一份
            readerx_source::store::init_data_root(data.clone());
            // mock 应用要活到进程结束（否则句柄失效）
            std::mem::forget(app);
            (handle, data)
        })
        .clone();
    for sub in [
        "books",
        "state",
        "sync",
        "book_sources",
        "source_sessions",
        "images",
        "tts-audio",
    ] {
        let _ = std::fs::remove_dir_all(data_root.join(sub));
    }
    (handle, data_root)
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// 造一本本地书（与 `book_store.rs` 的目录布局一致：书签单独一个文件）。
fn seed_local_book(data_root: &Path, id: &str, title: &str) {
    let dir = data_root.join("books").join(id);
    std::fs::create_dir_all(&dir).unwrap();
    write_json(
        &dir.join("bookdetail.json"),
        &json!({
            "schemaVersion": 1,
            "id": id,
            "title": title,
            "author": "刘慈欣",
            "intro": "简介",
            "format": "epub",
            "fileName": "三体.epub",
            "size": 1024,
            "importedAt": 1_700_000_000u64,
            "hue": 7,
            "splitDesc": "按章",
            "cover": "data:image/png;base64,AAAA",
            "groupId": null,
            "tags": ["科幻"],
        }),
    );
    write_json(
        &dir.join("content.json"),
        &json!({ "schemaVersion": 1, "chapters": [
            { "cid": "c0001", "title": "第一章", "paragraphs": ["正文"] }
        ]}),
    );
    write_json(
        &dir.join("bookmarks.json"),
        &json!({ "schemaVersion": 1, "bookmarks": [
            {
                "id": "bm-1",
                "bookId": id,
                "chapterCid": "c0001",
                "chapterIndex": 0,
                "chapterTitle": "第一章",
                "unitIndex": 0,
                "charStart": 0,
                "charEnd": 2,
                "text": "正文",
                "before": "",
                "after": "",
                "createdAt": 1_700_000_000_000u64,
            }
        ]}),
    );
}

fn seed_local_progress(data_root: &Path, book_id: &str, chapter: i64, offset: i64) {
    write_json(
        &data_root.join("state").join("readerx.shelf.json"),
        &json!({
            book_id: {
                "bookId": book_id,
                "chapter": chapter,
                "chapterCid": "c0001",
                "charOffset": offset,
                "context": "正文",
                "updatedAt": 1_700_000_000_000u64 + offset as u64,
            }
        }),
    );
    write_json(
        &data_root.join("state").join("readerx.groups.json"),
        &json!([{ "id": "grp-1", "name": "科幻", "createdAt": 1_700_000_000_000u64 }]),
    );
}

/// 本机引擎（就是 App 在 `<应用数据目录>/sync` 下开的那个）。
///
/// 与 App 一样注册**正文来源**：正文通道的落地方向（对端推来的正文写进书库、
/// 本机书库里的正文能发给对端）要靠它跑起来。
fn local_engine(handle: &tauri::AppHandle<tauri::test::MockRuntime>, data_root: &Path) -> SharedEngine {
    let options = EngineOptions::new("本机")
        .with_schemas(SchemaRegistry::readerx_defaults())
        .with_content(tcontent::AppContent::new(handle.clone()));
    shared(SyncEngine::open(data_root.join("sync"), options).unwrap())
}

/// 对端的正文来源（内存版）：模拟「另一台设备书库里有正文」。
#[derive(Default)]
struct PeerContent {
    books: Mutex<HashMap<String, Vec<readerx_sync::content::ChapterContent>>>,
}

impl PeerContent {
    fn put(&self, book: &str, cid: &str, title: &str, text: &str) {
        let chapter = readerx_sync::content::ChapterContent {
            cid: cid.to_string(),
            title: title.to_string(),
            url: Some(format!("https://example.com/{cid}")),
            paragraphs: vec![text.to_string()],
            blocks: None,
        };
        self.books
            .lock()
            .unwrap()
            .entry(book.to_string())
            .or_default()
            .push(chapter);
    }
}

impl readerx_sync::content::ContentSource for PeerContent {
    fn digests(&self, book: &str) -> Vec<readerx_sync::content::ChapterDigest> {
        self.books
            .lock()
            .unwrap()
            .get(book)
            .map(|chapters| {
                chapters
                    .iter()
                    .map(|chapter| readerx_sync::content::ChapterDigest {
                        cid: chapter.cid.clone(),
                        hash: chapter.fingerprint(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn load(&self, book: &str, cids: &[String]) -> Vec<readerx_sync::content::ChapterContent> {
        let all = self.books.lock().unwrap();
        let chapters = all.get(book);
        cids.iter()
            .filter_map(|cid| {
                chapters?
                    .iter()
                    .find(|chapter| &chapter.cid == cid)
                    .cloned()
            })
            .collect()
    }
}

/// 另一台设备的引擎（数据目录在临时区，直接开）。
fn peer_engine(tag: &str, pairing_code: Option<&str>) -> SharedEngine {
    peer_engine_with_content(tag, pairing_code, None)
}

/// 同上，但给对端注册一个正文来源（验证正文通道）。
fn peer_engine_with_content(
    tag: &str,
    pairing_code: Option<&str>,
    content: Option<Arc<PeerContent>>,
) -> SharedEngine {
    let dir =
        std::env::temp_dir().join(format!("readerx-sync-e2e-peer-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let mut options = EngineOptions::new(tag).with_schemas(SchemaRegistry::readerx_defaults());
    if let Some(content) = content {
        options = options.with_content(content);
    }
    let mut engine = SyncEngine::open(dir, options).unwrap();
    if let Some(code) = pairing_code {
        engine.join_group(code).unwrap();
    }
    shared(engine)
}

fn sync_once(client: &SharedEngine, server: &SharedEngine) -> readerx_sync::SyncReport {
    let mut transport = LoopbackTransport::new(server.clone());
    let mut guard = lock_engine(client);
    readerx_sync::sync_with(&mut guard, &mut transport).expect("同步应成功")
}

/// 集合字段（标签）比较：顺序由引擎的键序决定，比较时按集合看。
fn sorted_strings(value: &Value) -> Vec<String> {
    let mut items: Vec<String> = value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    items.sort();
    items
}

#[test]
fn local_library_is_published_and_remote_changes_land_back() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();

    seed_local_book(&app_data, "local-1", "三体");
    seed_local_progress(&app_data, "local-1", 3, 300);
    // 一份书源（书源以地址为身份）
    write_json(
        &app_data.join("book_sources").join("src-1.json"),
        &json!({
            "schemaVersion": 1,
            "id": "src-1",
            "name": "示例源",
            "bookSourceUrl": "https://example.com",
            "enabled": true,
            "js": "function searchBook(){}",
        }),
    );

    // ---- 本机引擎 + 本地对账 ----
    let local = local_engine(&handle, &app_data);
    let mut index = BookIndex::default();
    bridge::reconcile(&handle, &local, &mut index).unwrap();

    let uid = {
        let guard = lock_engine(&local);
        let books = guard.entities_of_kind("book", false);
        assert_eq!(books.len(), 1, "本地书应被发布成一条书实体");
        let book = books[0];
        assert_eq!(book.field("title"), Some(json!("三体")));
        assert_eq!(
            sorted_strings(&book.field("tags").unwrap()),
            vec!["科幻".to_string()]
        );
        assert_eq!(book.field("file_name"), Some(json!("三体.epub")));
        // 封面与导入时间不进同步（会撑爆操作日志 / 每台设备本来就不一样）
        assert!(book.field("cover").is_none(), "封面不参与同步");
        assert!(book.field("imported_at").is_none());
        let progress = guard.entities_of_kind("reading_progress", false);
        assert_eq!(progress.len(), 1);
        assert_eq!(progress[0].field("char_offset"), Some(json!(300)));
        assert_eq!(guard.entities_of_kind("bookmark", false).len(), 1);
        assert_eq!(guard.entities_of_kind("group", false).len(), 1, "分组应被发布");
        assert_eq!(
            guard.entities_of_kind("book_source", false).len(),
            1,
            "书源应被发布"
        );
        book.id.clone()
    };

    // ---- 另一台设备：同一本书、改了书名并读得更靠后 ----
    let peer = peer_engine("bridge-peer", Some(&lock_engine(&local).pairing_code()));
    {
        let mut guard = lock_engine(&peer);
        guard
            .create_entity(
                "book",
                Some(uid.clone()),
                [
                    ("title", json!("三体（对端改名）")),
                    ("author", json!("刘慈欣")),
                    ("tags", json!(["科幻", "待读"])),
                    ("format", json!("epub")),
                    ("file_name", json!("三体.epub")),
                    ("size", json!(1024)),
                ],
            )
            .unwrap();
        guard
            .create_entity(
                "reading_progress",
                Some(format!("rp-{uid}")),
                [
                    ("book_id", json!(uid)),
                    ("chapter", json!(9)),
                    ("chapter_cid", json!("c0001")),
                    ("char_offset", json!(900)),
                    ("updated_at", json!(1_800_000_000_000u64)),
                ],
            )
            .unwrap();
        guard.flush().unwrap();
    }

    // ---- 同步（本机主动连对端）----
    sync_once(&local, &peer);

    // ---- 落地：远端结果写回本地文件 ----
    let changes = bridge::materialize(&handle, &local, 0, &mut index).unwrap();
    assert!(changes.books, "书元信息应被同步落地：{changes:?}");
    assert!(changes.progress, "阅读进度应被同步落地：{changes:?}");

    let detail = read_json(&app_data.join("books").join("local-1").join("bookdetail.json"));
    assert_eq!(detail["title"], json!("三体（对端改名）"), "对端的改名应落回本地");
    assert_eq!(
        sorted_strings(&detail["tags"]),
        vec!["待读".to_string(), "科幻".to_string()],
        "标签按集合并集"
    );
    assert_eq!(
        detail["cover"],
        json!("data:image/png;base64,AAAA"),
        "封面是本机的，不受同步影响"
    );
    assert_eq!(detail["importedAt"], json!(1_700_000_000u64));

    let shelf = read_json(&app_data.join("state").join("readerx.shelf.json"));
    assert_eq!(
        shelf["local-1"]["charOffset"],
        json!(900),
        "读得更晚的那台设备的进度应落回本地"
    );
    assert_eq!(shelf["local-1"]["bookId"], json!("local-1"), "落地后仍是本机书 id");

    // 两台设备在**第一次同步之前**给同一本书起了不同的书名：这是真正的并发改写，
    // 引擎按 HLC 选边、把另一方留档（这正是冲突页要处理的东西）。
    // 标签是集合：两边的标签并集保留，不产生冲突。
    let conflict_fields: Vec<String> = {
        let guard = lock_engine(&local);
        assert_eq!(guard.pending_conflict_count(), 1, "只有书名是并发改写的：{:?}", guard.conflicts(None));
        guard
            .conflicts(Some(readerx_sync::ConflictStatus::Pending))
            .into_iter()
            .map(|conflict| conflict.field.clone())
            .collect()
    };
    assert_eq!(conflict_fields, vec!["title".to_string()]);

    // 对端也拿到了本机的书签与书源
    assert_eq!(
        lock_engine(&peer).entities_of_kind("bookmark", false).len(),
        1,
        "本机的书签应推给对端"
    );
    assert_eq!(
        lock_engine(&peer).entities_of_kind("book_source", false).len(),
        1,
        "本机的书源应推给对端"
    );
}

#[test]
fn second_device_import_of_the_same_file_keeps_synced_metadata() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();

    seed_local_book(&app_data, "local-1", "三体");
    let local = local_engine(&handle, &app_data);
    let mut index = BookIndex::default();
    bridge::reconcile(&handle, &local, &mut index).unwrap();
    let uid = lock_engine(&local).entities_of_kind("book", false)[0].id.clone();

    // 对端改了书名并同步过来
    let peer = peer_engine("imported-peer", Some(&lock_engine(&local).pairing_code()));
    {
        let mut guard = lock_engine(&peer);
        guard
            .create_entity(
                "book",
                Some(uid.clone()),
                [
                    ("title", json!("三体（对端改名）")),
                    ("file_name", json!("三体.epub")),
                    ("size", json!(1024)),
                ],
            )
            .unwrap();
        guard.flush().unwrap();
    }
    sync_once(&local, &peer);
    bridge::materialize(&handle, &local, 0, &mut index).unwrap();
    let detail = read_json(&app_data.join("books").join("local-1").join("bookdetail.json"));
    assert_eq!(detail["title"], json!("三体（对端改名）"));

    // 本机重新导入同一个文件（书名是导入时的原名）→ 不能覆盖同步来的名字
    bridge::publish_book(&handle, &local, "local-1", PublishMode::Imported).unwrap();
    let detail = read_json(&app_data.join("books").join("local-1").join("bookdetail.json"));
    assert_eq!(
        detail["title"],
        json!("三体（对端改名）"),
        "重新导入同一个文件不该抹掉同步来的改名"
    );
}

#[test]
fn deleted_book_on_the_peer_removes_the_local_copy() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();

    seed_local_book(&app_data, "local-1", "三体");
    seed_local_progress(&app_data, "local-1", 3, 300);
    let local = local_engine(&handle, &app_data);
    let mut index = BookIndex::default();
    bridge::reconcile(&handle, &local, &mut index).unwrap();

    // 先同步一次，让对端也有这本书
    let peer = peer_engine("deleted-peer", Some(&lock_engine(&local).pairing_code()));
    sync_once(&local, &peer);
    let uid = lock_engine(&local).entities_of_kind("book", false)[0].id.clone();

    // 对端删掉它，再同步回来
    {
        let mut guard = lock_engine(&peer);
        guard.delete_entity(&uid, Some("对端删除".to_string())).unwrap();
        guard.flush().unwrap();
    }
    sync_once(&local, &peer);
    let changes = bridge::materialize(&handle, &local, 0, &mut index).unwrap();
    assert!(
        !app_data.join("books").join("local-1").exists(),
        "对端删了书，本机这份也按同步结果删掉"
    );
    assert_eq!(changes.deleted_books, vec!["local-1".to_string()]);
    {
        let guard = lock_engine(&local);
        let entity = guard.entity(&uid).expect("删除只写墓碑，实体记录仍在");
        assert!(guard.is_effectively_deleted(entity), "对端的删除应同步到本机引擎");
    }
}

#[test]
fn concurrent_title_edit_is_reported_for_review_without_losing_either_side() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();

    seed_local_book(&app_data, "local-1", "三体");
    let local = local_engine(&handle, &app_data);
    let mut index = BookIndex::default();
    bridge::reconcile(&handle, &local, &mut index).unwrap();
    let peer = peer_engine("conflict-peer", Some(&lock_engine(&local).pairing_code()));
    sync_once(&local, &peer);

    // 两台设备各改书名，两边都没看到对方
    let uid = lock_engine(&local).entities_of_kind("book", false)[0].id.clone();
    lock_engine(&peer).set_field(&uid, "title", json!("三体（对端）")).unwrap();
    let detail_path = app_data.join("books").join("local-1").join("bookdetail.json");
    let mut detail = read_json(&detail_path);
    detail["title"] = json!("三体（本机）");
    write_json(&detail_path, &detail);
    bridge::publish_book(&handle, &local, "local-1", PublishMode::Edited).unwrap();

    sync_once(&local, &peer);

    // 冲突留档：两边都能在队列里看到另一方的取值
    let conflicts = {
        let guard = lock_engine(&local);
        guard
            .conflicts(Some(readerx_sync::ConflictStatus::Pending))
            .into_iter()
            .filter(|c| c.field == "title")
            .cloned()
            .collect::<Vec<_>>()
    };
    assert_eq!(conflicts.len(), 1, "同名书的两台设备各改书名应留档待裁决");
    let values: Vec<Value> = [conflicts[0].local.value.clone(), conflicts[0].remote.value.clone()]
        .into_iter()
        .flatten()
        .collect();
    assert!(values.contains(&json!("三体（对端）")), "{values:?}");
    assert!(values.contains(&json!("三体（本机）")), "{values:?}");
}

#[test]
fn local_edit_is_published_without_duplicating_operations() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();

    seed_local_book(&app_data, "local-1", "三体");
    let local = local_engine(&handle, &app_data);
    let mut index = BookIndex::default();
    bridge::reconcile(&handle, &local, &mut index).unwrap();
    let after_reconcile = lock_engine(&local).op_count();

    // 值没变：重新对账不该产生任何操作（否则每启动一次就灌一屏无意义的日志）
    bridge::reconcile(&handle, &local, &mut index).unwrap();
    assert_eq!(
        lock_engine(&local).op_count(),
        after_reconcile,
        "本地与引擎一致时对账必须一条操作都不写"
    );

    // 本地加了标签：只产生集合增删的操作，不重写整个集合
    let detail_path = app_data.join("books").join("local-1").join("bookdetail.json");
    let mut detail = read_json(&detail_path);
    detail["tags"] = json!(["科幻", "重读"]);
    write_json(&detail_path, &detail);
    bridge::publish_book(&handle, &local, "local-1", PublishMode::Edited).unwrap();

    let guard = lock_engine(&local);
    let uid = guard.entities_of_kind("book", false)[0].id.clone();
    assert_eq!(
        sorted_strings(&guard.field(&uid, "tags").unwrap()),
        vec!["科幻".to_string(), "重读".to_string()]
    );
    assert_eq!(
        guard.op_count(),
        after_reconcile + 1,
        "只加了「重读」这一个元素，应只写一条操作"
    );
}

/// App 侧的网络接线：**服务端握手时要把「连我用的端口」记成对方声明的监听端口**。
///
/// 等后台的「开启同步后的首轮同步」跑完（见 `SyncService::wait_startup_sync`）。
///
/// 不等它落定就手动同步，会和首轮撞成「正在同步中」；而首轮的会话又握着引擎锁，
/// 让被测服务的握手应答慢到超时 —— 用例应该与线程调度时机无关。
fn wait_until_idle(service: &SyncService<tauri::test::MockRuntime>) {
    assert!(
        service.wait_startup_sync(std::time::Duration::from_secs(30)),
        "开启同步后的首轮同步迟迟没有结束"
    );
}

/// 回归：曾经把 TCP 连接的源端口当成对端地址记下来，那个端口一断就回收，
/// 下次主动连它必然「连接被拒绝」（用户日志里的 `192.168.0.101:40010` 就是它）。
#[test]
fn app_advertises_its_listen_port_to_the_peer() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, data_root) = setup();

    // 对端设备：一个直接开的引擎 + 监听（随机端口）
    let peer = {
        let dir = std::env::temp_dir().join(format!("readerx-sync-e2e-listen-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut options = EngineOptions::new("对端");
        options.schemas = SchemaRegistry::readerx_defaults();
        shared(SyncEngine::open(dir, options).unwrap())
    };

    // App 侧的服务：开启同步（会真的监听 47821；被占用则跳过，不误报失败）
    let service = SyncService::new(handle.clone());
    let status = service.set_enabled(true).expect("开启同步应成功");
    let Some(listen) = status.listen_addr.clone() else {
        eprintln!("跳过：本机 {} 端口被占用", readerx_sync::DEFAULT_PORT);
        let _ = service.set_enabled(false);
        return;
    };
    let listen_port: u16 = listen
        .rsplit(':')
        .next()
        .and_then(|port| port.parse().ok())
        .expect("监听地址应带端口");

    // 对端加入同一群组并开始监听
    lock_engine(&peer).join_group(&service.pairing_code().unwrap()).unwrap();
    let options = {
        let guard = lock_engine(&peer);
        ServerOptions::from_engine(&guard)
            .unwrap()
            .with_bind(std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
    };
    let server = PeerServer::start(peer.clone(), options).unwrap();
    let peer_addr = server.local_addr().to_string();

    // 让 App 侧主动连过去（这就是「点某台设备同步」走的那条路）
    wait_until_idle(&service);
    service
        .sync_with_addr_now(&peer_addr)
        .expect("与对端同步应成功");

    // 对端记下的 App 地址 = 来源 IP + App 声明的监听端口
    let app_device = service.status().device_id;
    let guard = lock_engine(&peer);
    let recorded = guard
        .peers()
        .get(&app_device)
        .expect("对端应记下 App 这台设备")
        .addr
        .clone()
        .expect("App 在监听，对端就该记下可回连的地址");
    assert!(
        recorded.ends_with(&format!(":{listen_port}")),
        "对端应记下 App 的监听端口 {listen_port}，实际 {recorded}"
    );

    drop(server);
    drop(guard);
    service.shutdown();
    let _ = data_root;
}

/// App 侧「删除设备」的真实路径：移除之后，那台设备**连进来会被拒**，
/// 而 App 自己的设备列表里也不再显示它。
#[test]
fn removed_peer_cannot_sync_into_the_app_anymore() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, data_root) = setup();

    // 对端设备：直接开的引擎
    let peer = {
        let dir = std::env::temp_dir().join(format!("readerx-sync-e2e-remove-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut options = EngineOptions::new("旧手机");
        options.schemas = SchemaRegistry::readerx_defaults();
        shared(SyncEngine::open(dir, options).unwrap())
    };

    // App 侧的服务：开启同步（端口被占用就跳过，不误报失败）
    let service = SyncService::new(handle.clone());
    let status = service.set_enabled(true).expect("开启同步应成功");
    let Some(listen) = status.listen_addr.clone() else {
        eprintln!("跳过：本机 {} 端口被占用", readerx_sync::DEFAULT_PORT);
        let _ = service.set_enabled(false);
        return;
    };
    let listen_port: u16 = listen
        .rsplit(':')
        .next()
        .and_then(|port| port.parse().ok())
        .expect("监听地址应带端口");

    // 对端加入同一群组并开始监听，然后由 App 主动连它一次（互相认识）
    lock_engine(&peer).join_group(&service.pairing_code().unwrap()).unwrap();
    let options = {
        let guard = lock_engine(&peer);
        ServerOptions::from_engine(&guard)
            .unwrap()
            .with_bind(std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
    };
    let server = PeerServer::start(peer.clone(), options).unwrap();
    let peer_addr = server.local_addr().to_string();

    wait_until_idle(&service);
    service
        .sync_with_addr_now(&peer_addr)
        .expect("与对端同步应成功");
    let peer_device = lock_engine(&peer).device_id().to_string();
    assert!(
        service.peers().iter().any(|p| p.device_id == peer_device),
        "同步一次后设备列表里应有对端"
    );

    // App 侧删除它
    let remaining = service.remove_peer(&peer_device).expect("移除设备应成功");
    assert!(
        !remaining.iter().any(|p| p.device_id == peer_device),
        "移除后设备列表里不该再有它"
    );

    // 对端主动连过来（App 的监听地址 + 回环）：握手就被拒
    let app_loopback = format!("127.0.0.1:{listen_port}");
    let error = {
        let mut guard = lock_engine(&peer);
        readerx_sync::sync_with_addr(&mut guard, &app_loopback, std::time::Duration::from_secs(5))
            .expect_err("被移除的设备不该还能连进来")
    };
    // 按**稳定错误码**断言，而不是某句提示文案：文案会随界面措辞调整（客户端按码
    // 出「本机已被对端从同步设备里移除」），码才是线协议的一部分
    assert!(
        error.code() == "removed_by_peer" && error.to_string().contains("移除"),
        "错误应说明是被移除（实际：{error}）"
    );
    assert!(
        !service.peers().iter().any(|p| p.device_id == peer_device),
        "被拒绝的连接不能把设备记回列表"
    );

    drop(server);
    service.shutdown();
    let _ = data_root;
}

/// 书籍结构（章节目录）：本机目录发布成一份结构实体；对端改了目录后落回本地时
/// **按 cid 复用原有正文**（改标题 / 加章不该把已经下载的正文弄丢）。
#[test]
fn book_structure_lands_and_keeps_chapter_bodies() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();

    seed_local_book(&app_data, "local-1", "三体");
    let local = local_engine(&handle, &app_data);
    let mut index = BookIndex::default();
    bridge::reconcile(&handle, &local, &mut index).unwrap();

    let uid = {
        let guard = lock_engine(&local);
        let structures = guard.entities_of_kind("book_structure", false);
        assert_eq!(structures.len(), 1, "一本书一份结构实体");
        let chapters = structures[0].field("chapters").expect("结构里应有目录");
        assert_eq!(chapters[0]["cid"], json!("c0001"));
        assert_eq!(chapters[0]["title"], json!("第一章"));
        guard.entities_of_kind("book", false)[0].id.clone()
    };
    assert_eq!(
        identity::book_structure_uid(&uid),
        lock_engine(&local).entities_of_kind("book_structure", false)[0].id,
        "结构实体 id 跟书身份绑定"
    );

    // 对端拿到目录后改了它：第一章改名 + 换地址，另加一章（还没有正文）
    let peer = peer_engine("structure-peer", Some(&lock_engine(&local).pairing_code()));
    sync_once(&local, &peer);
    let structure_id = lock_engine(&peer).entities_of_kind("book_structure", false)[0]
        .id
        .clone();
    {
        let mut guard = lock_engine(&peer);
        guard
            .set_field(
                &structure_id,
                "chapters",
                json!([
                    { "cid": "c0001", "title": "第一章（对端改名）", "url": "https://example.com/c1" },
                    { "cid": "c0002", "title": "新增章" },
                ]),
            )
            .unwrap();
        guard.flush().unwrap();
    }

    sync_once(&peer, &local);
    let changes = bridge::materialize(&handle, &local, 0, &mut index).unwrap();
    assert_eq!(changes.chapters, vec!["local-1".to_string()], "{changes:?}");
    assert!(changes.books, "目录变了，书架元信息（章节头）也要刷新");

    let content = read_json(&app_data.join("books").join("local-1").join("content.json"));
    let chapters = content["chapters"].as_array().unwrap();
    assert_eq!(chapters.len(), 2, "目录以同步结果为准：{content}");
    assert_eq!(chapters[0]["cid"], json!("c0001"));
    assert_eq!(chapters[0]["title"], json!("第一章（对端改名）"));
    assert_eq!(chapters[0]["url"], json!("https://example.com/c1"));
    assert_eq!(chapters[0]["paragraphs"][0], json!("正文"), "已有正文按 cid 留用");
    assert_eq!(chapters[1]["cid"], json!("c0002"));
    assert!(
        chapters[1]["paragraphs"].as_array().unwrap().is_empty(),
        "新加的章节暂时没有正文（等正文通道搬过来）"
    );
}

/// 文本替换规则与分章规则：本机发布 → 对端拿到；对端增删 → 本机落回状态文件。
///
/// 两条容易踩的坑都在这里挡住：
/// - 按书生效的替换规则必须按**书实体 id** 走（本机书 id 每台设备都不一样），
///   落回本地时再翻回本机的书 id；
/// - 对端为「本机还没有的书」建的规则不能被本机的一次发布当成「用户删掉了」抹掉。
#[test]
fn rules_sync_in_both_directions() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();

    seed_local_book(&app_data, "local-1", "三体");
    write_json(
        &app_data.join("state").join("readerx.textReplacements.json"),
        &json!([
            { "id": "rep-a", "scope": "global", "bookId": "", "find": "的", "replace": "之", "regex": false, "createdAt": 100 },
            { "id": "rep-b", "scope": "book", "bookId": "local-1", "find": "他", "replace": "她", "regex": false, "createdAt": 200 },
        ]),
    );
    write_json(
        &app_data.join("state").join("readerx.chapterRules.json"),
        &json!([
            { "id": "user-a", "name": "卷首", "pattern": "^卷", "builtin": false, "createdAt": 100 },
        ]),
    );

    // ---- 本机引擎 + 对账：规则发布成实体 ----
    let local = local_engine(&handle, &app_data);
    let mut index = BookIndex::default();
    bridge::reconcile(&handle, &local, &mut index).unwrap();

    let global_uid = {
        let guard = lock_engine(&local);
        let rules = guard.entities_of_kind("text_replace", false);
        assert_eq!(rules.len(), 2, "两条替换规则都应发布");
        let book_rule = rules
            .iter()
            .find(|entity| entity.field("scope") == Some(json!("book")))
            .expect("按书生效的那条应在");
        let book_uid = book_rule.field("book_id").unwrap().as_str().unwrap().to_string();
        assert!(book_uid.starts_with("b-"), "按书规则指向书实体 id，实际 {book_uid}");
        assert_eq!(guard.entities_of_kind("chapter_rule", false).len(), 1);
        let global = rules
            .iter()
            .find(|entity| entity.field("scope") == Some(json!("global")))
            .expect("全局规则应在");
        global.id.clone()
    };

    // ---- 对端同步一轮：拿到规则，然后删掉全局替换、补一条分章规则 ----
    let peer = peer_engine("rules-peer", Some(&lock_engine(&local).pairing_code()));
    sync_once(&local, &peer);
    {
        let guard = lock_engine(&peer);
        assert_eq!(guard.entities_of_kind("text_replace", false).len(), 2);
        assert_eq!(guard.entities_of_kind("chapter_rule", false).len(), 1);
    }
    let peer_uid = identity::text_replace_uid("book", "b-unknown", "甲", "乙", false);
    {
        let mut guard = lock_engine(&peer);
        guard.delete_entity(&global_uid, Some("对端删除".to_string())).unwrap();
        guard
            .create_entity(
                "chapter_rule",
                Some(identity::chapter_rule_uid("英文卷", "^Volume")),
                [
                    ("name", json!("英文卷")),
                    ("pattern", json!("^Volume")),
                    ("created_at", json!(300)),
                ],
            )
            .unwrap();
        // 对端为「本机还没导入的书」建一条规则：本机不该因为看不到它就把它删掉
        guard
            .create_entity(
                "text_replace",
                Some(peer_uid.clone()),
                [
                    ("scope", json!("book")),
                    ("book_id", json!("b-unknown")),
                    ("find", json!("甲")),
                    ("replace", json!("乙")),
                    ("regex", json!(false)),
                    ("created_at", json!(300)),
                ],
            )
            .unwrap();
        guard.flush().unwrap();
    }

    // ---- 反向同步 + 落地 ----
    sync_once(&peer, &local);
    let changes = bridge::materialize(&handle, &local, 0, &mut index).unwrap();
    assert!(changes.text_replaces, "替换规则应被落地：{changes:?}");
    assert!(changes.chapter_rules, "分章规则应被落地：{changes:?}");

    let replaces = read_json(&app_data.join("state").join("readerx.textReplacements.json"));
    let items = replaces.as_array().unwrap();
    assert_eq!(items.len(), 1, "全局那条被对端删了，只剩按书的一条：{replaces}");
    assert_eq!(items[0]["bookId"], json!("local-1"), "书实体 id 要翻回本机书 id");
    assert_eq!(items[0]["find"], json!("他"));
    assert!(items[0]["id"].as_str().unwrap().starts_with("tr-"));

    let chapter_rules = read_json(&app_data.join("state").join("readerx.chapterRules.json"));
    let names: Vec<String> = chapter_rules
        .as_array()
        .unwrap()
        .iter()
        .map(|rule| rule["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, vec!["卷首".to_string(), "英文卷".to_string()]);
    assert_eq!(chapter_rules[0]["builtin"], json!(false));

    // 落地后再对账一次（等价于「下次启动」：先落地，再把本地清单发布回去）。
    // 本地清单里没有那条「未知书的规则」，它必须活着 —— 否则一次发布就抹掉了对端的规则。
    bridge::reconcile(&handle, &local, &mut index).unwrap();
    assert!(
        lock_engine(&local)
            .entity(&peer_uid)
            .is_some_and(|entity| !entity.is_deleted()),
        "指向本机没有的书的规则不该被本地发布删掉"
    );
    let after = read_json(&app_data.join("state").join("readerx.textReplacements.json"));
    assert_eq!(after.as_array().unwrap().len(), 1, "对账不该改动本地清单：{after}");
}

/// 正文同步的落地方向：对端有这本书（元信息 + 目录 + 正文），本机什么都没有 ——
/// 同步之后本机应该**多出一本可读的书**（而不是只有一条元信息）。
#[test]
fn synced_content_creates_the_book_locally() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();

    let local = local_engine(&handle, &app_data);
    let mut index = BookIndex::default();

    // 书实体 id 必须是对端按内容特征算出来的那个（这里是导入书：文件名 + 字节数）
    let uid = readerx_lib::sync::identity::book_uid(&readerx_lib::sync::identity::BookKey {
        file_name: "三体.epub",
        size: 2048,
        ..Default::default()
    });
    let content = Arc::new(PeerContent::default());
    content.put(&uid, "c0001", "第一章", "正文一");
    content.put(&uid, "c0002", "第二章", "正文二");
    let peer = peer_engine_with_content(
        "content-peer",
        Some(&lock_engine(&local).pairing_code()),
        Some(content),
    );
    {
        let mut guard = lock_engine(&peer);
        guard
            .create_entity(
                "book",
                Some(uid.clone()),
                [
                    ("title", json!("三体")),
                    ("author", json!("刘慈欣")),
                    ("format", json!("epub")),
                    ("file_name", json!("三体.epub")),
                    ("size", json!(2048)),
                    ("split_desc", json!("按章")),
                ],
            )
            .unwrap();
        guard
            .create_entity(
                "book_structure",
                Some(identity::book_structure_uid(&uid)),
                [
                    ("book_id", json!(uid)),
                    (
                        "chapters",
                        json!([
                            { "cid": "c0001", "title": "第一章" },
                            { "cid": "c0002", "title": "第二章" },
                            { "cid": "c0003", "title": "第三章（对端还没下正文）" },
                        ]),
                    ),
                ],
            )
            .unwrap();
        guard.flush().unwrap();
    }

    // 同步一轮：操作先到，正文随后进暂存区
    sync_once(&peer, &local);
    assert_eq!(
        lock_engine(&local).staged_bodies(&uid).len(),
        2,
        "对端的正文应先落在暂存区"
    );

    // 落地：本机按引擎里的元信息建书，并把正文写进 content.json
    let changes = bridge::materialize(&handle, &local, 0, &mut index).unwrap();
    assert!(changes.books, "新书落地要刷新书架：{changes:?}");
    assert_eq!(changes.chapters.len(), 1, "{changes:?}");

    let book_ids: Vec<String> = std::fs::read_dir(app_data.join("books"))
        .unwrap()
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(book_ids.len(), 1, "应该正好新建一本：{book_ids:?}");
    let book_id = &book_ids[0];

    let detail = read_json(&app_data.join("books").join(book_id).join("bookdetail.json"));
    assert_eq!(detail["title"], json!("三体"));
    assert_eq!(detail["fileName"], json!("三体.epub"));
    assert_eq!(detail["size"], json!(2048));
    assert_eq!(detail["importedAt"].as_u64().unwrap() > 0, true, "导入时间由本机生成");

    let content_file = read_json(&app_data.join("books").join(book_id).join("content.json"));
    let chapters = content_file["chapters"].as_array().unwrap();
    assert_eq!(chapters.len(), 3, "目录三章都在（没下正文的章是空的）：{content_file}");
    assert_eq!(chapters[0]["cid"], json!("c0001"));
    assert_eq!(chapters[0]["paragraphs"][0], json!("正文一"));
    assert_eq!(chapters[1]["paragraphs"][0], json!("正文二"));
    assert!(chapters[2]["paragraphs"].as_array().unwrap().is_empty());

    assert!(
        app_data.join("books").join(book_id).join("digest.json").is_file(),
        "正文落地要顺手写下章节指纹缓存"
    );
    assert!(
        lock_engine(&local).staged_bodies(&uid).is_empty(),
        "落地完成后暂存区要清干净"
    );

    // 身份一致：本机算出来的书实体 id 必须还是对端那个，否则进度 / 书签 / 目录都对不上
    assert_eq!(bridge::local_uid(&handle, book_id), uid);

    // 再落地一次不该重复建书
    let again = bridge::materialize(&handle, &local, usize::MAX, &mut index).unwrap();
    assert!(again.chapters.is_empty() && !again.books, "重复落地应无事发生：{again:?}");
    let still: Vec<String> = std::fs::read_dir(app_data.join("books"))
        .unwrap()
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(still, book_ids);
}

/// 反向：本机书库里的正文能发给对端（App 的正文来源接在书库上）。
#[test]
fn local_book_content_is_published_to_the_peer() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();

    seed_local_book(&app_data, "local-1", "三体");
    let local = local_engine(&handle, &app_data);
    let mut index = BookIndex::default();
    bridge::reconcile(&handle, &local, &mut index).unwrap();

    let content = Arc::new(PeerContent::default());
    let peer = peer_engine_with_content(
        "outgoing-peer",
        Some(&lock_engine(&local).pairing_code()),
        Some(content),
    );

    let report = sync_once(&local, &peer);
    assert!(report.content_pushed > 0, "本机的正文应推给对端：{report:?}");

    let uid = {
        let guard = lock_engine(&local);
        guard.entities_of_kind("book", false)[0].id.clone()
    };
    let staged = lock_engine(&peer).staged_bodies(&uid);
    assert_eq!(staged.len(), 1, "对端应收到本机那一章");
    assert_eq!(staged[0].paragraphs, vec!["正文".to_string()]);
    assert_eq!(staged[0].title, "第一章");
}

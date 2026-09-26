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
use readerx_lib::sync::SyncService;
use readerx_sync::net::{
    lock_engine, shared, LoopbackTransport, PeerServer, ServerOptions, SharedEngine,
};
use readerx_sync::{EngineOptions, SchemaRegistry, SyncEngine};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
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
fn local_engine(data_root: &Path) -> SharedEngine {
    let mut options = EngineOptions::new("本机");
    options.schemas = SchemaRegistry::readerx_defaults();
    shared(SyncEngine::open(data_root.join("sync"), options).unwrap())
}

/// 另一台设备的引擎（数据目录在临时区，直接开）。
fn peer_engine(tag: &str, pairing_code: Option<&str>) -> SharedEngine {
    let dir =
        std::env::temp_dir().join(format!("readerx-sync-e2e-peer-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let mut options = EngineOptions::new(tag);
    options.schemas = SchemaRegistry::readerx_defaults();
    let mut engine = SyncEngine::open(dir, options).unwrap();
    if let Some(code) = pairing_code {
        engine.join_group(code).unwrap();
    }
    shared(engine)
}

fn sync_once(client: &SharedEngine, server: &SharedEngine) {
    let mut transport = LoopbackTransport::new(server.clone());
    let mut guard = lock_engine(client);
    readerx_sync::sync_with(&mut guard, &mut transport).expect("同步应成功");
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
    let local = local_engine(&app_data);
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
    let local = local_engine(&app_data);
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
    let local = local_engine(&app_data);
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
    let local = local_engine(&app_data);
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
    let local = local_engine(&app_data);
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
    assert!(
        error.to_string().contains("已被对端移除"),
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

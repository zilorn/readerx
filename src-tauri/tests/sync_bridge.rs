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
/// 测试进程里「第二台设备」的目录前缀（见 [`RealPeer::start`]）。
const PEER_DIR_PREFIX: &str = "peer-";
/// mock 应用与它的数据目录（整个测试进程共用一份）。
static SHARED: OnceLock<(tauri::AppHandle<tauri::test::MockRuntime>, PathBuf)> = OnceLock::new();

/// 取共享的 mock 应用，**并清掉上一个用例留下的数据**（每个用例开头调它）。
fn setup() -> (tauri::AppHandle<tauri::test::MockRuntime>, PathBuf) {
    let (handle, data_root) = shared_app();
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

/// 本机的数据根（**只取不清**）：[`RealPeer::start`] 要用它算出对端目录。
///
/// 不能顺手调 [`setup`] —— 那会把调用方刚种好的书库一起删掉。
fn local_root() -> PathBuf {
    shared_app().1
}

/// 共享的 mock 应用与本机数据根（进程内只初始化一次）。
fn shared_app() -> (tauri::AppHandle<tauri::test::MockRuntime>, PathBuf) {
    let (handle, data_root) = SHARED
        .get_or_init(|| {
            let root =
                std::env::temp_dir().join(format!("readerx-sync-e2e-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            // Tauri 的 app_data_dir = $XDG_DATA_HOME/<identifier>。只在这里设一次，
            // 之后**不再改**它：`std::env::set_var` 与别的线程并发读环境变量是未定义
            // 行为（libtest 默认多线程跑用例），表现就是偶发卡死。要模拟第二台设备时
            // 用 `readerx_lib::pin_data_root` 钉数据根，别动环境变量。
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
    seed_book(&data_root.join("books").join(id), id, title, "三体.epub", true);
}

/// 另一台「设备」上的本地书：目录名与书 id 分开（本机书 id 每台设备各自生成），
/// **文件名仍与 `fileName` 一致** —— 书身份由 `fileName + size` 派生，两边因此算出
/// 同一个书实体 id，资源通道才认得是同一本书。
fn seed_peer_book(data_root: &Path, dir: &str, id: &str, title: &str, with_cover: bool) {
    seed_book(&data_root.join("books").join(dir), id, title, "三体.epub", with_cover);
}

/// 写一本本地书的三个文件；`with_cover` 控制有没有封面。
fn seed_book(dir: &Path, id: &str, title: &str, file_name: &str, with_cover: bool) {
    std::fs::create_dir_all(dir).unwrap();
    let mut detail = json!({
        "schemaVersion": 1,
        "id": id,
        "title": title,
        "author": "刘慈欣",
        "intro": "简介",
        "format": "epub",
        "fileName": file_name,
        "size": 1024,
        "importedAt": 1_700_000_000u64,
        "hue": 7,
        "splitDesc": "按章",
        "groupId": null,
        "tags": ["科幻"],
    });
    if with_cover {
        detail["cover"] = json!("data:image/png;base64,AAAA");
    }
    write_json(&dir.join("bookdetail.json"), &detail);
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

/// 本机这本书没有封面（验证封面从对端落地）。
fn seed_local_book_without_cover(data_root: &Path, id: &str, title: &str) {
    seed_book(&data_root.join("books").join(id), id, title, "三体.epub", false);
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
///
/// 资源（封面 / 插图）不在这里 —— 引擎要求「按名字取字节」与「报给对端的指纹」出自
/// 同一个来源，内存与真实书库混用会让对账与取字节对不上，因此资源一律走 [`RealPeer`]。
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

/// 另一台**设备**：独立的应用数据目录 + 独立的 mock AppHandle + 独立引擎。
///
/// 与 [`peer_engine`]（内存版来源）的区别是它有一份真实书库：资源通道的两端都要能
/// 「按名字读出字节」，因此验证资源落地时必须让对端也是一个真的 App 数据目录。
struct RealPeer {
    app: tauri::AppHandle<tauri::test::MockRuntime>,
    data_root: PathBuf,
    engine: SharedEngine,
}

impl RealPeer {
    /// 起一台「对端设备」。
    ///
    /// **不建第二个 App**：Tauri 的 App 构建带进程级状态，同一个进程里建两次会卡住
    /// （表现是所有用例都堵在串行锁上）。这里沿用同一个 App，把书库读写指向另一份数据根
    /// —— 根固定在**来源实例**上（`AppContent::at`），引擎读到哪一份不取决于调用时机。
    fn start(tag: &str, pairing_code: Option<&str>) -> RealPeer {
        let (handle, local) = (shared_app().0, local_root());
        // `app_data_dir()` 带尾斜杠，先归一再去父目录：否则 `parent()` 会把最后那段
        // 空名字剥掉，跑到 `/tmp` 下面去建对端目录（两台设备就此算岔）
        let base = local
            .to_string_lossy()
            .trim_end_matches(std::path::MAIN_SEPARATOR)
            .to_string();
        let data_root = Path::new(&base)
            .parent()
            .expect("数据根应有父目录")
            .join(format!("{PEER_DIR_PREFIX}{tag}"));
        assert_ne!(data_root, local, "对端目录不能等于本机数据根");
        let _ = std::fs::remove_dir_all(&data_root);
        std::fs::create_dir_all(&data_root).unwrap();

        let options = EngineOptions::new(tag)
            .with_schemas(SchemaRegistry::readerx_defaults())
            .with_content(tcontent::AppContent::at(handle.clone(), &data_root));
        let mut engine = SyncEngine::open(data_root.join("sync"), options).unwrap();
        if let Some(code) = pairing_code {
            engine.join_group(code).unwrap();
        }
        RealPeer { app: handle, data_root, engine: shared(engine) }
    }

    /// 这台设备自己算出来的书实体 id（书身份 = `fileName + size`，两边算出同一个）。
    ///
    /// **必须用它建实体**：`bridge::reconcile` 在本机算出的 uid 未必与对端那本对应
    /// （两台设备上「同名同大小的书」本来就共用身份），拿错了就会去读另一本书。
    fn book_uid(&self, local_id: &str) -> String {
        bridge::local_uid(&self.app, local_id)
    }

    /// 把本机的书实体发布状态抄到对端（书元信息不经过网络也能对齐身份）。
    fn publish_book(&self, uid: &str) {
        let mut guard = lock_engine(&self.engine);
        guard
            .create_entity(
                "book",
                Some(uid.to_string()),
                [
                    ("title", json!("三体")),
                    ("format", json!("epub")),
                    ("file_name", json!("三体.epub")),
                    ("size", json!(1024)),
                ],
            )
            .unwrap();
        guard.flush().unwrap();
    }
}

fn sync_once(client: &SharedEngine, server: &SharedEngine) -> readerx_sync::SyncReport {
    let mut transport = LoopbackTransport::new(server.clone());
    let mut guard = lock_engine(client);
    readerx_sync::sync_with(&mut guard, &mut transport).expect("同步应成功")
}

/// 目录下的文件名（不存在时为空）。
fn list_files(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|items| {
            items
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// sha1 十六进制（旧图片文件名里的哈希部分：`<本机书 id>_<sha1(地址)>.<ext>`）。
fn sha1_hex(text: &str) -> String {
    use sha2::Digest;
    let mut hasher = sha1::Sha1::new();
    hasher.update(text.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
    eprintln!("PHASE 2 前：落地");
    let changes = bridge::materialize(&handle, &local, 0, &mut index).unwrap();
    eprintln!("PHASE 2 后：落地完成");
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
    sync_once(&local, &peer);
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

/// 新设备主动拉取导入书，包括没有文字层、只有页面图片的 PDF。
#[test]
fn empty_device_pulls_readable_books_including_scanned_pdf() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for (format, scanned) in [("txt", false), ("epub", false), ("mobi", false), ("pdf", false), ("pdf", true)] {
        let (handle, app_data) = setup();
        let initial = local_engine(&handle, &app_data);
        lock_engine(&initial).flush().unwrap();
        drop(initial);
        let device_path = app_data.join("sync/device.json");
        let mut device = read_json(&device_path);
        device["device_id"] = json!("zz-empty-device");
        write_json(&device_path, &device);
        let local = local_engine(&handle, &app_data);
        let peer = RealPeer::start(&format!("import-{format}-{scanned}"), Some(&lock_engine(&local).pairing_code()));
        seed_peer_book(&peer.data_root, "peer-local", "peer-local", "三体", true);
        let detail_path = peer.data_root.join("books/peer-local/bookdetail.json");
        let mut detail = read_json(&detail_path);
        let file_name = format!("三体.{format}");
        detail["format"] = json!(format);
        detail["fileName"] = json!(file_name);
        write_json(&detail_path, &detail);
        let image = format!("{}.jpg", "a".repeat(40));
        let image_bytes = b"page-image-bytes";
        if scanned {
            write_json(&peer.data_root.join("books/peer-local/content.json"), &json!({
                "schemaVersion": 1, "chapters": [{ "cid": "c0001", "title": "扫描页",
                    "paragraphs": [], "blocks": [{ "kind": "img", "local": image }] }]
            }));
            std::fs::create_dir_all(peer.data_root.join("images")).unwrap();
            std::fs::write(peer.data_root.join("images").join(&image), image_bytes).unwrap();
        }
        let uid = identity::book_uid(&identity::BookKey { file_name: &file_name, size: 1024, ..Default::default() });
        {
            let mut guard = lock_engine(&peer.engine);
            guard.create_entity("book", Some(uid.clone()), [
                ("title", json!("三体")), ("format", json!(format)),
                ("file_name", json!(file_name)), ("size", json!(1024)),
            ]).unwrap();
        }
        // 刻意让空设备成为设备 id 较大的一侧，验证补图不再被全局赢家挡住。
        assert!(lock_engine(&local).device_id() > lock_engine(&peer.engine).device_id());
        let report = sync_once(&local, &peer.engine);
        assert_eq!(report.content_pulled, 1, "{format}/{scanned}: {report:?}");
        assert!(report.assets_pulled >= 1, "封面应同一轮拉取：{report:?}");
        let mut index = BookIndex::default();
        let changes = bridge::materialize(&handle, &local, 0, &mut index).unwrap();
        assert!(changes.books);
        let ids = list_files(&app_data.join("books"));
        assert_eq!(ids.len(), 1);
        let book_dir = app_data.join("books").join(&ids[0]);
        assert_eq!(read_json(&book_dir.join("bookdetail.json"))["format"], format);
        assert_eq!(bridge::local_uid(&handle, &ids[0]), uid);
        let body = read_json(&book_dir.join("content.json"));
        if scanned {
            assert_eq!(body["chapters"][0]["blocks"][0]["local"], image);
            assert_eq!(std::fs::read(app_data.join("images").join(&image)).unwrap(), image_bytes);
        } else {
            assert_eq!(body["chapters"][0]["paragraphs"][0], "正文");
        }
        assert!(lock_engine(&local).staged_bodies(&uid).is_empty());
        assert!(lock_engine(&local).staged_assets(&uid).is_empty());
        let again = sync_once(&local, &peer.engine);
        assert_eq!((again.content_pulled, again.content_pushed, again.assets_pulled, again.assets_pushed), (0, 0, 0, 0));
    }
}

/// 封面（资源通道）：本机有、对端没有 → 推过去，对端拿到的是**原文**（data URL）。
#[test]
fn cover_is_pushed_to_the_peer_that_has_none() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();
    seed_local_book(&app_data, "local-1", "三体");
    seed_local_progress(&app_data, "local-1", 0, 0);

    let local = local_engine(&handle, &app_data);
    let mut index = BookIndex::default();
    bridge::reconcile(&handle, &local, &mut index).unwrap();

    // 书身份（uid）取自本机引擎里那本真书：`local_uid` 走的是**本机**书库，
    // 拿它去算对端另一份目录里的书会退化成兜底值（两边对不上）
    let uid = {
        let guard = lock_engine(&local);
        guard.entities_of_kind("book", false)[0].id.clone()
    };

    // 对端（真实的第二台设备）：同一本书（同名同大小 = 同一个书身份）、没有封面
    let peer = RealPeer::start("cover-push", Some(&lock_engine(&local).pairing_code()));
    seed_peer_book(&peer.data_root, "peer-local", "peer-local", "三体", false);
    peer.publish_book(&uid);

    let mine = lock_engine(&local).asset_index_full(&uid);
    assert!(
        mine.iter().any(|asset| asset.name == readerx_sync::assets::COVER_ASSET && asset.present()),
        "本机的封面应出现在资源清单里：{mine:?}"
    );
    let report = sync_once(&local, &peer.engine);
    assert_eq!(report.assets_pushed, 1, "本机的封面应推给对端：{report:?}");
    assert_eq!(report.assets_pulled, 0, "对端没有封面可给：{report:?}");

    // 对端收到的是本机那份 data URL 的原文
    let staged = lock_engine(&peer.engine).staged_assets(&uid);
    let cover = staged
        .iter()
        .find(|asset| asset.name == readerx_sync::assets::COVER_ASSET)
        .expect("对端应收到封面");
    assert_eq!(cover.data_url.as_deref(), Some("data:image/png;base64,AAAA"));
    assert_eq!(cover.bytes, vec![0, 0, 0], "data:image/png;base64,AAAA 的三个字节");

    // 收敛：再同步一轮不该再搬
    let again = sync_once(&local, &peer.engine);
    assert_eq!((again.assets_pushed, again.assets_pulled), (0, 0), "{again:?}");
}

/// 封面落地：对端有、本机没有 → 写进 `bookdetail.json` 的 `cover` 并清掉暂存区。
#[test]
fn incoming_cover_lands_in_bookdetail_and_clears_staging() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();
    seed_local_book_without_cover(&app_data, "local-1", "三体");
    seed_local_progress(&app_data, "local-1", 0, 0);

    let local = local_engine(&handle, &app_data);
    let mut index = BookIndex::default();
    bridge::reconcile(&handle, &local, &mut index).unwrap();

    // 对端（真实的第二台设备）：同一本书、有封面
    let peer_cover = "data:image/jpeg;base64,cGVlci1jb3Zlcg==";
    let peer = RealPeer::start("cover-land", Some(&lock_engine(&local).pairing_code()));
    seed_peer_book(&peer.data_root, "peer-local", "peer-local", "三体", true);
    {
        let path = peer.data_root.join("books").join("peer-local").join("bookdetail.json");
        let mut detail = read_json(&path);
        detail["cover"] = json!(peer_cover);
        write_json(&path, &detail);
    }
    let uid = {
        let guard = lock_engine(&local);
        guard.entities_of_kind("book", false)[0].id.clone()
    };
    peer.publish_book(&uid);

    let report = sync_once(&local, &peer.engine);
    assert_eq!(report.assets_pulled, 1, "本机没有封面，应取回对端那份：{report:?}");
    assert_eq!(report.assets_pushed, 0, "对端有封面，不该被本机的「没有」覆盖：{report:?}");

    // 落地：cover 写进元信息，暂存区清空
    let changes = bridge::materialize(&handle, &local, 0, &mut index).unwrap();
    assert!(changes.books, "封面属于书籍元信息：{changes:?}");
    let detail = read_json(&app_data.join("books").join("local-1").join("bookdetail.json"));
    assert_eq!(detail["cover"], json!(peer_cover), "封面应按对端原文落地");
    assert!(
        lock_engine(&local)
            .staged_assets(&uid)
            .iter()
            .all(|asset| asset.name != readerx_sync::assets::COVER_ASSET),
        "落地成功才清暂存：封面应已被清掉"
    );

    // 再次同步：两边封面已经一致，不该再来回搬
    let again = sync_once(&local, &peer.engine);
    assert_eq!((again.assets_pushed, again.assets_pulled), (0, 0), "{again:?}");
}

/// 插图（资源通道 + 正文引用）：正文赢家那张图搬到另一侧，**引用名归一**
/// （两台设备对同一段正文算出同一个指纹），第二轮不再搬。
#[test]
fn illustration_follows_the_body_winner_and_normalizes_the_reference() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();

    let local_image = "https://img.example.com/local.png";
    let local_name = readerx_sync::content::image_asset_name(local_image);

    // 本机：一章正文引用本机那张图（`local` 故意写成旧名字：带本机书 id 前缀）
    seed_local_book(&app_data, "local-1", "三体");
    // 旧名字（同步引入前的落盘形态）：本机书 id 前缀 + 图片地址的 sha1
    let legacy_name = format!("local-1_{}.png", sha1_hex(local_image));
    write_json(
        &app_data.join("books").join("local-1").join("content.json"),
        &json!({ "schemaVersion": 1, "chapters": [{
            "cid": "c0001",
            "title": "第一章",
            "paragraphs": [],
            "blocks": [
                { "kind": "p", "text": "他指着那张图说道。" },
                { "kind": "img", "remote": local_image, "src": local_image, "local": legacy_name },
            ],
        }]}),
    );
    let images = app_data.join("images");
    std::fs::create_dir_all(&images).unwrap();
    std::fs::write(images.join(&legacy_name), b"local-image-bytes").unwrap();

    let local = local_engine(&handle, &app_data);
    let mut index = BookIndex::default();
    bridge::reconcile(&handle, &local, &mut index).unwrap();
    let uid = {
        let guard = lock_engine(&local);
        guard.entities_of_kind("book", false)[0].id.clone()
    };

    // 对端：同一本书，正文引用它自己那张图（地址不同 → 资源名不同）
    let peer_image = "https://img.example.com/peer.png";
    let peer_name = readerx_sync::content::image_asset_name(peer_image);
    assert_ne!(local_name, peer_name);
    let peer = RealPeer::start("illustration", Some(&lock_engine(&local).pairing_code()));
    seed_peer_book(&peer.data_root, "peer-local", "peer-local", "三体", false);
    write_json(
        &peer.data_root.join("books").join("peer-local").join("content.json"),
        &json!({ "schemaVersion": 1, "chapters": [{
            "cid": "c0001",
            "title": "第一章",
            "paragraphs": [],
            "blocks": [
                { "kind": "p", "text": "对端写的正文。" },
                { "kind": "img", "remote": peer_image, "src": peer_image, "local": peer_name },
            ],
        }]}),
    );
    let peer_images = peer.data_root.join("images");
    std::fs::create_dir_all(&peer_images).unwrap();
    std::fs::write(peer_images.join(&peer_name), b"peer-image-bytes").unwrap();
    peer.publish_book(&uid);

    // 谁赢由设备 id 决定（正文块整体按这个规则收敛），插图跟着赢家走
    let local_wins = {
        let local_id = lock_engine(&local).device_id().to_string();
        let peer_id = lock_engine(&peer.engine).device_id().to_string();
        local_id > peer_id
    };

    // 第一轮：正文先过去（插图跟正文不是同一轮 —— 资源清单只看**已落地**的内容，
    // 这样赢家不会去取败方那条即将被覆盖的旧引用）
    let first = sync_once(&local, &peer.engine);
    // 封面两边都有（seed 里一模一样），不算差集；有差集的只有插图
    if local_wins {
        assert!(first.assets_pushed > 0, "赢家应把正文引用的图推给败方：{first:?}");
        assert_eq!(first.assets_pulled, 0, "赢家不该取败方的图：{first:?}");
    } else {
        assert!(first.assets_pulled > 0, "败方应取回赢家那张图：{first:?}");
        // 败方唯一允许推的是**封面**（封面不跟正文赢家走）：多出来的只能是它
        assert!(
            first.assets_pushed <= 1,
            "败方除了封面不该推别的（尤其不该把正文不引用的图推给赢家）：{first:?}"
        );
    }
    // 败方那张图**没有**被搬走：正文赢家那边不能多出一个没人引用的图
    let loser_file = if local_wins { peer_name.clone() } else { local_name.clone() };
    let peer_files = list_files(&peer.data_root.join("images"));
    assert!(
        !peer_files.iter().any(|file| file == &loser_file),
        "赢家那边不该多出败方那张孤儿图：{peer_files:?}"
    );

    bridge::materialize(&handle, &local, 0, &mut index).unwrap();

    // 第二轮：引用与内容都已一致，不该再搬任何资源（插图不来回换）
    let second = sync_once(&local, &peer.engine);
    assert_eq!(
        (second.assets_pushed, second.assets_pulled),
        (0, 0),
        "收敛之后不该再来回搬：{second:?}"
    );
    let local_content = read_json(&app_data.join("books").join("local-1").join("content.json"));
    let local_ref = local_content["chapters"][0]["blocks"][1]["local"]
        .as_str()
        .unwrap_or_default()
        .to_string();

    let winner_name = if local_wins { &local_name } else { &peer_name };
    let local_images = app_data.join("images");
    if local_wins {
        // 本机是赢家：引用保持自己的名字（旧名字应已归一），败方那张不落到本机
        assert_eq!(local_ref, *winner_name, "赢家的引用应归一成设备无关的名字");
        assert!(local_images.join(&local_ref).is_file());
    } else {
        // 对端是赢家：本机应收到它那张图，引用换成它的名字
        assert_eq!(local_ref, *winner_name, "败方的引用应换成赢家那张图的名字");
        assert_eq!(
            std::fs::read(local_images.join(&local_ref)).unwrap(),
            b"peer-image-bytes",
            "赢家那张图的字节应落到本机图片目录"
        );
    }

}

/// 书源分组：分组清单与**书源归属**双向同步。
///
/// 两处容易踩的坑都在这里挡住：
/// - 归属不能塞进书源的整份 JSON（那份是多值字段：一边改分组、一边改 JS 会互相盖），
///   它按书源分组实体 id 记在独立的 `group` 字段上，落地时再翻回本机分组 id；
/// - 分组按**名字**对应：对端新建的分组要在本机补一个本机 id，对端删掉的分组要让
///   本机书源退回未分组（源文件里不能留指向已删分组的悬空 groupId）。
#[test]
fn source_groups_sync_in_both_directions() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();

    // 本机：一个书源分组「科幻」、一份归在里面的书源；另有一个**同名**的书架分组
    // （书架分组与书源分组是两个命名空间，同名也不能互相认领）
    write_json(
        &app_data.join("state").join("readerx.groups.json"),
        &json!([{ "id": "grp-1", "name": "科幻", "createdAt": 1 }]),
    );
    write_json(
        &app_data.join("state").join("readerx.sourceGroups.json"),
        &json!([{ "id": "sg-local", "name": "科幻", "createdAt": 1 }]),
    );
    write_json(
        &app_data.join("book_sources").join("src-1.json"),
        &json!({
            "schemaVersion": 1,
            "id": "src-1",
            "name": "示例源",
            "bookSourceUrl": "https://example.com",
            "enabled": true,
            "groupId": "sg-local",
            "js": "function searchBook(){}",
        }),
    );

    // ---- 本机引擎 + 对账：分组与归属一起发布 ----
    let local = local_engine(&handle, &app_data);
    let mut index = BookIndex::default();
    bridge::reconcile(&handle, &local, &mut index).unwrap();

    let source_uid = identity::source_uid("https://example.com");
    let scifi_uid = identity::source_group_uid("科幻");
    {
        let guard = lock_engine(&local);
        let groups = guard.entities_of_kind("source_group", false);
        assert_eq!(groups.len(), 1, "书源分组应被发布");
        assert_eq!(groups[0].id, scifi_uid, "分组实体 id 由分组名派生");
        assert_eq!(groups[0].field("name"), Some(json!("科幻")));
        assert_eq!(
            guard.entities_of_kind("group", false).len(),
            1,
            "同名书架分组该是另一个实体"
        );
        let source = guard.entity(&source_uid).expect("书源应被发布");
        assert_eq!(
            source.field("group"),
            Some(json!(scifi_uid.clone())),
            "归属按书源分组实体 id 走"
        );
        let payload = source.field("json").unwrap().to_string();
        assert!(!payload.contains("groupId"), "本机分组 id 不进同步载荷：{payload}");
    }

    // ---- 对端：拿到分组后新建一个「网文」，并把书源移进去 ----
    let peer = peer_engine("source-group-peer", Some(&lock_engine(&local).pairing_code()));
    sync_once(&local, &peer);
    let web_uid = identity::source_group_uid("网文");
    {
        let mut guard = lock_engine(&peer);
        assert_eq!(guard.entities_of_kind("source_group", false).len(), 1, "对端应拿到书源分组");
        assert_eq!(
            guard.entity(&source_uid).and_then(|entity| entity.field("group")),
            Some(json!(scifi_uid)),
            "对端应拿到书源的归属"
        );
        guard
            .create_entity(
                "source_group",
                Some(web_uid.clone()),
                [("name", json!("网文")), ("created_at", json!(2))],
            )
            .unwrap();
        guard.set_field(&source_uid, "group", json!(web_uid.clone())).unwrap();
        guard.flush().unwrap();
    }

    // ---- 反向同步 + 落地：本机补出新分组，书源改归到它下面 ----
    sync_once(&peer, &local);
    let changes = bridge::materialize(&handle, &local, 0, &mut index).unwrap();
    assert!(changes.source_groups, "书源分组应被落地：{changes:?}");
    assert!(changes.sources, "书源归属应被落地：{changes:?}");

    let groups = read_json(&app_data.join("state").join("readerx.sourceGroups.json"));
    let items = groups.as_array().unwrap();
    assert_eq!(items.len(), 2, "对端新建的分组应补进本机清单：{groups}");
    let web_local_id = items
        .iter()
        .find(|group| group["name"] == json!("网文"))
        .and_then(|group| group["id"].as_str())
        .expect("新分组应在清单里")
        .to_string();
    assert_eq!(items[0]["id"], json!("sg-local"), "原有分组沿用本机 id");
    let source = read_json(&app_data.join("book_sources").join("src-1.json"));
    assert_eq!(source["id"], json!("src-1"), "落地不改本机书源 id");
    assert_eq!(
        source["groupId"],
        json!(web_local_id),
        "书源应改归到新分组下（用本机分组 id）：{source}"
    );

    // ---- 对端删掉那个分组，并把书源移出分组 ----
    {
        let mut guard = lock_engine(&peer);
        guard.delete_entity(&web_uid, Some("对端删除分组".to_string())).unwrap();
        guard.unset_field(&source_uid, "group").unwrap();
        guard.flush().unwrap();
    }
    sync_once(&peer, &local);
    let changes = bridge::materialize(&handle, &local, 0, &mut index).unwrap();
    assert!(changes.source_groups, "删组也要落地：{changes:?}");
    assert!(changes.sources, "书源退回未分组也要落地：{changes:?}");

    let groups = read_json(&app_data.join("state").join("readerx.sourceGroups.json"));
    let names: Vec<String> = groups
        .as_array()
        .unwrap()
        .iter()
        .map(|group| group["name"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(names, vec!["科幻".to_string()], "被删的分组应从本机清单里消失：{groups}");
    let source = read_json(&app_data.join("book_sources").join("src-1.json"));
    assert!(
        source.get("groupId").is_none(),
        "书源应退回未分组，不留悬空引用：{source}"
    );

    // 再对账一次（等价于下次启动）：本地清单与引擎已经一致，不该产生多余操作
    let before = lock_engine(&local).op_count();
    bridge::reconcile(&handle, &local, &mut index).unwrap();
    assert_eq!(lock_engine(&local).op_count(), before, "对账不该写多余的操作");
}

/// 书源分组改名：分组名就是身份，改名后**归属不能丢**。
///
/// 改名等于「旧名字入墓碑 + 新名字建实体」，书源必须跟着重新发布一次（`group` 换成新
/// 名字派生出的实体 id）；否则对端按名字找不回分组，落地时会把它们退回未分组。
#[test]
fn renaming_a_source_group_keeps_source_membership() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();

    let state_key = |name: &str| json!([{ "id": "sg-local", "name": name, "createdAt": 1 }]);
    write_json(
        &app_data.join("state").join("readerx.sourceGroups.json"),
        &state_key("科幻"),
    );
    write_json(
        &app_data.join("book_sources").join("src-1.json"),
        &json!({
            "schemaVersion": 1,
            "id": "src-1",
            "name": "示例源",
            "bookSourceUrl": "https://example.com",
            "enabled": true,
            "groupId": "sg-local",
            "js": "function searchBook(){}",
        }),
    );

    let local = local_engine(&handle, &app_data);
    let mut index = BookIndex::default();
    bridge::reconcile(&handle, &local, &mut index).unwrap();

    let source_uid = identity::source_uid("https://example.com");
    let old_uid = identity::source_group_uid("科幻");
    let peer = peer_engine("rename-peer", Some(&lock_engine(&local).pairing_code()));
    sync_once(&local, &peer);
    assert_eq!(
        lock_engine(&peer).entity(&source_uid).and_then(|entity| entity.field("group")),
        Some(json!(old_uid.clone())),
        "对端先拿到旧名字派生的归属"
    );

    // ---- 本机改名（清单整份重写 → 钩子重新发布清单与组内书源）----
    let renamed = state_key("科幻小说");
    write_json(
        &app_data.join("state").join("readerx.sourceGroups.json"),
        &renamed,
    );
    bridge::publish_source_groups(&handle, &local, &renamed).unwrap();
    bridge::republish_grouped_sources(&handle, &local).unwrap();

    sync_once(&local, &peer);
    let new_uid = identity::source_group_uid("科幻小说");
    {
        let guard = lock_engine(&peer);
        assert!(
            guard.entity(&old_uid).is_some_and(|entity| entity.is_deleted()),
            "旧名字应进墓碑"
        );
        assert_eq!(
            guard.entity(&new_uid).and_then(|entity| entity.field("name")),
            Some(json!("科幻小说"))
        );
        assert_eq!(
            guard.entity(&source_uid).and_then(|entity| entity.field("group")),
            Some(json!(new_uid)),
            "书源的归属要跟着改名走"
        );
    }

    // ---- 再同步回来：本机文件里的归属仍是同一个本机分组 id ----
    sync_once(&peer, &local);
    bridge::materialize(&handle, &local, 0, &mut index).unwrap();
    let source = read_json(&app_data.join("book_sources").join("src-1.json"));
    assert_eq!(source["groupId"], json!("sg-local"), "改名不改本机归属：{source}");

    // 组内的书源重新发布后不该继续写重复操作（值没变就一条都不写）
    let before = lock_engine(&local).op_count();
    bridge::republish_grouped_sources(&handle, &local).unwrap();
    assert_eq!(lock_engine(&local).op_count(), before, "归属没变时重发布应无操作");
}

/// 内置隐藏分组不存于 readerx.groups，书籍归属仍要发布并在新设备落地。
#[test]
fn hidden_group_membership_survives_sync_and_can_be_cleared() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();
    let local = local_engine(&handle, &app_data);
    let peer = RealPeer::start("hidden-group", Some(&lock_engine(&local).pairing_code()));
    seed_local_book(&app_data, "local-1", "三体");
    let path = app_data.join("books/local-1/bookdetail.json");
    let mut detail = read_json(&path);
    detail["groupId"] = json!("__hidden__");
    write_json(&path, &detail);
    let mut index = BookIndex::default();
    bridge::reconcile(&handle, &local, &mut index).unwrap();
    let uid = bridge::local_uid(&handle, "local-1");
    assert_eq!(lock_engine(&local).entity(&uid).unwrap().field("group"), Some(json!("__hidden__")));
    sync_once(&local, &peer.engine);
    // 将远端暂存作为新设备数据拉回：本地书库清空，验证建书时也保留归属。
    std::fs::remove_dir_all(app_data.join("books")).unwrap();
    drop(local);
    let fresh = local_engine(&handle, &app_data);
    sync_once(&fresh, &peer.engine);
    let mut index = BookIndex::default();
    bridge::materialize(&handle, &fresh, 0, &mut index).unwrap();
    let ids = list_files(&app_data.join("books"));
    assert_eq!(ids.len(), 1);
    let path = app_data.join("books").join(&ids[0]).join("bookdetail.json");
    assert_eq!(read_json(&path)["groupId"], "__hidden__");
    assert!(!app_data.join("state/readerx.groups.json").exists(), "不能额外创建普通分组");
    lock_engine(&peer.engine).set_field(&uid, "group", json!(null)).unwrap();
    sync_once(&fresh, &peer.engine);
    bridge::materialize(&handle, &fresh, 0, &mut index).unwrap();
    assert!(read_json(&path)["groupId"].is_null(), "移出隐藏分组也应同步");
}

/// 升级时不能先用旧引擎的 null 归属覆盖本机尚在隐藏分组的书。
#[test]
fn startup_migrates_legacy_hidden_membership_once() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();
    seed_local_book(&app_data, "local-1", "三体");
    let old = local_engine(&handle, &app_data);
    bridge::reconcile(&handle, &old, &mut BookIndex::default()).unwrap();
    lock_engine(&old).flush().unwrap();
    drop(old);
    let path = app_data.join("books/local-1/bookdetail.json");
    let mut detail = read_json(&path);
    detail["groupId"] = json!("__hidden__");
    write_json(&path, &detail);
    write_json(&app_data.join("sync/settings.json"), &json!({"activated": true}));
    let service = SyncService::new(handle.clone());
    service.bootstrap();
    assert_eq!(read_json(&path)["groupId"], "__hidden__");
    assert_eq!(read_json(&app_data.join("sync/settings.json"))["hiddenGroupMigrated"], true);
    service.shutdown();
    drop(service);
    // 标记迁移后，远端正常的移出隐藏分组应得到尊重，不能再次强制隐藏。
    let engine = local_engine(&handle, &app_data);
    let uid = bridge::local_uid(&handle, "local-1");
    lock_engine(&engine).set_field(&uid, "group", json!(null)).unwrap();
    lock_engine(&engine).flush().unwrap();
    drop(engine);
    let service = SyncService::new(handle);
    service.bootstrap();
    assert!(read_json(&path)["groupId"].is_null());
    service.shutdown();
}

/// 点一次同步即连续搬完超过单会话预算的书，并逐批发送真实进度。
#[test]
fn sync_service_continues_large_books_and_reports_live_progress() {
    use tauri::Listener;
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (handle, app_data) = setup();
    write_json(&app_data.join("sync/settings.json"), &json!({"activated": true}));
    let service = SyncService::new(handle.clone());
    service.bootstrap();
    let peer = RealPeer::start("large-book-progress", Some(&service.pairing_code().unwrap()));
    seed_peer_book(&peer.data_root, "peer-local", "peer-local", "三体", true);
    let chapters: Vec<Value> = (0..450).map(|index| json!({
        "cid": format!("c{index:04}"), "title": format!("第{index}章"), "paragraphs": ["正文"]
    })).collect();
    write_json(&peer.data_root.join("books/peer-local/content.json"), &json!({
        "schemaVersion": 1, "chapters": chapters
    }));
    let uid = identity::book_uid(&identity::BookKey {
        file_name: "三体.epub", size: 1024, ..Default::default()
    });
    peer.publish_book(&uid);
    let options = ServerOptions::from_engine(&lock_engine(&peer.engine)).unwrap()
        .with_bind(std::net::SocketAddr::from(([127, 0, 0, 1], 0)));
    let server = PeerServer::start(peer.engine.clone(), options).unwrap();
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = events.clone();
    let listener = handle.listen("readerx-sync-progress", move |event| {
        captured.lock().unwrap().push(serde_json::from_str(event.payload()).unwrap());
    });
    let outcome = service.sync_with_addr_now(&server.local_addr().to_string()).unwrap();
    assert_eq!(outcome.content_pulled, 450);
    assert_eq!(outcome.assets_pulled, 1);
    assert!(outcome.bytes > 0);
    let progress = serde_json::to_value(service.status()).unwrap()["progress"].clone();
    assert_eq!(progress["phase"], "done");
    assert_eq!(progress["batch"], 3);
    assert_eq!(progress["contentPulled"], 450);
    let ids = list_files(&app_data.join("books"));
    assert_eq!(ids.len(), 1);
    assert_eq!(read_json(&app_data.join("books").join(&ids[0]).join("content.json"))["chapters"].as_array().unwrap().len(), 450);
    let events = events.lock().unwrap();
    assert!(events.iter().any(|event| event["phase"] == "continuing"));
    assert!(events.iter().any(|event| event["phase"] == "content" && event["completed"].as_u64().unwrap() > 0));
    assert!(events.windows(2).all(|pair| pair[0]["sequence"].as_u64() < pair[1]["sequence"].as_u64()));
    assert!(events.windows(2).all(|pair| pair[0]["contentPulled"].as_u64() <= pair[1]["contentPulled"].as_u64()));
    drop(events);
    // 单章超过帧上限时不能假报全部完成，也不能无限空转。
    let path = peer.data_root.join("books/peer-local/content.json");
    let mut content = read_json(&path);
    content["chapters"].as_array_mut().unwrap().push(json!({
        "cid": "oversized", "title": "超大章", "paragraphs": ["x".repeat(5 * 1024 * 1024)]
    }));
    write_json(&path, &content);
    assert!(service.sync_with_addr_now(&server.local_addr().to_string()).is_err());
    let failed = serde_json::to_value(service.status()).unwrap()["progress"].clone();
    assert_eq!(failed["phase"], "failed");
    assert!(!service.status().syncing);
    handle.unlisten(listener);
    drop(server);
    service.shutdown();
}

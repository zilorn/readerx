//! 全量数据导出 / 导入的端到端回归：**真实磁盘布局 + 真实 zip**，只把窗口换成 mock。
//!
//! 作为库内单元测试（而不是 `tests/` 下的集成测试）是刻意的：导出的采集与导入的落盘
//! 都是**内部实现**，不值得为了测试把它们提升成公开 API（`sync` 选择暴露桥接模块，
//! 这里选择不扩大公开面）。
//!
//! 覆盖的是单元测试够不到的那一层：目录遍历与归档写入、`content.json` / 图片的字节往返、
//! 书签文件与状态文件的合并、覆盖模式「先写后删」的顺序、以及跨设备身份对齐。
//!
//! **串行执行**：应用数据目录由进程级的 `XDG_DATA_HOME` 决定，书源引擎的数据根更是
//! 一次性初始化（`init_data_root`），所以用例之间必须错开 —— 共用一个临时目录，
//! 每个用例开始时清空它（与 `tests/sync_bridge.rs` 同一套做法）。

use super::archive;
use super::export::export_to;
use super::import::apply;
use super::ExportOptions;
use super::ImportMode;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

static SERIAL: Mutex<()> = Mutex::new(());
static SHARED: OnceLock<(tauri::AppHandle<tauri::test::MockRuntime>, PathBuf)> = OnceLock::new();

/// 取共享的 mock 应用，并清掉上一个用例留下的数据。
fn setup() -> (tauri::AppHandle<tauri::test::MockRuntime>, PathBuf) {
    let (handle, data_root) = SHARED
        .get_or_init(|| {
            let root =
                std::env::temp_dir().join(format!("readerx-backup-e2e-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            // Tauri 的 app_data_dir = $XDG_DATA_HOME/<identifier>
            std::env::set_var("XDG_DATA_HOME", &root);
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .expect("mock 应用应能构建");
            let handle = app.handle().clone();
            let data = handle.path().app_data_dir().unwrap();
            // 书源引擎的数据根是进程级一次性初始化：整个测试进程共用一份
            readerx_source::store::init_data_root(data.clone());
            std::mem::forget(app);
            (handle, data)
        })
        .clone();
    for sub in [
        "books",
        "state",
        "book_sources",
        "source_sessions",
        "images",
        "tts-audio",
    ] {
        let _ = fs::remove_dir_all(data_root.join(sub));
    }
    (handle, data_root)
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

/// 造一本本地书（与 `book_store.rs` 的目录布局一致）
fn seed_book(
    root: &Path,
    id: &str,
    title: &str,
    file_name: &str,
    size: u64,
    group_id: Option<&str>,
) {
    let dir = root.join("books").join(id);
    write_json(
        &dir.join("bookdetail.json"),
        &json!({
            "schemaVersion": 1,
            "id": id,
            "title": title,
            "author": "刘慈欣",
            "format": "epub",
            "fileName": file_name,
            "size": size,
            "importedAt": 1_700_000_000u64,
            "hue": 7,
            "splitDesc": "按章",
            "cover": "data:image/png;base64,AAAA",
            "groupId": group_id,
            "tags": ["科幻"],
        }),
    );
    write_json(
        &dir.join("content.json"),
        &json!({ "schemaVersion": 1, "chapters": [
            { "cid": "c0001", "title": "第一章", "paragraphs": [format!("{title} 的正文")] }
        ]}),
    );
    write_json(
        &dir.join("bookmarks.json"),
        &json!({ "schemaVersion": 1, "bookmarks": [{
            "id": format!("bm-{id}"),
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
        }]}),
    );
}

fn seed_image(root: &Path, book_id: &str, hash: &str) {
    let dir = root.join("images");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(format!("{book_id}_{hash}.jpg")), b"fake-jpeg").unwrap();
}

fn seed_state(root: &Path, key: &str, value: &Value) {
    write_json(&root.join("state").join(format!("{key}.json")), value);
}

fn seed_source(root: &Path, id: &str, url: &str, group_id: Option<&str>) {
    write_json(
        &root.join("book_sources").join(format!("{id}.json")),
        &json!({
            "schemaVersion": 1,
            "id": id,
            "name": "示例源",
            "bookSourceUrl": url,
            "enabled": true,
            "js": "function search() { return []; }",
            "groupId": group_id,
        }),
    );
}

fn seed_session(root: &Path, id: &str) {
    write_json(
        &root.join("source_sessions").join(format!("{id}.json")),
        &json!({ "url": "https://a.example.com/login", "cookie": "sid=secret", "updated_at": 1 }),
    );
}

/// 造一份「设备 A」的标准数据：两本书 + 一张插图 + 一个分组 + 一个书源（含登录态）
fn seed_device_a(root: &Path) {
    seed_state(
        root,
        "readerx.groups",
        &json!([{ "id": "grp-1", "name": "科幻", "createdAt": 1 }]),
    );
    seed_state(
        root,
        "readerx.sourceGroups",
        &json!([{ "id": "sg-1", "name": "小说站", "createdAt": 1 }]),
    );
    seed_state(
        root,
        "readerx.shelf",
        &json!({
            "local-a": { "bookId": "local-a", "chapter": 1, "charOffset": 10, "updatedAt": 1000 }
        }),
    );
    seed_state(
        root,
        "readerx.textReplacements",
        &json!([{ "id": "tr-1", "scope": "global", "bookId": "", "find": "的", "replace": "之",
                  "regex": false, "createdAt": 1 }]),
    );
    seed_state(
        root,
        "readerx.chapterRules",
        &json!([{ "id": "cr-1", "name": "卷首", "pattern": "^卷", "builtin": false }]),
    );
    seed_state(
        root,
        "readerx.webdavServers",
        &json!([{ "id": "dav-1", "name": "家里的 NAS", "url": "https://dav.example.com/dav",
                  "username": "reader", "password": "s3cret", "createdAt": 1 }]),
    );
    seed_state(root, "readerx.theme", &json!("dark"));
    seed_book(root, "local-a", "三体", "三体.epub", 1024, Some("grp-1"));
    seed_book(root, "local-b", "球状闪电", "球状闪电.epub", 2048, None);
    seed_image(root, "local-a", "0123456789abcdef0123456789abcdef01234567");
    seed_source(root, "src-1", "https://a.example.com", Some("sg-1"));
    seed_session(root, "src-1");
}

fn export_path(root: &Path, tag: &str) -> PathBuf {
    let path = root.join(format!("backup-{tag}.zip"));
    let _ = fs::remove_file(&path);
    path
}

fn export(
    app: &tauri::AppHandle<tauri::test::MockRuntime>,
    root: &Path,
    tag: &str,
    include_credentials: bool,
) -> PathBuf {
    let path = export_path(root, tag);
    let file = fs::File::create(&path).unwrap();
    export_to(
        app,
        file,
        ExportOptions {
            include_credentials,
        },
        &mut |_, _, _| {},
    )
    .expect("导出应成功");
    path
}

fn import(
    app: &tauri::AppHandle<tauri::test::MockRuntime>,
    path: &Path,
    mode: ImportMode,
) -> super::ImportSummary {
    apply(app, &path.to_string_lossy(), mode, &mut |_, _, _| {}).expect("导入应成功")
}

#[test]
fn export_and_merge_import_restores_everything() {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (app, root) = setup();
    seed_device_a(&root);

    let backup = export(&app, &root, "full", true);
    let scan = archive::scan(&app, &backup.to_string_lossy()).unwrap();
    assert_eq!(scan.manifest.books, 2);
    assert_eq!(scan.manifest.sources, 1);
    assert_eq!(scan.images.len(), 1);
    assert!(scan.manifest.credentials);
    assert!(scan.sessions.contains(&"src-1".to_string()));
    assert!(scan.bytes > 0);

    // 模拟换机：把本地数据全清掉（同步目录与日志不动）
    for sub in [
        "books",
        "state",
        "book_sources",
        "source_sessions",
        "images",
    ] {
        let _ = fs::remove_dir_all(root.join(sub));
    }
    let summary = import(&app, &backup, ImportMode::Merge);
    assert_eq!(summary.books_added, 2);
    assert_eq!(summary.sources_added, 1);
    assert_eq!(summary.images_added, 1);
    // 空设备恢复：状态文件本机没有 → 全部写下来（并计入结果）
    assert!(summary.state_keys.len() >= 5, "{:?}", summary.state_keys);

    // 正文按字节回来（含中文与章节结构）
    let content = read_json(&root.join("books/b-5e20dcb39c59dc92/content.json"));
    assert_eq!(content["chapters"][0]["paragraphs"][0], "三体 的正文");
    let detail = read_json(&root.join("books/b-5e20dcb39c59dc92/bookdetail.json"));
    assert_eq!(detail["title"], "三体");
    assert_eq!(detail["groupId"], crate::sync::identity::group_uid("科幻"));

    // 书签、分组、规则、插图、书源、登录态
    assert_eq!(
        read_json(&root.join("books/b-5e20dcb39c59dc92/bookmarks.json"))["bookmarks"][0]["id"],
        "bm-local-a"
    );
    assert_eq!(
        fs::read_to_string(
            root.join("images/local-a_0123456789abcdef0123456789abcdef01234567.jpg")
        )
        .unwrap(),
        "fake-jpeg"
    );
    assert_eq!(
        read_json(&root.join("state/readerx.groups.json"))[0]["name"],
        "科幻"
    );
    assert_eq!(
        read_json(&root.join("state/readerx.chapterRules.json"))[0]["name"],
        "卷首"
    );
    assert_eq!(
        read_json(&root.join(format!("book_sources/{}.json", crate::sync::identity::source_uid("https://a.example.com"))))["bookSourceUrl"],
        "https://a.example.com"
    );
    assert_eq!(
        read_json(&root.join(format!("source_sessions/{}.json", crate::sync::identity::source_uid("https://a.example.com"))))["cookie"],
        "sid=secret"
    );
    // 偏好类状态原样回来（换机时是「本机没有」→ 取归档那份）
    assert_eq!(
        read_json(&root.join("state/readerx.theme.json")),
        json!("dark")
    );
    assert_eq!(
        read_json(&root.join("state/readerx.webdavServers.json"))[0]["password"],
        "s3cret"
    );
}

#[test]
fn export_without_credentials_leaves_login_state_and_passwords_out() {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (app, root) = setup();
    seed_device_a(&root);

    let backup = export(&app, &root, "no-creds", false);
    let scan = archive::scan(&app, &backup.to_string_lossy()).unwrap();
    assert!(!scan.manifest.credentials);
    assert!(scan.sessions.is_empty());
    assert!(
        !scan
            .entries
            .iter()
            .any(|name| name.starts_with("source_sessions/")),
        "默认导出不该带登录态：{:?}",
        scan.entries
    );

    // WebDAV 密码被抹掉，服务器地址与用户名保留（它们不是凭据）
    let dav = archive_read_json(&backup, "state/readerx.webdavServers.json");
    assert_eq!(dav[0]["password"], "");
    assert_eq!(dav[0]["username"], "reader");

    // 导入后本机的登录态不被删（归档没带它，不等于「用户不要了」）
    let summary = import(&app, &backup, ImportMode::Merge);
    assert_eq!(summary.books_updated, 2);
    assert!(root.join(format!("source_sessions/{}.json", crate::sync::identity::source_uid("https://a.example.com"))).is_file());
    assert_eq!(
        read_json(&root.join(format!("source_sessions/{}.json", crate::sync::identity::source_uid("https://a.example.com"))))["cookie"],
        "sid=secret"
    );
}

#[test]
fn merge_keeps_local_extras_and_newer_progress() {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (app, root) = setup();
    seed_device_a(&root);
    let backup = export(&app, &root, "merge", true);

    // 本机在导出之后又多了一本书、进度也更靠后、偏好被改过
    seed_book(
        &root,
        "local-c",
        "超新星纪元",
        "超新星纪元.epub",
        4096,
        None,
    );
    seed_state(
        &root,
        "readerx.shelf",
        &json!({
            "local-a": { "bookId": "local-a", "chapter": 9, "updatedAt": 9000 },
            "local-c": { "bookId": "local-c", "chapter": 3, "updatedAt": 100 }
        }),
    );
    seed_state(&root, "readerx.theme", &json!("sepia"));

    let summary = import(&app, &backup, ImportMode::Merge);
    assert_eq!(summary.books_added, 0, "归档里的书本机都有");
    assert_eq!(summary.books_updated, 2);
    assert_eq!(summary.books_removed, 0);

    // 本机多出来的书一本都不动
    assert!(root.join("books/b-3e75c5b1cc830167/bookdetail.json").is_file());
    // 进度按 updatedAt 取新的：本机那份更靠后 → 保留本机
    let shelf = read_json(&root.join("state/readerx.shelf.json"));
    assert_eq!(shelf["b-5e20dcb39c59dc92"]["chapter"], 9);
    assert_eq!(shelf["b-3e75c5b1cc830167"]["chapter"], 3);
    // 偏好类状态合并模式下一律保持本机
    assert_eq!(
        read_json(&root.join("state/readerx.theme.json")),
        json!("sepia")
    );
}

#[test]
fn replace_rewrites_content_state_and_removes_local_extras() {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (app, root) = setup();
    seed_device_a(&root);
    let backup = export(&app, &root, "replace", true);

    seed_book(
        &root,
        "local-c",
        "超新星纪元",
        "超新星纪元.epub",
        4096,
        None,
    );
    seed_source(&root, "src-9", "https://b.example.com", None);
    seed_state(
        &root,
        "readerx.shelf",
        &json!({
            "local-a": { "bookId": "local-a", "chapter": 9, "updatedAt": 9000 },
            "local-c": { "bookId": "local-c", "chapter": 3, "updatedAt": 100 }
        }),
    );
    seed_state(&root, "readerx.theme", &json!("sepia"));
    // 归档里没有这个内容类状态：覆盖恢复要把它清掉
    fs::remove_file(root.join("state/readerx.chapterRules.json")).ok();
    seed_state(
        &root,
        "readerx.chapterRules",
        &json!([{ "id": "cr-9", "name": "多余" }]),
    );
    seed_state(
        &root,
        "readerx.sourceGroups",
        &json!([{ "id": "sg-9", "name": "别的" }]),
    );

    let summary = import(&app, &backup, ImportMode::Replace);
    assert_eq!(summary.books_removed, 1);
    assert_eq!(summary.sources_removed, 1);

    // 归档里没有的书与书源被删掉（连同插图与登录态）
    assert!(!root.join("books/local-c").exists());
    assert!(!root.join("book_sources/src-9.json").exists());
    // 内容类状态完全按归档来：进度回到归档那一刻
    let shelf = read_json(&root.join("state/readerx.shelf.json"));
    assert_eq!(shelf["b-5e20dcb39c59dc92"]["chapter"], 1, "{shelf}");
    assert!(shelf.get("local-c").is_none());
    assert_eq!(
        read_json(&root.join("state/readerx.sourceGroups.json"))[0]["name"],
        "小说站"
    );
    // 偏好类状态也被归档覆盖（覆盖恢复的语义就是「回到备份那一刻」）
    assert_eq!(
        read_json(&root.join("state/readerx.theme.json")),
        json!("dark")
    );
    // 同步目录 / 听书缓存不在导出导入范围，不检查它们的内容
}

#[test]
fn merge_matches_the_same_book_from_another_device_by_identity() {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (app, root) = setup();
    seed_device_a(&root);
    let backup = export(&app, &root, "cross-device", true);

    // 「另一台设备」：同一本《三体》（文件名 + 字节数一致）但本机 id 不同
    for sub in [
        "books",
        "state",
        "book_sources",
        "source_sessions",
        "images",
    ] {
        let _ = fs::remove_dir_all(root.join(sub));
    }
    seed_book(&root, "local-other", "三体", "三体.epub", 1024, None);
    seed_state(
        &root,
        "readerx.shelf",
        &json!({
            "local-other": { "bookId": "local-other", "chapter": 5, "updatedAt": 5000 }
        }),
    );

    let summary = import(&app, &backup, ImportMode::Merge);
    assert_eq!(summary.books_skipped, 1, "同一本书不该导入成第二本");
    assert_eq!(summary.books_added, 1, "另一本《球状闪电》是新书");
    assert!(
        !root.join("books/local-a").exists(),
        "不应新建第二个《三体》"
    );

    // 归档里《三体》的书签被并进本机那本（bookId 跟着本机 id 改写）
    let bookmarks = read_json(&root.join("books/b-5e20dcb39c59dc92/bookmarks.json"));
    let ids: Vec<&str> = bookmarks["bookmarks"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|item| item["id"].as_str())
        .collect();
    assert!(ids.contains(&"bm-local-a"), "{bookmarks}");
    assert!(ids.contains(&"bm-local-other"), "{bookmarks}");
    assert!(bookmarks["bookmarks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["bookId"] == "b-5e20dcb39c59dc92"));
    // 进度按身份落到本机那本上，且本机那份更新（5000 > 1000）→ 保持本机
    let shelf = read_json(&root.join("state/readerx.shelf.json"));
    assert_eq!(shelf["b-5e20dcb39c59dc92"]["chapter"], 5);
    assert!(shelf.get("local-a").is_none(), "{shelf}");
}

#[test]
fn a_file_that_is_not_a_backup_is_rejected() {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (app, root) = setup();
    let not_a_backup = root.join("random.zip");
    fs::write(&not_a_backup, "这不是 zip".as_bytes()).unwrap();
    let error = archive::scan(&app, &not_a_backup.to_string_lossy()).unwrap_err();
    assert!(error.contains("无法读取备份文件"), "{error}");
}

#[test]
fn archive_entries_cannot_escape_the_data_dir() {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (app, root) = setup();
    seed_device_a(&root);
    let backup = export(&app, &root, "safe", true);
    let scan = archive::scan(&app, &backup.to_string_lossy()).unwrap();
    assert!(scan.entries.iter().all(|name| !name.contains("..")));
    assert!(scan.entries.iter().all(|name| !name.starts_with('/')));
}

/// 直接读归档里的一个 JSON 条目（不经过导入逻辑），断言导出内容本身
fn archive_read_json(path: &Path, entry: &str) -> Value {
    let file = fs::File::open(path).unwrap();
    let mut zip = archive::open_zip_from(file).unwrap();
    archive::read_entry_json(&mut zip, entry)
        .unwrap()
        .unwrap_or_else(|| panic!("归档里没有 {entry}"))
        .clone()
}

#[test]
fn annotations_survive_archive_merge_replace_and_old_backup() {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (app, root) = setup();
    let id = "b-5e20dcb39c59dc92";
    seed_book(&root, id, "三体", "三体.epub", 1_000, None);
    let path = root.join(format!("books/{id}/annotations.json"));
    let paragraph = json!({ "id":"p1", "chapterCid":"c0001", "unitIndex":0, "fingerprint":"f", "before":"", "after":"", "notes":[{"id":"n1","text":"原注释"}] });
    write_json(
        &path,
        &json!({"schemaVersion":1,"annotations":[paragraph.clone()]}),
    );
    let backup = export(&app, &root, "annotations", false);
    fs::remove_dir_all(root.join("books")).unwrap();
    import(&app, &backup, ImportMode::Merge);
    assert_eq!(read_json(&path)["annotations"][0], paragraph);
    let mut local = paragraph.clone();
    local["notes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"n2","text":"本机新增"}));
    write_json(&path, &json!({"schemaVersion":1,"annotations":[local]}));
    import(&app, &backup, ImportMode::Merge);
    assert_eq!(
        read_json(&path)["annotations"][0]["notes"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    import(&app, &backup, ImportMode::Replace);
    assert_eq!(read_json(&path)["annotations"][0], paragraph);
    fs::remove_file(&path).unwrap();
    let old_backup = export(&app, &root, "without-annotations", false);
    write_json(&path, &json!({"schemaVersion":1,"annotations":[paragraph]}));
    import(&app, &old_backup, ImportMode::Replace);
    assert!(read_json(&path)["annotations"]
        .as_array()
        .unwrap()
        .is_empty());
}

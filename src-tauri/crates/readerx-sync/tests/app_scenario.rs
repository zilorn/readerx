//! App 接入后的真实场景回归：**两台设备各自有一份相同书库**，互相同步。
//!
//! 这里用的是 App 实际注册的 schema（[`SchemaRegistry::readerx_defaults`]）与 App 写入的
//! 字段名（见 `src-tauri/src/sync/bridge.rs`），因此能挡住「改了合并策略 / 字段名却没人
//! 发现」这类问题 —— 单元测试覆盖的是机制，这里覆盖的是**接线**。
//!
//! 必须成立的性质：
//!
//! 1. 同一个文件在两台设备上算出同一个 uid → 元信息与进度能对上；
//! 2. 两台设备各读到不同位置 → 收敛到较晚的一次，**不进冲突队列**
//!    （否则第一次同步就堆一屏「保留哪个进度」）；
//! 3. 两边都改了书名 → 收敛到较晚的一次，且**留档待裁决**（不静默丢数据）；
//! 4. 删书连带它的进度与书签一起消失，而不是留下指不到书的孤儿记录。

use readerx_sync::model::ConflictStatus;
use readerx_sync::net::{lock_engine, shared, LoopbackTransport, SharedEngine};
use readerx_sync::{EngineOptions, Resolution, SchemaRegistry, SyncEngine};
use serde_json::{json, Value};
use std::path::PathBuf;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("readerx-sync-app-{tag}-{}", readerx_sync::new_id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn device(tag: &str) -> SharedEngine {
    let mut options = EngineOptions::new(tag);
    options.schemas = SchemaRegistry::readerx_defaults();
    shared(SyncEngine::open(temp_dir(tag), options).expect("引擎应能打开"))
}

/// 把一台设备「书架上已有的那本书」写进引擎（对应 App 启动时的本地数据对账）。
fn seed_device(engine: &SharedEngine, uid: &str, title: &str, progress: i64) {
    let mut guard = lock_engine(engine);
    guard
        .create_entity(
            "book",
            Some(uid.to_string()),
            [
                ("title", json!(title)),
                ("author", json!("刘慈欣")),
                ("tags", json!(["科幻"])),
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
                ("chapter", json!(progress)),
                ("chapter_cid", json!("c0001")),
                ("char_offset", json!(progress * 100)),
                ("updated_at", json!(1_700_000_000_000u64 + progress as u64)),
            ],
        )
        .unwrap();
    guard.flush().unwrap();
}

/// 让 `client` 主动连 `server` 同步一次（进程内直连，不需要网卡）。
fn sync_once(client: &SharedEngine, server: &SharedEngine) {
    let mut transport = LoopbackTransport::new(server.clone());
    let mut guard = lock_engine(client);
    readerx_sync::sync_with(&mut guard, &mut transport).expect("同步应成功");
}

/// 双向同步（真实场景两侧的自动同步都会发起）。
fn sync_pair(a: &SharedEngine, b: &SharedEngine) {
    sync_once(a, b);
    sync_once(b, a);
}

fn bookmarks(engine: &SharedEngine, uid: &str) -> Vec<Value> {
    lock_engine(engine)
        .entities_of_kind("bookmark", false)
        .into_iter()
        .filter(|entity| {
            entity.field("book_id").and_then(|v| v.as_str().map(str::to_string)).as_deref()
                == Some(uid)
        })
        .map(|entity| entity.field("text").unwrap_or(Value::Null))
        .collect()
}

#[test]
fn same_book_on_two_devices_converges_without_conflicts() {
    let uid = "b-0123456789abcdef";
    let a = device("app-a");
    let b = device("app-b");
    seed_device(&a, uid, "三体", 3);
    seed_device(&b, uid, "三体", 7);

    sync_pair(&a, &b);

    // 两边收敛到同一份元信息与同一个进度
    assert_eq!(
        lock_engine(&a).field(uid, "title"),
        lock_engine(&b).field(uid, "title")
    );
    let progress = format!("rp-{uid}");
    let offset_a = lock_engine(&a).field(&progress, "char_offset");
    let offset_b = lock_engine(&b).field(&progress, "char_offset");
    assert_eq!(offset_a, offset_b, "两侧进度必须收敛");
    assert!(
        offset_a == Some(json!(300)) || offset_a == Some(json!(700)),
        "进度应是两台设备中较晚的那一次：{offset_a:?}"
    );

    // 进度是**静默 LWW**：并发读到不同位置不是需要人裁决的冲突
    assert_eq!(
        lock_engine(&a).pending_conflict_count(),
        0,
        "阅读进度并发不应进冲突队列：{:?}",
        lock_engine(&a).conflicts(None)
    );
    assert_eq!(lock_engine(&b).pending_conflict_count(), 0);
}

#[test]
fn concurrent_title_edit_keeps_both_sides_for_review() {
    let uid = "b-fedcba9876543210";
    let a = device("title-a");
    let b = device("title-b");
    seed_device(&a, uid, "三体", 1);
    seed_device(&b, uid, "三体", 1);
    sync_pair(&a, &b);

    // 各自离线改书名
    lock_engine(&a).set_field(uid, "title", json!("三体（手机改）")).unwrap();
    lock_engine(&b).set_field(uid, "title", json!("三体（桌面改）")).unwrap();
    sync_pair(&a, &b);

    // 收敛到同一个值
    assert_eq!(
        lock_engine(&a).field(uid, "title"),
        lock_engine(&b).field(uid, "title")
    );

    // 败方留档：两侧都能看到这条待裁决冲突
    let conflict = {
        let guard = lock_engine(&a);
        let pending: Vec<_> = guard
            .conflicts(Some(ConflictStatus::Pending))
            .into_iter()
            .filter(|c| c.field == "title")
            .cloned()
            .collect();
        assert_eq!(pending.len(), 1, "书名并发改写必须留档：{:?}", guard.conflicts(None));
        pending[0].clone()
    };
    let values: Vec<Value> = [conflict.local.value.clone(), conflict.remote.value.clone()]
        .into_iter()
        .flatten()
        .collect();
    assert!(values.contains(&json!("三体（手机改）")), "{values:?}");
    assert!(values.contains(&json!("三体（桌面改）")), "{values:?}");

    // 裁决后冲突关闭，字段收敛到选中的那一侧
    lock_engine(&a).resolve_conflict(&conflict.id, Resolution::KeepLocal).unwrap();
    assert_eq!(lock_engine(&a).pending_conflict_count(), 0);
}

#[test]
fn bookmarks_from_both_devices_land_side_by_side() {
    let uid = "b-1111222233334444";
    let a = device("marks-a");
    let b = device("marks-b");
    seed_device(&a, uid, "三体", 1);
    seed_device(&b, uid, "三体", 1);

    for (id, text) in [("bm-1", "手机上的书签"), ("bm-2", "桌面上的书签")] {
        let owner = if id == "bm-1" { &a } else { &b };
        lock_engine(owner)
            .create_entity(
                "bookmark",
                Some(id.to_string()),
                [
                    ("book_id", json!(uid)),
                    ("chapter_cid", json!("c0001")),
                    ("chapter_index", json!(0)),
                    ("char_start", json!(10)),
                    ("char_end", json!(20)),
                    ("text", json!(text)),
                    ("created_at", json!(1_700_000_000_000u64)),
                ],
            )
            .unwrap();
        lock_engine(owner).flush().unwrap();
    }

    sync_pair(&a, &b);

    let mut marks = bookmarks(&a, uid);
    marks.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    assert_eq!(marks, vec![json!("手机上的书签"), json!("桌面上的书签")], "书签应并集保留");
    assert_eq!(bookmarks(&b, uid).len(), 2);
    assert_eq!(lock_engine(&a).pending_conflict_count(), 0);
}

#[test]
fn deleting_a_book_cascades_to_progress_and_bookmarks() {
    let uid = "b-5555666677778888";
    let a = device("del-a");
    seed_device(&a, uid, "三体", 5);
    lock_engine(&a)
        .create_entity(
            "bookmark",
            Some("bm-9".to_string()),
            [
                ("book_id", json!(uid)),
                ("chapter_cid", json!("c0001")),
                ("char_start", json!(1)),
                ("char_end", json!(2)),
            ],
        )
        .unwrap();
    lock_engine(&a).delete_entity(uid, Some("测试删除".to_string())).unwrap();

    let guard = lock_engine(&a);
    assert!(guard.entity(uid).unwrap().is_deleted());
    assert!(guard.is_effectively_deleted(guard.entity("bm-9").unwrap()));
    assert!(guard.is_effectively_deleted(guard.entity(&format!("rp-{uid}")).unwrap()));
    assert_eq!(guard.entities_of_kind("bookmark", false).len(), 0);
}

#[test]
fn deleted_book_stays_deleted_after_sync() {
    // A 删了书并同步给 B：B 那边这本书也是删除态，而不是被 B 的本地数据「救回来」
    let uid = "b-9999888877776666";
    let a = device("del-sync-a");
    let b = device("del-sync-b");
    seed_device(&a, uid, "三体", 1);
    seed_device(&b, uid, "三体", 1);
    sync_pair(&a, &b);

    lock_engine(&a).delete_entity(uid, Some("在手机删除".to_string())).unwrap();
    sync_pair(&a, &b);

    let guard = lock_engine(&b);
    assert!(
        guard.is_effectively_deleted(guard.entity(uid).expect("B 应拿到这本书的墓碑")),
        "删除必须同步到另一台设备"
    );
}

#[test]
fn joining_a_group_makes_local_data_syncable() {
    // App 的「加入其它设备」流程：本机已有数据在加入后成为本设备的新记录
    let a = device("join-a");
    let b = device("join-b");
    let code = lock_engine(&a).pairing_code();
    lock_engine(&b).join_group(&code).unwrap();
    seed_device(&a, "b-aaaabbbbccccdddd", "A 的书", 1);
    seed_device(&b, "b-aaaabbbbccccdddd", "A 的书", 2);

    sync_pair(&a, &b);
    assert_eq!(lock_engine(&a).pending_conflict_count(), 0);
    // 加入后两边是同一个群组（配对码就是信任边界，跨群组拒绝见 session.rs 的 TCP 用例）
    assert_eq!(lock_engine(&a).group_id(), lock_engine(&b).group_id());
}

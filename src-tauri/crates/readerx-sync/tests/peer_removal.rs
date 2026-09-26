//! 「删除设备」在真实网络路径上的行为（真 TCP 回环，走完整的握手）。
//!
//! 界面上删除一台设备之后，有两条路能到达本机：**对方主动连过来**（必须被拒，
//! 数据一条都不收），**本机主动连对方**（用户显式动作，即「重新接受」）。
//! 这两条路必须在传输层就分开，而不是靠界面不显示 —— 否则「删除」就只是藏起来。

use readerx_sync::net::{lock_engine, shared, PeerServer, ServerOptions, SharedEngine};
use readerx_sync::{EngineOptions, SchemaRegistry, SyncEngine};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(5);

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("readerx-sync-removal-{tag}-{}", readerx_sync::new_id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn device(tag: &str) -> SharedEngine {
    let mut options = EngineOptions::new(tag);
    options.schemas = SchemaRegistry::readerx_defaults();
    shared(SyncEngine::open(temp_dir(tag), options).expect("引擎应能打开"))
}

/// 让引擎在回环地址上监听（端口由系统分配，测试之间互不干扰）。
fn serve(engine: &SharedEngine) -> PeerServer {
    let options = {
        let guard = lock_engine(engine);
        ServerOptions::from_engine(&guard)
            .expect("服务端选项应能派生")
            .with_bind(SocketAddr::from(([127, 0, 0, 1], 0)))
    };
    PeerServer::start(engine.clone(), options).expect("监听应能启动")
}

fn sync_to(engine: &SharedEngine, addr: &str) -> readerx_sync::Result<()> {
    let mut guard = lock_engine(engine);
    readerx_sync::sync_with_addr(&mut guard, addr, TIMEOUT).map(|_| ())
}

#[test]
fn removed_device_is_rejected_until_we_contact_it_again() {
    let a = device("removal-a");
    let b = device("removal-b");
    // 同一群组（配对）
    let code = lock_engine(&a).pairing_code();
    lock_engine(&b).join_group(&code).unwrap();

    let server_a = serve(&a);
    let server_b = serve(&b);
    let addr_a = server_a.local_addr().to_string();
    let addr_b = server_b.local_addr().to_string();

    // 先正常同步一次：两边互相认识
    sync_to(&b, &addr_a).expect("首次同步应成功");
    let b_id = lock_engine(&b).device_id().to_string();
    assert!(lock_engine(&a).peers().contains_key(&b_id));

    // A 删除 B
    lock_engine(&a).remove_peer(&b_id).unwrap();
    assert!(!lock_engine(&a).peers().contains_key(&b_id), "移除后不该再出现在设备列表里");

    // B 主动连过来：握手就被拒，且不会被重新记进 A 的设备列表
    let error = sync_to(&b, &addr_a).expect_err("被移除的设备不该还能连进来");
    // 判据是**错误码**：界面按码给「重新接受」的引导，中英文各有文案（见 error::Code）
    assert_eq!(
        error.code(),
        "removed_by_peer",
        "错误码应说明是被对端移除（实际：{error}）"
    );
    assert!(
        !lock_engine(&a).peers().contains_key(&b_id),
        "被拒绝的连接不能把设备记回列表"
    );

    // A 主动连 B：只同步数据，**不会**把删除撤销（撤销只能靠显式 accept-peer）
    sync_to(&a, &addr_b).expect("本机主动同步应成功");
    assert!(lock_engine(&a).is_device_removed(&b_id), "同步本身不能撤销删除");
    assert!(
        !lock_engine(&a).peers().contains_key(&b_id),
        "没被接受之前，被移除的设备不该回到设备列表"
    );

    // 显式重新接受（界面上的「重新接受」= 先接受、再同步一次）
    lock_engine(&a).accept_peer(&b_id).unwrap();
    assert!(!lock_engine(&a).is_device_removed(&b_id), "接受后不再拒绝");
    sync_to(&a, &addr_b).expect("重新接受后应能同步");
    assert!(lock_engine(&a).peers().contains_key(&b_id), "同步一次后回到设备列表");

    // 之后 B 再连过来又能同步了
    sync_to(&b, &addr_a).expect("重新接受后应恢复正常");
}

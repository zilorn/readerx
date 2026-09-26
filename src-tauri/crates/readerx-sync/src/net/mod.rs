//! 局域网传输层。
//!
//! | 模块 | 职责 |
//! | --- | --- |
//! | [`frame`] | `[长度][JSON]` 分帧 + 鉴权信封（MAC / 序号） |
//! | [`handler`] | 把一条 [`Request`] 应用到引擎并产生 [`Response`]（服务端与测试共用） |
//! | [`client`] | TCP 客户端：握手 + 断线重连 |
//! | [`server`] | TCP 服务端：监听、鉴权、按请求驱动引擎 |
//! | [`discovery`] | UDP 广播发现（同一局域网内找到对端地址） |
//! | [`loopback`] | 进程内直连传输（测试与「本机两实例」用，不需要真网卡） |
//!
//! 所有传输都实现 [`Transport`]：同步会话（[`crate::session`]）只依赖这个 trait，
//! 因此「怎么把消息送过去」与「同步语义」是解耦的——以后要换成 HTTP / QUIC / BLE，
//! 只需要再实现一个 [`Transport`]。

pub mod client;
pub mod discovery;
pub mod frame;
pub mod handler;
pub mod loopback;
pub mod server;

use std::sync::{Arc, Mutex};

use crate::error::Result;
use crate::proto::{Request, Response};
use crate::engine::SyncEngine;

pub use client::TcpTransport;
pub use discovery::{DiscoveredPeer, DiscoveryService};
pub use loopback::LoopbackTransport;
pub use server::{PeerServer, ServerOptions, TrustPolicy};

/// 共享引擎：同步服务端线程与本地写入共用同一个引擎。
///
/// 粒度是「一次请求一把锁」而不是「一个连接一把锁」：局域网同步的请求很快，
/// 而 UI 的本地写入不该因为某个对端连着不干活就被挡住。
pub type SharedEngine = Arc<Mutex<SyncEngine>>;

/// 把引擎包成共享句柄。
pub fn shared(engine: SyncEngine) -> SharedEngine {
    Arc::new(Mutex::new(engine))
}

/// 取共享引擎的锁（中毒时继续用：同步数据只是状态，不该因为别的线程 panic 就整体瘫痪）。
pub fn lock_engine(engine: &SharedEngine) -> std::sync::MutexGuard<'_, SyncEngine> {
    engine.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 对端身份（报告 / 状态展示用）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PeerInfo {
    pub device_id: String,
    pub name: String,
    /// 连接地址（进程内直连为空）
    pub addr: Option<String>,
}

/// 一次同步所需的传输抽象。
pub trait Transport {
    /// 对端身份（握手完成后才有值）。
    fn peer(&self) -> PeerInfo;

    /// 发一条请求并等一条应答。
    fn request(&mut self, request: &Request) -> Result<Response>;
}

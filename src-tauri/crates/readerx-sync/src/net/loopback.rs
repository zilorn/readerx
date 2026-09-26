//! 进程内直连：不经过网络，直接把请求交给另一个引擎处理。
//!
//! 用途：
//!
//! - **测试**：同步语义（推送 / 拉取 / 冲突）可以在没有网卡、没有端口的环境里验证；
//! - **本机自测 / 调试**：同一台机器上的两个数据目录互相同步，不需要走回环端口；
//! - **对照**：同一个 [`handle_request`] 也被 TCP 服务端使用，因此直连跑通
//!   与真机跑通在语义上是一致的（差别只在鉴权与分帧）。
//!
//! 它**不做**握手鉴权（进程内调用方已经持有引擎句柄），因此不要用它跨越信任边界。

use crate::net::handler::handle_request;
use crate::net::{lock_engine, PeerInfo, SharedEngine, Transport};
use crate::error::Result;
use crate::proto::{Request, Response};

/// 直连传输。
pub struct LoopbackTransport {
    engine: SharedEngine,
    peer: PeerInfo,
}

impl LoopbackTransport {
    /// 连接到另一个引擎（读取它的设备信息作为对端身份）。
    pub fn new(engine: SharedEngine) -> LoopbackTransport {
        let peer = {
            let engine = lock_engine(&engine);
            PeerInfo {
                device_id: engine.device_id().to_string(),
                name: engine.device_name().to_string(),
                addr: None,
                // 与真 TCP 握手同一口径：对端能不能收正文，看它有没有注册正文来源
                content: engine.has_content_source(),
            }
        };
        LoopbackTransport { engine, peer }
    }
}

impl Transport for LoopbackTransport {
    fn peer(&self) -> PeerInfo {
        self.peer.clone()
    }

    fn request(&mut self, request: &Request) -> Result<Response> {
        let mut engine = lock_engine(&self.engine);
        Ok(handle_request(&mut engine, Some(&self.peer.device_id), request))
    }
}

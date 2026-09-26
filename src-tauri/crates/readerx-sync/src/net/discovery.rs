//! UDP 广播发现：在局域网里找到「谁在跑同步服务」。
//!
//! 手机不知道台式机的 IP，靠用户手输地址不现实。做法是**查询 / 应答**：
//!
//! ```text
//! 扫描方：绑定临时端口 → 向 255.255.255.255:47822 广播 Query（带群组与 HMAC）
//! 应答方：监听 47822 → 校验群组与 HMAC → 单播回自己的 device / name / 同步端口
//! ```
//!
//! 为什么不用「服务端定时广播」：那需要应答方一直占着固定端口并周期发包
//! （移动端耗电），而查询/应答只在用户点「扫描」时发包。
//!
//! 安全：广播消息用群组密钥算 HMAC。别的群组的设备既解不开、也冒充不了；
//! 同时**不会回应不属于自己群组的查询**，避免把「这里有一台 ReaderX」暴露给陌生设备。
//! 广播只用于发现，真正的数据同步仍然走已鉴权的 TCP 连接。

use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::crypto::{constant_time_eq, nonce, proof};
use crate::error::{Result, SyncError};

/// 广播消息的固定前缀（防止误收其它程序的 UDP 包）。
pub const MAGIC: &str = "readerx-sync-discover/1";

/// 广播消息。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DiscoveryMessage {
    pub magic: String,
    pub protocol: String,
    pub group: String,
    pub device: String,
    pub name: String,
    /// 同步端口；`0` 表示这是一条查询
    pub port: u16,
    pub nonce: String,
    pub mac: String,
}

impl DiscoveryMessage {
    /// 生成一条消息（自动算 MAC）。
    pub fn new(
        secret: &[u8],
        protocol: &str,
        group: &str,
        device: &str,
        name: &str,
        port: u16,
    ) -> DiscoveryMessage {
        let nonce = nonce();
        let mac = mac_for(secret, protocol, group, device, name, port, &nonce);
        DiscoveryMessage {
            magic: MAGIC.to_string(),
            protocol: protocol.to_string(),
            group: group.to_string(),
            device: device.to_string(),
            name: name.to_string(),
            port,
            nonce,
            mac,
        }
    }

    /// 校验 MAGIC 与 MAC（群组密钥不对 / 版本不对一律当噪音丢弃）。
    pub fn verify(&self, secret: &[u8], group: &str) -> bool {
        if self.magic != MAGIC || self.group != group {
            return false;
        }
        if self.protocol != crate::PROTOCOL_VERSION {
            return false;
        }
        let expected = mac_for(
            secret,
            &self.protocol,
            &self.group,
            &self.device,
            &self.name,
            self.port,
            &self.nonce,
        );
        constant_time_eq(expected.as_bytes(), self.mac.as_bytes())
    }
}

fn mac_for(
    secret: &[u8],
    protocol: &str,
    group: &str,
    device: &str,
    name: &str,
    port: u16,
    nonce: &str,
) -> String {
    proof(secret, &format!("{MAGIC}|{protocol}|{group}|{device}|{name}|{port}|{nonce}"))
}

/// 扫描到的对端。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredPeer {
    pub device: String,
    pub name: String,
    /// 同步服务的地址（`ip:port`）
    pub addr: SocketAddr,
    pub protocol: String,
}

/// 广播一次查询并收集应答。
pub fn scan(
    secret: &[u8],
    group: &str,
    device: &str,
    name: &str,
    timeout: Duration,
    discovery_port: u16,
) -> Result<Vec<DiscoveredPeer>> {
    let socket = UdpSocket::bind(SocketAddr::from(([0, 0, 0, 0], 0)))
        .map_err(|e| SyncError::Transport(format!("无法绑定发现端口：{e}")))?;
    socket.set_broadcast(true)?;
    let query = DiscoveryMessage::new(secret, crate::PROTOCOL_VERSION, group, device, name, 0);
    let payload = serde_json::to_vec(&query)?;
    let target = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::BROADCAST, discovery_port));
    // 广播可能被系统拦（没有权限 / 没有网卡），此时退回本机回环，至少能发现同机实例
    if let Err(e) = socket.send_to(&payload, target) {
        log::debug!("广播发现失败（尝试回环）：{e}");
    }
    let _ = socket.send_to(&payload, SocketAddr::from(([127, 0, 0, 1], discovery_port)));

    let deadline = Instant::now() + timeout;
    let mut found: Vec<DiscoveredPeer> = Vec::new();
    let mut buffer = [0u8; 2048];
    loop {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        socket.set_read_timeout(Some(deadline - now))?;
        match socket.recv_from(&mut buffer) {
            Ok((len, from)) => {
                let Ok(message) = serde_json::from_slice::<DiscoveryMessage>(&buffer[..len]) else {
                    continue;
                };
                if message.port == 0 || !message.verify(secret, group) {
                    continue;
                }
                if message.device == device {
                    continue; // 自己回的包
                }
                let addr = SocketAddr::new(from.ip(), message.port);
                // 同一台设备可能从多个网卡各回一次（广播走一张、回环走另一张）：
                // 优先记住回环地址——同机实例（CLI 自测、模拟器）才连得上
                if let Some(existing) = found.iter_mut().find(|p| p.device == message.device) {
                    if addr.ip().is_loopback() && !existing.addr.ip().is_loopback() {
                        existing.addr = addr;
                    }
                    continue;
                }
                found.push(DiscoveredPeer {
                    device: message.device,
                    name: message.name,
                    addr,
                    protocol: message.protocol,
                });
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                break
            }
            Err(e) => return Err(SyncError::Transport(e.to_string())),
        }
    }
    found.sort_by(|a, b| a.device.cmp(&b.device));
    Ok(found)
}

/// 运行中的发现应答服务。
pub struct DiscoveryService {
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl DiscoveryService {
    /// 监听发现端口并回应本群组的查询。
    pub fn start(
        secret: Vec<u8>,
        group: String,
        device: String,
        name: String,
        sync_port: u16,
        discovery_port: u16,
        bind: IpAddr,
    ) -> Result<DiscoveryService> {
        let socket = UdpSocket::bind(SocketAddr::new(bind, discovery_port)).map_err(|e| {
            SyncError::Transport(format!("绑定发现端口 {discovery_port} 失败：{e}"))
        })?;
        socket.set_broadcast(true)?;
        let addr = socket.local_addr()?;
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();

        let handle = std::thread::Builder::new()
            .name("readerx-sync-discovery".to_string())
            .spawn(move || {
                log::info!("同步发现服务已启动 addr={addr}");
                let mut buffer = [0u8; 2048];
                while !thread_stop.load(Ordering::Relaxed) {
                    socket.set_read_timeout(Some(Duration::from_millis(500))).ok();
                    match socket.recv_from(&mut buffer) {
                        Ok((len, from)) => {
                            let Ok(query) = serde_json::from_slice::<DiscoveryMessage>(&buffer[..len])
                            else {
                                continue;
                            };
                            // 只回应「本群组的查询」：其他群组连存在性都不该知道
                            if query.port != 0 || !query.verify(&secret, &group) {
                                continue;
                            }
                            let reply = DiscoveryMessage::new(
                                &secret,
                                crate::PROTOCOL_VERSION,
                                &group,
                                &device,
                                &name,
                                sync_port,
                            );
                            if let Ok(payload) = serde_json::to_vec(&reply) {
                                if let Err(e) = socket.send_to(&payload, from) {
                                    log::debug!("回应发现查询失败: {e}");
                                }
                            }
                        }
                        Err(e)
                            if matches!(
                                e.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(e) => {
                            log::warn!("发现服务读取失败: {e}");
                            std::thread::sleep(Duration::from_millis(200));
                        }
                    }
                }
                log::info!("同步发现服务已停止");
            })
            .map_err(|e| SyncError::Transport(format!("无法创建发现线程：{e}")))?;

        Ok(DiscoveryService { addr, stop, handle: Some(handle) })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for DiscoveryService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_verification() {
        let secret = b"group-secret-group-secret-group";
        let message =
            DiscoveryMessage::new(secret, crate::PROTOCOL_VERSION, "g1", "d1", "手机", 47821);
        assert!(message.verify(secret, "g1"));
        // 群组不同 / 密钥不同 / 被改过 → 一律不认
        assert!(!message.verify(secret, "g2"));
        assert!(!message.verify(b"other-secret-other-secret-other", "g1"));
        let mut tampered = message.clone();
        tampered.port = 1;
        assert!(!tampered.verify(secret, "g1"));
        let mut tampered = message.clone();
        tampered.device = "d2".to_string();
        assert!(!tampered.verify(secret, "g1"));
    }

    #[test]
    fn scan_finds_a_responding_service() {
        let secret = b"group-secret-group-secret-group".to_vec();
        let port = 47_000 + (std::process::id() % 200) as u16;
        let mut service = DiscoveryService::start(
            secret.clone(),
            "g1".to_string(),
            "device-b".to_string(),
            "台式机".to_string(),
            47_821,
            port,
            IpAddr::V4(Ipv4Addr::LOCALHOST),
        )
        .expect("发现服务应能启动");

        // 查询走回环（scan 会同时发广播与回环）
        let found = scan(&secret, "g1", "device-a", "手机", Duration::from_millis(800), port)
            .expect("扫描不应失败");
        let peer = found
            .iter()
            .find(|p| p.device == "device-b")
            .unwrap_or_else(|| panic!("应发现本机应答方：{found:?}"));
        assert_eq!(peer.name, "台式机");
        assert_eq!(peer.addr.port(), 47_821);

        // 别的群组扫不到（对方根本不回应）
        let found_other = scan(
            b"other-secret-other-secret-other",
            "g2",
            "device-a",
            "手机",
            Duration::from_millis(300),
            port,
        )
        .unwrap();
        assert!(found_other.is_empty(), "其他群组不应得到应答：{found_other:?}");
        service.shutdown();
    }
}

//! TCP 服务端：监听局域网对端的同步请求。
//!
//! 连接的生命周期：
//!
//! ```text
//! accept → 读 Hello（校验协议 / 群组 / 信任名单）
//!        → 读 Auth（校验 proof，回自己的 proof）
//!        → 循环：读一条带 MAC 的 Request → 应用 → 写 Response
//! ```
//!
//! 设计取舍：
//!
//! - **一连接一线程**：局域网同步是低频短连接（一台设备同时只会同步几次），
//!   线程模型足够，也不需要引入 async 运行时；
//! - **一次请求一把锁**：引擎的锁只在处理请求时持有，UI 的本地写入不会被长连接挡住；
//! - **超时必修**：读写都设超时，避免半开连接把线程永久占住（手机切网时很常见）；
//! - **信任名单可选**：默认「持有群组密钥即可加入」（配对码就是信任凭证），
//!   想要更严可以配 [`TrustPolicy::AllowList`] 只放行已知设备。

use std::io::BufReader;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use crate::crypto::{self, derive_keys, nonce, proof, ROLE_CLIENT, ROLE_SERVER, ROLE_SESSION};
use crate::error::{Result, SyncError};
use crate::net::frame::{read_message, read_secure, write_message, write_secure};
use crate::net::handler::handle_request;
use crate::net::{lock_engine, SharedEngine};
use crate::proto::{MAX_FRAME_BYTES, MAX_HANDSHAKE_BYTES, Request, Response};

/// 信任策略。
#[derive(Clone, Debug, Default)]
pub enum TrustPolicy {
    /// 持有群组密钥即可加入（配对码即凭证）——默认
    #[default]
    Open,
    /// 只放行名单内的设备 id（更严，但每次加设备都要改配置）
    AllowList(Vec<String>),
}

impl TrustPolicy {
    pub fn allows(&self, device: &str) -> bool {
        match self {
            TrustPolicy::Open => true,
            TrustPolicy::AllowList(list) => list.iter().any(|d| d == device),
        }
    }
}

/// 服务端选项。
#[derive(Clone, Debug)]
pub struct ServerOptions {
    pub bind: SocketAddr,
    /// 群组密钥
    pub secret: Vec<u8>,
    pub group: String,
    pub device: String,
    pub name: String,
    pub trust: TrustPolicy,
    pub timeout: Duration,
    pub max_connections: usize,
}

impl ServerOptions {
    /// 由引擎派生默认选项（监听全部网卡的默认端口）。
    pub fn from_engine(engine: &crate::engine::SyncEngine) -> Result<ServerOptions> {
        Ok(ServerOptions {
            bind: SocketAddr::from(([0, 0, 0, 0], crate::DEFAULT_PORT)),
            secret: engine.secret_bytes()?,
            group: engine.group_id().to_string(),
            device: engine.device_id().to_string(),
            name: engine.device_name().to_string(),
            trust: TrustPolicy::Open,
            timeout: Duration::from_secs(20),
            max_connections: 8,
        })
    }

    pub fn with_bind(mut self, bind: SocketAddr) -> ServerOptions {
        self.bind = bind;
        self
    }

    pub fn with_trust(mut self, trust: TrustPolicy) -> ServerOptions {
        self.trust = trust;
        self
    }
}

/// 运行中的同步服务端。
pub struct PeerServer {
    local_addr: SocketAddr,
    stop: Arc<AtomicBool>,
    active: Arc<AtomicUsize>,
    handle: Option<JoinHandle<()>>,
}

impl PeerServer {
    /// 启动监听。
    pub fn start(engine: SharedEngine, options: ServerOptions) -> Result<PeerServer> {
        let listener = TcpListener::bind(options.bind)
            .map_err(|e| SyncError::Transport(format!("监听 {} 失败：{e}", options.bind)))?;
        let local_addr = listener.local_addr()?;
        listener.set_nonblocking(true)?;
        let stop = Arc::new(AtomicBool::new(false));
        let active = Arc::new(AtomicUsize::new(0));

        let thread_stop = stop.clone();
        let thread_active = active.clone();
        let handle = std::thread::Builder::new()
            .name("readerx-sync-server".to_string())
            .spawn(move || {
                log::info!(
                    "同步服务端已启动 addr={} device={}",
                    local_addr,
                    crate::version::short_device(&options.device)
                );
                while !thread_stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, addr)) => {
                            if thread_active.load(Ordering::Relaxed) >= options.max_connections {
                                log::warn!("同步连接数已达上限，拒绝 {addr}");
                                let mut stream = stream;
                                let _ = write_message(
                                    &mut stream,
                                    &Response::error("busy", "连接数已达上限"),
                                    MAX_HANDSHAKE_BYTES,
                                );
                                continue;
                            }
                            let engine = engine.clone();
                            let options = options.clone();
                            let active = thread_active.clone();
                            active.fetch_add(1, Ordering::Relaxed);
                            let spawned = std::thread::Builder::new()
                                .name("readerx-sync-conn".to_string())
                                .spawn(move || {
                                    if let Err(e) = serve_connection(stream, addr, engine, options) {
                                        log::debug!("同步连接结束 addr={addr}: {e}");
                                    }
                                    active.fetch_sub(1, Ordering::Relaxed);
                                });
                            if let Err(e) = spawned {
                                log::warn!("无法创建同步连接线程: {e}");
                                thread_active.fetch_sub(1, Ordering::Relaxed);
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(50));
                        }
                        Err(e) => {
                            log::warn!("同步监听出错: {e}");
                            std::thread::sleep(Duration::from_millis(200));
                        }
                    }
                }
                log::info!("同步服务端已停止 addr={local_addr}");
            })
            .map_err(|e| SyncError::Transport(format!("无法创建监听线程：{e}")))?;

        Ok(PeerServer { local_addr, stop, active, handle: Some(handle) })
    }

    /// 实际监听的地址（`bind` 用 0 端口时由系统分配，测试与 CLI 都靠它拿到端口）。
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn active_connections(&self) -> usize {
        self.active.load(Ordering::Relaxed)
    }

    /// 停止监听（幂等）。
    pub fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for PeerServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// 处理一条连接（握手 + 请求循环）。
fn serve_connection(
    stream: TcpStream,
    addr: SocketAddr,
    engine: SharedEngine,
    options: ServerOptions,
) -> Result<()> {
    stream.set_read_timeout(Some(options.timeout))?;
    stream.set_write_timeout(Some(options.timeout))?;
    stream.set_nodelay(true).ok();
    let writer = stream.try_clone().map_err(|e| SyncError::Transport(e.to_string()))?;
    let mut reader = BufReader::new(stream);
    let mut writer = writer;

    // 1) Hello
    let hello: Request = read_message(&mut reader, MAX_HANDSHAKE_BYTES)?
        .ok_or_else(|| SyncError::Transport("对端未打招呼就断开".to_string()))?;
    let (protocol, group, client_device, client_name, client_knowledge, client_nonce) = match hello {
        Request::Hello { protocol, group, device, name, knowledge, nonce } => {
            (protocol, group, device, name, knowledge, nonce)
        }
        other => {
            let _ = write_message(
                &mut writer,
                &Response::error("unexpected", format!("期望 hello，收到 {}", other.kind())),
                MAX_HANDSHAKE_BYTES,
            );
            return Err(SyncError::Protocol(format!("期望 hello，收到 {}", other.kind())));
        }
    };

    let server_nonce = nonce();
    let reject = |writer: &mut TcpStream, reason: &str| -> Result<()> {
        write_message(
            writer,
            &Response::Hello {
                ok: false,
                protocol: crate::PROTOCOL_VERSION.to_string(),
                group: options.group.clone(),
                device: options.device.clone(),
                name: options.name.clone(),
                nonce: server_nonce.clone(),
                message: Some(reason.to_string()),
            },
            MAX_HANDSHAKE_BYTES,
        )
    };

    if protocol != crate::PROTOCOL_VERSION {
        reject(&mut writer, "协议版本不一致")?;
        return Err(SyncError::Protocol(format!("协议版本不一致：{protocol}")));
    }
    if group != options.group {
        // 群组不同 = 不是同一份数据，绝不能同步（多租户隔离，见场景 25）
        log::warn!("拒绝来自其他群组的连接 addr={addr} group={}", crate::version::short_device(&group));
        reject(&mut writer, "群组不一致")?;
        return Err(SyncError::Auth("群组不一致".to_string()));
    }
    if !options.trust.allows(&client_device) {
        log::warn!("设备不在信任名单 addr={addr} device={}", crate::version::short_device(&client_device));
        reject(&mut writer, "设备不在信任名单")?;
        return Err(SyncError::Auth("设备不在信任名单".to_string()));
    }

    write_message(
        &mut writer,
        &Response::Hello {
            ok: true,
            protocol: crate::PROTOCOL_VERSION.to_string(),
            group: options.group.clone(),
            device: options.device.clone(),
            name: options.name.clone(),
            nonce: server_nonce.clone(),
            message: None,
        },
        MAX_HANDSHAKE_BYTES,
    )?;

    // 2) Auth
    let auth: Request = read_message(&mut reader, MAX_HANDSHAKE_BYTES)?
        .ok_or_else(|| SyncError::Transport("鉴权阶段断开".to_string()))?;
    let client_proof = match auth {
        Request::Auth { proof } => proof,
        other => {
            let _ = write_message(
                &mut writer,
                &Response::Auth { ok: false, proof: String::new(), message: Some("期望 auth".to_string()) },
                MAX_HANDSHAKE_BYTES,
            );
            return Err(SyncError::Protocol(format!("期望 auth，收到 {}", other.kind())));
        }
    };
    let client_text = crypto::transcript(
        &options.group,
        &client_device,
        &options.device,
        &client_nonce,
        &server_nonce,
        ROLE_CLIENT,
    );
    let expected = proof(&options.secret, &client_text);
    if !crypto::constant_time_eq(expected.as_bytes(), client_proof.as_bytes()) {
        log::warn!("鉴权失败 addr={addr} device={}", crate::version::short_device(&client_device));
        write_message(
            &mut writer,
            &Response::Auth { ok: false, proof: String::new(), message: Some("鉴权失败".to_string()) },
            MAX_HANDSHAKE_BYTES,
        )?;
        return Err(SyncError::Auth("客户端 proof 校验失败".to_string()));
    }
    let server_text = crypto::transcript(
        &options.group,
        &client_device,
        &options.device,
        &client_nonce,
        &server_nonce,
        ROLE_SERVER,
    );
    write_message(
        &mut writer,
        &Response::Auth { ok: true, proof: proof(&options.secret, &server_text), message: None },
        MAX_HANDSHAKE_BYTES,
    )?;

    let session_text = crypto::transcript(
        &options.group,
        &client_device,
        &options.device,
        &client_nonce,
        &server_nonce,
        ROLE_SESSION,
    );
    let keys = derive_keys(&options.secret, &session_text);

    log::debug!(
        "对端已连接 addr={addr} device={} name={client_name}",
        crate::version::short_device(&client_device)
    );
    // 记下「见过这台设备」（对端地址与它自称的已知版本，便于展示与下次主动连接）
    {
        let mut engine = lock_engine(&engine);
        engine.record_peer_sync(
            &client_device,
            &client_name,
            Some(addr.to_string()),
            client_knowledge.clone(),
            None,
        );
    }

    // 3) 请求循环
    let mut recv_seq = 0u64;
    let mut send_seq = 0u64;
    // 读到 None 表示对端正常关闭
    while let Some((seq, request)) =
        read_secure::<_, Request>(&mut reader, &keys.client_to_server, recv_seq, MAX_FRAME_BYTES)?
    {
        recv_seq = seq;

        let response = {
            let mut engine = lock_engine(&engine);
            handle_request(&mut engine, Some(&client_device), &request)
        };
        send_seq += 1;
        write_secure(&mut writer, &keys.server_to_client, send_seq, &response, MAX_FRAME_BYTES)?;

        // 推送之后把对端进度落盘（它下次连接就能只发差集）
        if let Response::Ack { knowledge, .. } = &response {
            let mut engine = lock_engine(&engine);
            engine.record_peer_sync(
                &client_device,
                &client_name,
                Some(addr.to_string()),
                knowledge.clone(),
                None,
            );
            if let Err(e) = engine.flush() {
                log::warn!("同步服务端落盘失败: {e}");
            }
        }
    }
    Ok(())
}

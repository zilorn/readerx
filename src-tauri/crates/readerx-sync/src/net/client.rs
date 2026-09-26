//! TCP 客户端：握手鉴权，然后收发带 MAC 的请求。
//!
//! 握手三步（见 [`crate::crypto`]）：
//!
//! ```text
//! 客户端 → Hello{protocol, group, device, name, knowledge, nonce_c}
//! 服务端 → Hello{ok, protocol, group, device, name, nonce_s}
//! 客户端 → Auth{proof = HMAC(secret, 文本(client))}
//! 服务端 → Auth{ok, proof = HMAC(secret, 文本(server))}   ← 双向认证
//! ```
//!
//! 之后每帧都是 `Envelope{seq, mac, body}`。连接由 [`crate::session::sync_with`]
//! 在一次同步的时长内持有，同步结束即断开（局域网内建连成本可以忽略，
//! 换来的是「不留长连接、不需要心跳与重连状态机」）。

use std::io::BufReader;
use std::net::TcpStream;
use std::time::Duration;

use crate::crypto::{self, derive_keys, nonce, proof, SessionKeys, ROLE_CLIENT, ROLE_SERVER, ROLE_SESSION};
use crate::error::{Result, SyncError, WireError};
use crate::net::frame::{read_message, read_secure, write_message, write_secure};
use crate::net::{PeerInfo, Transport};
use crate::proto::{MAX_FRAME_BYTES, MAX_HANDSHAKE_BYTES, Request, Response};
use crate::version::VersionVector;

/// 默认连接 / 读写超时：局域网里超过这个时间基本就是对方没在跑。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

/// 发起连接时自报的身份（对端据此认识我们、并记住怎么连回来）。
#[derive(Clone, Debug)]
pub struct ClientIdentity<'a> {
    pub group: &'a str,
    pub device: &'a str,
    pub name: &'a str,
    /// 我这边已有的操作（增量同步游标）
    pub knowledge: VersionVector,
    /// 本机同步服务的**监听端口**（`0` = 本机没在监听）：对端据此记住怎么主动连回来。
    ///
    /// **不要传这条连接的源端口**：那是内核临时分配的，连接一结束就回收，
    /// 对端拿它当地址会在下一次连接时被拒。
    pub listen_port: u16,
    /// 本机是否参与**正文**同步（注册了正文来源）：对端据此决定要不要发起正文对账。
    pub content: bool,
}

/// 一次同步连接。
pub struct TcpTransport {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
    peer: PeerInfo,
    keys: SessionKeys,
    send_seq: u64,
    recv_seq: u64,
}

impl TcpTransport {
    /// 连接并完成握手。
    pub fn connect(
        addr: &str,
        secret: &[u8],
        identity: &ClientIdentity<'_>,
        timeout: Duration,
    ) -> Result<TcpTransport> {
        let stream = TcpStream::connect(addr)
            .map_err(|e| SyncError::Transport(format!("连接 {addr} 失败：{e}")))?;
        stream.set_read_timeout(Some(timeout))?;
        stream.set_write_timeout(Some(timeout))?;
        stream.set_nodelay(true).ok();

        let mut writer = stream.try_clone().map_err(|e| SyncError::Transport(e.to_string()))?;
        let mut reader = BufReader::new(stream);

        // 1) Hello
        let ClientIdentity { group, device, name, knowledge, listen_port, content } = identity;
        let client_nonce = nonce();
        write_message(
            &mut writer,
            &Request::Hello {
                protocol: crate::PROTOCOL_VERSION.to_string(),
                group: (*group).to_string(),
                device: (*device).to_string(),
                name: (*name).to_string(),
                knowledge: knowledge.clone(),
                nonce: client_nonce.clone(),
                port: *listen_port,
                content: *content,
            },
            MAX_HANDSHAKE_BYTES,
        )?;

        let hello: Response = read_message(&mut reader, MAX_HANDSHAKE_BYTES)?.ok_or_else(|| {
            // 连上了、一句话没说就断：多半不是 ReaderX 的同步端口
            SyncError::from(WireError::NotReaderx)
        })?;
        let (ok, server_device, server_name, server_nonce, message, protocol, peer_group, code, content) =
            match hello {
                Response::Hello { ok, protocol, group: peer_group, device, name, nonce, message, code, content } => {
                    (ok, device, name, nonce, message, protocol, peer_group, code, content)
                }
                Response::Error { code, message } => {
                    return Err(SyncError::from(WireError::from_wire(&code))
                        .with_context(format!("{code}: {message}")))
                }
                other => {
                    return Err(SyncError::from(WireError::Unexpected)
                        .with_context(format!("握手期望 hello，收到 {}", other.kind())))
                }
            };
        if !ok {
            // 拒绝原因优先按对端给的码出文案（群组不一致 / 已被移除 / 版本不一致…）
            let wire = code.as_deref().map(WireError::from_wire);
            return Err(match (wire, message) {
                (Some(wire), _) => SyncError::from(wire),
                (None, Some(message)) => SyncError::Auth(message),
                (None, None) => SyncError::Auth("对端拒绝了本次连接".to_string()),
            });
        }
        if protocol != crate::PROTOCOL_VERSION {
            return Err(SyncError::from(WireError::ProtocolMismatch).with_context(format!(
                "协议版本不一致：本机 {} / 对端 {protocol}",
                crate::PROTOCOL_VERSION
            )));
        }
        if peer_group != *group {
            return Err(SyncError::from(WireError::GroupMismatch));
        }

        // 2) Auth：各自签自己角色的文本（避免把对方的 proof 反打回去的反射攻击）
        let client_text =
            crypto::transcript(group, device, &server_device, &client_nonce, &server_nonce, ROLE_CLIENT);
        write_message(&mut writer, &Request::Auth { proof: proof(secret, &client_text) }, MAX_HANDSHAKE_BYTES)?;

        let auth: Response = read_message(&mut reader, MAX_HANDSHAKE_BYTES)?
            .ok_or_else(|| SyncError::Transport("鉴权阶段连接被关闭".to_string()))?;
        let (auth_ok, server_proof, auth_message, auth_code) = match auth {
            Response::Auth { ok, proof, message, code } => (ok, proof, message, code),
            Response::Error { code, message } => {
                return Err(SyncError::from(WireError::from_wire(&code))
                    .with_context(format!("{code}: {message}")))
            }
            other => {
                return Err(SyncError::from(WireError::Unexpected)
                    .with_context(format!("鉴权期望 auth，收到 {}", other.kind())))
            }
        };
        if !auth_ok {
            let wire = auth_code.as_deref().map(WireError::from_wire);
            return Err(match (wire, auth_message) {
                (Some(wire), _) => SyncError::from(wire),
                (None, Some(message)) => SyncError::Auth(message),
                (None, None) => SyncError::Auth("鉴权被拒绝".to_string()),
            });
        }
        let server_text =
            crypto::transcript(group, device, &server_device, &client_nonce, &server_nonce, ROLE_SERVER);
        let expected = proof(secret, &server_text);
        if !crypto::constant_time_eq(expected.as_bytes(), server_proof.as_bytes()) {
            return Err(SyncError::coded(
                crate::error::Code::AuthFailed,
                "对端未能证明自己持有群组密钥",
            ));
        }

        let session_text =
            crypto::transcript(group, device, &server_device, &client_nonce, &server_nonce, ROLE_SESSION);
        let keys = derive_keys(secret, &session_text);

        log::debug!(
            "已连接到对端 {}（{}）",
            crate::version::short_device(&server_device),
            addr
        );
        Ok(TcpTransport {
            reader,
            writer,
            peer: PeerInfo {
                device_id: server_device,
                name: server_name,
                addr: Some(addr.to_string()),
                content,
            },
            keys,
            send_seq: 0,
            recv_seq: 0,
        })
    }
}

impl Transport for TcpTransport {
    fn peer(&self) -> PeerInfo {
        self.peer.clone()
    }

    fn request(&mut self, request: &Request) -> Result<Response> {
        self.send_seq += 1;
        write_secure(&mut self.writer, &self.keys.client_to_server, self.send_seq, request, MAX_FRAME_BYTES)?;
        let Some((seq, response)): Option<(u64, Response)> =
            read_secure(&mut self.reader, &self.keys.server_to_client, self.recv_seq, MAX_FRAME_BYTES)?
        else {
            return Err(SyncError::Transport("对端在处理请求前关闭了连接".to_string()));
        };
        self.recv_seq = seq;
        Ok(response)
    }
}

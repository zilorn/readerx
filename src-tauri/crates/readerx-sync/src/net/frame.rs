//! 帧与信封：把 JSON 消息按 `[长度][内容]` 写进 TCP 流，并在鉴权后加 MAC。
//!
//! TCP 是**字节流**，没有消息边界：「一次 write 对应一次 read」这种假设在局域网里
//! 也不成立（Nagle、缓冲区、分包）。所以每条消息前面放 4 字节大端长度，接收端先读
//! 长度再读满内容；长度超上限直接报错，避免对端（或坏数据）让我们分配一大块内存。
//!
//! 信封（[`Envelope`]）在帧之外再包一层 `seq + mac`：
//!
//! - `mac = HMAC(会话密钥, seq || 规范化 JSON)`；
//! - `seq` 必须严格递增——重放旧帧、调换顺序都会被拒。
//!
//! MAC 覆盖的是**规范化后的 JSON 文本**（收发双方用同一套 serde_json 序列化，
//! 键顺序一致），这样不必手工拼接原始字节，也不会因为键序不同而误判。

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

use crate::crypto::{frame_mac, verify_frame_mac};
use crate::error::{Result, SyncError};

/// 信封：鉴权后的每一帧。
#[derive(Debug, Serialize, Deserialize)]
pub struct Envelope {
    pub seq: u64,
    pub mac: String,
    pub body: serde_json::Value,
}

/// 写一帧（长度前缀 + 内容）。
pub fn write_frame<W: Write>(writer: &mut W, payload: &[u8], max: usize) -> Result<()> {
    if payload.len() > max {
        return Err(SyncError::Protocol(format!(
            "帧过大：{} 字节（上限 {max}）",
            payload.len()
        )));
    }
    writer.write_all(&(payload.len() as u32).to_be_bytes())?;
    writer.write_all(payload)?;
    writer.flush()?;
    Ok(())
}

/// 读一帧；对端正常关闭（还没读到长度就 EOF）返回 `Ok(None)`。
pub fn read_frame<R: Read>(reader: &mut R, max: usize) -> Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => return Ok(None),
        Err(e) => return Err(SyncError::Transport(e.to_string())),
    }
    let len = u32::from_be_bytes(header) as usize;
    if len > max {
        return Err(SyncError::Protocol(format!("对端声明的帧长 {len} 超过上限 {max}")));
    }
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload).map_err(|e| SyncError::Transport(e.to_string()))?;
    Ok(Some(payload))
}

/// 写一条明文消息（握手阶段用）。
pub fn write_message<W: Write, T: Serialize>(writer: &mut W, message: &T, max: usize) -> Result<()> {
    let payload = serde_json::to_vec(message)?;
    write_frame(writer, &payload, max)
}

/// 读一条明文消息。
pub fn read_message<R: Read, T: DeserializeOwned>(
    reader: &mut R,
    max: usize,
) -> Result<Option<T>> {
    match read_frame(reader, max)? {
        None => Ok(None),
        Some(payload) => Ok(Some(serde_json::from_slice(&payload)?)),
    }
}

/// 写一条带 MAC 的消息。
pub fn write_secure<W: Write, T: Serialize>(
    writer: &mut W,
    key: &[u8],
    seq: u64,
    message: &T,
    max: usize,
) -> Result<()> {
    let body = serde_json::to_value(message)?;
    let canonical = serde_json::to_string(&body)?;
    let envelope = Envelope { seq, mac: frame_mac(key, seq, &canonical), body };
    write_message(writer, &envelope, max)
}

/// 读一条带 MAC 的消息并校验（序号必须大于 `last_seq`）。
///
/// 返回 `(新序号, 消息)`。
pub fn read_secure<R: Read, T: DeserializeOwned>(
    reader: &mut R,
    key: &[u8],
    last_seq: u64,
    max: usize,
) -> Result<Option<(u64, T)>> {
    let Some(envelope): Option<Envelope> = read_message(reader, max)? else {
        return Ok(None);
    };
    if envelope.seq <= last_seq && last_seq != 0 {
        return Err(SyncError::Protocol(format!(
            "帧序号回退（{} <= {}），可能是重放",
            envelope.seq, last_seq
        )));
    }
    if last_seq == 0 && envelope.seq == 0 {
        return Err(SyncError::Protocol("帧序号必须从 1 开始".to_string()));
    }
    let canonical = serde_json::to_string(&envelope.body)?;
    if !verify_frame_mac(key, envelope.seq, &canonical, &envelope.mac) {
        return Err(SyncError::Auth("帧校验失败（内容被改或密钥不一致）".to_string()));
    }
    let message: T = serde_json::from_value(envelope.body)?;
    Ok(Some((envelope.seq, message)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::{Request, Response};
    use std::io::Cursor;

    #[test]
    fn frame_roundtrip() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, b"hello", 1024).unwrap();
        write_frame(&mut buffer, b"world", 1024).unwrap();
        let mut cursor = Cursor::new(buffer);
        assert_eq!(read_frame(&mut cursor, 1024).unwrap().unwrap(), b"hello");
        assert_eq!(read_frame(&mut cursor, 1024).unwrap().unwrap(), b"world");
        assert!(read_frame(&mut cursor, 1024).unwrap().is_none(), "读到尾应返回 None");
    }

    #[test]
    fn oversized_frame_is_rejected() {
        let mut buffer = Vec::new();
        assert!(write_frame(&mut buffer, &[0u8; 64], 16).is_err());
        // 对端声明超长：拒绝而不是分配
        let mut hostile = Vec::new();
        hostile.extend_from_slice(&(1_000_000u32).to_be_bytes());
        let mut cursor = Cursor::new(hostile);
        assert!(matches!(read_frame(&mut cursor, 1024), Err(SyncError::Protocol(_))));
    }

    #[test]
    fn secure_roundtrip_and_tamper_detection() {
        let key = b"session-key-session-key-session";
        let mut buffer = Vec::new();
        write_secure(&mut buffer, key, 1, &Request::Ping, 4096).unwrap();
        write_secure(
            &mut buffer,
            key,
            2,
            &Request::Pull { since: Default::default(), limit: 10 },
            4096,
        )
        .unwrap();

        let mut cursor = Cursor::new(buffer.clone());
        let (seq, message): (u64, Request) = read_secure(&mut cursor, key, 0, 4096).unwrap().unwrap();
        assert_eq!(seq, 1);
        assert_eq!(message, Request::Ping);
        let (seq, message): (u64, Request) = read_secure(&mut cursor, key, seq, 4096).unwrap().unwrap();
        assert_eq!(seq, 2);
        assert!(matches!(message, Request::Pull { .. }));

        // 换密钥：MAC 校验失败
        let mut cursor = Cursor::new(buffer.clone());
        let err = read_secure::<_, Request>(&mut cursor, b"another-key-another-key-another", 0, 4096)
            .unwrap_err();
        assert!(matches!(err, SyncError::Auth(_)), "{err}");

        // 序号回退（重放）：拒绝
        let mut cursor = Cursor::new(buffer);
        let _ = read_secure::<_, Request>(&mut cursor, key, 0, 4096).unwrap();
        let err = read_secure::<_, Request>(&mut cursor, key, 5, 4096).unwrap_err();
        assert!(matches!(err, SyncError::Protocol(_)), "{err}");
    }

    #[test]
    fn responses_are_serializable_in_envelopes() {
        let key = b"k";
        let mut buffer = Vec::new();
        write_secure(
            &mut buffer,
            key,
            1,
            &Response::Ack { accepted: 2, rejected: vec![], conflicts: 1, knowledge: Default::default() },
            4096,
        )
        .unwrap();
        let mut cursor = Cursor::new(buffer);
        let (_, response): (u64, Response) = read_secure(&mut cursor, key, 0, 4096).unwrap().unwrap();
        assert!(matches!(response, Response::Ack { accepted: 2, .. }));
    }
}

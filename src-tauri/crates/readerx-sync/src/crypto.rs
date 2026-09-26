//! 局域网传输的鉴权与完整性：HMAC-SHA256 握手 + 每帧 MAC。
//!
//! 局域网同步**没有账号体系**，安全边界就是「同一个群组密钥」（配对码）。
//! 因此这里做三件事：
//!
//! 1. **双向认证**：双方各自用密钥对握手文本（协议 / 群组 / 双方设备 id / 双方随机数）
//!    算 HMAC；服务端先验客户端，客户端再验服务端——防止有人把假设备塞进群组，
//!    也防止客户端连到冒充的对端。
//! 2. **会话密钥派生**：握手文本再派生出两个方向的密钥，避免同一把密钥在两条
//!    方向上产生相同的 MAC（也便于以后换成 AEAD 加密）。
//! 3. **每帧 MAC + 单调序号**：帧被改动会被发现；序号必须严格递增，
//!    重放旧帧会被拒绝。**注意：载荷本身不加密**（局域网内同一信任域），
//!    这是明确的取舍，见 `docs/sync.md` 的「安全边界」。
//!
//! 所有比较都用等时比较（[`constant_time_eq`]），避免用比较耗时反推密钥。

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::error::{Result, SyncError};
use crate::id::random_bytes;

type HmacSha256 = Hmac<Sha256>;

/// 握手文本中的角色标记。
pub const ROLE_CLIENT: &str = "client";
pub const ROLE_SERVER: &str = "server";
/// 会话密钥派生用的中性角色（与两个 proof 文本都不同）
pub const ROLE_SESSION: &str = "session";

/// 生成一个随机 nonce（16 字节 hex）。
pub fn nonce() -> String {
    crate::store::hex_encode(&random_bytes(16))
}

/// 握手文本：双方用同一份文本算 proof，任何字段不同都会导致校验失败。
pub fn transcript(
    group: &str,
    client_device: &str,
    server_device: &str,
    client_nonce: &str,
    server_nonce: &str,
    role: &str,
) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        crate::PROTOCOL_VERSION,
        group,
        client_device,
        server_device,
        client_nonce,
        server_nonce,
        role
    )
}

/// 用群组密钥对文本算 HMAC（hex）。
pub fn proof(secret: &[u8], text: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC 接受任意长度密钥");
    mac.update(text.as_bytes());
    crate::store::hex_encode(&mac.finalize().into_bytes())
}

/// 会话密钥（两个方向各一把）。
#[derive(Clone)]
pub struct SessionKeys {
    pub client_to_server: [u8; 32],
    pub server_to_client: [u8; 32],
}

/// 由握手文本派生会话密钥。
pub fn derive_keys(secret: &[u8], handshake: &str) -> SessionKeys {
    let c2s = proof(secret, &format!("{handshake}|c2s"));
    let s2c = proof(secret, &format!("{handshake}|s2c"));
    SessionKeys {
        client_to_server: to_key(&c2s),
        server_to_client: to_key(&s2c),
    }
}

fn to_key(hex: &str) -> [u8; 32] {
    let bytes = crate::store::hex_decode(hex).unwrap_or_default();
    let mut key = [0u8; 32];
    let len = bytes.len().min(32);
    key[..len].copy_from_slice(&bytes[..len]);
    key
}

/// 一帧的 MAC：`HMAC(会话密钥, 序号 || 帧体)`。
pub fn frame_mac(key: &[u8], seq: u64, body: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    mac.update(&seq.to_be_bytes());
    mac.update(body.as_bytes());
    crate::store::hex_encode(&mac.finalize().into_bytes())
}

/// 校验一帧的 MAC。
pub fn verify_frame_mac(key: &[u8], seq: u64, body: &str, mac_hex: &str) -> bool {
    let expected = frame_mac(key, seq, body);
    constant_time_eq(expected.as_bytes(), mac_hex.as_bytes())
}

/// 等时比较（长度不同直接返回 false；内容逐字节异或累加）。
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 校验一段 hex 是否合法（供上层给出更好的报错）。
pub fn ensure_hex(text: &str, what: &str) -> Result<()> {
    if crate::store::hex_decode(text).is_none() {
        return Err(SyncError::Invalid(format!("{what} 不是合法的十六进制")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_matches_for_same_input_and_differs_otherwise() {
        let secret = b"0123456789abcdef0123456789abcdef";
        let text = transcript("g", "c", "s", "n1", "n2", ROLE_CLIENT);
        assert_eq!(proof(secret, &text), proof(secret, &text));
        let other = transcript("g", "c", "s", "n1", "n2", ROLE_SERVER);
        assert_ne!(proof(secret, &text), proof(secret, &other), "角色不同 proof 必须不同");
        assert_ne!(proof(b"another-secret-key-0123456789", &text), proof(secret, &text));
    }

    #[test]
    fn keys_are_directional() {
        let secret = b"0123456789abcdef0123456789abcdef";
        let handshake = transcript("g", "c", "s", "n1", "n2", ROLE_CLIENT);
        let keys = derive_keys(secret, &handshake);
        assert_ne!(keys.client_to_server, keys.server_to_client);
        // 同一个握手文本两次派生结果一致（双方各自算，必须一致）
        let again = derive_keys(secret, &handshake);
        assert_eq!(keys.client_to_server, again.client_to_server);
    }

    #[test]
    fn frame_mac_detects_tampering_and_replay() {
        let key = [7u8; 32];
        let body = r#"{"type":"pull"}"#;
        let mac = frame_mac(&key, 1, body);
        assert!(verify_frame_mac(&key, 1, body, &mac));
        // 序号变了（重放旧帧）→ 不通过
        assert!(!verify_frame_mac(&key, 2, body, &mac));
        // 内容被改 → 不通过
        assert!(!verify_frame_mac(&key, 1, r#"{"type":"stat"}"#, &mac));
        // 换密钥 → 不通过
        assert!(!verify_frame_mac(&[8u8; 32], 1, body, &mac));
    }

    #[test]
    fn constant_time_eq_basics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    #[test]
    fn nonces_are_unique() {
        let a = nonce();
        let b = nonce();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        ensure_hex(&a, "nonce").unwrap();
        assert!(ensure_hex("zz", "nonce").is_err());
    }
}

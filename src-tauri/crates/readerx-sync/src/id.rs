//! 标识符：ULID（时间有序的 128 位 id）。
//!
//! 为什么不是「自增主键」：两台设备离线各自新增记录时，自增号必然撞车
//! （场景 7「双方新增同 ID」）。ULID 前 48 位是毫秒时间戳、后 80 位随机，
//! 字符串按字典序即按时间序，可直接当排序键与文件名，也不需要 uuid crate。
//!
//! 新增同一个毫秒内的多个 id 时，随机部分**单调 +1**（而不是重新取随机数），
//! 保证同毫秒内生成的 id 依然严格递增——否则同一毫秒里建的两条记录顺序不确定，
//! 会让「按 id 排序取最新」这类用法不稳定。

use crate::error::{Result, SyncError};
use std::cell::RefCell;
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

/// Crockford base32 字母表（去掉 I / L / O / U，避免手抄 id 时认错）。
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// 同一毫秒内的单调状态：上一次生成的时间戳与随机部分。
///
/// 按**线程**保存：不同线程各自递增互不干扰（跨线程只保证唯一，不保证先后），
/// 这样单元测试并行跑也不会互相把对方的单调序列搅乱。
#[derive(Default)]
struct MonoState {
    last_ms: u64,
    last_rand: u128,
}

thread_local! {
    static MONO: RefCell<MonoState> = const { RefCell::new(MonoState { last_ms: 0, last_rand: 0 }) };
}

/// 当前墙钟毫秒（取不到系统时间时返回 0：id 仍唯一，只是排序退化）。
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 取 `n` 字节随机数；系统随机源不可用时退回「时间 + 计数」派生值。
///
/// 这里的降级只影响 id 的不可预测性，不影响唯一性（调用方还会叠加时间戳），
/// 所以宁可给出弱随机也不要 panic —— 同步框架不该因为熵池问题让 App 崩。
pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    if getrandom::getrandom(&mut buf).is_ok() {
        return buf;
    }
    // 退化路径：用时间与一个进程内计数拼出确定性但仍在变化的字节
    let mut seed = now_ms()
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(std::process::id() as u64);
    for b in buf.iter_mut() {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        *b = (seed & 0xFF) as u8;
    }
    buf
}

/// 128 位 ULID。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Ulid(u128);

impl Ulid {
    /// 生成一个新的 ULID（同毫秒内单调递增）。
    pub fn new() -> Ulid {
        Ulid::new_at(now_ms())
    }

    /// 以指定时间戳生成（测试用；生产走 [`Ulid::new`]）。
    pub fn new_at(ms: u64) -> Ulid {
        let mut rand = [0u8; 10];
        rand.copy_from_slice(&random_bytes(10));
        let random = u128::from_be_bytes({
            let mut wide = [0u8; 16];
            wide[6..].copy_from_slice(&rand);
            wide
        });

        let random = MONO.with(|state| {
            let mut state = state.borrow_mut();
            if ms == state.last_ms {
                // 同毫秒：+1 保序（溢出概率 2^-80，真溢出就归零重来）
                state.last_rand = state.last_rand.wrapping_add(1);
                state.last_rand
            } else if ms > state.last_ms {
                state.last_ms = ms;
                state.last_rand = random;
                random
            } else {
                // 时间比上次还早（只有测试会这么调）：给一个新鲜随机值，但不污染单调状态
                let mut buf = [0u8; 10];
                buf.copy_from_slice(&random_bytes(10));
                let mut wide = [0u8; 16];
                wide[6..].copy_from_slice(&buf);
                u128::from_be_bytes(wide)
            }
        });

        Ulid(((ms as u128) << 80) | (random & ((1u128 << 80) - 1)))
    }

    /// 由时间戳与 10 字节随机部分构造（测试 / 迁移用）。
    pub fn from_parts(ms: u64, random: [u8; 10]) -> Ulid {
        let mut wide = [0u8; 16];
        wide[6..].copy_from_slice(&random);
        let r = u128::from_be_bytes(wide);
        Ulid(((ms as u128) << 80) | (r & ((1u128 << 80) - 1)))
    }

    /// 内嵌的时间戳（毫秒）。
    pub fn timestamp_ms(&self) -> u64 {
        (self.0 >> 80) as u64
    }

    /// 128 位原始值。
    pub fn to_u128(&self) -> u128 {
        self.0
    }

    /// 由 128 位原始值构造。
    pub fn from_u128(v: u128) -> Ulid {
        Ulid(v)
    }
}

impl Default for Ulid {
    fn default() -> Self {
        Ulid::new()
    }
}

impl fmt::Display for Ulid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut buf = [0u8; 26];
        let mut v = self.0;
        for i in (0..26).rev() {
            buf[i] = ALPHABET[(v & 0x1F) as usize];
            v >>= 5;
        }
        // 26 × 5 = 130 位，最高位那 2 位必然是 0，按 ASCII 输出即可
        f.write_str(std::str::from_utf8(&buf).unwrap_or(""))
    }
}

impl fmt::Debug for Ulid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Ulid({self})")
    }
}

impl std::str::FromStr for Ulid {
    type Err = SyncError;

    fn from_str(s: &str) -> Result<Ulid> {
        let bytes = s.as_bytes();
        if bytes.len() != 26 {
            return Err(SyncError::Invalid(format!("ULID 长度应为 26，实际 {}", bytes.len())));
        }
        let mut v: u128 = 0;
        for (i, b) in bytes.iter().enumerate() {
            let digit = decode_digit(*b)
                .ok_or_else(|| SyncError::Invalid(format!("ULID 含非法字符：{}", *b as char)))?;
            if i == 0 && digit > 7 {
                return Err(SyncError::Invalid("ULID 首字符超出 128 位范围".to_string()));
            }
            v = (v << 5) | digit as u128;
        }
        Ok(Ulid(v))
    }
}

fn decode_digit(b: u8) -> Option<u8> {
    let up = b.to_ascii_uppercase();
    ALPHABET.iter().position(|c| *c == up).map(|i| i as u8)
}

impl serde::Serialize for Ulid {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> serde::Deserialize<'de> for Ulid {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Ulid, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

/// 设备 id（全局唯一，ULID 字符串）。
pub type DeviceId = String;
/// 实体 id（全局唯一，ULID 字符串；也允许业务自带 id）。
pub type EntityId = String;
/// 操作 id（全局唯一，ULID 字符串）。
pub type OpId = String;

/// 生成一个新的 ULID 字符串。
pub fn new_id() -> String {
    Ulid::new().to_string()
}

/// 生成一个 `前綴_<ULID>` 形式的 id（便于人眼分辨对象类型）。
pub fn new_prefixed(prefix: &str) -> String {
    format!("{prefix}_{}", Ulid::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn roundtrip_string_form() {
        let id = Ulid::new_at(1_730_000_000_123);
        let text = id.to_string();
        assert_eq!(text.len(), 26);
        let back = Ulid::from_str(&text).expect("应能解析");
        assert_eq!(id, back);
        assert_eq!(back.timestamp_ms(), 1_730_000_000_123);
    }

    #[test]
    fn string_order_follows_time_order() {
        let a = Ulid::new_at(1_700_000_000_000);
        let b = Ulid::new_at(1_700_000_000_001);
        assert!(a.to_string() < b.to_string());
    }

    #[test]
    fn same_millisecond_is_monotonic() {
        let ids: Vec<String> = (0..64).map(|_| Ulid::new_at(1_700_000_000_000).to_string()).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted, "同毫秒生成的 id 必须严格递增");
        // 严格递增（无重复）
        for pair in ids.windows(2) {
            assert!(pair[0] < pair[1]);
        }
    }

    #[test]
    fn rejects_bad_input() {
        assert!(Ulid::from_str("short").is_err());
        assert!(Ulid::from_str("!!!!!!!!!!!!!!!!!!!!!!!!!!").is_err());
        // 首字符 > 7 超出 128 位
        assert!(Ulid::from_str("Z0000000000000000000000000").is_err());
    }

    #[test]
    fn random_bytes_are_not_all_zero() {
        let bytes = random_bytes(16);
        assert_eq!(bytes.len(), 16);
        assert!(bytes.iter().any(|b| *b != 0));
    }

    #[test]
    fn json_is_plain_string() {
        let id = Ulid::new_at(1_700_000_000_000);
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, format!("\"{id}\""));
        let back: Ulid = serde_json::from_str(&json).unwrap();
        assert_eq!(id, back);
    }
}

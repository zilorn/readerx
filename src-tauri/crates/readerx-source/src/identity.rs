//! 书源在持久化、App、CLI 与同步中使用同一个稳定 ID。
use sha2::{Digest, Sha256};

pub fn source_id(url: &str) -> String {
    let seed = format!(
        "source\n{}",
        url.trim().trim_end_matches('/').to_lowercase()
    );
    let digest = Sha256::digest(seed.as_bytes());
    format!(
        "s-{}",
        digest[..8]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

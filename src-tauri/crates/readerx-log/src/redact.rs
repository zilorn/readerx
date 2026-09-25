//! 写入日志前的脱敏。
//!
//! 日志是「会被导出、会被贴进 issue」的东西，Cookie / token / 密码一旦落进文件就收不回来。
//! 约定：**凭据只记数量或前几位，URL 里的敏感查询参数打码**。
//!
//! ```no_run
//! # use readerx_log::redact;
//! assert_eq!(redact::secret("cf_clearance=abcdef123456"), "cf_c…（共 23 字符）");
//! assert_eq!(
//!     redact::url("https://user:pass@example.com/api?token=abc&id=7"),
//!     "https://example.com/api?token=***&id=7"
//! );
//! ```

/// 敏感值打码：保留前 4 个字符便于比对「是不是同一个值」，其余一律不写。
pub fn secret(value: &str) -> String {
    let count = value.chars().count();
    if count == 0 {
        return "（空）".to_string();
    }
    let head: String = value.chars().take(4).collect();
    format!("{head}…（共 {count} 字符）")
}

/// 日志里出现的参数名命中这些关键字（不区分大小写、含即算）时，值替换成 `***`
const SENSITIVE_KEYS: &[&str] = &[
    "token",
    "password",
    "passwd",
    "pwd",
    "secret",
    "sign",
    "signature",
    "auth",
    "ticket",
    "session",
    "cookie",
    "credential",
];

/// URL 脱敏：
/// - 去掉 `//user:password@` 里的凭据（只留主机）；
/// - 查询串里敏感参数的值替换为 `***`（参数名保留，便于确认书源确实带了这个参数）。
///
/// 非 http(s) 或解析不出结构的输入原样返回 —— 脱敏失败不应该让日志丢掉信息。
pub fn url(raw: &str) -> String {
    let raw = raw.trim();
    let (head, query) = match raw.split_once('?') {
        Some((head, query)) => (head, Some(query)),
        None => (raw, None),
    };
    let head = strip_userinfo(head);
    match query {
        Some(query) => format!("{head}?{}", mask_query(query)),
        None => head,
    }
}

/// `scheme://user:pass@host/path` → `scheme://host/path`
fn strip_userinfo(head: &str) -> String {
    let Some(scheme_end) = head.find("://") else {
        return head.to_string();
    };
    let authority_start = scheme_end + 3;
    let rest = &head[authority_start..];
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    match authority.rfind('@') {
        Some(at) => format!(
            "{}{}",
            &head[..authority_start],
            &rest[at + 1..]
        ),
        None => head.to_string(),
    }
}

/// `a=1&token=abc&b=2` → `a=1&token=***&b=2`
fn mask_query(query: &str) -> String {
    query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((key, _value)) if is_sensitive(key) => format!("{key}=***"),
            _ => pair.to_string(),
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// 把一段文本里出现的 URL **逐个**脱敏，用于「原因是底层错误文本」的日志。
///
/// 为什么不能只对「自己拼的 `url=` 字段」脱敏：底层错误常把完整地址原样带进来
/// （reqwest 的 `error sending request for url (https://…?token=…)`），
/// 于是同一个地址从 `reason` 这一路又泄回日志文件。书源引擎的 HTTP / 图片 /
/// 认证失败原因全部走这里，App 侧回传的前端日志也过一道。
///
/// 非 URL 文本原样保留；URL 的边界取到空白或 `)` `(` `"` `'` `<` `>` 为止 ——
/// 错误文本里的地址总是被包在某种引号或括号里。
pub fn urls_in_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = next_url_start(rest) {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, ')' | '(' | '"' | '\'' | '<' | '>'))
            .unwrap_or(tail.len());
        out.push_str(&url(&tail[..end]));
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// 文本里下一个 `http://` / `https://` 的起始下标
fn next_url_start(text: &str) -> Option<usize> {
    match (text.find("http://"), text.find("https://")) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn is_sensitive(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SENSITIVE_KEYS.iter().any(|needle| lower.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_keeps_only_a_hint() {
        assert_eq!(secret(""), "（空）");
        assert_eq!(secret("abcd"), "abcd…（共 4 字符）");
        assert_eq!(secret("abcdefgh"), "abcd…（共 8 字符）");
        // 多字节字符按字符数计，不会切出半个汉字
        assert_eq!(secret("中文令牌值"), "中文令牌…（共 5 字符）");
    }

    #[test]
    fn url_masks_credentials_and_sensitive_query_values() {
        assert_eq!(
            url("https://user:pass@example.com/api?token=abc&id=7"),
            "https://example.com/api?token=***&id=7"
        );
        assert_eq!(
            url("https://example.com/login?access_token=xyz&sign=deadbeef"),
            "https://example.com/login?access_token=***&sign=***"
        );
        // 普通参数与路径原样保留
        assert_eq!(
            url("https://example.com/search?q=%E4%B9%A6&page=2"),
            "https://example.com/search?q=%E4%B9%A6&page=2"
        );
        assert_eq!(url("https://example.com/a/b"), "https://example.com/a/b");
    }

    #[test]
    fn url_survives_inputs_that_are_not_urls() {
        assert_eq!(url("/relative/path?token=1"), "/relative/path?token=***");
        assert_eq!(url(""), "");
        assert_eq!(url("not a url"), "not a url");
    }

    /// 错误文本里的 URL 必须跟着一起脱敏：reqwest 那种「把完整地址写进原因」的错误
    /// 会从 `reason` 这条路把 token 重新带回日志（真实踩过）。
    #[test]
    fn urls_in_text_redacts_every_url_in_a_message() {
        let message =
            "请求失败: error sending request for url (https://example.com/api?token=abcdef&id=7)";
        let redacted = urls_in_text(message);
        assert!(redacted.contains("token=***"), "{redacted}");
        assert!(!redacted.contains("abcdef"), "{redacted}");
        // 一条消息里的多个地址都要处理，非 URL 文本原样保留
        let two = urls_in_text("a https://x.com/?sign=1 b https://y.com/p 完");
        assert_eq!(two, "a https://x.com/?sign=*** b https://y.com/p 完");
        assert_eq!(urls_in_text("没有地址的原因"), "没有地址的原因");
        assert_eq!(urls_in_text(""), "");
    }
}

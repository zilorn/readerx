//! 浏览器身份（profile）：User-Agent / 默认请求头 / Cookie 文件。
//!
//! 独立二进制的「浏览器标志信息」入口：把真实浏览器的身份套到书源会话上，
//! 用来复现登录态、通过 Cloudflare 校验（`cf_clearance` 与 IP + UA + TLS 指纹绑定，
//! 见 docs/cloudflare.md）、以及离线测试需要登录才能看的规则。
//!
//! ## Cookie 文件
//!
//! 支持三种最常见的导出格式，按内容自动识别（不靠扩展名）：
//! - **Netscape cookies.txt**（curl / wget / yt-dlp / 各类「导出 Cookie」插件）；
//! - **JSON 数组**（EditThisCookie / Cookie-Editor / Playwright `storageState`），
//!   字段名兼容 `name/Name`、`value/Value`、`domain/Domain`、`path/Path`、
//!   `expirationDate/expires/expiry`、`secure/Secure`、`httpOnly`、`sameSite`；
//! - **`Cookie: k=v; k2=v2` 单行文本**（从浏览器 DevTools 请求头直接复制）。
//!
//! 解析出的每条 Cookie 都带域名 / 路径 / 安全标记，运行时按请求 URL 逐条筛选
//! （见 [`crate::host::ScopedCookie`]）——浏览器里存着几十个站点的 Cookie，
//! 整个头部无条件发送既不必要也不安全。

use crate::host::ScopedCookie;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// 默认浏览器 UA（与内置默认一致：Android Chrome 移动端）
pub const DEFAULT_UA: &str = "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

/// 浏览器身份：一次测试要用的全部「浏览器标志信息」。
///
/// 命令行参数覆盖 profile 文件里的同名字段（见 CLI `--profile`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    /// 身份名（仅用于展示）
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// User-Agent（空 = 书源自带 UA / 内置默认）
    #[serde(skip_serializing_if = "String::is_empty")]
    pub user_agent: String,
    /// 默认请求头（`{"Referer": "…", "Accept-Language": "…"}`）
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub headers: Vec<(String, String)>,
    /// 带作用域的 Cookie（导入 / 抓取的产物）
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cookies: Vec<ScopedCookie>,
    /// 供 `--auth` 使用的认证地址（登录页 / 站点首页）；留空则用书源主页
    #[serde(skip_serializing_if = "String::is_empty")]
    pub auth_url: String,
}

impl Profile {
    /// 从 JSON 文件加载（未知字段忽略；`headers` 也接受对象写法）。
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("读取身份文件 {} 失败: {e}", path.display()))?;
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("解析身份文件 {} 失败: {e}", path.display()))?;
        Self::from_value(value)
    }

    /// 从 JSON 值构造（兼容 `headers` 的对象写法与 Cookie 数组）
    pub fn from_value(value: serde_json::Value) -> Result<Self, String> {
        let mut object = value
            .as_object()
            .cloned()
            .ok_or_else(|| "身份文件必须是一个 JSON 对象".to_string())?;
        // headers: { "Referer": "…" } → [("Referer", "…")]
        if let Some(serde_json::Value::Object(map)) = object.get("headers").cloned() {
            let mut headers: Vec<(String, String)> = Vec::new();
            for (k, v) in map {
                if let Some(text) = v.as_str() {
                    headers.push((k, text.to_string()));
                }
            }
            object.insert(
                "headers".to_string(),
                serde_json::to_value(headers).unwrap_or(serde_json::Value::Null),
            );
        }
        // cookies 里的 domain / secure / expires 允许缺省
        if let Some(serde_json::Value::Array(list)) = object.get("cookies").cloned() {
            let mut cookies: Vec<ScopedCookie> = Vec::new();
            for item in list {
                if let Some(cookie) = scoped_from_json(&item) {
                    cookies.push(cookie);
                }
            }
            object.insert(
                "cookies".to_string(),
                serde_json::to_value(cookies).unwrap_or(serde_json::Value::Null),
            );
        }
        serde_json::from_value(serde_json::Value::Object(object))
            .map_err(|e| format!("身份文件字段不合法: {e}"))
    }

    /// 保存到 JSON 文件（`auth` 命令落盘用）
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| format!("序列化身份失败: {e}"))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录 {} 失败: {e}", parent.display()))?;
        }
        std::fs::write(path, text).map_err(|e| format!("写入身份文件 {} 失败: {e}", path.display()))
    }

    /// 按域名挑选 Cookie（用于展示 / 统计）
    pub fn cookies_for(&self, host: &str) -> Vec<&ScopedCookie> {
        let host = host.trim_start_matches("www.").to_ascii_lowercase();
        self.cookies
            .iter()
            .filter(|c| {
                let domain = c.domain.trim_start_matches('.').to_ascii_lowercase();
                domain.is_empty() || domain == host || host.ends_with(&format!(".{domain}"))
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Cookie 解析（Netscape / JSON / Cookie 头）
// ---------------------------------------------------------------------------

/// 从 json 对象里取字符串字段（兼容大小写两种写法，EditThisCookie 用大写开头）
fn json_str(value: &serde_json::Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(|v| v.as_str()) {
            return text.to_string();
        }
    }
    String::new()
}

fn json_u64(value: &serde_json::Value, keys: &[&str]) -> u64 {
    for key in keys {
        let Some(field) = value.get(*key) else { continue };
        if let Some(number) = field.as_u64() {
            return number;
        }
        if let Some(number) = field.as_f64() {
            if number > 0.0 {
                return number as u64;
            }
        }
    }
    0
}

fn json_bool(value: &serde_json::Value, keys: &[&str]) -> bool {
    for key in keys {
        match value.get(*key) {
            Some(serde_json::Value::Bool(flag)) => return *flag,
            Some(serde_json::Value::String(text)) if text.eq_ignore_ascii_case("true") => {
                return true
            }
            _ => {}
        }
    }
    false
}

/// JSON Cookie 条目 → [`ScopedCookie`]；缺 name 视为无效
pub fn scoped_from_json(value: &serde_json::Value) -> Option<ScopedCookie> {
    let name = json_str(value, &["name", "Name"]);
    if name.trim().is_empty() {
        return None;
    }
    Some(ScopedCookie {
        name: name.trim().to_string(),
        value: json_str(value, &["value", "Value"]),
        domain: json_str(value, &["domain", "Domain"]).trim().to_string(),
        path: json_str(value, &["path", "Path"]).trim().to_string(),
        secure: json_bool(value, &["secure", "Secure"]),
        expires: json_u64(
            value,
            &["expirationDate", "expires", "expiry", "expiresAt", "Expires"],
        ),
    })
}

/// 解析 `k=v; k2=v2` 单行 Cookie 头（无域名作用域，作为整行 Cookie 使用）
pub fn parse_cookie_header(text: &str) -> Vec<(String, String)> {
    text.split(';')
        .filter_map(|part| {
            let part = part.trim();
            if part.is_empty() {
                return None;
            }
            let (name, value) = part.split_once('=')?;
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            Some((name.to_string(), value.trim().to_string()))
        })
        .collect()
}

/// 解析 Cookie 文件：自动识别 Netscape / JSON / Cookie 头三种格式。
/// 返回 (作用域 Cookie, 无作用域的整行文本)；整行文本用于 DevTools 直接复制的内容。
pub fn parse_cookie_file(
    path: &Path,
) -> Result<(Vec<ScopedCookie>, Vec<String>), String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("读取 Cookie 文件 {} 失败: {e}", path.display()))?;
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return Err(format!("Cookie 文件 {} 是空的", path.display()));
    }
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let value: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|e| format!("解析 Cookie JSON {} 失败: {e}", path.display()))?;
        // Playwright storageState: { "cookies": [...] }
        let list = value
            .get("cookies")
            .and_then(|v| v.as_array())
            .cloned()
            .or_else(|| value.as_array().cloned())
            .ok_or_else(|| {
                format!(
                    "Cookie JSON {} 里没有 cookies 数组（EditThisCookie / Cookie-Editor / storageState 均可）",
                    path.display()
                )
            })?;
        let mut cookies = Vec::new();
        for item in list {
            if let Some(cookie) = scoped_from_json(&item) {
                cookies.push(cookie);
            }
        }
        if cookies.is_empty() {
            return Err(format!("Cookie 文件 {} 里没有可用条目", path.display()));
        }
        return Ok((cookies, Vec::new()));
    }
    // Netscape cookies.txt：每行 7 个 TAB 分隔字段
    if trimmed.lines().any(|line| {
        let line = line.trim();
        !line.is_empty() && !line.starts_with('#') && line.split('\t').count() >= 6
    }) {
        let mut cookies = Vec::new();
        for line in trimmed.lines() {
            let line = line.trim_end();
            let http_only = line.starts_with("#HttpOnly_");
            let line = if http_only {
                line.trim_start_matches("#HttpOnly_")
            } else {
                line
            };
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() < 7 {
                continue;
            }
            let name = fields[5].trim();
            if name.is_empty() {
                continue;
            }
            let expires = fields[4].trim().parse::<u64>().unwrap_or(0);
            cookies.push(ScopedCookie {
                name: name.to_string(),
                value: fields[6].trim().to_string(),
                domain: fields[0].trim().to_string(),
                path: fields[2].trim().to_string(),
                secure: fields[3].trim().eq_ignore_ascii_case("TRUE"),
                expires,
            });
        }
        if cookies.is_empty() {
            return Err(format!("Cookie 文件 {} 里没有可用条目", path.display()));
        }
        return Ok((cookies, Vec::new()));
    }
    // 兜底：`Cookie: k=v; …` 纯文本（整行使用，不限定域名）
    let raw = trimmed
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|line| line.trim_start_matches("Cookie:").trim().to_string())
        .collect::<Vec<String>>()
        .join("; ");
    if parse_cookie_header(&raw).is_empty() {
        return Err(format!(
            "无法识别 Cookie 文件 {} 的格式（支持 Netscape cookies.txt / JSON / Cookie 头文本）",
            path.display()
        ));
    }
    Ok((Vec::new(), vec![raw]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_netscape_and_json() {
        let dir = std::env::temp_dir().join(format!("readerx-profile-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let netscape = dir.join("cookies.txt");
        std::fs::write(
            &netscape,
            "# Netscape HTTP Cookie File\n\
             .example.com\tTRUE\t/\tTRUE\t4102444800\tcf_clearance\tabc123\n\
             #HttpOnly_.example.com\tTRUE\t/\tFALSE\t0\tsession\txyz\n",
        )
        .unwrap();
        let (cookies, lines) = parse_cookie_file(&netscape).unwrap();
        assert!(lines.is_empty());
        assert_eq!(cookies.len(), 2);
        assert_eq!(cookies[0].name, "cf_clearance");
        assert!(cookies[0].secure && cookies[0].expires == 4_102_444_800);
        assert_eq!(cookies[1].name, "session");

        let json = dir.join("cookies.json");
        std::fs::write(
            &json,
            r#"{"cookies":[{"name":"a","value":"1","domain":".example.com","path":"/","secure":true,"expirationDate":4102444800}]}"#,
        )
        .unwrap();
        let (cookies, _) = parse_cookie_file(&json).unwrap();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].value, "1");

        let header = dir.join("header.txt");
        std::fs::write(&header, "Cookie: a=1; b=2\n").unwrap();
        let (cookies, lines) = parse_cookie_file(&header).unwrap();
        assert!(cookies.is_empty());
        assert_eq!(lines, vec!["a=1; b=2".to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn profile_json_accepts_object_headers() {
        let profile = Profile::from_value(serde_json::json!({
            "userAgent": "UA/1",
            "headers": { "Referer": "https://example.com/" },
        }))
        .unwrap();
        assert_eq!(profile.user_agent, "UA/1");
        assert_eq!(profile.headers, vec![("Referer".to_string(), "https://example.com/".to_string())]);
    }
}

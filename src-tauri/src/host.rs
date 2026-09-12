//! 书源宿主服务层：为 Boa 引擎提供受控的爬虫工具。
//!
//! - 全部能力以 **JSON 字符串** 形式跨宿主边界传递（原生函数签名最简、可序列化）；
//! - 每个书源一个常驻 `reqwest::blocking::Client`（独立 cookie jar，会话内跨调用共享）；
//! - 单次请求默认超时、响应体/正文上限、字符集探测等都在这里统一处理；
//! - HTML 选择器基于 `scraper`，正文清洗是轻量标签扫描实现（文档中注明为近似结果）。

use crate::models::BookSource;
use crate::webview_login;
use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use digest::Digest;
use hmac::{Hmac, Mac};
use md5::Md5;
use scraper::{ElementRef, Html, Selector};
use serde_json::{json, Map, Value};
use sha1::Sha1;
use sha2::Sha256;
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// AES-256 密钥长度（字节）
const AES_GCM_KEY_LEN: usize = 32;
/// AES-GCM IV 长度（字节，GCM 推荐值）
const AES_GCM_IV_LEN: usize = 12;
/// AES-GCM 认证标签长度（字节）
const AES_GCM_TAG_LEN: usize = 16;

/// HMAC 实例（RFC 2104；三种摘要都走同一套收尾逻辑）
type HmacMd5 = Hmac<Md5>;
type HmacSha1 = Hmac<Sha1>;
type HmacSha256 = Hmac<Sha256>;

/// 响应体读取上限（32 MiB），超限截断
pub const BODY_LIMIT: u64 = 32 * 1024 * 1024;
/// 单请求默认超时（毫秒）
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// 请求并发上限
pub const CONCURRENCY_CAP: usize = 8;
/// 每源最多保存的手动 Cookie 行数
const MAX_COOKIE_LINES: usize = 64;
/// 缺省 UA（与 http_request 中原先的内联值一致）
const DEFAULT_UA: &str = "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
/// 正文图片读取上限（24 MiB，超限报错而非截断）
const IMAGE_BODY_LIMIT: u64 = 24 * 1024 * 1024;
/// 正文图片下载超时（毫秒；图片通常比页面慢）
const IMAGE_TIMEOUT_MS: u64 = 60_000;
/// CF 挑战自动认证：两次自动拉起 WebView 的最小间隔（避免批量下载/并发搜索弹窗风暴）
const AUTO_AUTH_COOLDOWN: Duration = Duration::from_secs(45);
/// CF 挑战检测时最多扫描的响应体前缀长度
const CF_SCAN_BODY: usize = 32 * 1024;

static SOURCES: OnceLock<Mutex<HashMap<String, Arc<SourceState>>>> = OnceLock::new();
/// 全局最近一次自动拉起网页认证的时间（跨源共用：同一时刻只该有一个认证窗口）
static AUTO_AUTH_LAST_TRY: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

fn auto_auth_last_slot() -> &'static Mutex<Option<Instant>> {
    AUTO_AUTH_LAST_TRY.get_or_init(Default::default)
}

/// 尝试占一次「自动拉起网页认证」名额；距上次不足冷却时间时返回 false。
fn claim_auto_auth_slot() -> bool {
    let now = Instant::now();
    let mut guard = auto_auth_last_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(last) = *guard {
        if now.duration_since(last) < AUTO_AUTH_COOLDOWN {
            return false;
        }
    }
    *guard = Some(now);
    true
}

fn sources_registry() -> &'static Mutex<HashMap<String, Arc<SourceState>>> {
    SOURCES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 每源会话：reqwest client（自动 cookie jar）+ 默认头 + 手动 cookie 行
pub(crate) struct SourceState {
    pub(crate) client: reqwest::blocking::Client,
    /// redirect=false 时使用（跟随重定向会丢失原始 URL 语义）
    pub(crate) client_no_redirect: reqwest::blocking::Client,
    pub(crate) default_headers: Mutex<Vec<(String, String)>>,
    pub(crate) user_agent: Mutex<String>,
    pub(crate) extra_cookies: Mutex<Vec<String>>,
    /// 书源是否允许自动网页认证（CF 挑战自动拉起 WebView / 代码级 webview.login）
    pub(crate) auto_auth: Mutex<bool>,
}

fn build_client(no_redirect: bool) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder().cookie_store(true);
    if no_redirect {
        builder = builder.redirect(reqwest::redirect::Policy::none());
    }
    builder
        .build()
        .map_err(|e| format!("创建书源 HTTP 客户端失败: {e}"))
}

/// 注册/刷新一个书源的运行会话（幂等；client 与 cookie jar 全程复用）
pub(crate) fn prepare_source(source: &BookSource) -> Result<(), String> {
    let mut guard = sources_registry()
        .lock()
        .map_err(|_| "书源会话锁异常".to_string())?;
    let state = match guard.get(&source.id) {
        Some(state) => state.clone(),
        None => {
            let client = build_client(false)?;
            let client_no_redirect = build_client(true)?;
            let state = Arc::new(SourceState {
                client,
                client_no_redirect,
                default_headers: Mutex::new(Vec::new()),
                user_agent: Mutex::new(String::new()),
                extra_cookies: Mutex::new(Vec::new()),
                auto_auth: Mutex::new(true),
            });
            guard.insert(source.id.clone(), state.clone());
            state
        }
    };
    let mut headers: Vec<(String, String)> = source
        .headers
        .iter()
        .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
        .filter(|(k, v)| !k.is_empty() && !v.is_empty())
        .collect();
    headers.retain(|(k, _)| k != "user-agent" && k != "cookie");
    *state.default_headers.lock().unwrap_or_else(|e| e.into_inner()) = headers;
    *state.user_agent.lock().unwrap_or_else(|e| e.into_inner()) =
        source.user_agent.trim().to_string();
    *state.auto_auth.lock().unwrap_or_else(|e| e.into_inner()) = source.auto_auth;
    Ok(())
}

fn source_state(source_id: &str) -> Result<Arc<SourceState>, String> {
    let guard = sources_registry()
        .lock()
        .map_err(|_| "书源会话锁异常".to_string())?;
    guard
        .get(source_id)
        .cloned()
        .ok_or_else(|| "书源会话尚未初始化".to_string())
}

/// 组装书源会话的基础请求头：默认头 + 手动 Cookie 行 + UA（空 UA 用内置默认）。
/// 顺序与历史实现一致（默认头 → Cookie → UA），便于后续“末尾同名覆盖”。
fn session_base_headers(state: &SourceState) -> Vec<(String, String)> {
    let mut lines: Vec<(String, String)> = state
        .default_headers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let cookies = state
        .extra_cookies
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if !cookies.is_empty() {
        lines.push(("cookie".to_string(), cookies.join("; ")));
    }
    let ua = state
        .user_agent
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if !ua.is_empty() {
        lines.push(("user-agent".to_string(), ua));
    } else {
        lines.push(("user-agent".to_string(), DEFAULT_UA.to_string()));
    }
    lines
}

/// 同名请求头合并：cookie 追加合并，其余“后出现的覆盖先出现的”。
fn finalize_headers(header_lines: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut final_headers: Vec<(String, String)> = Vec::new();
    for (k, v) in header_lines {
        if let Some(existing) = final_headers.iter_mut().find(|(ek, _)| *ek == k) {
            if k == "cookie" {
                existing.1 = format!("{}; {}", existing.1, v);
            } else {
                existing.1 = v;
            }
        } else {
            final_headers.push((k, v));
        }
    }
    final_headers
}

/// 统一错误 JSON（宿主边界内原生函数不抛 JS 异常，交由 JS 包装层 throw）
fn error_payload(message: String) -> String {
    serde_json::to_string(&json!({ "__rxError": message })).unwrap_or_else(|_| "{}".to_string())
}

/// 把响应对象序列化为 JSON 文本（序列化失败兜底为宿主错误对象）
fn serialize_value(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| error_payload("序列化失败".into()))
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

fn percent_encode(input: &str) -> String {
    let mut out = String::new();
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                    if let Ok(v) = u8::from_str_radix(hex, 16) {
                        out.push(v);
                        i += 3;
                        continue;
                    }
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn append_query(url: &str, params: &Map<String, Value>) -> String {
    let mut parts = Vec::new();
    for (k, v) in params {
        let s = match v {
            Value::Null => String::new(),
            _ => v.to_string().trim_matches('"').to_string(),
        };
        parts.push(format!("{}={}", percent_encode(k), percent_encode(&s)));
    }
    if parts.is_empty() {
        return url.to_string();
    }
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}{}", parts.join("&"))
}

/// 按 Content-Type 里的 charset / 常见中文编码探测解码响应体
fn decode_body(bytes: &[u8], content_type: &str) -> String {
    // 必须用 to_ascii_lowercase：它不改变字节长度，因此在小写串里找到的下标可以
    // 安全地用于原串切片。若用 to_lowercase（会改变部分非 ASCII 字符的字节长度，
    // 如 'İ' → "i̇"），按小写串下标切原串会越界 / 落在多字节字符中间而 panic ——
    // Content-Type 完全由远端服务器控制，不能让响应头把应用打崩。
    let lower = content_type.to_ascii_lowercase();
    if let Some(pos) = lower.find("charset=") {
        let label = lower[pos + 8..]
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches('"');
        if !label.is_empty() {
            if let Some(enc) = encoding_rs::Encoding::for_label(label.as_bytes()) {
                let (text, _, _) = enc.decode(bytes);
                return text.into_owned();
            }
        }
    }
    // 合法 UTF-8 优先，替代符过多时退回 GB18030（中文站点常见）
    let utf8 = String::from_utf8_lossy(bytes);
    let replacements = utf8.chars().filter(|c| *c == '\u{FFFD}').count();
    if replacements == 0 {
        // 整段就是合法 UTF-8（无缺省 charset 的 JSON / 小页面同样适用）：
        // 旧实现分子固定 max(1)，短响应体会被误判成 GB18030 而整段乱码
        return utf8.into_owned();
    }
    let replacement_ratio = replacements as f64 / utf8.chars().count().max(1) as f64;
    if replacement_ratio < 0.003 {
        return utf8.into_owned();
    }
    let (gbk, _, _) = encoding_rs::GB18030.decode(bytes);
    gbk.into_owned()
}

/// 执行一次 HTTP 请求（单发，不做 CF 挑战自动认证）；成功返回响应对象 Value。
fn do_http_request(source_id: &str, method: &str, raw_url: &str, opts: &str) -> Result<Value, String> {
    let url = raw_url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持 http/https 绝对地址".to_string());
    }
    let opts: Value = if opts.trim().is_empty() || opts.trim() == "null" {
        Value::Null
    } else {
        serde_json::from_str(opts).map_err(|e| format!("http 参数解析失败: {e}"))?
    };
    let o = opts.as_object().cloned().unwrap_or_default();
    let method = method.to_uppercase();

    let state = source_state(source_id)?;
    let redirect_false = o.get("redirect").and_then(|v| v.as_bool()) == Some(false);
    let client = if redirect_false {
        &state.client_no_redirect
    } else {
        &state.client
    };
    // 方法只解析一次：解析失败返回可读错误（旧实现在组装 params 时二次解析并 unwrap）
    let parsed_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| format!("不支持的请求方法: {method}"))?;
    let mut req = client.request(parsed_method.clone(), url);

    let mut header_lines = session_base_headers(&state);

    // 单请求头覆盖（末尾同名覆盖默认头；Referer 等按需追加）
    if let Some(Value::Object(extra)) = o.get("headers") {
        for (k, v) in extra {
            if let Value::String(s) = v {
                header_lines.push((k.trim().to_lowercase(), s.clone()));
            }
        }
    }

    // 组装参数与 body
    let mut body_bytes: Option<Vec<u8>> = None;
    if let Some(Value::Object(params)) = o.get("params") {
        let full = append_query(url, params);
        req = client.request(parsed_method.clone(), full);
    }
    if let Some(Value::Object(form)) = o.get("form") {
        let mut parts = Vec::new();
        for (k, v) in form {
            parts.push(format!(
                "{}={}",
                percent_encode(k),
                percent_encode(&v.as_str().unwrap_or("").to_string())
            ));
        }
        body_bytes = Some(parts.join("&").into_bytes());
        if !header_lines.iter().any(|(k, _)| k == "content-type") {
            header_lines.push((
                "content-type".to_string(),
                "application/x-www-form-urlencoded; charset=UTF-8".to_string(),
            ));
        }
    } else if let Some(json_body) = o.get("json") {
        let text = serde_json::to_string(json_body)
            .map_err(|e| format!("json 序列化失败: {e}"))?;
        body_bytes = Some(text.into_bytes());
        if !header_lines.iter().any(|(k, _)| k == "content-type") {
            header_lines.push(("content-type".to_string(), "application/json".to_string()));
        }
    } else if let Some(Value::String(s)) = o.get("body") {
        body_bytes = Some(s.clone().into_bytes());
    }

    // 去重同名头（cookie/ua/头覆盖优先级最高，保留最后一次）
    let final_headers = finalize_headers(header_lines);
    let mut header_map = reqwest::header::HeaderMap::new();
    for (k, v) in final_headers {
        if let Ok(name) = reqwest::header::HeaderName::from_bytes(k.as_bytes()) {
            if let Ok(val) = reqwest::header::HeaderValue::from_str(&v) {
                header_map.append(name, val);
            }
        }
    }
    req = req.headers(header_map);

    let timeout_ms = o
        .get("timeoutMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(100, 120_000);
    req = req.timeout(Duration::from_millis(timeout_ms));
    if let Some(bytes) = body_bytes {
        req = req.body(bytes);
    }

    let resp = req.send().map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let mut header_out = Map::new();
    for (k, v) in resp.headers() {
        if let Ok(text) = v.to_str() {
            let key = k.as_str().to_lowercase();
            match header_out.get_mut(&key) {
                Some(Value::String(existing)) => {
                    *existing = format!("{existing}, {text}");
                }
                _ => {
                    header_out.insert(key, Value::String(text.to_string()));
                }
            }
        }
    }

    // 限量读取响应体
    let mut reader = resp.take(BODY_LIMIT + 1);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取响应失败: {e}"))?;
    let truncated = bytes.len() as u64 > BODY_LIMIT;
    bytes.truncate(BODY_LIMIT as usize);
    let body = decode_body(&bytes, &content_type);

    let mut out = Map::new();
    out.insert("ok".into(), json!(status.is_success()));
    out.insert("status".into(), json!(status.as_u16()));
    out.insert("statusText".into(), json!(status_text));
    out.insert("headers".into(), Value::Object(header_out));
    out.insert("body".into(), json!(body));
    out.insert("url".into(), json!(raw_url.to_string()));
    if truncated {
        out.insert("truncated".into(), json!(true));
    }
    Ok(Value::Object(out))
}

// ---------------------------------------------------------------------------
// Cloudflare 挑战自动认证（请求层）
// ---------------------------------------------------------------------------

fn header_contains(headers: &Map<String, Value>, name: &str, needle: &str) -> bool {
    headers
        .get(name)
        .and_then(|v| v.as_str())
        .map(|s| s.to_lowercase().contains(needle))
        .unwrap_or(false)
}

/// 判断一次响应是否为 Cloudflare 人机挑战页（此时旧的 cf_clearance 已失效，
/// 需要重新在浏览器内核里完成挑战换取新令牌）。
fn is_cf_challenge_response(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    let headers = obj
        .get("headers")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    // CF 挑战页恒为 text/html；非 HTML 响应（JSON/图片）不做挑战判定，避免误拉认证窗
    let content_type = headers
        .get("content-type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    if !content_type.is_empty() && !content_type.contains("text/html") {
        return false;
    }
    // `cf-mitigated: challenge` 是最可靠的现代标记（WAF 托管挑战/机器人拦截）
    if header_contains(&headers, "cf-mitigated", "challenge") {
        return true;
    }
    let server_cf = header_contains(&headers, "server", "cloudflare");
    let status = obj.get("status").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
    // 老式「Just a moment…」挑战多为 403 / 503
    if !server_cf && status != 403 && status != 503 {
        return false;
    }
    let body = obj.get("body").and_then(|v| v.as_str()).unwrap_or("");
    let scan = body.len().min(CF_SCAN_BODY);
    let head = body.get(..scan).unwrap_or(body).to_ascii_lowercase();
    const STRONG_MARKERS: [&str; 5] = [
        "cf_chl_opt",
        "cf-chl-widget",
        "cf-browser-verification",
        "cf-chl-out",
        "__cf_chl",
    ];
    if STRONG_MARKERS.iter().any(|m| head.contains(m)) {
        return true;
    }
    // 无 server: cloudflare 头时，「just a moment」置信不足（普通 403 页也可能出现）
    server_cf && head.contains("just a moment")
}

/// 给挑战响应对象补一个 `cf` 字段，说明本次自动认证的处理情况（供规则/日志观察）。
fn mark_cf_challenge(value: &mut Value, auto: &str, message: Option<&str>) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    let existing = obj.get("cf").cloned().unwrap_or_else(|| json!({}));
    let mut m = existing.as_object().cloned().unwrap_or_default();
    m.insert("challenge".into(), json!(true));
    m.insert("auto".into(), json!(auto));
    if let Some(msg) = message {
        m.insert("message".into(), json!(msg));
    }
    obj.insert("cf".into(), Value::Object(m));
}

/// 取 URL 的 origin（scheme://host），CF 认证用站点根即可触发挑战。
fn origin_of(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    let scheme = if lower.starts_with("https://") {
        "https"
    } else if lower.starts_with("http://") {
        "http"
    } else {
        return None;
    };
    let rest = &url[scheme.len() + 3..];
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

/// 对外 HTTP 请求入口：命中 Cloudflare 挑战时，按书源「自动网页认证」开关决定
/// 是否自动拉起应用内 WebView 认证并重试一次（cf_clearance 过期场景覆盖在此）。
/// 始终返回 JSON 字符串（成功为响应对象，失败为 __rxError）。
pub(crate) fn http_request(source_id: &str, method: &str, raw_url: &str, opts: &str) -> String {
    let one = || do_http_request(source_id, method, raw_url, opts);
    let first = match one() {
        Ok(value) => value,
        Err(message) => return error_payload(message),
    };
    if !is_cf_challenge_response(&first) {
        return serialize_value(&first);
    }
    let mut first = first;

    // 书源开关：允许自动网页认证才继续（可单独关闭）
    let auto_auth = source_state(source_id)
        .map(|s| s.auto_auth.lock().map(|g| *g).unwrap_or(false))
        .unwrap_or(false);
    if !auto_auth {
        mark_cf_challenge(&mut first, "disabled", Some("该书源已关闭自动网页认证"));
        return serialize_value(&first);
    }
    // 平台能力：应用内 WebView 认证仅 Android
    if !webview_login::is_supported() {
        mark_cf_challenge(&mut first, "unsupported", Some("自动网页认证仅 Android 端可用"));
        return serialize_value(&first);
    }
    // 全局冷却：避免批量下载 / 并发搜索时连续弹多个认证窗
    if !claim_auto_auth_slot() {
        mark_cf_challenge(&mut first, "cooldown", Some("距上次自动认证过近，请稍后重试"));
        return serialize_value(&first);
    }

    // GET/HEAD 直接把原地址交给 WebView（挑战通过后会落到真实页面）；其余方法用站点根
    let method = method.to_uppercase();
    let get_like = method == "GET" || method == "HEAD";
    let target = if get_like {
        raw_url.trim().to_string()
    } else {
        origin_of(raw_url.trim()).unwrap_or_else(|| raw_url.trim().to_string())
    };

    let outcome = match webview_login::perform(source_id, &target) {
        Ok(o) => o,
        Err(err) => {
            // 登录桥异常（极少见）：按取消处理，避免阻塞书源代码
            mark_cf_challenge(&mut first, "cancelled", Some(&err));
            return serialize_value(&first);
        }
    };

    // 用户取消 / 超时 / 失败：原样返回挑战响应（带说明字段），不打扰书源代码
    if !outcome.ok {
        let msg = if outcome.message.trim().is_empty() {
            "认证未完成（已取消或失败），请重试".to_string()
        } else {
            outcome.message.clone()
        };
        mark_cf_challenge(&mut first, "cancelled", Some(&msg));
        return serialize_value(&first);
    }

    // 认证成功（新 Cookie 已持久化并注入会话）：用原参数重试一次，不再递归自动认证
    match one() {
        Ok(second) => {
            let mut second = second;
            if is_cf_challenge_response(&second) {
                mark_cf_challenge(
                    &mut second,
                    "stale",
                    Some("认证后仍被拦截：令牌未生效或站点校验浏览器指纹，请确认书源 UA 与网页一致"),
                );
            }
            serialize_value(&second)
        }
        Err(message) => error_payload(message),
    }
}

// ---------------------------------------------------------------------------
// 二进制图片下载（正文插图 / 整章图片用；复用书源会话头与 Cookie）
// ---------------------------------------------------------------------------

fn ext_image_mime(url: &str) -> Option<&'static str> {
    let path = url.split(['?', '#']).next().unwrap_or("");
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" | "jpe" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\xFF\xD8\xFF") {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = String::from_utf8_lossy(&bytes[8..12]).to_ascii_lowercase();
        if brand.contains("avif") || brand.contains("avis") {
            return Some("image/avif");
        }
        return None;
    }
    if bytes.starts_with(b"BM") && bytes.len() > 14 {
        return Some("image/bmp");
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)])
        .trim()
        .to_ascii_lowercase();
    if head.starts_with("<svg") || (head.starts_with("<?xml") && head.contains("<svg")) {
        return Some("image/svg+xml");
    }
    None
}

fn u16_be(bytes: &[u8], at: usize) -> Option<u16> {
    let slice = bytes.get(at..at + 2)?;
    Some(u16::from_be_bytes([slice[0], slice[1]]))
}

fn u32_be(bytes: &[u8], at: usize) -> Option<u32> {
    let slice = bytes.get(at..at + 4)?;
    Some(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn u32_le(bytes: &[u8], at: usize) -> Option<u32> {
    let slice = bytes.get(at..at + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn junk_dimensions(width: u32, height: u32) -> Option<(u32, u32)> {
    // 上限兜底：明显离谱的数值（解析错位 / 畸形文件）视为解析失败，
    // 让前端退回占位而不是按天文数字排版
    if width == 0 || height == 0 || width > 100_000 || height > 100_000 {
        return None;
    }
    Some((width, height))
}

/// 从图片字节头解析原始像素尺寸（**不解码整张图**）。
/// 支持 JPEG / PNG / GIF / BMP / WebP；SVG、AVIF 或畸形数据返回 None。
///
/// 阅读器排版需要每张图的真实尺寸：旧实现在 WebView 里用 `new Image()` 逐张解码，
/// 一章几百张图时会一次性申请巨量位图内存（应用直接闪退）；改读文件头后
/// 尺寸获取与「解码」解耦，整章图片也不再需要全部解码。
pub(crate) fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    // PNG：IHDR 固定紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 24 {
        return junk_dimensions(u32_be(bytes, 16)?, u32_be(bytes, 20)?);
    }
    // GIF：逻辑屏幕宽高为小端 u16
    if bytes.starts_with(b"GIF8") && bytes.len() >= 10 {
        let width = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
        let height = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
        return junk_dimensions(width, height);
    }
    // BMP：BITMAPINFOHEADER 的宽高（高度可能为负，表示自上而下）
    if bytes.starts_with(b"BM") && bytes.len() >= 26 {
        let width = u32_le(bytes, 18)? as i32;
        let height = u32_le(bytes, 22)? as i32;
        return junk_dimensions(width.unsigned_abs(), height.unsigned_abs());
    }
    if bytes.starts_with(b"RIFF") && bytes.len() >= 16 && &bytes[8..12] == b"WEBP" {
        return webp_dimensions(bytes);
    }
    if bytes.starts_with(b"\xFF\xD8\xFF") {
        return jpeg_dimensions(bytes);
    }
    None
}

/// JPEG：顺序扫段，命中 SOF0-SOF15（排除 DHT/JPG/DAC）即取段内高、宽
fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2usize;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        // 填充字节（0xFF 0xFF …）
        if marker == 0xFF {
            i += 1;
            continue;
        }
        // 无长度字段的独立标记
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        let length = u16_be(bytes, i + 2)? as usize;
        if length < 2 {
            return None;
        }
        let is_sof = (0xC0..=0xCF).contains(&marker)
            && marker != 0xC4
            && marker != 0xC8
            && marker != 0xCC;
        if is_sof {
            return junk_dimensions(u16_be(bytes, i + 7)? as u32, u16_be(bytes, i + 5)? as u32);
        }
        i += 2 + length;
    }
    None
}

/// WebP：VP8（有损）/ VP8L（无损）/ VP8X（扩展）三种容器各自的头部布局
fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    match &bytes[12..16] {
        b"VP8 " => {
            // 3 字节 frame tag + 3 字节同步码 0x9D012A 之后是小端 14 位宽高
            if bytes.len() < 30 || &bytes[23..26] != b"\x9D\x01\x2A" {
                return None;
            }
            let width = u16::from_le_bytes([bytes[26], bytes[27]]) as u32 & 0x3FFF;
            let height = u16::from_le_bytes([bytes[28], bytes[29]]) as u32 & 0x3FFF;
            junk_dimensions(width, height)
        }
        b"VP8L" => {
            if bytes.len() < 25 || bytes[20] != 0x2F {
                return None;
            }
            let bits = u32_le(bytes, 21)?;
            let width = (bits & 0x3FFF) + 1;
            let height = ((bits >> 14) & 0x3FFF) + 1;
            junk_dimensions(width, height)
        }
        b"VP8X" => {
            if bytes.len() < 30 {
                return None;
            }
            let width = 1 + (bytes[24] as u32 | (bytes[25] as u32) << 8 | (bytes[26] as u32) << 16);
            let height = 1 + (bytes[27] as u32 | (bytes[28] as u32) << 8 | (bytes[29] as u32) << 16);
            junk_dimensions(width, height)
        }
        _ => None,
    }
}

/// 识别图片 MIME：优先响应头 Content-Type；否则按 URL 扩展名；最后嗅探字节头。
fn image_mime(url: &str, content_type: &str, bytes: &[u8]) -> String {
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if ct.starts_with("image/") && ct.len() > "image/".len() {
        return ct;
    }
    if let Some(mime) = ext_image_mime(url) {
        return mime.to_string();
    }
    if let Some(mime) = sniff_image_mime(bytes) {
        return mime.to_string();
    }
    "application/octet-stream".to_string()
}

/// 用书源会话请求一张图片的原始字节。referer 非空时作为 Referer 头（防盗链常见）。
/// 返回 (MIME, 字节)；无法识别为图片时返回 Err。
pub(crate) fn fetch_image_bytes(
    source_id: &str,
    url: &str,
    referer: &str,
) -> Result<(String, Vec<u8>), String> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持 http/https 图片地址".to_string());
    }
    let state = source_state(source_id)?;
    let mut header_lines = session_base_headers(&state);
    let referer = referer.trim();
    if !referer.is_empty() {
        header_lines.push(("referer".to_string(), referer.to_string()));
    }
    let final_headers = finalize_headers(header_lines);
    let mut header_map = reqwest::header::HeaderMap::new();
    for (k, v) in final_headers {
        if let Ok(name) = reqwest::header::HeaderName::from_bytes(k.as_bytes()) {
            if let Ok(val) = reqwest::header::HeaderValue::from_str(&v) {
                header_map.append(name, val);
            }
        }
    }
    let resp = state
        .client
        .get(url)
        .headers(header_map)
        .timeout(Duration::from_millis(IMAGE_TIMEOUT_MS))
        .send()
        .map_err(|e| format!("图片请求失败: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("图片下载失败 HTTP {}", status.as_u16()));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut reader = resp.take(IMAGE_BODY_LIMIT + 1);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取图片失败: {e}"))?;
    if bytes.len() as u64 > IMAGE_BODY_LIMIT {
        return Err("图片过大（超过 24 MiB 上限）".to_string());
    }
    let mime = image_mime(url, &content_type, &bytes);
    if mime == "application/octet-stream" {
        return Err("无法识别图片格式（响应不是有效图片）".to_string());
    }
    Ok((mime, bytes))
}

/// http.setCookie：手动追加一行 Cookie 头内容（后续所有请求自动携带）。
/// 与已有行完全相同的文本会被跳过，避免重复累积。
pub(crate) fn http_set_cookie(source_id: &str, cookie_text: &str) {
    let text = cookie_text.trim().to_string();
    if text.is_empty() {
        return;
    }
    if let Ok(state) = source_state(source_id) {
        let mut lines = state
            .extra_cookies
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if lines.iter().any(|l| l == &text) {
            return;
        }
        lines.push(text);
        if lines.len() > MAX_COOKIE_LINES {
            let overflow = lines.len() - MAX_COOKIE_LINES / 2;
            lines.drain(0..overflow);
        }
    }
}

/// 从会话手动 Cookie 行中移除与给定文本完全相同的行（用于「清空登录 Cookie」）。
/// 返回移除的行数。
pub(crate) fn http_remove_cookie(source_id: &str, cookie_text: &str) -> u64 {
    let text = cookie_text.trim();
    if text.is_empty() {
        return 0;
    }
    let Ok(state) = source_state(source_id) else {
        return 0;
    };
    let mut lines = state
        .extra_cookies
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let before = lines.len();
    lines.retain(|l| l.trim() != text);
    (before - lines.len()) as u64
}

pub(crate) fn http_cookies(source_id: &str) -> String {
    let list = source_state(source_id)
        .ok()
        .and_then(|state| {
            state
                .extra_cookies
                .lock()
                .map(|lines| lines.clone())
                .ok()
        })
        .unwrap_or_default();
    serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string())
}

pub(crate) fn http_clear_cookies(source_id: &str) {
    if let Ok(state) = source_state(source_id) {
        if let Ok(mut lines) = state.extra_cookies.lock() {
            lines.clear();
        }
    }
}

// ---------------------------------------------------------------------------
// HTML：scraper CSS 选择器 + 轻量正文清洗
// ---------------------------------------------------------------------------

fn element_json(element: ElementRef<'_>) -> Value {
    let mut attrs = Map::new();
    for (k, v) in element.value().attrs() {
        attrs.insert(k.to_string(), Value::String(v.to_string()));
    }
    json!({
        "tag": element.value().name(),
        "attrs": attrs,
        "text": element.text().collect::<String>().trim(),
        "html": element.html(),
    })
}

/// 解析 CSS 查询结果；返回元素数组 JSON 或 __rxError
pub(crate) fn html_query_all(html: &str, selector: &str) -> String {
    match Selector::parse(selector) {
        Err(e) => error_payload(format!("CSS 选择器「{selector}」非法: {e}")),
        Ok(sel) => {
            // parse_fragment 的 tokenizer 默认编码会误解读非 ASCII；用 parse_document
            // 保证按 UTF-8 处理（选择器仍能命中片段内元素）
            let doc = Html::parse_document(html);
            let list: Vec<Value> = doc.select(&sel).map(element_json).collect();
            serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string())
        }
    }
}

fn parse_entity_token(token: &str) -> Option<char> {
    if let Some(hex) = token.strip_prefix("#x") {
        u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
    } else if let Some(dec) = token.strip_prefix('#') {
        dec.parse::<u32>().ok().and_then(char::from_u32)
    } else {
        match token {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some('\u{00a0}'),
            _ => None,
        }
    }
}

/// 常见 HTML 实体解码（只处理 `&…;`，其余原样保留，避免破坏多字节 UTF-8）
fn entity_decode(input: &str) -> String {
    if !input.contains('&') {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    loop {
        match rest.find('&') {
            None => {
                out.push_str(rest);
                break;
            }
            Some(p) => {
                out.push_str(&rest[..p]);
                let tail = &rest[p + 1..];
                if let Some(q) = tail.find(';') {
                    let token = &tail[..q];
                    if let Some(ch) = parse_entity_token(token) {
                        out.push(ch);
                        rest = &tail[q + 1..];
                        continue;
                    }
                }
                out.push('&');
                rest = tail;
            }
        }
    }
    out
}

/// 把 HTML 片段清洗为纯文本（近似）：剔除 script/style/注释，块级与 <br> 换行，实体解码。
/// 输入是远端页面内容（可能被任意构造），所有切片都走 `str::get`，越界只跳过不 panic。
pub(crate) fn html_to_text(html: &str, sep: &str) -> String {
    let mut out = String::new();
    let bytes = html.as_bytes();
    let mut i = 0;
    let len = bytes.len();
    while i < len {
        // 统一用 get 取剩余片段：任何下标异常都退化为「到此结束」，绝不 panic
        let Some(rest) = html.get(i..) else {
            break;
        };
        match bytes[i] {
            b'<' => {
                let close = rest.find('>').map(|p| i + p);
                let Some(gt) = close else {
                    break;
                };
                let Some(tag) = html.get(i + 1..gt) else {
                    break;
                };
                let lower = tag.trim_start().to_ascii_lowercase();
                // 注释 / script / style 整体跳过
                if lower.starts_with("!--") {
                    let end = rest.find("-->").map(|p| i + p + 3);
                    match end {
                        Some(e) => i = e,
                        None => break,
                    }
                    continue;
                }
                if lower.starts_with("script") || lower.starts_with("style") {
                    let end = rest
                        .find(&format!("</{}", lower.split_whitespace().next().unwrap_or("")))
                        .map(|p| i + p)
                        .unwrap_or(len);
                    // find 命中的位置恒 > i；这里再兜一层，保证循环一定前进
                    i = if end > i { end } else { i + 1 };
                    continue;
                }
                let name = lower
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .trim_end_matches('/');
                let is_block = matches!(
                    name,
                    "br" | "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5"
                        | "h6" | "section" | "article" | "ul" | "ol" | "blockquote" | "table"
                ) || name.starts_with("</p")
                    || name.starts_with("</d")
                    || name.starts_with("</h");
                if is_block && !out.is_empty() && !out.ends_with('\n') {
                    out.push_str(sep);
                }
                i = gt + 1;
            }
            _ => {
                // 拷贝到下一个 '<' 或结尾
                let next = rest.find('<').map(|p| i + p).unwrap_or(len);
                if let Some(chunk) = html.get(i..next) {
                    out.push_str(&entity_decode(chunk));
                }
                i = if next > i { next } else { i + 1 };
            }
        }
    }
    let mut clean: String = out
        .chars()
        .filter(|c| !matches!(*c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}'))
        .collect();
    clean = clean.replace("\r\n", "\n").replace('\r', "\n");
    // 折叠 sep 的连续空白
    if sep == "\n" {
        while clean.contains("\n\n\n") {
            clean = clean.replace("\n\n\n", "\n\n");
        }
    }
    clean
}

// ---------------------------------------------------------------------------
// URL 工具
// ---------------------------------------------------------------------------

pub(crate) fn url_join(base: &str, rel: &str) -> String {
    let rel = rel.trim();
    if rel.is_empty() {
        return base.to_string();
    }
    if rel.starts_with("http://") || rel.starts_with("https://") {
        return rel.to_string();
    }
    if rel.starts_with("//") {
        if let Some(pos) = base.find("://") {
            return format!("{}{rel}", &base[..pos + 3]);
        }
        return rel.to_string();
    }
    // 取 scheme://authority
    let Some(scheme_end) = base.find("://") else {
        return rel.to_string();
    };
    let authority_start = scheme_end + 3;
    let path_start = base[authority_start..]
        .find('/')
        .map(|p| authority_start + p)
        .unwrap_or(base.len());
    let origin = &base[..path_start];
    let base_path = &base[path_start..];
    let mut out_path: String = if rel.starts_with('/') {
        rel.to_string()
    } else {
        // 相对：基于 base 所在目录
        let dir = base_path
            .rsplit_once('/')
            .map(|(d, _)| if d.is_empty() { "/" } else { d })
            .unwrap_or("/");
        let joined = format!("{}/{}", dir.trim_end_matches('/'), rel);
        if !joined.starts_with('/') {
            format!("/{joined}")
        } else {
            joined
        }
    };
    // 规范化 . 与 ..
    let mut stack: Vec<&str> = Vec::new();
    for seg in out_path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            s => stack.push(s),
        }
    }
    out_path = format!("/{}", stack.join("/"));
    if let Some(query) = rel.find('?') {
        return format!("{origin}{}{}", &out_path, &rel[query..]);
    }
    format!("{origin}{out_path}")
}

pub(crate) fn query_string(obj: &Map<String, Value>) -> String {
    let mut parts = Vec::new();
    for (k, v) in obj {
        let s = match v {
            Value::Null => String::new(),
            Value::Array(items) => items
                .iter()
                .filter_map(|x| x.as_str())
                .collect::<Vec<_>>()
                .join(","),
            other => other.to_string().trim_matches('"').to_string(),
        };
        parts.push(format!("{}={}", percent_encode(k), percent_encode(&s)));
    }
    parts.join("&")
}

pub(crate) fn query_parse(input: &str) -> String {
    let query = match input.find('?') {
        Some(pos) => &input[pos + 1..],
        None => input,
    };
    let mut out = Map::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (percent_decode(k), percent_decode(v)),
            None => (percent_decode(pair), String::new()),
        };
        if k.is_empty() {
            continue;
        }
        out.entry(k).or_insert(Value::String(v));
    }
    serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| "{}".to_string())
}

// ---------------------------------------------------------------------------
// 杂项原生能力
// ---------------------------------------------------------------------------

pub(crate) fn sleep_ms(ms: u64) {
    let ms = ms.clamp(0, 10_000);
    std::thread::sleep(Duration::from_millis(ms));
}

// ---------------------------------------------------------------------------
// 编码 / 摘要 / HMAC / AES-256-GCM（书源 JS 的 base64 与 cryptoUtil）
//
// 编码契约（见 docs/book-source-api.md）：
// - data 一律按 **UTF-8 文本**取字节；要喂二进制就在 JS 侧用 `base64.decode` /
//   `cryptoUtil.hexDecode` 转成字符串再传进来（1 字节 = 1 字符，不丢真）；
// - key / iv 字符串按 **base64 优先**解析（与密文同一套编码，可原样回传），
//   解不出正确长度时退回 UTF-8 字面量（口令型写法，如 32 个 0）。十六进制密钥
//   请用 `cryptoUtil.hexDecode` 转换 —— hex 不会被当成 base64，但会让 32 字符的
//   hex 串被误读成 24 字节，故不做隐式兼容；
// - 摘要 / HMAC 默认小写 hex 输出（可选 base64），加解密默认 base64 输出。
// ---------------------------------------------------------------------------

/// `base64` 包对非规范输入报错，而各语言宽松解码的口径并不一致；这里先归一化：
/// 去空白、`-`/`_` → `+`/`/`、补回省略的 `=`；真正非法的字符仍交由解码器报错。
fn normalized_b64(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    let body_len = cleaned.trim_end_matches('=').len();
    let mut out = cleaned;
    out.truncate(body_len);
    for _ in 0..(4 - body_len % 4) % 4 {
        out.push('=');
    }
    out
}

fn b64_decode(text: &str, what: &str) -> Result<Vec<u8>, String> {
    B64.decode(normalized_b64(text).as_bytes())
        .map_err(|e| format!("{what}不是合法的 base64: {e}"))
}

/// 归一化后解码、再重新编码，结果与归一化输入逐字符相同才算「真 base64」。
/// 这一步挡的是 `key` / `iv` 的歧义输入：`"0123456789abcdef0123456789abcdef"`
/// （32 字节口令）归一化后也能被解出 24 字节，宽松解码会让它静默变成另一把密钥；
/// 真正的 base64（重新编码后与输入一致、或仅补了省略的 `=`）仍原样通过。
fn is_canonical_b64(text: &str) -> bool {
    let want = normalized_b64(text);
    match B64.decode(want.as_bytes()) {
        Ok(bytes) => B64.encode(&bytes) == want,
        Err(_) => false,
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// 十六进制解码（容忍空白 / 冒号分隔 / 大小写 / `0x` 前缀，奇数字节或非 hex 报错）
fn hex_decode(text: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = text
        .chars()
        .filter(|c| !c.is_ascii_whitespace() && *c != ':' && *c != '-')
        .collect();
    let cleaned = cleaned
        .strip_prefix("0x")
        .or_else(|| cleaned.strip_prefix("0X"))
        .unwrap_or(&cleaned);
    if cleaned.is_empty() {
        return Ok(Vec::new());
    }
    if !cleaned.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("十六进制字符串含非 0-9a-f 字符".to_string());
    }
    if !cleaned.len().is_multiple_of(2) {
        return Err("十六进制字符串长度为奇数".to_string());
    }
    let mut out = Vec::with_capacity(cleaned.len() / 2);
    let bytes = cleaned.as_bytes();
    for pair in bytes.chunks(2) {
        let s = std::str::from_utf8(pair).map_err(|_| "十六进制字符串非法".to_string())?;
        out.push(u8::from_str_radix(s, 16).map_err(|e| format!("十六进制解析失败: {e}"))?);
    }
    Ok(out)
}

/// 输出编码（摘要 / HMAC / 加解密共用）：默认小写 hex，可选 base64
fn encode_bytes(bytes: &[u8], encoding: Option<&str>) -> Result<String, String> {
    match encoding.unwrap_or("hex") {
        "hex" => Ok(hex_encode(bytes)),
        "base64" => Ok(B64.encode(bytes)),
        other => Err(format!("不支持的编码「{other}」（可用 hex / base64）")),
    }
}

/// 摘要 / HMAC 的输出编码：缺省 hex，空串也按缺省处理
fn digest_encoding(text: &str) -> Result<&'static str, String> {
    let text = text.trim();
    let text = if text.is_empty() { "hex" } else { text };
    match text {
        "hex" => Ok("hex"),
        "base64" => Ok("base64"),
        other => Err(format!("不支持的编码「{other}」（可用 hex / base64）")),
    }
}

/// key / iv 取字节，按 **字节数** 精确匹配（不做静默填充 / 截断）。
/// 与密文字段同一套判据：base64（含 `+` `/` `=` 的真 base64，见 [`is_canonical_b64`]）→
/// 十六进制（`cipher.keyHex` 这类）→ 字节保留字符串（`"0".repeat(32)` 这类字面量，
/// 以及 `base64.decode` / `hexDecode` 出来的字节串），取第一个正好 `want` 字节的解释；
/// 三种都对不上才报错并列出各自解出的字节数。
fn key_bytes(text: &str, want: usize, what: &str) -> Result<Vec<u8>, String> {
    let as_b64 = if is_canonical_b64(text) {
        b64_decode(text, what).ok()
    } else {
        None
    };
    if let Some(bytes) = as_b64.as_ref() {
        if bytes.len() == want {
            return Ok(bytes.clone());
        }
    }
    let as_hex = hex_decode(text).ok();
    if let Some(bytes) = as_hex.as_ref() {
        if bytes.len() == want {
            return Ok(bytes.clone());
        }
    }
    let raw = text_to_bytes(text);
    if raw.len() == want {
        return Ok(raw);
    }
    let mut seen: Vec<String> = Vec::new();
    if let Some(bytes) = as_b64.as_ref() {
        seen.push(format!("base64 解出 {} 字节", bytes.len()));
    }
    if let Some(bytes) = as_hex.as_ref() {
        seen.push(format!("hex 解出 {} 字节", bytes.len()));
    }
    seen.push(format!("文本 {} 字节", raw.len()));
    Err(format!(
        "{what}长度不对：需要 {want} 字节；当前 {} 字符（{}）",
        text.chars().count(),
        seen.join("，")
    ))
}

/// 随机 IV（12 字节，AES-GCM 推荐长度）
fn random_iv() -> Result<[u8; AES_GCM_IV_LEN], String> {
    let mut iv = [0u8; AES_GCM_IV_LEN];
    getrandom::getrandom(&mut iv).map_err(|e| format!("生成随机 IV 失败: {e}"))?;
    Ok(iv)
}

/// 不含 iv / aad 的 aesGcmEncrypt 参数错误提示
const AES_OPTS_HINT: &str =
    "参数需为对象：{ data, key, iv?, aad?, encoding? }";

/// 字节 → JS 字符串：每个字节映射成一个 U+0000–U+00FF 字符（Latin-1）。
/// 这是 base64 / hex 解码的输出形式：JS 里一个字符就是一个字节，文本可直接比较、
/// 拼接、丢回 `cryptoUtil`（`hexEncode` / `aesGcmEncrypt` 再按同一规则还原字节），
/// 不需要额外的类型；对纯 ASCII 而言与普通字符串完全一致。
pub(crate) fn bytes_to_js_string(bytes: &[u8]) -> String {
    bytes.iter().map(|b| *b as char).collect()
}

/// [`bytes_to_js_string`] 的逆运算：字节保留字符串 → 原始字节。
/// U+0000–U+00FF 每个字符还原成一个字节，其余字符（真正的中文 / emoji 文本）按 UTF-8 取字节。
///
/// **必须**用它取「字节保留字符串」的字节，不能用 `as_bytes()`：后者会把 U+0080–U+00FF
/// 各编码成 2 字节，而 `String::from_utf8` / `from_utf8_lossy` 更会把 0x80–0xFF 的原始字节
/// 直接替换成 U+FFFD（efbfbd），静默改写密钥 / 明文 / 摘要输入。
fn text_to_bytes(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    for ch in text.chars() {
        match ch as u32 {
            cp @ 0..=0xFF => out.push(cp as u8),
            _ => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    out
}

/// 字节保留字符串 → 小写 hex（`cryptoUtil.hexEncode` 的宿主实现）
pub(crate) fn hex_encode_text(text: &str) -> String {
    hex_encode(&text_to_bytes(text))
}

/// `base64.encode`：入参与 [`base64_decode`] 同一套字节保留约定
/// （`base64.encode(base64.decode(x))` 必须回到 `x`），非字节保留的文本按 UTF-8 取字节。
pub(crate) fn base64_encode(text: &str) -> String {
    B64.encode(text_to_bytes(text))
}

/// `base64.decode` → **字节保留**字符串（1 字符 = 1 字节，见 [`bytes_to_js_string`]）
pub(crate) fn base64_decode(text: &str) -> Result<String, String> {
    Ok(bytes_to_js_string(&b64_decode(text, "输入")?))
}

/// `cryptoUtil.hexDecode` → **字节保留**字符串（与 [`base64_decode`] 同一套约定）
pub(crate) fn hex_decode_to_string(text: &str) -> Result<String, String> {
    Ok(bytes_to_js_string(&hex_decode(text)?))
}

pub(crate) fn md5_hex(text: &str) -> String {
    hex_encode(&Md5::digest(text.as_bytes()))
}

pub(crate) fn sha1_hex(text: &str) -> String {
    hex_encode(&Sha1::digest(text.as_bytes()))
}

pub(crate) fn sha256_hex(text: &str) -> String {
    hex_encode(&Sha256::digest(text.as_bytes()))
}

/// `cryptoUtil.md5|sha1|sha256(data, encoding?)`：
/// `dataEncoding: "hex"` 表示 `data` 是十六进制（JS 侧二进制安全路径），缺省按 UTF-8 文本；
/// `encoding` 是**输出**编码（hex 默认 / base64）。
/// 历史写法 `md5(data)` / `sha1(data)` 与 `cryptoUtil.md5(data)` 走缺省 UTF-8 分支，行为不变。
pub(crate) fn digest_json(args: &str, kind: &str) -> Result<String, String> {
    let (data, encoding) = text_encoding_args(args, kind)?;
    let bytes = decode_data_arg(&data, args)?;
    match kind {
        "md5" => encode_bytes(&Md5::digest(&bytes), Some(encoding)),
        "sha1" => encode_bytes(&Sha1::digest(&bytes), Some(encoding)),
        "sha256" => encode_bytes(&Sha256::digest(&bytes), Some(encoding)),
        other => Err(format!("不支持的摘要算法「{other}」")),
    }
}

/// 取 `data` 的原始字节：`dataEncoding` 为 `"hex"` / `"base64"` 时先解码（二进制安全路径），
/// 否则按字节保留字符串还原（普通文本落到 UTF-8 分支，行为不变，见 [`text_to_bytes`]）。
fn decode_data_arg(data: &str, args: &str) -> Result<Vec<u8>, String> {
    let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    match parsed
        .get("dataEncoding")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "hex" => hex_decode(data),
        "base64" => b64_decode(data, "data"),
        _ => Ok(text_to_bytes(data)),
    }
}

/// `cryptoUtil.hmac(algorithm, key, data, encoding?)`
pub(crate) fn hmac_json(args: &str) -> Result<String, String> {
    let parsed: Value = serde_json::from_str(args)
        .map_err(|_| "参数需为对象：{ algorithm, key, data, encoding? }".to_string())?;
    let algorithm = parsed
        .get("algorithm")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .replace(['-', '_', ' '], "");
    // 容忍 "HMAC-SHA256" / "hmac_sha256" 这类写法
    let algorithm = algorithm
        .strip_prefix("hmac")
        .unwrap_or(&algorithm)
        .to_string();
    let key = parsed.get("key").and_then(Value::as_str).unwrap_or("");
    let data = parsed.get("data").and_then(Value::as_str).unwrap_or("");
    let data_bytes = decode_data_arg(data, args)?;
    let encoding = digest_encoding(parsed.get("encoding").and_then(Value::as_str).unwrap_or(""))?;
    match algorithm.as_str() {
        "md5" => hmac_digest(key, &data_bytes, encoding, <HmacMd5 as Mac>::new_from_slice),
        "sha1" => hmac_digest(key, &data_bytes, encoding, <HmacSha1 as Mac>::new_from_slice),
        "sha256" => hmac_digest(key, &data_bytes, encoding, <HmacSha256 as Mac>::new_from_slice),
        other => Err(format!(
            "不支持的 HMAC 算法「{other}」（可用 md5 / sha1 / sha256）"
        )),
    }
}

/// HMAC 收尾：`build` 只负责按算法建实例（RFC 2104 下三种摘要都接受任意长度密钥，
/// 实际不会返回 Err，仍按规范映射成错误）。
/// `key` 与 `data` 同为字节保留字符串：`base64.decode` / `hexDecode` 出来的字节串可直接当密钥。
fn hmac_digest<M, F>(key: &str, data: &[u8], encoding: &str, build: F) -> Result<String, String>
where
    M: Mac,
    F: FnOnce(&[u8]) -> Result<M, digest::InvalidLength>,
{
    let mut mac = build(&text_to_bytes(key)).map_err(|e| format!("HMAC 密钥非法: {e}"))?;
    mac.update(data);
    encode_bytes(&mac.finalize().into_bytes(), Some(encoding))
}

/// `cryptoUtil.aesGcmEncrypt({ data, key, iv?, aad?, encoding? })`
/// → JSON 文本 `{ iv, ivHex, key, keyHex, encoding, hex, base64, text }`。
/// `data` / `aad` 按字节保留字符串取字节（JS 侧决定是明文还是 base64.decode 出来的原始字节）。
pub(crate) fn aes_gcm_encrypt_json(args: &str) -> Result<String, String> {
    let parsed: Value = serde_json::from_str(args).map_err(|_| AES_OPTS_HINT.to_string())?;
    let data = parsed
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少 data（明文文本）；{AES_OPTS_HINT}"))?;
    let key = parsed.get("key").and_then(Value::as_str).unwrap_or("");
    let key = key_bytes(key, AES_GCM_KEY_LEN, "AES-256 密钥")?;
    let iv = match parsed.get("iv").and_then(Value::as_str) {
        Some(text) => key_bytes(text, AES_GCM_IV_LEN, "IV（12 字节）")?,
        None => random_iv()?.to_vec(),
    };
    let aad = text_to_bytes(parsed.get("aad").and_then(Value::as_str).unwrap_or(""));
    let encoding = parsed
        .get("encoding")
        .and_then(Value::as_str)
        .unwrap_or("base64");

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("AES 密钥非法: {e}"))?;
    let nonce = Nonce::from_slice(&iv);
    let mut buf = text_to_bytes(data);
    let tag = cipher
        .encrypt_in_place_detached(nonce, &aad, &mut buf)
        .map_err(|e| format!("AES-GCM 加密失败: {e}"))?;
    // 密文尾部接 16 字节认证标签，与 WebCrypto 的 `ciphertext||tag` 一致
    buf.extend_from_slice(&tag);
    let key_b64 = B64.encode(&key);
    let iv_b64 = B64.encode(&iv);
    Ok(json!({
        "iv": iv_b64,
        "ivHex": hex_encode(&iv),
        "key": key_b64,
        "keyHex": hex_encode(&key),
        "encoding": encoding,
        "hex": hex_encode(&buf),
        "base64": B64.encode(&buf),
        // 字节保留字符串（1 字符 = 1 字节）：可直接拼接进 body，也可原样回传给解密
        "text": bytes_to_js_string(&buf),
    })
    .to_string())
}

/// `cryptoUtil.aesGcmDecrypt({ data, iv, key, aad?, encoding? })` → 明文字符串。
/// `encoding` 决定明文的返回形态：`"text"`（默认，按 UTF-8 解码；解不出就当作文本尽力还原）
/// 或 `"bytes"`（字节保留字符串，1 字符 = 1 字节，见 [`bytes_to_js_string`]）。
/// 明文本身是二进制时必须显式传 `"bytes"`，否则非法 UTF-8 字节会被替换。
/// `data` / `iv` 当作 key 一样按 base64 优先解析（`cipher.base64` / `cipher.iv` 可原样回传）。
pub(crate) fn aes_gcm_decrypt_json(args: &str) -> Result<String, String> {
    let parsed: Value = serde_json::from_str(args)
        .map_err(|_| "参数需为对象：{ data, iv, key, aad?, encoding? }".to_string())?;
    let payload = parsed
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| "缺少 data（密文）".to_string())?;
    let key = parsed.get("key").and_then(Value::as_str).unwrap_or("");
    let key = key_bytes(key, AES_GCM_KEY_LEN, "AES-256 密钥")?;
    let iv_text = parsed
        .get("iv")
        .and_then(Value::as_str)
        .ok_or_else(|| "缺少 iv（应回传 aesGcmEncrypt 返回的 iv）".to_string())?;
    let iv = key_bytes(iv_text, AES_GCM_IV_LEN, "IV（12 字节）")?;
    let aad = text_to_bytes(parsed.get("aad").and_then(Value::as_str).unwrap_or(""));

    // 密文：先试十六进制（`cipher.hex` 只有 0-9a-f，base64 解码器会把这类串当乱码
    // 收下一半字节），再试 base64（`cipher.base64`）；两种都解不出就报 base64 的错误。
    let mut buf = match hex_decode(payload) {
        Ok(bytes) => bytes,
        Err(_) => b64_decode(payload, "密文")?,
    };
    if buf.len() < AES_GCM_TAG_LEN {
        return Err(format!(
            "密文长度不足：AES-GCM 密文至少包含 {} 字节认证标签",
            AES_GCM_TAG_LEN
        ));
    }
    let tag_at = buf.len() - AES_GCM_TAG_LEN;
    let tag: [u8; AES_GCM_TAG_LEN] = buf[tag_at..]
        .try_into()
        .map_err(|_| "认证标签长度异常".to_string())?;
    buf.truncate(tag_at);

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("AES 密钥非法: {e}"))?;
    cipher
        .decrypt_in_place_detached(Nonce::from_slice(&iv), &aad, &mut buf, &tag.into())
        .map_err(|_| "AES-GCM 解密失败：密钥 / IV / AAD 不匹配，或密文被篡改".to_string())?;
    // 默认按文本返回（历史行为：明文是 UTF-8 文本时结果可读）；
    // 明文是二进制时调用方要显式声明 "bytes"，否则非法 UTF-8 字节会被替换成 U+FFFD。
    match decrypt_output_encoding(parsed.get("encoding").and_then(Value::as_str))? {
        "bytes" => Ok(bytes_to_js_string(&buf)),
        _ => Ok(String::from_utf8_lossy(&buf).into_owned()),
    }
}

/// 解密输出的形态：`"text"`（默认）/ `"bytes"`（字节保留）
fn decrypt_output_encoding(text: Option<&str>) -> Result<&'static str, String> {
    match text.map(str::trim).unwrap_or("") {
        "" | "text" | "utf8" | "utf-8" => Ok("text"),
        "bytes" | "binary" | "latin1" => Ok("bytes"),
        other => Err(format!(
            "不支持的 encoding「{other}」（aesGcmDecrypt 可用 text / bytes）"
        )),
    }
}

/// 摘要类函数的入参：兼容 `sha256(data)` 与 `sha256(data, encoding)` 两种调用形态
/// （JS 侧统一打包成 `{ data }` / `{ data, encoding }`）。
fn text_encoding_args(args: &str, what: &str) -> Result<(String, &'static str), String> {
    let parsed: Value = serde_json::from_str(args)
        .map_err(|_| format!("{what} 参数非法（内部编码错误）"))?;
    let data = parsed
        .get("data")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let encoding = digest_encoding(parsed.get("encoding").and_then(Value::as_str).unwrap_or(""))?;
    Ok((data, encoding))
}

// ---------------------------------------------------------------------------
// WebView 登录（书源 JS 引擎调用；编排见 crate::webview_login）
// ---------------------------------------------------------------------------

/// 平台是否支持网页登录（当前仅 Android）。
pub(crate) fn webview_login_supported() -> bool {
    webview_login::is_supported()
}

/// 打开登录浮层并**阻塞等待**用户完成/取消/超时。
/// 成功后内部已完成：持久化 + 注入该书源会话（后续 http.* 自动携带 Cookie）。
/// 返回 JSON 文本 `{ ok, url, cookies, count, message }`（不抛宿主错误）。
pub(crate) fn webview_login(source_id: &str, url: &str, _opts: &str) -> String {
    // 书源「自动网页认证」开关关闭时，书源代码无法主动拉起登录窗（编辑页手动按钮不受影响）
    let auto_auth = source_state(source_id)
        .map(|s| s.auto_auth.lock().map(|g| *g).unwrap_or(true))
        .unwrap_or(true);
    if !auto_auth {
        let value = json!({
            "ok": false,
            "url": url,
            "cookies": "",
            "count": 0,
            "message": "该书源已关闭「自动网页认证」，书源代码无法拉起登录窗口"
        });
        return serde_json::to_string(&value).unwrap_or_else(|_| error_payload("登录结果序列化失败".into()));
    }
    let value = match webview_login::perform(source_id, url) {
        Ok(outcome) => serde_json::to_value(&outcome)
            .unwrap_or_else(|_| json!({ "ok": false, "message": "登录结果序列化失败" })),
        Err(err) => json!({ "ok": false, "message": err }),
    };
    serde_json::to_string(&value).unwrap_or_else(|_| error_payload("登录结果序列化失败".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(status: u16, content_type: &str, extra_headers: &[(&str, &str)], body: &str) -> Value {
        let mut headers = Map::new();
        headers.insert("content-type".into(), json!(content_type));
        for (k, v) in extra_headers {
            headers.insert((*k).into(), json!(v));
        }
        json!({
            "ok": status < 400,
            "status": status,
            "headers": headers,
            "body": body,
        })
    }

    #[test]
    fn detects_modern_cf_challenge_by_header() {
        let resp = response(
            403,
            "text/html; charset=UTF-8",
            &[("server", "cloudflare"), ("cf-mitigated", "challenge")],
            "<html>Verify you are human</html>",
        );
        assert!(is_cf_challenge_response(&resp));
    }

    #[test]
    fn detects_classic_cf_challenge_page() {
        let resp = response(
            403,
            "text/html",
            &[("server", "cloudflare")],
            "<html>Just a moment... Enable JavaScript and cookies to continue</html>",
        );
        assert!(is_cf_challenge_response(&resp));
    }

    #[test]
    fn ignores_plain_error_pages() {
        // 非 cloudflare 服务器 + 文案巧合，不应误判为挑战
        let resp = response(
            403,
            "text/html",
            &[("server", "nginx")],
            "<html>Just a moment... retry later</html>",
        );
        assert!(!is_cf_challenge_response(&resp));

        // 普通 404 页面
        let resp = response(
            404,
            "text/html",
            &[("server", "cloudflare")],
            "<html>Not Found</html>",
        );
        assert!(!is_cf_challenge_response(&resp));
    }

    #[test]
    fn ignores_non_html_blocked_responses() {
        // cloudflare 拦 JSON 接口（非挑战页）不应触发自动认证窗
        let resp = response(
            403,
            "application/json",
            &[("server", "cloudflare")],
            r#"{"code":403,"msg":"blocked"}"#,
        );
        assert!(!is_cf_challenge_response(&resp));
    }

    #[test]
    fn origin_keeps_scheme_and_host() {
        assert_eq!(origin_of("https://a.example.com/p?x=1").unwrap(), "https://a.example.com");
        assert_eq!(origin_of("http://b.example.net:8080/x").unwrap(), "http://b.example.net:8080");
        assert_eq!(origin_of("https://c.example.org"), Some("https://c.example.org".into()));
        assert_eq!(origin_of("javascript:void(0)"), None);
    }

    #[test]
    fn decode_body_reads_charset_and_never_panics() {
        // 常规 charset 生效（GBK「中文」）
        assert_eq!(decode_body(&[0xD6, 0xD0, 0xCE, 0xC4], "text/html; charset=gbk"), "中文");
        // 旧实现用 to_lowercase 的下标切原串：'İ' 小写化后多一个字节，下标越界 panic
        assert_eq!(decode_body("正文".as_bytes(), "İcharset="), "正文");
        // 没有 charset / 空 header 也不能出错
        assert_eq!(decode_body("正文".as_bytes(), ""), "正文");
        assert_eq!(decode_body("正文".as_bytes(), "charset="), "正文");
    }

    #[test]
    fn decode_body_prefers_valid_utf8_without_charset() {
        // 短响应体（无 charset 的 JSON / 小页面）必须按 UTF-8 解，而不是退回 GB18030 变乱码
        let json = r#"{"bookName":"斗破苍穹"}"#;
        assert_eq!(decode_body(json.as_bytes(), "application/json"), json);
        // 真正的 GBK 字节（非法 UTF-8）仍应走 GB18030 兜底
        assert_eq!(decode_body(&[0xD6, 0xD0, 0xCE, 0xC4], "text/html"), "中文");
    }

    #[test]
    fn html_to_text_survives_broken_markup() {
        // 残缺 / 恶意构造的 HTML 只应退化输出，绝不 panic（旧实现的切片理论上可越界）
        assert_eq!(html_to_text("<p>正文", "\n"), "正文");
        assert_eq!(html_to_text("裸文本", "\n"), "裸文本");
        assert_eq!(html_to_text("<div>中文<未闭合", "\n"), "中文");
        assert_eq!(html_to_text("<!-- 未闭合注释", "\n"), "");
        assert_eq!(html_to_text("<script>var a = 1;", "\n"), "");
        assert_eq!(html_to_text("<", "\n"), "");
        assert_eq!(html_to_text("<>", "\n"), "");
        assert_eq!(html_to_text("", "\n"), "");
        assert_eq!(html_to_text("a &amp; b", ""), "a & b");
        assert_eq!(html_to_text("<p>中文</p><p>正文</p>", "\n").trim(), "中文\n正文");
    }

    #[test]
    fn image_dimensions_reads_common_formats() {
        // PNG：签名 + 长度 + IHDR + 宽高（大端）
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&800u32.to_be_bytes());
        png.extend_from_slice(&600u32.to_be_bytes());
        assert_eq!(image_dimensions(&png), Some((800, 600)));

        // GIF：逻辑屏幕宽高小端
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&320u16.to_le_bytes());
        gif.extend_from_slice(&240u16.to_le_bytes());
        assert_eq!(image_dimensions(&gif), Some((320, 240)));

        // BMP：BITMAPINFOHEADER，高度为负表示自上而下
        let mut bmp = b"BM".to_vec();
        bmp.resize(18, 0);
        bmp.extend_from_slice(&64u32.to_le_bytes());
        bmp.extend_from_slice(&(-48i32).to_le_bytes());
        assert_eq!(image_dimensions(&bmp), Some((64, 48)));

        // JPEG：SOI + APP0 段 + SOF0（高 1080、宽 1920）
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        jpeg.extend_from_slice(&[0u8; 14]);
        jpeg.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        jpeg.extend_from_slice(&1080u16.to_be_bytes());
        jpeg.extend_from_slice(&1920u16.to_be_bytes());
        assert_eq!(image_dimensions(&jpeg), Some((1920, 1080)));

        // WebP（无损 VP8L）：signature 0x2F + 14 位宽高（各减 1）
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&0u32.to_le_bytes());
        webp.extend_from_slice(b"WEBP");
        webp.extend_from_slice(b"VP8L");
        webp.extend_from_slice(&0u32.to_le_bytes());
        webp.push(0x2F);
        let bits: u32 = (199) | ((99) << 14);
        webp.extend_from_slice(&bits.to_le_bytes());
        assert_eq!(image_dimensions(&webp), Some((200, 100)));

        // 解析不出 / 畸形输入：返回 None，绝不 panic
        assert_eq!(image_dimensions(b""), None);
        assert_eq!(image_dimensions(b"\x89PNG\r\n\x1a\n"), None);
        assert_eq!(image_dimensions(b"\xFF\xD8\xFF"), None);
        assert_eq!(image_dimensions(&[0xFF, 0xD8, 0xFF, 0xC0, 0xFF, 0xFF]), None);
        // 尺寸离谱（解析错位 / 畸形文件）也按失败处理，避免按天文数字排版
        let mut huge = b"BM".to_vec();
        huge.resize(18, 0);
        huge.extend_from_slice(&4_000_000_000u32.to_le_bytes());
        huge.extend_from_slice(&4_000_000_000u32.to_le_bytes());
        assert_eq!(image_dimensions(&huge), None);
    }

    // -----------------------------------------------------------------------
    // base64 / 摘要 / HMAC / AES-GCM
    // 期望值由 Python hashlib/hmac 与 Node crypto（WebCrypto 同语义）独立算出，
    // 明文统一为 "hello 书源"（UTF-8 含中文，覆盖非 ASCII 路径）。
    // -----------------------------------------------------------------------

    const SAMPLES: &str = "hello 书源";

    fn ok(result: Result<String, String>) -> String {
        match result {
            Ok(text) => text,
            Err(err) => panic!("期望成功，实际报错: {err}"),
        }
    }

    fn err(result: Result<String, String>) -> String {
        match result {
            Ok(text) => panic!("期望报错，实际返回: {text}"),
            Err(err) => err,
        }
    }

    fn encrypt(args: Value) -> Value {
        serde_json::from_str(&ok(aes_gcm_encrypt_json(&args.to_string())))
            .expect("aesGcmEncrypt 应返回 JSON 对象")
    }

    /// 含 0x00 / 0x7f 与 0x80–0xff 的 32 字节密钥：**不是**合法 UTF-8。
    /// 字节保留字符串写成 Latin-1 后正好 32 个字符，必须被原样取字节。
    fn binary_key() -> String {
        let bytes: [u8; 32] = [
            0x81, 0xff, 0x88, 0x00, 0x8f, 0x7f, 0x96, 0xc3, 0x9d, 0x28, 0xa4, 0xab, 0xb2, 0xb9,
            0xc0, 0xc7, 0xce, 0xd5, 0xdc, 0xe3, 0xea, 0xf1, 0xf8, 0xfe, 0x06, 0x0d, 0x14, 0x1b,
            0x22, 0x29, 0x30, 0x37,
        ];
        bytes_to_js_string(&bytes)
    }

    /// 字节保留字符串的字节取法：U+0080–U+00FF 一个字符一个字节，
    /// 非 Latin-1 字符才按 UTF-8。回归的是「0x80–0xff 被替换成 U+FFFD」这类静默改写。
    #[test]
    fn byte_preserving_strings_keep_non_utf8_bytes() {
        let key = binary_key();
        assert_eq!(key.chars().count(), 32);
        assert_eq!(
            text_to_bytes(&key),
            vec![
                0x81, 0xff, 0x88, 0x00, 0x8f, 0x7f, 0x96, 0xc3, 0x9d, 0x28, 0xa4, 0xab, 0xb2,
                0xb9, 0xc0, 0xc7, 0xce, 0xd5, 0xdc, 0xe3, 0xea, 0xf1, 0xf8, 0xfe, 0x06, 0x0d,
                0x14, 0x1b, 0x22, 0x29, 0x30, 0x37,
            ]
        );
        // 期望值由 Node Buffer.from(bytes).toString('hex') 独立算出
        assert_eq!(
            hex_encode_text(&key),
            "81ff88008f7f96c39d28a4abb2b9c0c7ced5dce3eaf1f8fe060d141b22293037"
        );
        assert_eq!(
            base64_encode(&key),
            "gf+IAI9/lsOdKKSrsrnAx87V3OPq8fj+Bg0UGyIpMDc="
        );
        // 普通文本仍按 UTF-8 取字节（中文一个字 3 字节），不受字节保留规则影响
        assert_eq!(text_to_bytes("hello 书源"), "hello 书源".as_bytes());
        assert_eq!(text_to_bytes("é"), vec![0xe9]); // U+00E9 落在 U+0000–U+00FF，算一个字节，不是 UTF-8 的 c3a9
    }

    /// hexDecode / base64.decode 的产物必须能原样取回字节：
    /// 0x80–0xff 既不能被 UTF-8 展开，也不能被替换成 U+FFFD。
    #[test]
    fn decoded_bytes_survive_round_trip() {
        assert_eq!(ok(hex_decode_to_string("80ff")), "\u{80}\u{ff}");
        assert_eq!(hex_encode_text(&ok(hex_decode_to_string("80ff"))), "80ff");
        // base64 → 字节保留字符串 → hex，与 Node 的 Buffer 结果一致
        let raw = ok(base64_decode("aGVsbG8g5Lmm5rqQ"));
        assert_eq!(raw.chars().count(), 12);
        assert_eq!(hex_encode_text(&raw), "68656c6c6f20e4b9a6e6ba90");
        // 含 0x80–0xff 的字节串（Base64 与期望 hex 都由 node/Python 独立核对）
        let bin = ok(base64_decode("gYiPkpSms7nAx87V3OPq8fj/Bg0UGyIpMDc+RUxTWg=="));
        assert_eq!(bin.chars().count(), 31);
        assert_eq!(
            hex_encode_text(&bin),
            "81888f9294a6b3b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a"
        );
        // base64.encode(base64.decode(x)) === x（同一份字节，不再被 UTF-8 展开）
        assert_eq!(
            base64_encode(&bin),
            "gYiPkpSms7nAx87V3OPq8fj/Bg0UGyIpMDc+RUxTWg=="
        );
    }

    /// 二进制密钥 / 明文 / AAD / HMAC key 全部按字节参与，期望值由 Node crypto 独立算出。
    #[test]
    fn binary_crypto_vectors_from_node() {
        let key = binary_key();
        // 摘要传的是「字节串」而不是文本
        assert_eq!(
            ok(digest_json(
                &json!({ "data": hex_encode_text(&key), "dataEncoding": "hex" }).to_string(),
                "md5"
            )),
            "9158d4811244cee87734527a861445c2"
        );
        assert_eq!(
            ok(digest_json(
                &json!({ "data": hex_encode_text(&key), "dataEncoding": "hex" }).to_string(),
                "sha256"
            )),
            "5b363960de2f647c4c185ff95feb8a652e6e131ac2fbd5c9eda85859edd5d981"
        );
        // HMAC：key 是二进制字节串；data 走字节保留 / hex 两条路径结果一致
        assert_eq!(
            ok(hmac_json(
                &json!({ "algorithm": "sha256", "key": key, "data": "page=2" }).to_string()
            )),
            "a0df0c346e1f198965036a5f1f9d2fc5d4feb58440bac080260b4764b8ac8c1b"
        );
        assert_eq!(
            ok(hmac_json(
                &json!({
                    "algorithm": "sha256",
                    "key": "secret",
                    "data": hex_encode_text(&key),
                    "dataEncoding": "hex"
                })
                .to_string()
            )),
            "c5c2443892554246915f9516682ce34ddd0ab7375d2ab9b1f72ddcf45120e915"
        );

        // AES-256-GCM：明文含 0x81 / 0xc3 0x28（非法 UTF-8 对）/ 0x00 / 0xff，
        // 固定 IV，密文（含 16 字节标签）由 Node createCipheriv('aes-256-gcm') 算出
        let plain: String = [0x81u8, 0xc3, 0x28, 0x00, 0xff, 0x7f]
            .iter()
            .map(|b| *b as char)
            .collect();
        let cipher = encrypt(json!({
            "data": plain,
            "key": key,
            "iv": "0".repeat(12),
            "encoding": "hex",
        }));
        assert_eq!(
            cipher["hex"].as_str().unwrap(),
            "2bb3c6b7e121f7145f508107e79d099ed4c3a17ad78e"
        );
        assert_eq!(
            cipher["base64"].as_str().unwrap(),
            "K7PGt+Eh9xRfUIEH550JntTDoXrXjg=="
        );
        // 二进制密钥的 base64 / hex 写法都解出同一把密钥
        assert_eq!(cipher["keyHex"].as_str().unwrap(), hex_encode_text(&key));
        assert_eq!(cipher["key"].as_str().unwrap(), base64_encode(&key));
        // 密文可以原样解回同一串字节：base64 / hex 两种写法 + 二进制密钥的三种写法混搭都行。
        // 明文是二进制，必须显式 encoding: "bytes" 才不会被 U+FFFD 改写。
        assert_eq!(
            ok(aes_gcm_decrypt_json(
                &json!({ "data": cipher["base64"], "iv": cipher["iv"], "key": key, "encoding": "bytes" })
                    .to_string()
            )),
            plain
        );
        assert_eq!(
            ok(aes_gcm_decrypt_json(
                &json!({
                    "data": cipher["hex"], "iv": cipher["ivHex"], "key": cipher["keyHex"], "encoding": "bytes"
                })
                .to_string()
            )),
            plain
        );
        // 不给 encoding 时保持历史行为：按文本解码（非法字节替换成 U+FFFD）
        assert_eq!(
            ok(aes_gcm_decrypt_json(
                &json!({ "data": cipher["base64"], "iv": cipher["iv"], "key": key }).to_string()
            )),
            String::from_utf8_lossy(&text_to_bytes(&plain)).into_owned()
        );
        // cipher.text 是**密文**的字节保留字符串（不是明文）：hexEncode 回来必须等于 cipher.hex
        assert_eq!(
            hex_encode_text(cipher["text"].as_str().unwrap()),
            cipher["hex"].as_str().unwrap()
        );
        // 明文是 UTF-8 文本时，默认（文本）与 bytes 两种形态都能还原出同一串字节
        let text_cipher = encrypt(json!({
            "data": SAMPLES,
            "key": key,
            "iv": "0".repeat(12),
        }));
        assert_eq!(
            ok(aes_gcm_decrypt_json(
                &json!({ "data": text_cipher["base64"], "iv": text_cipher["iv"], "key": key })
                    .to_string()
            )),
            SAMPLES
        );
        assert_eq!(
            hex_encode_text(&ok(aes_gcm_decrypt_json(
                &json!({
                    "data": text_cipher["base64"], "iv": text_cipher["iv"], "key": key, "encoding": "bytes"
                })
                .to_string()
            ))),
            hex_encode_text(SAMPLES)
        );
        assert!(aes_gcm_decrypt_json(
            &json!({ "data": text_cipher["base64"], "iv": text_cipher["iv"], "key": key, "encoding": "base32" })
                .to_string()
        )
        .is_err());
        // key 直接用 base64.decode 出来的字节串也认；换一把密钥必须失败
        let key_b64 = ok(base64_decode(&base64_encode(&key)));
        assert_eq!(
            ok(aes_gcm_decrypt_json(
                &json!({ "data": cipher["base64"], "iv": cipher["iv"], "key": key_b64, "encoding": "bytes" })
                    .to_string()
            )),
            plain
        );
        let mut other = vec![0u8];
        other.extend(text_to_bytes(&key)[1..].iter().copied());
        let other = bytes_to_js_string(&other);
        assert_ne!(other, key);
        assert!(aes_gcm_decrypt_json(
            &json!({ "data": cipher["base64"], "iv": cipher["iv"], "key": other }).to_string()
        )
        .is_err());
    }

    #[test]
    fn base64_accepts_common_variants() {
        // 标准 / URL-safe / 省略 padding / 带空白都应解出同一份字节
        let bytes = "hello 书源".as_bytes();
        let standard = B64.encode(bytes);
        assert_eq!(b64_decode(&standard, "输入").unwrap(), bytes);
        assert_eq!(
            b64_decode(&standard.trim_end_matches('='), "输入").unwrap(),
            bytes
        );
        let url_safe = standard.replace('+', "-").replace('/', "_");
        assert_eq!(b64_decode(&url_safe, "输入").unwrap(), bytes);
        assert_eq!(
            b64_decode(&format!(" {} \n", standard), "输入").unwrap(),
            bytes
        );
        assert!(b64_decode("!!!非法!!!", "输入").is_err());
    }

    #[test]
    fn hex_round_trip_and_tolerance() {
        let bytes = "hello 书源".as_bytes();
        assert_eq!(hex_encode(bytes), "68656c6c6f20e4b9a6e6ba90");
        assert_eq!(hex_decode(&hex_encode(bytes)).unwrap(), bytes);
        // 大写 / 空白 / 冒号分隔 / 0x 前缀都是常见写法
        assert_eq!(hex_decode("68 65:6C 6C6F").unwrap(), b"hello");
        assert_eq!(hex_decode("0x68656c6c6f").unwrap(), b"hello");
        assert_eq!(hex_decode("").unwrap(), Vec::<u8>::new());
        assert!(hex_decode("abc").is_err()); // 奇数长度
        assert!(hex_decode("zz").is_err()); // 非 hex 字符
        // 与 base64 互相独立：hex 解码失败时不应静默给出别的字节
        assert_eq!(ok(hex_decode_to_string("6869")), "hi");
    }

    #[test]
    fn digests_match_reference_vectors() {
        assert_eq!(md5_hex(SAMPLES), "44a24962f6b0e616c0ed0fdf91b943cd");
        assert_eq!(sha1_hex(SAMPLES), "3662e0b52fc079e6cd8854ad86d8c5997826be62");
        assert_eq!(
            sha256_hex(SAMPLES),
            "9744786d75102275f714407c6edee01b65716eb3cfc7d56ea1e940897236dfb3"
        );
        // 空输入是历史写法容易踩的边界
        assert_eq!(
            md5_hex(""),
            "d41d8cd98f00b204e9800998ecf8427e"
        );
        assert_eq!(sha1_hex(""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn digest_json_keeps_hex_default_and_supports_base64() {
        // 只传 data（历史写法）→ 小写 hex
        assert_eq!(
            ok(digest_json(&json!({ "data": SAMPLES }).to_string(), "md5")),
            "44a24962f6b0e616c0ed0fdf91b943cd"
        );
        assert_eq!(
            ok(digest_json(&json!({ "data": SAMPLES }).to_string(), "sha1")),
            "3662e0b52fc079e6cd8854ad86d8c5997826be62"
        );
        assert_eq!(
            ok(digest_json(&json!({ "data": SAMPLES }).to_string(), "sha256")),
            "9744786d75102275f714407c6edee01b65716eb3cfc7d56ea1e940897236dfb3"
        );
        // 显式 hex / base64
        assert_eq!(
            ok(digest_json(
                &json!({ "data": SAMPLES, "encoding": "base64" }).to_string(),
                "sha256"
            )),
            "l0R4bXUQInX3FEB8bt7gG2VxbrPPx9VuoelAiXI237M="
        );
        assert_eq!(
            ok(digest_json(
                &json!({ "data": SAMPLES, "encoding": "base64" }).to_string(),
                "md5"
            )),
            "RKJJYvaw5hbA7Q/fkblDzQ=="
        );
        assert_eq!(
            ok(digest_json(
                &json!({ "data": SAMPLES, "encoding": "base64" }).to_string(),
                "sha1"
            )),
            "NmLgtS/AeebNiFSthtjFmXgmvmI="
        );
        assert!(digest_json(&json!({ "data": SAMPLES, "encoding": "base32" }).to_string(), "sha256").is_err());
    }

    #[test]
    fn hmac_matches_reference_vectors() {
        let md5 = ok(hmac_json(
            &json!({ "algorithm": "md5", "key": "0123456789ab", "data": SAMPLES }).to_string(),
        ));
        let sha1 = ok(hmac_json(
            &json!({ "algorithm": "sha1", "key": "0123456789ab", "data": SAMPLES }).to_string(),
        ));
        let sha256 = ok(hmac_json(
            &json!({ "algorithm": "sha256", "key": "0123456789ab", "data": SAMPLES }).to_string(),
        ));
        assert_eq!(md5, "2ae3172de63671084bc3b1deb19317d0");
        assert_eq!(sha1, "425f5aab0ef2c4f036c633e7a6bc3d529f0338de");
        assert_eq!(
            sha256,
            "d052845a12f557e4efeed421fad7149e3e7495beab35f7bef8adb0c115e8a2f3"
        );
        // 算法名容忍大小写与连字符（"HMAC-SHA256" / "sha-256" 都常见）
        assert_eq!(
            ok(hmac_json(
                &json!({ "algorithm": "HMAC-SHA256", "key": "0123456789ab", "data": SAMPLES })
                    .to_string(),
            )),
            sha256
        );
        // base64 输出
        assert_eq!(
            ok(hmac_json(
                &json!({ "algorithm": "sha256", "key": "0123456789ab", "data": SAMPLES, "encoding": "base64" })
                    .to_string(),
            )),
            "0FKEWhL1V+Tv7tQh+tcUnj50lb6rNfe++K2wwRXoovM="
        );
        // RFC 4231 用例 1（HMAC-SHA256）
        assert_eq!(
            ok(hmac_json(
                &json!({
                    "algorithm": "sha256",
                    "key": "key",
                    "data": "The quick brown fox jumps over the lazy dog"
                })
                .to_string(),
            )),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
        assert!(hmac_json(
            &json!({ "algorithm": "sha3", "key": "k", "data": "d" }).to_string()
        )
        .is_err());
    }

    #[test]
    fn aes_gcm_matches_webcrypto_vectors() {
        let key32 = "ReaderX-AES-key-0123456789abcdef"; // 正好 32 字节 UTF-8
        let zero_iv = "0".repeat(12);
        // 已知向量：固定 key / iv、无 AAD（Python cryptography 独立算出）
        let cipher = encrypt(json!({
            "data": SAMPLES,
            "key": key32,
            "iv": zero_iv,
            "encoding": "hex",
        }));
        assert_eq!(cipher["keyHex"].as_str().unwrap(), hex_encode(key32.as_bytes()));
        assert_eq!(cipher["ivHex"].as_str().unwrap(), hex_encode(zero_iv.as_bytes()));
        assert_eq!(
            cipher["hex"].as_str().unwrap(),
            "9eb433b2fd772257d75fe1ceebf424ccda2006adbf1347de7749406b"
        );
        assert_eq!(
            cipher["base64"].as_str().unwrap(),
            "nrQzsv13IlfXX+HO6/QkzNogBq2/E0fed0lAaw=="
        );
        // 密文 = 明文（12 字节）+ 16 字节 GCM 标签
        assert_eq!(cipher["hex"].as_str().unwrap().len() / 2, SAMPLES.len() + AES_GCM_TAG_LEN);
        // AAD 参与认证（同一 key/iv 下密文与标签都不同）
        let with_aad = encrypt(json!({
            "data": SAMPLES,
            "key": key32,
            "iv": zero_iv,
            "aad": "aad-extra",
            "encoding": "hex",
        }));
        assert_eq!(
            with_aad["hex"].as_str().unwrap(),
            "9eb433b2fd772257d75fe1ce0a93c329e75a29e830879bd93ffa8c9d"
        );
        assert_ne!(with_aad["hex"], cipher["hex"]);
    }

    #[test]
    fn aes_gcm_round_trips_and_rejects_tampering() {
        let key32 = "ReaderX-AES-key-0123456789abcdef";
        let args = json!({
            "data": SAMPLES,
            "key": key32,
            "iv": B64.encode("0".repeat(12).as_bytes()),
        });
        let cipher = encrypt(args.clone());
        let data = cipher["base64"].as_str().unwrap().to_string();
        let iv = cipher["iv"].as_str().unwrap().to_string();
        // 默认编码就是 base64，cipher.base64 / cipher.iv 可原样回传给解密
        assert_eq!(cipher["encoding"], "base64");
        assert_eq!(
            ok(aes_gcm_decrypt_json(
                &json!({ "data": data, "iv": iv, "key": key32 }).to_string()
            )),
            SAMPLES
        );
        // key 用 base64 形式同样可解（{ key } 与 { keyHex } 等价）
        assert_eq!(
            ok(aes_gcm_decrypt_json(
                &json!({ "data": data, "iv": iv, "key": cipher["key"] }).to_string()
            )),
            SAMPLES
        );
        // 十六进制密文 + hex 形式的 iv 也能解
        assert_eq!(
            ok(aes_gcm_decrypt_json(
                &json!({
                    "data": cipher["hex"],
                    "iv": cipher["ivHex"],
                    "key": cipher["keyHex"],
                })
                .to_string()
            )),
            SAMPLES
        );

        // AAD 必须一致
        let with_aad = encrypt(json!({
            "data": SAMPLES,
            "key": key32,
            "iv": "0".repeat(12),
            "aad": "extra",
        }));
        assert_eq!(
            with_aad["hex"].as_str().unwrap(),
            "9eb433b2fd772257d75fe1ce3966db020174ae3302e8d63693dcad72"
        );
        let aad_args = json!({
            "data": with_aad["base64"],
            "iv": with_aad["iv"],
            "key": key32,
        });
        assert!(aes_gcm_decrypt_json(&aad_args.to_string()).is_err());
        let mut ok_args = aad_args.clone();
        ok_args["aad"] = json!("extra");
        assert_eq!(ok(aes_gcm_decrypt_json(&ok_args.to_string())), SAMPLES);

        // 篡改密文 / 换错密钥 / 换错 IV：一律报错，绝不返回半截明文
        let mut tampered = data.clone().into_bytes();
        tampered[0] = if tampered[0] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(tampered).unwrap();
        assert!(aes_gcm_decrypt_json(
            &json!({ "data": tampered, "iv": iv, "key": key32 }).to_string()
        )
        .is_err());
        let other_key = "ReaderX-AES-key-0123456789abcdeZ";
        assert!(aes_gcm_decrypt_json(
            &json!({ "data": data, "iv": iv, "key": other_key }).to_string()
        )
        .is_err());
        assert!(aes_gcm_decrypt_json(
            &json!({ "data": data, "iv": B64.encode("1".repeat(12).as_bytes()), "key": key32 })
                .to_string()
        )
        .is_err());
        // 密文长度不足一个标签
        assert!(aes_gcm_decrypt_json(
            &json!({ "data": B64.encode(b"short"), "iv": iv, "key": key32 }).to_string()
        )
        .is_err());
    }

    #[test]
    fn aes_gcm_random_iv_and_key_errors() {
        // 不给 iv：随机生成（12 字节），且碰巧与另一个随机 iv 相同的概率可忽略
        let key32 = "ReaderX-AES-key-0123456789abcdef";
        let first = encrypt(json!({ "data": SAMPLES, "key": key32 }));
        let second = encrypt(json!({ "data": SAMPLES, "key": key32 }));
        assert_eq!(B64.decode(first["iv"].as_str().unwrap()).unwrap().len(), AES_GCM_IV_LEN);
        assert_ne!(first["iv"], second["iv"]);
        // Random IV 也要能解回来
        assert_eq!(
            ok(aes_gcm_decrypt_json(
                &json!({ "data": first["base64"], "iv": first["iv"], "key": key32 })
                    .to_string()
            )),
            SAMPLES
        );

        // 长度不对一律拒绝（不做静默填充 / 截断）
        let short = err(aes_gcm_encrypt_json(
            &json!({ "data": SAMPLES, "key": "1234567890123456" }).to_string(),
        ));
        assert!(short.contains("AES-256 密钥长度不对"), "{short}");
        // 十六进制写法：64 字符 hex → 32 字节密钥、24 字符 hex → 12 字节 IV，可直接用
        let hex_key = encrypt(json!({
            "data": SAMPLES,
            "key": "0".repeat(64),
            "iv": "0".repeat(12),
        }));
        assert_eq!(hex_key["keyHex"].as_str().unwrap(), "0".repeat(64));
        // 24 字符 hex → 12 字节 IV，与 hexDecode 出的字节完全等价
        let hex_iv = encrypt(json!({
            "data": SAMPLES,
            "key": "ReaderX-AES-key-0123456789abcdef",
            "iv": "0".repeat(24),
        }));
        assert_eq!(hex_iv["ivHex"].as_str().unwrap(), "0".repeat(24));
        // 长度对不上（30 字符，base64 / hex / UTF-8 都不是 32 字节）走长度错误分支
        let bad_key = err(aes_gcm_encrypt_json(
            &json!({ "data": SAMPLES, "key": "00112233445566778899aabbccddee" }).to_string(),
        ));
        assert!(bad_key.contains("长度不对"), "{bad_key}");
        // base64 密钥（44 字符）与同内容的 UTF-8 字面量等价
        let key32 = "ReaderX-AES-key-0123456789abcdef"; // 32 字节 UTF-8，非 hex
        assert_eq!(key32.len(), AES_GCM_KEY_LEN);
        let as_b64 = encrypt(json!({
            "data": SAMPLES,
            "key": B64.encode(key32.as_bytes()),
            "iv": "0".repeat(12),
        }));
        let as_text = encrypt(json!({ "data": SAMPLES, "key": key32, "iv": "0".repeat(12) }));
        assert_eq!(as_b64["base64"], as_text["base64"]);
        assert_eq!(
            as_text["hex"].as_str().unwrap(),
            "9eb433b2fd772257d75fe1ceebf424ccda2006adbf1347de7749406b"
        );
        assert_eq!(
            ok(aes_gcm_decrypt_json(
                &json!({ "data": as_text["base64"], "iv": as_text["iv"], "key": key32 })
                    .to_string()
            )),
            SAMPLES
        );
        // IV 长度不对（3 字节既非 12 字节 base64 也非 12 字节文本）
        let iv_err = err(aes_gcm_encrypt_json(
            &json!({ "data": SAMPLES, "key": key32, "iv": "abc" }).to_string(),
        ));
        assert!(iv_err.contains("IV（12 字节）"), "{iv_err}");
        // 缺少必填项
        assert!(aes_gcm_encrypt_json(&json!({ "key": key32 }).to_string()).is_err());
        assert!(aes_gcm_decrypt_json(
            &json!({ "data": "AAAA", "key": key32 }).to_string()
        )
        .is_err());
    }

}

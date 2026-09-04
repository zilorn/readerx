//! 书源宿主服务层：为 Boa 引擎提供受控的爬虫工具。
//!
//! - 全部能力以 **JSON 字符串** 形式跨宿主边界传递（原生函数签名最简、可序列化）；
//! - 每个书源一个常驻 `reqwest::blocking::Client`（独立 cookie jar，会话内跨调用共享）；
//! - 单次请求默认超时、响应体/正文上限、字符集探测等都在这里统一处理；
//! - HTML 选择器基于 `scraper`，正文清洗是轻量标签扫描实现（文档中注明为近似结果）。

use crate::models::BookSource;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use md5::{Digest as _, Md5};
use scraper::{ElementRef, Html, Selector};
use serde_json::{json, Map, Value};
use sha1::Sha1;
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// 响应体读取上限（32 MiB），超限截断
pub const BODY_LIMIT: u64 = 32 * 1024 * 1024;
/// 单请求默认超时（毫秒）
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// 请求并发上限
pub const CONCURRENCY_CAP: usize = 8;
/// 每源最多保存的手动 Cookie 行数
const MAX_COOKIE_LINES: usize = 64;

static SOURCES: OnceLock<Mutex<HashMap<String, Arc<SourceState>>>> = OnceLock::new();

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

/// 统一错误 JSON（宿主边界内原生函数不抛 JS 异常，交由 JS 包装层 throw）
fn error_payload(message: String) -> String {
    serde_json::to_string(&json!({ "__rxError": message })).unwrap_or_else(|_| "{}".to_string())
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
    if let Some(pos) = content_type.to_lowercase().find("charset=") {
        let label = content_type[pos + 8..]
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
    // BOM / 合法 UTF-8 优先，替代符过多时退回 GB18030（中文站点常见）
    let utf8 = String::from_utf8_lossy(bytes);
    let replacement_ratio = utf8
        .chars()
        .filter(|c| *c == '\u{FFFD}')
        .count()
        .max(1) as f64
        / utf8.chars().count().max(1) as f64;
    if replacement_ratio < 0.003 {
        return utf8.into_owned();
    }
    let (gbk, _, _) = encoding_rs::GB18030.decode(bytes);
    gbk.into_owned()
}

/// 执行一次 HTTP 请求；始终返回 JSON 字符串（成功为响应对象，失败为 __rxError）
pub(crate) fn http_request(source_id: &str, method: &str, raw_url: &str, opts: &str) -> String {
    let do_request = || -> Result<Value, String> {
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
        let mut req = client.request(
            reqwest::Method::from_bytes(method.as_bytes())
                .map_err(|_| format!("不支持的请求方法: {method}"))?,
            url,
        );

        let mut header_lines: Vec<(String, String)> = state
            .default_headers
            .lock()
            .map_err(|_| "会话锁异常".to_string())?
            .clone();

        // 手动 Cookie 行（跨调用累积，CF cookie 等）
        let cookies = state
            .extra_cookies
            .lock()
            .map_err(|_| "会话锁异常".to_string())?
            .clone();
        if !cookies.is_empty() {
            header_lines.push(("cookie".to_string(), cookies.join("; ")));
        }
        let ua = state
            .user_agent
            .lock()
            .map_err(|_| "会话锁异常".to_string())?
            .clone();
        if !ua.is_empty() {
            header_lines.push(("user-agent".to_string(), ua));
        } else {
            header_lines.push((
                "user-agent".to_string(),
                "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36".to_string(),
            ));
        }

        // 单请求头覆盖
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
            req = client.request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), full);
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
        let status_text = status
            .canonical_reason()
            .unwrap_or("")
            .to_string();
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
    };

    match do_request() {
        Ok(value) => serde_json::to_string(&value).unwrap_or_else(|_| error_payload("序列化失败".into())),
        Err(message) => error_payload(message),
    }
}

/// http.setCookie：手动追加一行 Cookie 头内容（后续所有请求自动携带）
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
        lines.push(text);
        if lines.len() > MAX_COOKIE_LINES {
            let overflow = lines.len() - MAX_COOKIE_LINES / 2;
            lines.drain(0..overflow);
        }
    }
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

/// 把 HTML 片段清洗为纯文本（近似）：剔除 script/style/注释，块级与 <br> 换行，实体解码
pub(crate) fn html_to_text(html: &str, sep: &str) -> String {
    let mut out = String::new();
    let bytes = html.as_bytes();
    let mut i = 0;
    let len = bytes.len();
    while i < len {
        match bytes[i] {
            b'<' => {
                let close = html[i..].find('>').map(|p| i + p);
                let Some(gt) = close else {
                    break;
                };
                let tag = &html[i + 1..gt];
                let lower = tag.trim_start().to_ascii_lowercase();
                // 注释 / script / style 整体跳过
                if lower.starts_with("!--") {
                    let end = html[i..].find("-->").map(|p| i + p + 3);
                    match end {
                        Some(e) => i = e,
                        None => break,
                    }
                    continue;
                }
                if lower.starts_with("script") || lower.starts_with("style") {
                    let end = html[i..]
                        .find(&format!("</{}", lower.split_whitespace().next().unwrap_or("")))
                        .map(|p| i + p)
                        .unwrap_or(len);
                    i = end;
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
                let next = html[i..].find('<').map(|p| i + p).unwrap_or(len);
                out.push_str(&entity_decode(&html[i..next]));
                i = next;
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

pub(crate) fn base64_encode(text: &str) -> String {
    B64.encode(text.as_bytes())
}

pub(crate) fn base64_decode(text: &str) -> Result<String, String> {
    let bytes = B64
        .decode(text.trim().as_bytes())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

pub(crate) fn md5_hex(text: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(text.as_bytes());
    hex_digest(&hasher.finalize())
}

pub(crate) fn sha1_hex(text: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(text.as_bytes());
    hex_digest(&hasher.finalize())
}

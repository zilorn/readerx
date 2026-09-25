//! 书源 JS 引擎（Boa 0.22）。
//!
//! 设计要点：
//! - 每个书源调用在**独立线程**上运行一个 Boa `Context`（Context 非 Send，天然线程局域）；
//! - 宿主边界全部走 **JSON 字符串**（原生函数只收/返字符串，最大程度避开 boa 对象构造 API）；
//! - 支持 `async/await` 风格规则：入口调用包在 `async IIFE` 里，驱动循环反复 `run_jobs()`
//!   处理微任务直至 settle 或超时；宿主 `http` 为同步阻塞（在引擎线程内执行真实请求），
//!   因此规则里的 `await http.get(...)` 也能正常按序推进；
//! - 并发由「多个引擎线程各自串行执行」实现：拉正文时按配置并发起若干 worker，
//!   队列里的最小单位是**一章**（见 [`run_chapter_tasks`]），完成一章立刻交付。

use crate::host;
use crate::models::{
    BookItem, ChapterContentResult, ChapterItem, ChapterPromoteResult, ChapterRunSummary,
    ChapterTaskItem, ChapterTaskResult, SourceCallResult,
};
use crate::panic_guard;
use boa_engine::{Context, JsResult, JsString, JsValue, NativeFunction, Source};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 单次函数调用默认预算（毫秒）
pub const DEFAULT_CALL_BUDGET_MS: u64 = 45_000;
/// 单章正文默认预算（毫秒）
pub const DEFAULT_CHAPTER_BUDGET_MS: u64 = 30_000;
/// 单个函数帧允许的最大循环次数（死循环兜底）：
/// 书源 JS 里出现 `while (true) {}` 时 Boa 会一直跑，`context.eval` 永不返回——
/// 超时预算形同虚设、引擎线程被永久占住、界面一直转圈。设上限后 Boa 抛出
/// RuntimeLimitError，由 [`engine_error_message`] 转成用户可读的中文原因。
const JS_LOOP_ITERATION_LIMIT: u64 = 100_000_000;

/// JS 宿主能力可调用白名单（即书源入口函数集合）
pub const ENTRY_FUNCTIONS: &[&str] = &[
    "searchBook",
    "discoverBooks",
    "discoverCategories",
    "bookDetail",
    "bookToc",
    "bookContent",
];

// ---------------------------------------------------------------------------
// 线程局域调用上下文：native 函数通过它拿到 sourceId / 结果 / 日志
// ---------------------------------------------------------------------------

pub(crate) struct CallCtx {
    source_id: String,
    /// 单次调用结算结果：Ok(json 字符串) 或 Err(错误文本)
    settled: RefCell<Option<Result<String, String>>>,
    logs: RefCell<Vec<String>>,
}

impl CallCtx {
    fn new(source_id: String) -> Self {
        Self {
            source_id,
            settled: RefCell::new(None),
            logs: RefCell::new(Vec::new()),
        }
    }

    /// 结算一次调用。这些槽位由书源 JS 反复触发，全部走 `try_borrow_mut`：
    /// 极端重入下宁可丢弃一次写入，也不能因借用冲突 panic 打断整条调用链。
    fn settle(&self, result: Result<String, String>) {
        if let Ok(mut slot) = self.settled.try_borrow_mut() {
            *slot = Some(result);
        }
    }

    fn take_settled(&self) -> Option<Result<String, String>> {
        self.settled
            .try_borrow_mut()
            .ok()
            .and_then(|mut slot| slot.take())
    }

    fn push_log(&self, line: String) {
        if let Ok(mut logs) = self.logs.try_borrow_mut() {
            if logs.len() >= 200 {
                let remove = logs.len() - 180;
                logs.drain(0..remove);
            }
            logs.push(line);
        }
    }

    fn logs_snapshot(&self) -> Vec<String> {
        self.logs
            .try_borrow()
            .map(|logs| logs.clone())
            .unwrap_or_default()
    }

    fn reset(&self) {
        if let Ok(mut slot) = self.settled.try_borrow_mut() {
            *slot = None;
        }
        if let Ok(mut logs) = self.logs.try_borrow_mut() {
            logs.clear();
        }
    }
}

thread_local! {
    static CALL: RefCell<Option<Rc<CallCtx>>> = const { RefCell::new(None) };
}

/// 在当前线程安装调用上下文（引擎线程启动时调用一次）。
fn install_call_ctx(source_id: &str) {
    CALL.with(|cell| {
        if let Ok(mut slot) = cell.try_borrow_mut() {
            *slot = Some(Rc::new(CallCtx::new(source_id.to_string())));
        }
    });
}

fn with_call<F, T>(f: F) -> Option<T>
where
    F: FnOnce(&CallCtx) -> T,
{
    CALL.with(|cell| {
        // 先取出 Rc 再释放线程局域借用，f 内部再取上下文也不会冲突
        let guard = cell.try_borrow().ok()?;
        let ctx = guard.as_ref()?.clone();
        drop(guard);
        Some(f(&ctx))
    })
}

/// 原生函数通用参数转字符串。
///
/// 优先用 `to_std_string`（Latin-1 码元按原样映射成 U+0000–U+00FF），**不能**直接用
/// `to_std_string_lossy`：后者会把 U+0080–U+00FF 的码元显示成 U+FFFD，让
/// `base64.decode` / `hexDecode` 出来的字节串在桥接层就被改写。
/// 只有含孤立代理项的病态字符串才退回 lossy（JS 语义下本就无法表示）。
fn arg_string(arg: &JsValue, context: &mut Context) -> String {
    arg.to_string(context)
        .map(|s| s.to_std_string().unwrap_or_else(|_| s.to_std_string_lossy()))
        .unwrap_or_default()
}

/// 二进制安全版 [`arg_string`]：把 U+0000–U+00FF 的每个字符还原成一个字节
/// （host 侧 `base64_decode` / `hex_decode_to_string` / `aesGcmEncrypt().text` 的编码）。
/// 超出该范围的字符（真正的中文 / emoji 文本）按 UTF-8 取字节，保证普通字符串不受影响。
///
/// 只有 `__hexEncode` / `__hexDecode` / `__base64Encode` 需要在桥接层显式取字节；
/// 摘要 / HMAC / 加解密把字节保留字符串原样塞进 JSON，由 host 侧按同一约定还原
/// （见 `host::text_to_bytes`）。
fn arg_bytes(arg: &JsValue, context: &mut Context) -> Vec<u8> {
    let text = arg_string(arg, context);
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

fn ret_string(s: String) -> JsResult<JsValue> {
    Ok(JsValue::from(JsString::from(s)))
}

/// 失败结果包成 `{"__rxError":"…"}`，由 `__rxUnwrap` 还原成 JS 异常（与 `base64.decode` 同一约定）
fn ret_error(message: String) -> JsResult<JsValue> {
    ret_string(format!(
        "{{\"__rxError\":{}}}",
        serde_json::to_string(&message).unwrap_or_default()
    ))
}

// ---------------------------------------------------------------------------
// 原生函数（全部签名 fn(&JsValue, &[JsValue], &mut Context) -> JsResult<JsValue>）
// ---------------------------------------------------------------------------

fn nv_settle(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let text = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    with_call(|c| c.settle(Ok(text)));
    Ok(JsValue::undefined())
}

fn nv_settle_err(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let text = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    with_call(|c| c.settle(Err(text)));
    Ok(JsValue::undefined())
}

fn nv_log(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let mut parts: Vec<String> = Vec::new();
    for arg in args {
        parts.push(arg_string(arg, context));
    }
    let line = parts.join(" ");
    with_call(|c| {
        // 规则作者的 console.log 除了随调用结果返回（CLI / App 展示），也镜像一条到统一日志：
        // 排查线上问题时不用重跑书源，翻日志文件就能看到规则自己打的线索
        log::debug!("[书源 {}] {line}", c.source_id);
        c.push_log(line)
    });
    Ok(JsValue::undefined())
}

fn nv_http_request(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let method = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    let url = args.get(1).map(|a| arg_string(a, context)).unwrap_or_default();
    let opts = args.get(2).map(|a| arg_string(a, context)).unwrap_or_default();
    let out = with_call(|c| host::http_request(&c.source_id, &method, &url, &opts))
        .unwrap_or_else(|| "{\"__rxError\":\"缺少运行上下文\"}".to_string());
    ret_string(out)
}

fn nv_http_set_cookie(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let text = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    with_call(|c| host::http_set_cookie(&c.source_id, &text));
    Ok(JsValue::undefined())
}

fn nv_http_cookies(_: &JsValue, _args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let out = with_call(|c| host::http_cookies(&c.source_id))
        .unwrap_or_else(|| "[]".to_string());
    ret_string(out)
}

fn nv_http_clear_cookies(_: &JsValue, _args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    with_call(|c| host::http_clear_cookies(&c.source_id));
    Ok(JsValue::undefined())
}

fn nv_webview_login_supported(_: &JsValue, _args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let supported = host::webview_login_supported();
    ret_string(if supported { "1".to_string() } else { "0".to_string() })
}

fn nv_webview_login(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let url = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    let opts = args.get(1).map(|a| arg_string(a, context)).unwrap_or_default();
    let out = with_call(|c| host::webview_login(&c.source_id, &url, &opts))
        .unwrap_or_else(|| "{\"ok\":false,\"message\":\"缺少运行上下文\"}".to_string());
    ret_string(out)
}

/// 登录时采集到的存储快照（localStorage / sessionStorage / IndexedDB）。
/// 只读、不触发任何认证：没有快照时返回空视图，规则里不必判 null。
fn nv_webview_storage(_: &JsValue, _args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let out = with_call(|c| host::webview_storage(&c.source_id))
        .unwrap_or_else(|| "{}".to_string());
    ret_string(out)
}

fn nv_html_query_all(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let html = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    let sel = args.get(1).map(|a| arg_string(a, context)).unwrap_or_default();
    ret_string(host::html_query_all(&html, &sel))
}

fn nv_html_to_text(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let html = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    let sep = args.get(1).map(|a| arg_string(a, context)).unwrap_or_else(|| "\n".to_string());
    ret_string(host::html_to_text(&html, &sep))
}

fn nv_sleep(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let ms = args
        .first()
        .map(|a| arg_string(a, context).parse::<u64>().unwrap_or(0))
        .unwrap_or(0);
    host::sleep_ms(ms);
    Ok(JsValue::undefined())
}

fn nv_base64_encode(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    // 入参是字节保留字符串（base64.decode / hexDecode 的产物）或普通文本；
    // 先把每个字符还原成字节再编码，保证 base64.encode(base64.decode(x)) === x。
    let raw = args.first().map(|a| arg_bytes(a, context)).unwrap_or_default();
    ret_string(host::base64_encode(&host::bytes_to_js_string(&raw)))
}

fn nv_base64_decode(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let text = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    match host::base64_decode(&text) {
        Ok(decoded) => ret_string(decoded),
        Err(msg) => ret_string(format!("{{\"__rxError\":{}}}", serde_json::to_string(&msg).unwrap_or_default())),
    }
}

fn nv_md5(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let text = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    ret_string(host::md5_hex(&text))
}

fn nv_sha1(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let text = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    ret_string(host::sha1_hex(&text))
}

fn nv_sha256(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let text = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    ret_string(host::sha256_hex(&text))
}

/// 摘要：参数 JSON 里的 data 已是十六进制（见 PROLOGUE 的 `__digestArgs`），
/// 二进制字符串也能逐字节参与；`kind` 与注册名一一对应。
fn crypto_digest(
    args: &[JsValue],
    context: &mut Context,
    kind: &str,
) -> JsResult<JsValue> {
    let opts = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    match host::digest_json(&opts, kind) {
        Ok(out) => ret_string(out),
        Err(message) => ret_error(message),
    }
}

fn nv_crypto_md5(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    crypto_digest(args, context, "md5")
}

fn nv_crypto_sha1(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    crypto_digest(args, context, "sha1")
}

fn nv_crypto_sha256(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    crypto_digest(args, context, "sha256")
}

fn nv_crypto_hmac(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let opts = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    match host::hmac_json(&opts) {
        Ok(out) => ret_string(out),
        Err(message) => ret_error(message),
    }
}

fn nv_hex_encode(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    // 输入按「一个字符 = 一个字节」还原后**直接**编码成 hex。
    // 这里绝不能走 String::from_utf8_lossy：0x80–0xFF 的字节会被替换成 U+FFFD（efbfbd），
    // 32 字节密钥会被改写成 60 字节，摘要 / 签名随之全错。
    let raw = args.first().map(|a| arg_bytes(a, context)).unwrap_or_default();
    ret_string(host::hex_encode_text(&host::bytes_to_js_string(&raw)))
}

fn nv_hex_decode(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    // hex 文本本身必须是纯 ASCII；非 ASCII 字节在这里换成替换字符即可——
    // host::hex_decode 会因「含非 0-9a-f 字符」报错，用户看到的原因比编码错误更直白。
    let raw = args.first().map(|a| arg_bytes(a, context)).unwrap_or_default();
    let text = String::from_utf8_lossy(&raw).into_owned();
    match host::hex_decode_to_string(&text) {
        Ok(out) => ret_string(out),
        Err(message) => ret_error(message),
    }
}

fn nv_aes_gcm_encrypt(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let opts = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    match host::aes_gcm_encrypt_json(&opts) {
        Ok(out) => ret_string(out),
        Err(message) => ret_error(message),
    }
}

fn nv_aes_gcm_decrypt(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let opts = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    match host::aes_gcm_decrypt_json(&opts) {
        Ok(out) => ret_string(out),
        Err(message) => ret_error(message),
    }
}

fn nv_url_join(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let base = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    let rel = args.get(1).map(|a| arg_string(a, context)).unwrap_or_default();
    ret_string(host::url_join(&base, &rel))
}

fn nv_query_string(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let raw = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let obj = parsed.as_object().cloned().unwrap_or_default();
    ret_string(host::query_string(&obj))
}

fn nv_query_parse(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let input = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    ret_string(host::query_parse(&input))
}

fn native_registry() -> Vec<(&'static str, usize, NativeFunction)> {
    vec![
        ("__rxSettle", 1, NativeFunction::from_fn_ptr(nv_settle)),
        ("__rxSettleErr", 1, NativeFunction::from_fn_ptr(nv_settle_err)),
        ("__rxLog", 8, NativeFunction::from_fn_ptr(nv_log)),
        ("__httpRequest", 3, NativeFunction::from_fn_ptr(nv_http_request)),
        ("__httpSetCookie", 1, NativeFunction::from_fn_ptr(nv_http_set_cookie)),
        ("__httpCookies", 0, NativeFunction::from_fn_ptr(nv_http_cookies)),
        ("__httpClearCookies", 0, NativeFunction::from_fn_ptr(nv_http_clear_cookies)),
        ("__webviewLogin", 2, NativeFunction::from_fn_ptr(nv_webview_login)),
        ("__webviewLoginSupported", 0, NativeFunction::from_fn_ptr(nv_webview_login_supported)),
        ("__webviewStorage", 0, NativeFunction::from_fn_ptr(nv_webview_storage)),
        ("__htmlQueryAll", 2, NativeFunction::from_fn_ptr(nv_html_query_all)),
        ("__htmlToText", 2, NativeFunction::from_fn_ptr(nv_html_to_text)),
        ("__sleep", 1, NativeFunction::from_fn_ptr(nv_sleep)),
        ("__base64Encode", 1, NativeFunction::from_fn_ptr(nv_base64_encode)),
        ("__base64Decode", 1, NativeFunction::from_fn_ptr(nv_base64_decode)),
        ("__md5", 1, NativeFunction::from_fn_ptr(nv_md5)),
        ("__sha1", 1, NativeFunction::from_fn_ptr(nv_sha1)),
        ("__sha256", 1, NativeFunction::from_fn_ptr(nv_sha256)),
        ("__cryptoMd5", 1, NativeFunction::from_fn_ptr(nv_crypto_md5)),
        ("__cryptoSha1", 1, NativeFunction::from_fn_ptr(nv_crypto_sha1)),
        ("__cryptoSha256", 1, NativeFunction::from_fn_ptr(nv_crypto_sha256)),
        ("__cryptoHmac", 1, NativeFunction::from_fn_ptr(nv_crypto_hmac)),
        ("__hexEncode", 1, NativeFunction::from_fn_ptr(nv_hex_encode)),
        ("__hexDecode", 1, NativeFunction::from_fn_ptr(nv_hex_decode)),
        ("__aesGcmEncrypt", 1, NativeFunction::from_fn_ptr(nv_aes_gcm_encrypt)),
        ("__aesGcmDecrypt", 1, NativeFunction::from_fn_ptr(nv_aes_gcm_decrypt)),
        ("__urlJoin", 2, NativeFunction::from_fn_ptr(nv_url_join)),
        ("__queryString", 1, NativeFunction::from_fn_ptr(nv_query_string)),
        ("__queryParse", 1, NativeFunction::from_fn_ptr(nv_query_parse)),
    ]
}

/// JS 预置层：把宿主原生函数包装成语义化的命名空间对象，并注入 __rxUnwrap 错误抛出器
const PROLOGUE: &str = r#"
(function () {
  if (globalThis.__rxBooted) return;
  globalThis.__rxBooted = true;
  function __rxUnwrap(raw) {
    const o = JSON.parse(raw);
    if (o && typeof o === "object" && "__rxError" in o) throw new Error(o.__rxError);
    return o;
  }
  // 摘要 / HMAC 返回的是纯文本（hex / base64），只做错误检查、不 JSON.parse
  function __rxText(raw) {
    if (typeof raw === "string" && raw.lastIndexOf("{\"__rxError\"", 0) === 0) {
      throw new Error(JSON.parse(raw).__rxError);
    }
    return raw;
  }
  // 摘要 / HMAC 参数打包：data 一律转成十六进制再交给宿主，
  // 二进制字符串（base64.decode 的产物）也能逐字节参与；key 按文本参与 HMAC。
  function __digestArgs(data, encoding) {
    return JSON.stringify({
      data: __hexEncode(data == null ? "" : String(data)),
      dataEncoding: "hex",
      encoding: encoding == null ? "hex" : String(encoding)
    });
  }
  globalThis.http = {
    request(method, url, opts) {
      return __rxUnwrap(__httpRequest(String(method), String(url), JSON.stringify(opts || null)));
    },
    get(url, opts) { return this.request("GET", url, opts); },
    post(url, body, opts) {
      const o = Object.assign({}, opts || {});
      if (o.body === undefined && o.json === undefined && o.form === undefined) o.body = body;
      return this.request("POST", url, o);
    },
    setCookie(text) { __httpSetCookie(String(text)); },
    cookies() { return __rxUnwrap(__httpCookies()); },
    clearCookies() { __httpClearCookies(); }
  };
  globalThis.webview = {
    isSupported() { return __webviewLoginSupported() === "1"; },
    login(url, opts) {
      return __rxUnwrap(__webviewLogin(String(url), JSON.stringify(opts || null)));
    },
    // 登录时采集到的 localStorage / sessionStorage / IndexedDB 快照（只读）
    storage() { return __rxUnwrap(__webviewStorage()); }
  };
  globalThis.html = {
    queryAll(html, selector) { return __rxUnwrap(__htmlQueryAll(String(html), String(selector))); },
    query(html, selector) {
      const list = __rxUnwrap(__htmlQueryAll(String(html), String(selector)));
      return list && list.length ? list[0] : null;
    },
    text(html, sep) { return __htmlToText(String(html), sep === undefined ? "\n" : String(sep)); }
  };
  globalThis.util = {
    stripHtml(html) { return __htmlToText(String(html), "").trim(); },
    trim(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); },
    urlJoin(base, rel) { return __urlJoin(String(base), String(rel)); },
    queryString(obj) { return __queryString(JSON.stringify(obj || {})); },
    queryParse(url) { return __rxUnwrap(__queryParse(String(url))); },
    decodeEntities(s) { return __htmlToText(String(s), "").trim(); },
    sleep(ms) { __sleep(Number(ms) || 0); }
  };
  globalThis.base64 = {
    encode(s) { return __base64Encode(String(s)); },
    // 解码结果可能是任意二进制（1 字符 = 1 字节），不是 JSON，故用 __rxText 只查错误
    decode(s) { return __rxText(__base64Decode(String(s))); }
  };
  globalThis.cryptoUtil = {
    // 二进制安全的文本编码（1 字符 = 1 字节）：hash / hmac / 加解密都吃这种字符串
    toHex(s) { return __hexEncode(String(s)); },
    fromHex(s) { return __rxText(__hexDecode(String(s))); },
    hexEncode(s) { return __hexEncode(String(s)); },
    hexDecode(s) { return __rxText(__hexDecode(String(s))); },
    md5(s, encoding) { return __rxText(__cryptoMd5(__digestArgs(s, encoding))); },
    sha1(s, encoding) { return __rxText(__cryptoSha1(__digestArgs(s, encoding))); },
    sha256(s, encoding) { return __rxText(__cryptoSha256(__digestArgs(s, encoding))); },
    hmac(algorithm, key, data, encoding) {
      return __rxText(__cryptoHmac(JSON.stringify({
        algorithm: String(algorithm),
        key: key == null ? "" : String(key),
        data: __hexEncode(data == null ? "" : String(data)),
        dataEncoding: "hex",
        encoding: encoding == null ? "hex" : String(encoding)
      })));
    },
    aesGcmEncrypt(opts) {
      const o = opts || {};
      if (o.data == null) throw new Error("aesGcmEncrypt 需要 data（明文文本）");
      if (o.key == null) throw new Error("aesGcmEncrypt 需要 key（32 字节）");
      const args = {
        data: String(o.data),
        key: String(o.key),
        encoding: o.encoding == null ? "base64" : String(o.encoding)
      };
      if (o.iv != null) args.iv = String(o.iv);
      if (o.aad != null) args.aad = String(o.aad);
      return __rxUnwrap(__aesGcmEncrypt(JSON.stringify(args)));
    },
    aesGcmDecrypt(opts) {
      const o = opts || {};
      if (o.data == null || o.iv == null || o.key == null) {
        throw new Error("aesGcmDecrypt 需要 data / iv / key");
      }
      const args = { data: String(o.data), iv: String(o.iv), key: String(o.key) };
      if (o.aad != null) args.aad = String(o.aad);
      // 明文是二进制时传 encoding: "bytes"，返回字节保留字符串（1 字符 = 1 字节）
      if (o.encoding != null) args.encoding = String(o.encoding);
      return __rxText(__aesGcmDecrypt(JSON.stringify(args)));
    }
  };
  const __rxLogFn = function () {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) parts.push(typeof arguments[i] === "string" ? arguments[i] : JSON.stringify(arguments[i]));
    __rxLog(parts.join(" "));
  };
  globalThis.console = {
    log: __rxLogFn,
    info: __rxLogFn,
    warn: __rxLogFn,
    error: __rxLogFn
  };
})();
"#;

// ---------------------------------------------------------------------------
// Context 构建与单次函数调用驱动
// ---------------------------------------------------------------------------

fn build_context(js: &str) -> Result<Context, String> {
    let mut context = Context::default();
    // 死循环兜底（见 JS_LOOP_ITERATION_LIMIT 注释）
    context
        .runtime_limits_mut()
        .set_loop_iteration_limit(JS_LOOP_ITERATION_LIMIT);
    for (name, length, func) in native_registry() {
        context
            .register_global_builtin_callable(JsString::from(name), length, func)
            .map_err(|e| format!("注册宿主函数「{name}」失败: {e}"))?;
    }
    context
        .eval(Source::from_bytes(PROLOGUE.as_bytes()))
        .map_err(|e| format!("宿主初始化失败: {e}"))?;
    context
        .eval(Source::from_bytes(js.as_bytes()))
        .map_err(|e| engine_error_message("解析书源代码", &e))?;
    Ok(context)
}

fn valid_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// 识别 Boa 的「运行时限制」异常（死循环 / 无限递归 / 栈超限），换成用户看得懂的中文原因；
/// 其它引擎异常原样保留（含调用栈），便于书源作者排查。
fn engine_error_message(what: &str, error: &boa_engine::JsError) -> String {
    let text = error.to_string();
    if text.contains("RuntimeLimitError") {
        let reason = if text.contains("iteration loops") {
            "循环次数超出上限（书源代码可能存在死循环）"
        } else if text.contains("recursive calls") {
            "递归过深（书源代码可能存在无限递归）"
        } else {
            "执行栈超出上限"
        };
        let message = format!("{what}被中断：{reason}");
        log::error!("书源引擎异常：{}", host::redact_urls(&message));
        return message;
    }
    let message = format!("{what}时引擎异常: {text}");
    log::error!("书源引擎异常：{}", host::redact_urls(&message));
    message
}

/// 在同一 Context 中执行一次入口调用。
/// args_json 必须是一个 **数组 JSON**（展开为位置参数）。
/// 返回：Ok(结算的 JSON 文本) / Err(错误文本)。
fn try_call(
    context: &mut Context,
    fn_name: &str,
    args_json: &str,
    budget: Duration,
) -> Result<String, String> {
    if !valid_identifier(fn_name) {
        return Err(format!("非法的书源函数名: {fn_name}"));
    }
    // 清空上次状态（复用 Context 时）
    with_call(|c| c.reset());

    let args_literal = serde_json::to_string(args_json).map_err(|e| format!("参数编码失败: {e}"))?;
    let glue = format!(
        "(async()=>{{try{{const a=JSON.parse({al});const v=await {fn}(...a);let s=v===undefined?\"null\":JSON.stringify(v);__rxSettle(typeof s===\"string\"?s:\"null\");}}catch(e){{const m=(e&&typeof e.message===\"string\")?e.message:String(e);const st=(e&&typeof e.stack===\"string\")?String.fromCharCode(10)+e.stack:\"\";__rxSettleErr(m+st);}}}})();",
        al = args_literal,
        fn = fn_name
    );
    context
        .eval(Source::from_bytes(glue.as_bytes()))
        .map_err(|e| engine_error_message(&format!("调用「{fn_name}」"), &e))?;

    let deadline = Instant::now() + budget;
    loop {
        context
            .run_jobs()
            .map_err(|e| engine_error_message(&format!("执行「{fn_name}」"), &e))?;
        let taken = with_call(|c| c.take_settled()).flatten();
        if let Some(result) = taken {
            return result;
        }
        if Instant::now() >= deadline {
            return Err(format!("书源函数「{fn_name}」执行超时（{}ms）", budget.as_millis()));
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// 结算 JSON 文本 → serde Value；结算失败/超时时给出可读错误
fn settle_value(context: &mut Context, fn_name: &str, args: &Value, budget: Duration) -> Result<Value, String> {
    // 非数组参数按单参数展开，便于命令层直接传对象/字符串
    let call_args = if args.is_array() {
        args.clone()
    } else {
        json!([args])
    };
    let args_json = serde_json::to_string(&call_args).map_err(|e| format!("参数编码失败: {e}"))?;
    let settled = try_call(context, fn_name, &args_json, budget)?;
    // settled 已是 JSON 文本
    if settled.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&settled).map_err(|e| format!("「{fn_name}」返回不是合法 JSON: {e}"))
}

/// 把结算结果文本转成 SourceCallResult（附带日志）
fn to_call_result(
    logs: Vec<String>,
    elapsed: Duration,
    outcome: Result<Value, String>,
) -> SourceCallResult {
    match outcome {
        Ok(value) => SourceCallResult {
            ok: true,
            value: Some(value),
            error: None,
            logs,
            elapsed_ms: elapsed.as_millis() as u64,
        },
        Err(error) => SourceCallResult {
            ok: false,
            value: None,
            error: Some(error),
            logs,
            elapsed_ms: elapsed.as_millis() as u64,
        },
    }
}

// ---------------------------------------------------------------------------
// 对外入口一：单函数调用（搜索/详情/目录等）
// ---------------------------------------------------------------------------

pub fn call_source_function(
    source_id: &str,
    js: &str,
    fn_name: &str,
    args: &Value,
    budget_ms: u64,
) -> Result<SourceCallResult, String> {
    let started = Instant::now();
    let source_id = source_id.to_string();
    let js = js.to_string();
    let fn_tag = fn_name.to_string();
    let fn_in_thread = fn_name.to_string();
    let args_owned = args.clone();
    // 参数只记编码后的长度：里面可能是关键词 / 章节地址，也可能带登录信息
    let args_len = args.to_string().chars().count();
    log::debug!(
        "书源调用开始 source={source_id} fn={fn_name} args={args_len} 字符 budget={}ms",
        budget_ms.max(1_000)
    );
    // 线程名与失败日志都要用，clone 一份（source_id 随后被 move 进引擎线程）
    let source_tag = source_id.clone();

    let handle = std::thread::Builder::new()
        .name(format!("booksource-{fn_tag}"))
        .spawn(move || -> SourceCallResult {
            // 整段引擎执行（Boa + 书源 JS）都放在 panic 兜底里：任何意外的 panic
            // 都退化成本次调用失败 + 可读原因，而不是把应用直接带走。
            let run = panic_guard::catch("书源引擎", || -> SourceCallResult {
                install_call_ctx(&source_id);
                // 解析/初始化失败也作为“失败结果”返回，方便命令层展示可读错误
                let outcome = (|| -> Result<Value, String> {
                    let mut context = build_context(&js)?;
                    let budget = Duration::from_millis(budget_ms.max(1_000));
                    settle_value(&mut context, &fn_in_thread, &args_owned, budget)
                })();
                let logs = with_call(|c| c.logs_snapshot()).unwrap_or_default();
                to_call_result(logs, started.elapsed(), outcome)
            });
            run.unwrap_or_else(|error| SourceCallResult {
                ok: false,
                value: None,
                error: Some(error),
                logs: Vec::new(),
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        })
        .map_err(|e| {
            let message = format!("无法创建书源引擎线程: {e}");
            log::error!("书源调用无法开始 source={source_tag} fn={fn_tag} reason={message}");
            message
        })?;

    // 兜底：线程若在兜底之外异常结束，也返回结构化失败（不 panic、不丢错误原因）
    let result = handle.join().unwrap_or_else(|_| SourceCallResult {
        ok: false,
        value: None,
        error: Some(format!("书源函数「{fn_tag}」执行线程异常退出")),
        logs: Vec::new(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    });
    // 这里只写「谁、多久、为什么」：返回值与 logs 由调用方展示，不重复灌进日志
    match &result {
        SourceCallResult { ok: true, .. } => log::info!(
            "书源调用完成 source={source_tag} fn={fn_tag} ms={}",
            result.elapsed_ms
        ),
        call => {
            // 失败原因常把完整 URL（含 token）带进来：过一遍脱敏再写
            let reason = host::redact_urls(&call.error.clone().unwrap_or_default());
            log::error!(
                "书源调用失败 source={source_tag} fn={fn_tag} ms={} reason={reason}",
                result.elapsed_ms
            );
        }
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// 对外入口二：逐章拉取正文（每章一个任务，完成一章立刻交付）
//
// 队列里的最小单位是**一章**：不再按 20 章打包，也不用等一整批回来才交付 ——
// 慢章 / 失败章不会拖住同一批里的其它章节，前端可以逐章落盘、逐章推进度。
//   - 用户操作优先：`promote` 把「正在读的那一章」提到队首，`cancel` 立刻停止领取新章节；
//   - 并发由 concurrency 个 worker 线程提供（每个 worker 一份 Boa 上下文，串行取自己领到的章）。
// ---------------------------------------------------------------------------

/// 逐章取正文的一次运行：任务队列 + 取消标志。
///
/// 生命周期：由调用方（App 的命令层）按运行 id 登记，运行结束后注销；
/// worker 线程通过 `ChapterRun::take` 领取任务，因此队列是三者（领取 / 插队 / 停止）唯一的交汇点。
pub struct ChapterRun {
    cancel: AtomicBool,
    queue: Mutex<RunQueue>,
    total: usize,
}

struct RunQueue {
    /// 全部任务（按提交顺序；位置即任务序号，结果里回带 task.index）
    tasks: Vec<ChapterTaskItem>,
    /// 章节地址 → 任务序号（插队按地址定位；同一地址可能有多个任务）
    by_url: HashMap<String, Vec<usize>>,
    /// 待领取的任务序号（队首优先）
    pending: VecDeque<usize>,
    /// 已领取、正在取的任务序号（插队时据此回答「这一章是不是已经在取了」）
    running: HashSet<usize>,
}

impl ChapterRun {
    pub fn new(tasks: Vec<ChapterTaskItem>) -> Arc<Self> {
        let mut by_url: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, task) in tasks.iter().enumerate() {
            by_url
                .entry(task.chapter.chapter_url.clone())
                .or_default()
                .push(index);
        }
        let pending = (0..tasks.len()).collect();
        let total = tasks.len();
        Arc::new(Self {
            cancel: AtomicBool::new(false),
            queue: Mutex::new(RunQueue {
                tasks,
                by_url,
                pending,
                running: HashSet::new(),
            }),
            total,
        })
    }

    /// 本次运行的任务总数
    pub fn total(&self) -> usize {
        self.total
    }

    /// 用户停止：不再领取新任务（已取回的照常交付；在飞的那一章取完即止）
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Ok(mut queue) = self.queue.lock() {
            queue.pending.clear();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// 还没取回的任务数（待领取 + 在飞）
    pub fn remaining(&self) -> usize {
        self.queue
            .lock()
            .map(|queue| queue.pending.len() + queue.running.len())
            .unwrap_or(0)
    }

    /// 把给定章节地址的任务提到队首（读到哪一章就先取哪一章）。
    /// 返回「已插队 / 已在取」的数量：两者都为 0 说明这一章不在本次运行的队列里
    /// （调用方据此决定要不要为它单独发一次请求）。
    pub fn promote(&self, urls: &[String]) -> ChapterPromoteResult {
        let Ok(mut queue) = self.queue.lock() else {
            return ChapterPromoteResult::default();
        };
        let mut promoted: Vec<usize> = Vec::new();
        let mut running = 0usize;
        for url in urls {
            let Some(indexes) = queue.by_url.get(url) else {
                continue;
            };
            for &index in indexes {
                if queue.running.contains(&index) {
                    running += 1;
                    continue;
                }
                if queue.pending.contains(&index) && !promoted.contains(&index) {
                    promoted.push(index);
                }
            }
        }
        if !promoted.is_empty() {
            let moved: HashSet<usize> = promoted.iter().copied().collect();
            queue.pending.retain(|index| !moved.contains(index));
            // 保持调用方给的先后顺序（入参里靠前的章节更先取）
            for index in promoted.iter().rev() {
                queue.pending.push_front(*index);
            }
        }
        ChapterPromoteResult {
            promoted: promoted.len(),
            running,
        }
    }

    /// 领取下一个任务（已取消 / 已取空 → None），并标记为在飞
    fn take(&self) -> Option<ChapterTaskItem> {
        if self.is_cancelled() {
            return None;
        }
        let mut queue = self.queue.lock().ok()?;
        let index = queue.pending.pop_front()?;
        queue.running.insert(index);
        Some(queue.tasks[index].clone())
    }

    /// 被 worker 领取过的任务（按提交顺序）：收尾时给「领了却没交付」的章节兜底。
    /// 取消后没被领取的任务不在其中 —— 它们根本没试过，不该记成失败。
    fn claimed_tasks(&self) -> Vec<ChapterTaskItem> {
        let Ok(queue) = self.queue.lock() else {
            return Vec::new();
        };
        queue
            .tasks
            .iter()
            .enumerate()
            .filter(|(index, _)| queue.running.contains(index))
            .map(|(_, task)| task.clone())
            .collect()
    }
}

/// 一次运行的交付统计：结果计数 + 「哪些任务已经交付过」（收尾兜底时用）
#[derive(Default)]
struct RunDelivery {
    ok: AtomicUsize,
    failed: AtomicUsize,
    delivered: Mutex<HashSet<usize>>,
}

impl RunDelivery {
    /// 交付一条结果：每个任务只交付一次（重复交付直接丢弃）
    fn deliver<F>(&self, on_task: &F, result: ChapterTaskResult) -> bool
    where
        F: Fn(ChapterTaskResult),
    {
        let fresh = self
            .delivered
            .lock()
            .map(|mut set| set.insert(result.index))
            .unwrap_or(false);
        if !fresh {
            return false;
        }
        if result.ok {
            self.ok.fetch_add(1, Ordering::SeqCst);
        } else {
            self.failed.fetch_add(1, Ordering::SeqCst);
        }
        on_task(result);
        true
    }
}

/// 取一章正文（在给定上下文里调用 bookContent）。
/// 单章失败只反映在这一章上：同一 worker 的后续章节照常继续。
fn fetch_one_chapter(
    context: &mut Context,
    source_id: &str,
    book: &BookItem,
    chapter: &ChapterItem,
    budget: Duration,
) -> ChapterContentResult {
    // 用 to_value 而不是 json!：json! 对表达式内部会 unwrap，这里显式把编码失败变成该章的错误
    let args = match serde_json::to_value((chapter, book)) {
        Ok(value) => value,
        Err(error) => {
            let error = format!("参数编码失败: {error}");
            log::warn!(
                "章节正文拉取失败 source={source_id} chapter={} reason={error}",
                chapter.chapter_name
            );
            return ChapterContentResult {
                ok: false,
                chapter_name: chapter.chapter_name.clone(),
                text: String::new(),
                error,
            };
        }
    };
    let args_json = match serde_json::to_string(&args) {
        Ok(text) => text,
        Err(error) => {
            let error = format!("参数编码失败: {error}");
            log::warn!(
                "章节正文拉取失败 source={source_id} chapter={} reason={error}",
                chapter.chapter_name
            );
            return ChapterContentResult {
                ok: false,
                chapter_name: chapter.chapter_name.clone(),
                text: String::new(),
                error,
            };
        }
    };
    match try_call(context, "bookContent", &args_json, budget) {
        Ok(settled) => {
            // 期望返回纯文本字符串
            let value: Value = serde_json::from_str(&settled).unwrap_or(Value::String(settled));
            let text = match &value {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                _ => value.to_string(),
            };
            ChapterContentResult {
                ok: true,
                chapter_name: chapter.chapter_name.clone(),
                text,
                error: String::new(),
            }
        }
        Err(error) => {
            // 单章失败不拖垮整轮：记章节标题与原因（正文本身绝不进日志）
            log::warn!(
                "章节正文拉取失败 source={source_id} chapter={} reason={error}",
                chapter.chapter_name
            );
            ChapterContentResult {
                ok: false,
                chapter_name: chapter.chapter_name.clone(),
                text: String::new(),
                error,
            }
        }
    }
}

/// 逐章拉取正文：`concurrency` 个 worker 各自领取章节任务，**每完成一章立刻 `on_task` 交付一条结果**
/// （不打包、不等整批）。运行结束（或 `cancel` 之后队列清空）时返回汇总。
///
/// 交付保证：每个被领取的任务都会恰好交付一条结果 —— worker 因引擎异常退出时，
/// 收尾会给「领了却没交付」的章节补一条失败结果，调用方不会漏章、也不会永远等下去。
pub fn run_chapter_tasks<F>(
    source_id: &str,
    js: &str,
    book: &BookItem,
    run: Arc<ChapterRun>,
    concurrency: usize,
    budget_ms: u64,
    on_task: F,
) -> Result<ChapterRunSummary, String>
where
    F: Fn(ChapterTaskResult) + Send + Sync + 'static,
{
    let started = Instant::now();
    let requested = run.total();
    if requested == 0 {
        return Ok(ChapterRunSummary {
            requested: 0,
            ..ChapterRunSummary::default()
        });
    }
    let workers = concurrency.clamp(1, host::CONCURRENCY_CAP).min(requested);
    let source_id = source_id.to_string();
    let js = js.to_string();
    let book = book.clone();
    let on_task = Arc::new(on_task);
    let delivery = Arc::new(RunDelivery::default());
    // worker 异常退出时记录原因：收尾给「没交付」的章节一个可读解释
    let panic_note: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let mut handles = Vec::new();
    for _ in 0..workers {
        let source_id = source_id.clone();
        let js = js.clone();
        let book = book.clone();
        let run = run.clone();
        let on_task = on_task.clone();
        let delivery = delivery.clone();
        let panic_note = panic_note.clone();
        handles.push(
            std::thread::Builder::new()
                .name("booksource-chapter".to_string())
                .spawn(move || {
                    // 每个 worker 的整段执行都做 panic 兜底：单个 worker 因意外异常退出时，
                    // 它没领到的章节仍会被其它 worker 处理，已取回的结果也不会丢。
                    let outcome = panic_guard::catch_result("书源正文引擎", || -> Result<(), String> {
                        install_call_ctx(&source_id);
                        let mut context = match build_context(&js) {
                            Ok(context) => context,
                            Err(build_error) => {
                                // 引擎起不来：把还能领到的任务逐个标失败（每个任务都要有一条结果）
                                log::warn!(
                                    "书源正文引擎初始化失败 source={source_id} reason={build_error}"
                                );
                                while let Some(task) = run.take() {
                                    delivery.deliver(
                                        &*on_task,
                                        ChapterTaskResult::failed(
                                            task.index,
                                            task.chapter.chapter_name,
                                            build_error.clone(),
                                        ),
                                    );
                                }
                                return Ok(());
                            }
                        };
                        let budget = Duration::from_millis(budget_ms.max(1_000));
                        while let Some(task) = run.take() {
                            let result =
                                fetch_one_chapter(&mut context, &source_id, &book, &task.chapter, budget);
                            delivery.deliver(&*on_task, result.into_task_result(task.index));
                        }
                        Ok(())
                    });
                    if let Err(message) = outcome {
                        if let Ok(mut note) = panic_note.lock() {
                            if note.is_none() {
                                *note = Some(message);
                            }
                        }
                    }
                })
                .map_err(|e| format!("无法创建书源 worker 线程: {e}"))?,
        );
    }

    for handle in handles {
        // worker 内部的异常已在各自入口收敛；这里 join 失败也不影响已取回的结果
        let _ = handle.join();
    }

    // 领了却没交付的章节（worker 异常）：补一条失败结果，保证一章不漏
    let fallback = panic_note
        .lock()
        .ok()
        .and_then(|note| note.clone())
        .unwrap_or_else(|| "该书源未返回本章内容".to_string());
    let mut missing = 0usize;
    for task in run.claimed_tasks() {
        if delivery.deliver(
            &*on_task,
            ChapterTaskResult::failed(task.index, task.chapter.chapter_name, fallback.clone()),
        ) {
            missing += 1;
        }
    }
    if missing > 0 {
        log::warn!(
            "逐章正文拉取有章节未交付 source={source_id} missing={missing} reason={fallback}"
        );
    }

    let summary = ChapterRunSummary {
        requested,
        ok: delivery.ok.load(Ordering::SeqCst),
        failed: delivery.failed.load(Ordering::SeqCst),
        cancelled: run.is_cancelled(),
        missing,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    // 一次运行一条 info：任务数与耗时是判断「站点变慢 / 规则失效」的第一手线索
    log::info!(
        "逐章正文拉取结束 source={source_id} requested={} ok={} failed={} workers={workers} cancelled={} ms={}",
        summary.requested,
        summary.ok,
        summary.failed,
        summary.cancelled,
        summary.elapsed_ms
    );
    Ok(summary)
}

/// 批量拉取正文（CLI / 少量章节用）：内部就是「逐章任务 + 收集结果」，
/// 与 App 的逐章流式入口共用同一条流水线，只是把结果按章节序号收集起来一次返回。
pub fn fetch_chapter_contents(
    source_id: &str,
    js: &str,
    book: &BookItem,
    chapters: &[ChapterItem],
    concurrency: usize,
    budget_ms: u64,
) -> Result<Vec<ChapterContentResult>, String> {
    if chapters.is_empty() {
        return Ok(Vec::new());
    }
    let tasks: Vec<ChapterTaskItem> = chapters
        .iter()
        .enumerate()
        .map(|(index, chapter)| ChapterTaskItem {
            index,
            chapter: chapter.clone(),
        })
        .collect();
    let slots: Arc<Vec<Mutex<Option<ChapterTaskResult>>>> =
        Arc::new((0..chapters.len()).map(|_| Mutex::new(None)).collect());
    let write_slots = slots.clone();
    run_chapter_tasks(
        source_id,
        js,
        book,
        ChapterRun::new(tasks),
        concurrency,
        budget_ms,
        move |result| {
            if let Some(slot) = write_slots.get(result.index) {
                if let Ok(mut guard) = slot.lock() {
                    *guard = Some(result);
                }
            }
        },
    )?;
    let mut results = Vec::with_capacity(chapters.len());
    for slot in slots.iter() {
        let guard = slot.lock().map_err(|_| "结果锁异常".to_string())?;
        results.push(
            guard
                .clone()
                .unwrap_or_else(|| {
                    ChapterTaskResult::failed(0, "", "该书源未返回本章内容")
                })
                .into_content_result(),
        );
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 死循环兜底：Boa 的循环上限必须能把 `while (true) {}` 变成可捕获的错误，
    /// 否则 `context.eval` 永不返回、引擎线程被永久占住（界面一直转圈）。
    #[test]
    fn loop_limit_stops_dead_loop() {
        let mut context = Context::default();
        context.runtime_limits_mut().set_loop_iteration_limit(10_000);
        let result = context.eval(Source::from_bytes(b"while (true) {}"));
        assert!(result.is_err(), "死循环必须被循环上限中断");
    }

    /// 无限递归兜底：Boa 默认递归上限把它变成错误（而非原生栈溢出）。
    #[test]
    fn recursion_limit_stops_runaway_recursion() {
        let mut context = Context::default();
        let result = context.eval(Source::from_bytes(b"function f() { return f(); } f();"));
        assert!(result.is_err(), "无限递归必须被递归上限中断");
    }

    /// 书源 JS 抛出的异常要变成「本次调用失败 + 可读原因」，而不是进程级错误。
    #[test]
    fn source_exception_returns_failure_result() {
        let js = "function searchBook() { throw new Error('站点改版了'); }";
        let result = call_source_function("test-source", js, "searchBook", &json!([]), 5_000)
            .expect("命令层不应返回 Err");
        assert!(!result.ok);
        assert!(result.error.unwrap_or_default().contains("站点改版了"));
    }

    /// `cryptoUtil` 端到端：摘要 / HMAC / hex 编解码 / AES-256-GCM 在**真实 JS 调用链**上可用。
    /// 期望值见 host::tests（Python cryptography 独立算出），这里验证的是宿主桥接与编码契约。
    #[test]
    fn crypto_util_round_trips_through_js() {
        let js = r#"
        function searchBook() {
          const text = "hello 书源";
          // 摘要：中文按 UTF-8 参与，MD5/SHA1 与历史写法一致
          const md5 = cryptoUtil.md5(text);
          if (md5 !== "44a24962f6b0e616c0ed0fdf91b943cd") throw new Error("md5=" + md5);
          const sha1 = cryptoUtil.sha1(text);
          if (sha1 !== "3662e0b52fc079e6cd8854ad86d8c5997826be62") throw new Error("sha1=" + sha1);
          // SHA-256：hex 默认 / base64 可选
          const sha256 = cryptoUtil.sha256(text);
          if (sha256 !== "9744786d75102275f714407c6edee01b65716eb3cfc7d56ea1e940897236dfb3") {
            throw new Error("sha256=" + sha256);
          }
          const sha256b64 = cryptoUtil.sha256(text, "base64");
          if (sha256b64 !== "l0R4bXUQInX3FEB8bt7gG2VxbrPPx9VuoelAiXI237M=") {
            throw new Error("sha256 b64=" + sha256b64);
          }
          // HMAC（算法名容忍 HMAC-SHA256 写法）
          const hmac = cryptoUtil.hmac("sha256", "0123456789ab", text);
          if (hmac !== "d052845a12f557e4efeed421fad7149e3e7495beab35f7bef8adb0c115e8a2f3") {
            throw new Error("hmac=" + hmac);
          }
          if (cryptoUtil.hmac("HMAC-SHA1", "0123456789ab", text)
              !== "425f5aab0ef2c4f036c633e7a6bc3d529f0338de") throw new Error("hmac sha1");
          // hex 编解码是二进制安全的：base64.decode 出来的字节经 hexEncode → hexDecode 不变
          const raw = base64.decode("aGVsbG8g5Lmm5rqQ");
          if (cryptoUtil.hexEncode(raw) !== "68656c6c6f20e4b9a6e6ba90") {
            throw new Error("hexEncode=" + cryptoUtil.hexEncode(raw));
          }
          if (cryptoUtil.hexDecode("68656c6c6f") !== "hello") throw new Error("hexDecode");
          // 二进制字节串（含 >0x7f 的字节）喂给摘要，结果与直接传文本一致
          if (cryptoUtil.md5(raw) !== md5) throw new Error("md5(binary)=" + cryptoUtil.md5(raw));
          // AES-256-GCM：32 字节密钥 + 随机 IV，密文可原样解回
          const key = "0123456789abcdef0123456789abcdef";
          const cipher = cryptoUtil.aesGcmEncrypt({ data: text, key: key, aad: "aad" });
          if (cipher.encoding !== "base64" || !cipher.iv || !cipher.base64) throw new Error("cipher 字段缺失");
          const back = cryptoUtil.aesGcmDecrypt({
            data: cipher.base64, iv: cipher.iv, key: key, aad: "aad"
          });
          if (back !== text) throw new Error("解密结果不对: " + back);
          // hex 形式的密文 / iv / 密钥同样可解（cipher.hex / ivHex / keyHex 可直接回传）
          const back2 = cryptoUtil.aesGcmDecrypt({
            data: cipher.hex, iv: cipher.ivHex, key: cipher.keyHex, aad: "aad"
          });
          if (back2 !== text) throw new Error("hex 回传解密失败: " + back2);
          // AAD 不一致必须失败（抛错而不是返回半截明文）
          let failed = false;
          try {
            cryptoUtil.aesGcmDecrypt({ data: cipher.base64, iv: cipher.iv, key: key });
          } catch (e) {
            failed = true;
          }
          if (!failed) throw new Error("AAD 不一致时必须报错");
          return { md5: md5, sha256: sha256, cipher: cipher.base64 };
        }
        "#;
        let result = call_source_function("test-source", js, "searchBook", &json!([]), 5_000)
            .expect("命令层不应返回 Err");
        assert!(result.ok, "{:?}", result.error);
        let value = result.value.unwrap_or(Value::Null);
        assert_eq!(value["md5"], json!("44a24962f6b0e616c0ed0fdf91b943cd"));
    }

    /// `webview.storage()`：登录时采集的 localStorage / sessionStorage / IndexedDB 快照
    /// 必须在书源沙箱里读得到（不用 Cookie 记登录信息的站点全靠它），且没有快照时给空视图。
    #[test]
    fn webview_storage_exposes_login_snapshot() {
        use crate::storage::{StorageDatabase, StorageEntry, StorageOrigin, StorageSnapshot};
        let source = crate::models::BookSource {
            schema_version: 1,
            id: "storage-source".to_string(),
            name: "存储快照".to_string(),
            book_source_url: "https://example.com".to_string(),
            author: String::new(),
            version: String::new(),
            comment: String::new(),
            enabled: true,
            capabilities: Default::default(),
            auto_auth: true,
            group_id: None,
            user_agent: String::new(),
            headers: Default::default(),
            update_time: 0,
            js: String::new(),
        };
        crate::host::prepare_source(&source).unwrap();
        crate::host::set_storage_snapshot(
            "storage-source",
            StorageSnapshot {
                version: 1,
                updated_at: 42,
                origins: vec![StorageOrigin {
                    origin: "https://example.com".to_string(),
                    url: "https://example.com/home".to_string(),
                    local_storage: vec![StorageEntry {
                        key: "token".to_string(),
                        value: "jwt-1".to_string(),
                        truncated: false,
                    }],
                    session_storage: vec![StorageEntry {
                        key: "sid".to_string(),
                        value: "s-1".to_string(),
                        truncated: false,
                    }],
                    indexed_db: vec![StorageDatabase {
                        name: "app".to_string(),
                        version: 2,
                        stores: vec!["kv".to_string()],
                    }],
                }],
            },
            "https://example.com/login",
        );

        let js = r#"
        function searchBook() {
          const s = webview.storage();
          if (!s.ok) throw new Error("storage.ok 应为 true");
          if (s.localStorage.token !== "jwt-1") throw new Error("localStorage.token=" + s.localStorage.token);
          if (s.sessionStorage.sid !== "s-1") throw new Error("sessionStorage.sid=" + s.sessionStorage.sid);
          if (s.origin !== "https://example.com") throw new Error("origin=" + s.origin);
          if (!s.indexedDb.length || s.indexedDb[0].name !== "app") throw new Error("indexedDb 缺失");
          return { token: s.localStorage.token, updatedAt: s.updatedAt, db: s.indexedDb[0].stores.length };
        }
        "#;
        let result = call_source_function("storage-source", js, "searchBook", &json!([]), 5_000)
            .expect("命令层不应返回 Err");
        assert!(result.ok, "{:?}", result.error);
        let value = result.value.unwrap_or(Value::Null);
        assert_eq!(value["token"], json!("jwt-1"));
        assert_eq!(value["updatedAt"], json!(42));
        assert_eq!(value["db"], json!(1));

        // 没有任何快照的书源：返回空视图而不是抛错（规则里不必判 null）
        let empty = r#"
        function searchBook() {
          const s = webview.storage();
          return { ok: s.ok, keys: Object.keys(s.localStorage).length, dbs: s.indexedDb.length };
        }
        "#;
        let result = call_source_function("no-storage-source", empty, "searchBook", &json!([]), 5_000)
            .expect("命令层不应返回 Err");
        assert!(result.ok, "{:?}", result.error);
        let value = result.value.unwrap_or(Value::Null);
        assert_eq!(value["ok"], json!(true));
        assert_eq!(value["keys"], json!(0));
        assert_eq!(value["dbs"], json!(0));
    }

    /// 二进制字符串（1 字符 = 1 字节，含 0x80–0xff 与非法 UTF-8 序列）在**真实 JS 调用链**上
    /// 必须逐字节保真：hexEncode / base64.encode / 摘要 / HMAC / AES-GCM 都不能把它当文本再编码，
    /// 也不能替换成 U+FFFD。期望值由 Node crypto / Buffer 独立算出。
    #[test]
    fn crypto_util_keeps_binary_bytes_intact() {
        let js = r#"
        function searchBook() {
          const out = {};
          // 32 字节二进制密钥（base64.decode 的产物），0x00 / 0x7f / 0x80–0xff 都在里面
          const key = base64.decode("gf+IAI9/lsOdKKSrsrnAx87V3OPq8fj+Bg0UGyIpMDc=");
          out.keyLen = key.length;
          out.keyHex = cryptoUtil.hexEncode(key);
          // 32 字节密钥必须编出 64 个 hex 字符（曾因 from_utf8_lossy 变成 60/70 字符）
          out.keyHexLen = out.keyHex.length;
          out.keyB64 = base64.encode(key);
          // base64.encode(base64.decode(x)) 必须回到 x
          out.b64RoundTrip = base64.encode(base64.decode("gYiPkpSms7nAx87V3OPq8fj/Bg0UGyIpMDc+RUxTWg=="));
          // hexDecode → hexEncode 必须回到原 hex
          out.hexRoundTrip = cryptoUtil.hexEncode(cryptoUtil.hexDecode("80ff"));
          // 摘要：二进制字节串参与运算，不是文本
          out.sha256Key = cryptoUtil.sha256(key);
          out.md5Key = cryptoUtil.md5(key);
          out.sha256KeyB64 = cryptoUtil.sha256(key, "base64");
          // HMAC：二进制密钥
          out.hmac = cryptoUtil.hmac("sha256", key, "page=2");
          // AES-256-GCM：二进制密钥 + 二进制明文（含 0xc3 0x28 这种非法 UTF-8 对）
          const plain = String.fromCharCode(0x81, 0xc3, 0x28, 0x00, 0xff, 0x7f);
          const cipher = cryptoUtil.aesGcmEncrypt({ data: plain, key: key, iv: "0".repeat(12), encoding: "hex" });
          out.cipherHex = cipher.hex;
          out.cipherB64 = cipher.base64;
          out.cipherKeyHex = cipher.keyHex;
          out.cipherTextLen = cipher.text.length;
          // 明文是二进制：显式要求 bytes 形态才能逐字节还原
          out.backBytes = cryptoUtil.hexEncode(
            cryptoUtil.aesGcmDecrypt({ data: cipher.base64, iv: cipher.iv, key: key, encoding: "bytes" }));
          out.backHexKey = cryptoUtil.hexEncode(
            cryptoUtil.aesGcmDecrypt({ data: cipher.hex, iv: cipher.ivHex, key: cipher.keyHex, encoding: "bytes" }));
          // 文本明文不受影响：默认按文本返回可读字符串
          const tc = cryptoUtil.aesGcmEncrypt({ data: "hello 书源", key: key, iv: "0".repeat(12) });
          out.textBack = cryptoUtil.aesGcmDecrypt({ data: tc.base64, iv: tc.iv, key: key });
          return out;
        }
        "#;
        let result = call_source_function("test-source", js, "searchBook", &json!([]), 5_000)
            .expect("命令层不应返回 Err");
        assert!(result.ok, "{:?}", result.error);
        let value = result.value.unwrap_or(Value::Null);
        let text = |key: &str| value[key].as_str().unwrap_or_default().to_string();

        assert_eq!(value["keyLen"], json!(32));
        // 32 字节密钥 → 64 个 hex 字符（回归：曾被 from_utf8_lossy 改写）
        assert_eq!(value["keyHexLen"], json!(64));
        assert_eq!(
            text("keyHex"),
            "81ff88008f7f96c39d28a4abb2b9c0c7ced5dce3eaf1f8fe060d141b22293037"
        );
        assert_eq!(
            text("keyB64"),
            "gf+IAI9/lsOdKKSrsrnAx87V3OPq8fj+Bg0UGyIpMDc="
        );
        assert_eq!(
            text("b64RoundTrip"),
            "gYiPkpSms7nAx87V3OPq8fj/Bg0UGyIpMDc+RUxTWg=="
        );
        assert_eq!(text("hexRoundTrip"), "80ff");
        assert_eq!(
            text("sha256Key"),
            "5b363960de2f647c4c185ff95feb8a652e6e131ac2fbd5c9eda85859edd5d981"
        );
        assert_eq!(text("md5Key"), "9158d4811244cee87734527a861445c2");
        assert_eq!(
            text("sha256KeyB64"),
            "WzY5YN4vZHxMGF/5X+uKZS5uExrC+9XJ7ahYWe3V2YE="
        );
        assert_eq!(
            text("hmac"),
            "a0df0c346e1f198965036a5f1f9d2fc5d4feb58440bac080260b4764b8ac8c1b"
        );
        assert_eq!(
            text("cipherHex"),
            "2bb3c6b7e121f7145f508107e79d099ed4c3a17ad78e"
        );
        assert_eq!(text("cipherB64"), "K7PGt+Eh9xRfUIEH550JntTDoXrXjg==");
        assert_eq!(
            text("cipherKeyHex"),
            "81ff88008f7f96c39d28a4abb2b9c0c7ced5dce3eaf1f8fe060d141b22293037"
        );
        // 密文 6 字节 + 16 字节标签 = 22 字节
        assert_eq!(value["cipherTextLen"], json!(22));
        assert_eq!(text("backBytes"), "81c32800ff7f");
        assert_eq!(text("backHexKey"), "81c32800ff7f");
        assert_eq!(text("textBack"), "hello 书源");
    }

    /// 死循环在**完整调用链**（glue → eval → 结算）上必须变成一条中文可读错误，
    /// 而不是一直转圈或只剩一句英文引擎报错。
    #[test]
    fn dead_loop_becomes_readable_error() {
        let js = "function searchBook() { while (true) {} }";
        let mut context = build_context(js).unwrap();
        context.runtime_limits_mut().set_loop_iteration_limit(10_000);
        let error = try_call(&mut context, "searchBook", "[]", Duration::from_secs(5))
            .expect_err("死循环必须失败");
        assert!(error.contains("循环次数超出上限"), "{error}");
        assert!(error.contains("searchBook"), "{error}");
    }

    /// 无限递归同样要给中文原因（而不是英文 RuntimeLimitError 原文）。
    #[test]
    fn runaway_recursion_becomes_readable_error() {
        let js = "function searchBook() { return searchBook(); }";
        let error = call_source_function("test-source", js, "searchBook", &json!([]), 5_000)
            .expect("命令层不应返回 Err")
            .error
            .unwrap_or_default();
        assert!(error.contains("递归过深"), "{error}");
    }

    /// 批量拉正文：单章失败不拖垮整批，结果仍按章节下标一一对应。
    #[test]
    fn fetch_contents_keeps_per_chapter_results() {
        let js = r#"
        function bookContent(chapter, book) {
          if (chapter.chapterName === "坏章") throw new Error("该章解析失败");
          return "正文：" + chapter.chapterName + "@" + book.bookName;
        }
        "#;
        let book: BookItem = serde_json::from_value(json!({
            "bookName": "测试书",
            "bookUrl": "https://example.com/book/1",
        }))
        .unwrap();
        let chapters = vec![
            ChapterItem {
                chapter_name: "好章".to_string(),
                chapter_url: "https://example.com/1".to_string(),
            },
            ChapterItem {
                chapter_name: "坏章".to_string(),
                chapter_url: "https://example.com/2".to_string(),
            },
            ChapterItem {
                chapter_name: "好章2".to_string(),
                chapter_url: "https://example.com/3".to_string(),
            },
        ];
        let results = fetch_chapter_contents("test-source", js, &book, &chapters, 2, 5_000)
            .expect("批量拉取本身不应返回 Err");
        assert_eq!(results.len(), 3);
        assert!(results[0].ok, "{:?}", results[0]);
        assert_eq!(results[0].text, "正文：好章@测试书");
        assert!(!results[1].ok);
        assert!(results[1].error.contains("该章解析失败"));
        assert!(results[2].ok);
        assert_eq!(results[2].chapter_name, "好章2");
    }

    /// 逐章任务：每个任务恰好交付一条结果（按提交时给的章节序号回带），
    /// 且**完成一章就交付一章** —— 慢章不挡快章，取回顺序不必等于提交顺序。
    #[test]
    fn chapter_tasks_deliver_each_chapter_as_soon_as_it_is_ready() {
        let js = r#"
        function bookContent(chapter, book) {
          // 第一章故意慢：它必须最后才交付，不能拖住后面的章节
          if (chapter.chapterName === "慢章") {
            let spin = 0;
            for (let i = 0; i < 5000000; i++) { spin += i; }
            if (spin < 0) throw new Error("unreachable");
          }
          return "正文：" + chapter.chapterName;
        }
        "#;
        let book: BookItem =
            serde_json::from_value(json!({ "bookName": "测试书", "bookUrl": "https://example.com/b" }))
                .unwrap();
        let tasks: Vec<ChapterTaskItem> = ["慢章", "快章1", "快章2"]
            .iter()
            .enumerate()
            .map(|(index, name)| ChapterTaskItem {
                index: index * 10,
                chapter: ChapterItem {
                    chapter_name: (*name).to_string(),
                    chapter_url: format!("https://example.com/{index}"),
                },
            })
            .collect();
        let delivered: Arc<Mutex<Vec<ChapterTaskResult>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = delivered.clone();
        let summary = run_chapter_tasks(
            "test-source",
            js,
            &book,
            ChapterRun::new(tasks),
            2,
            5_000,
            move |result| sink.lock().unwrap().push(result),
        )
        .expect("逐章拉取本身不应返回 Err");
        let results = delivered.lock().unwrap().clone();
        assert_eq!(results.len(), 3, "每个任务都要有一条结果");
        assert_eq!(summary.ok, 3);
        assert_eq!(summary.failed, 0);
        assert_eq!(summary.missing, 0);
        // 序号按提交时的 index 回带（不是队列位置）
        let mut indexes: Vec<usize> = results.iter().map(|item| item.index).collect();
        indexes.sort_unstable();
        assert_eq!(indexes, vec![0, 10, 20]);
        // 快章先交付：慢章排在最后
        assert_eq!(results[2].chapter_name, "慢章");
    }

    /// 插队：`promote` 把指定章节地址的任务提到队首（用户读到哪一章就先取哪一章），
    /// 已在取的任务不重复插队（调用方据此不再另发请求）。
    #[test]
    fn chapter_run_promote_moves_task_to_front() {
        let tasks: Vec<ChapterTaskItem> = (0..4)
            .map(|index| ChapterTaskItem {
                index,
                chapter: ChapterItem {
                    chapter_name: format!("第{index}章"),
                    chapter_url: format!("https://example.com/{index}"),
                },
            })
            .collect();
        let run = ChapterRun::new(tasks);
        assert_eq!(run.total(), 4);

        let promoted = run.promote(&["https://example.com/3".to_string()]);
        assert_eq!(promoted.promoted, 1);
        assert_eq!(promoted.running, 0);
        assert_eq!(run.take().map(|task| task.index), Some(3), "插队的章节必须最先领取");
        // 已领取（在飞）的任务：只回答「正在取」，不再插队
        let running = run.promote(&["https://example.com/3".to_string()]);
        assert_eq!(running.promoted, 0);
        assert_eq!(running.running, 1);
        // 不在队列里的地址：两者都是 0
        let absent = run.promote(&["https://example.com/404".to_string()]);
        assert_eq!((absent.promoted, absent.running), (0, 0));
        // 其余任务按提交顺序领取
        let mut rest: Vec<usize> = Vec::new();
        while let Some(task) = run.take() {
            rest.push(task.index);
        }
        assert_eq!(rest, vec![0, 1, 2]);
    }

    /// 并发：concurrency 个 worker 同时领取各自的任务（每章都在 JS 里空转一会儿）。
    /// 同一批章节在并发 4 下必须明显快过串行 —— 否则「多线程并发」就名存实亡。
    #[test]
    fn chapter_tasks_run_with_configured_concurrency() {
        let js = r#"
        function bookContent(chapter, book) {
          let spin = 0;
          for (let i = 0; i < 1000000; i++) { spin += i; }
          return "正文：" + chapter.chapterName + spin;
        }
        "#;
        let book: BookItem =
            serde_json::from_value(json!({ "bookName": "测试书", "bookUrl": "https://example.com/b" }))
                .unwrap();
        let tasks = || -> Vec<ChapterTaskItem> {
            (0..4)
                .map(|index| ChapterTaskItem {
                    index,
                    chapter: ChapterItem {
                        chapter_name: format!("第{index}章"),
                        chapter_url: format!("https://example.com/{index}"),
                    },
                })
                .collect()
        };
        let delivered: Arc<Mutex<usize>> = Arc::new(Mutex::new(0));
        let elapsed = |concurrency: usize| -> f64 {
            let sink = delivered.clone();
            let started = Instant::now();
            let summary = run_chapter_tasks(
                "test-source",
                js,
                &book,
                ChapterRun::new(tasks()),
                concurrency,
                30_000,
                move |result| {
                    assert!(result.ok, "{:?}", result);
                    *sink.lock().unwrap() += 1;
                },
            )
            .unwrap();
            assert_eq!(summary.ok, 4);
            started.elapsed().as_secs_f64()
        };
        let serial = elapsed(1);
        let parallel = elapsed(4);
        assert_eq!(*delivered.lock().unwrap(), 8);
        assert!(
            parallel * 2.0 < serial,
            "并发 4（{parallel:.2}s）应明显快过串行（{serial:.2}s）"
        );
    }

    /// 停止：`cancel` 之后不再领取新任务（已取回的照常交付，未领取的不算失败）。
    #[test]
    fn chapter_run_cancel_stops_taking_new_tasks() {
        let tasks: Vec<ChapterTaskItem> = (0..3)
            .map(|index| ChapterTaskItem {
                index,
                chapter: ChapterItem {
                    chapter_name: format!("第{index}章"),
                    chapter_url: format!("https://example.com/{index}"),
                },
            })
            .collect();
        let run = ChapterRun::new(tasks);
        run.cancel();
        assert!(run.is_cancelled());
        assert!(run.take().is_none());
        assert_eq!(run.remaining(), 0);

        // 取消后跑一轮：一条结果都不该交付（没试过的章节不能记成失败）
        let js = "function bookContent(chapter) { return chapter.chapterName; }";
        let book: BookItem =
            serde_json::from_value(json!({ "bookName": "测试书", "bookUrl": "https://example.com/b" }))
                .unwrap();
        let tasks: Vec<ChapterTaskItem> = (0..2)
            .map(|index| ChapterTaskItem {
                index,
                chapter: ChapterItem {
                    chapter_name: format!("第{index}章"),
                    chapter_url: format!("https://example.com/{index}"),
                },
            })
            .collect();
        let delivered: Arc<Mutex<Vec<ChapterTaskResult>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = delivered.clone();
        let summary = run_chapter_tasks(
            "test-source",
            js,
            &book,
            {
                let run = ChapterRun::new(tasks);
                run.cancel();
                run
            },
            2,
            5_000,
            move |result| sink.lock().unwrap().push(result),
        )
        .unwrap();
        assert_eq!(summary.requested, 2);
        assert_eq!(summary.ok, 0);
        assert_eq!(summary.failed, 0);
        assert!(summary.cancelled);
        assert!(delivered.lock().unwrap().is_empty());
    }
}

// ---------------------------------------------------------------------------
// 离线检查（CLI `test` 命令 / App 保存前校验）
// ---------------------------------------------------------------------------

/// 书源代码的离线检查结果
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInspection {
    /// 是否编译通过
    pub ok: bool,
    /// 编译失败原因（ok=true 时为 None）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 代码里出现的入口函数名（按 ENTRY_FUNCTIONS 顺序）
    pub defined: Vec<String>,
}

/// 编译一次书源代码并列出已定义的入口函数——**不发起任何网络请求**。
///
/// 用途：CLI `test` 与编辑页保存前的快速检查（语法错误、忘了定义入口函数）。
/// 注意：与真实调用一样会执行顶层语句（书源代码通常只有函数声明），
/// 因此这里同样走 panic 兜底，避免坏代码把进程带走。
pub fn inspect(js: &str) -> SourceInspection {
    let js = js.to_string();
    panic_guard::catch("书源检查", move || match build_context(&js) {
        Ok(_) => SourceInspection {
            ok: true,
            error: None,
            defined: detect_entry_functions(&js),
        },
        Err(error) => SourceInspection {
            ok: false,
            error: Some(error),
            defined: detect_entry_functions(&js),
        },
    })
    .unwrap_or_else(|error| SourceInspection {
        ok: false,
        error: Some(error),
        defined: Vec::new(),
    })
}

/// 从书源代码里挑出入口函数名（文本匹配即可：Boa 侧不暴露全局函数表遍历，
/// 而这里只用于「有没有定义」的提示，命名冲突等由真实调用暴露）
fn detect_entry_functions(js: &str) -> Vec<String> {
    ENTRY_FUNCTIONS
        .iter()
        .filter(|name| {
            [
                format!("function {name}"),
                format!("{name} ="),
                format!("{name}="),
                format!("async function {name}"),
            ]
            .iter()
            .any(|pattern| js.contains(pattern.as_str()))
        })
        .map(|name| name.to_string())
        .collect()
}

#[cfg(test)]
mod inspect_tests {
    use super::*;

    #[test]
    fn detects_entry_functions_and_syntax_errors() {
        let good = "async function searchBook(k) { return []; }\nfunction bookToc(b) { return []; }";
        let result = inspect(good);
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(result.defined, vec!["searchBook", "bookToc"]);

        let bad = "function searchBook( { return []; }";
        let result = inspect(bad);
        assert!(!result.ok);
        assert!(result.error.is_some());
    }
}

//! 书源 JS 引擎（Boa 0.22）。
//!
//! 设计要点：
//! - 每个书源调用在**独立线程**上运行一个 Boa `Context`（Context 非 Send，天然线程局域）；
//! - 宿主边界全部走 **JSON 字符串**（原生函数只收/返字符串，最大程度避开 boa 对象构造 API）；
//! - 支持 `async/await` 风格规则：入口调用包在 `async IIFE` 里，驱动循环反复 `run_jobs()`
//!   处理微任务直至 settle 或超时；宿主 `http` 为同步阻塞（在引擎线程内执行真实请求），
//!   因此规则里的 `await http.get(...)` 也能正常按序推进；
//! - 并发由「多个引擎线程各自串行执行」实现：批量拉正文时按配置并发起若干 worker。

use crate::host;
use crate::models::{BookItem, ChapterContentResult, ChapterItem, SourceCallResult};
use boa_engine::{Context, JsResult, JsString, JsValue, NativeFunction, Source};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 单次函数调用默认预算（毫秒）
pub(crate) const DEFAULT_CALL_BUDGET_MS: u64 = 45_000;
/// 单章正文默认预算（毫秒）
pub(crate) const DEFAULT_CHAPTER_BUDGET_MS: u64 = 30_000;

/// JS 宿主能力可调用白名单（即书源入口函数集合）
pub(crate) const ENTRY_FUNCTIONS: &[&str] = &[
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
    fn reset(&self) {
        *self.settled.borrow_mut() = None;
        self.logs.borrow_mut().clear();
    }
}

thread_local! {
    static CALL: RefCell<Option<Rc<CallCtx>>> = const { RefCell::new(None) };
}

fn with_call<F, T>(f: F) -> Option<T>
where
    F: FnOnce(&CallCtx) -> T,
{
    CALL.with(|cell| cell.borrow().as_ref().map(|ctx| f(ctx)))
}

/// 原生函数通用参数转字符串
fn arg_string(arg: &JsValue, context: &mut Context) -> String {
    arg.to_string(context)
        .map(|s| s.to_std_string_lossy())
        .unwrap_or_default()
}

fn ret_string(s: String) -> JsResult<JsValue> {
    Ok(JsValue::from(JsString::from(s)))
}

// ---------------------------------------------------------------------------
// 原生函数（全部签名 fn(&JsValue, &[JsValue], &mut Context) -> JsResult<JsValue>）
// ---------------------------------------------------------------------------

fn nv_settle(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let text = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    with_call(|c| *c.settled.borrow_mut() = Some(Ok(text)));
    Ok(JsValue::undefined())
}

fn nv_settle_err(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let text = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    with_call(|c| *c.settled.borrow_mut() = Some(Err(text)));
    Ok(JsValue::undefined())
}

fn nv_log(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let mut parts: Vec<String> = Vec::new();
    for arg in args {
        parts.push(arg_string(arg, context));
    }
    let line = parts.join(" ");
    with_call(|c| {
        let mut logs = c.logs.borrow_mut();
        if logs.len() >= 200 {
            let remove = logs.len() - 180;
            logs.drain(0..remove);
        }
        logs.push(line);
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
    let text = args.first().map(|a| arg_string(a, context)).unwrap_or_default();
    ret_string(host::base64_encode(&text))
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
        ("__htmlQueryAll", 2, NativeFunction::from_fn_ptr(nv_html_query_all)),
        ("__htmlToText", 2, NativeFunction::from_fn_ptr(nv_html_to_text)),
        ("__sleep", 1, NativeFunction::from_fn_ptr(nv_sleep)),
        ("__base64Encode", 1, NativeFunction::from_fn_ptr(nv_base64_encode)),
        ("__base64Decode", 1, NativeFunction::from_fn_ptr(nv_base64_decode)),
        ("__md5", 1, NativeFunction::from_fn_ptr(nv_md5)),
        ("__sha1", 1, NativeFunction::from_fn_ptr(nv_sha1)),
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
    }
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
    decode(s) { return __rxUnwrap(__base64Decode(String(s))); }
  };
  globalThis.cryptoUtil = {
    md5(s) { return __md5(String(s)); },
    sha1(s) { return __sha1(String(s)); }
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
        .map_err(|e| format!("书源代码解析失败: {e}"))?;
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
        .map_err(|e| format!("调用「{fn_name}」失败: {e}"))?;

    let deadline = Instant::now() + budget;
    loop {
        context
            .run_jobs()
            .map_err(|e| format!("执行「{fn_name}」时引擎异常: {e}"))?;
        let taken = with_call(|c| c.settled.borrow_mut().take()).flatten();
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

pub(crate) fn call_source_function(
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

    let handle = std::thread::Builder::new()
        .name(format!("booksource-{fn_tag}"))
        .spawn(move || -> Result<SourceCallResult, String> {
            CALL.with(|cell| {
                *cell.borrow_mut() = Some(Rc::new(CallCtx::new(source_id.clone())));
            });
            // 解析/初始化失败也作为“失败结果”返回，方便命令层展示可读错误
            let outcome = (|| -> Result<Value, String> {
                let mut context = build_context(&js)?;
                let budget = Duration::from_millis(budget_ms.max(1_000));
                settle_value(&mut context, &fn_in_thread, &args_owned, budget)
            })();
            let logs = with_call(|c| c.logs.borrow().clone()).unwrap_or_default();
            Ok(to_call_result(logs, started.elapsed(), outcome))
        })
        .map_err(|e| format!("无法创建书源引擎线程: {e}"))?;

    handle
        .join()
        .map_err(|_| format!("书源函数「{fn_tag}」执行线程崩溃"))?
}

// ---------------------------------------------------------------------------
// 对外入口二：批量拉取正文（多 worker 线程，并发可配置）
// ---------------------------------------------------------------------------

pub(crate) fn fetch_chapter_contents(
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
    let workers = concurrency.clamp(1, host::CONCURRENCY_CAP).min(chapters.len());
    let source_id = source_id.to_string();
    let js = js.to_string();
    let book = book.clone();
    let next = Arc::new(AtomicUsize::new(0));
    let slots: Arc<Vec<Mutex<Option<ChapterContentResult>>>> =
        Arc::new((0..chapters.len()).map(|_| Mutex::new(None)).collect());

    let mut handles = Vec::new();
    for _ in 0..workers {
        let source_id = source_id.clone();
        let js = js.clone();
        let book = book.clone();
        let next = next.clone();
        let slots = slots.clone();
        let chapters = chapters.to_vec();
        handles.push(
            std::thread::Builder::new()
                .name("booksource-content".to_string())
                .spawn(move || -> Result<(), String> {
                    CALL.with(|cell| {
                        *cell.borrow_mut() = Some(Rc::new(CallCtx::new(source_id.clone())));
                    });
                    let build = build_context(&js);
                    if let Err(build_error) = build {
                        // 解析失败：把本 worker 尚未领取的章节全部标记错误，避免静默缺失
                        loop {
                            let idx = next.fetch_add(1, Ordering::SeqCst);
                            if idx >= chapters.len() {
                                break;
                            }
                            if let Some(slot) = slots.get(idx) {
                                if let Ok(mut guard) = slot.lock() {
                                    *guard = Some(ChapterContentResult {
                                        ok: false,
                                        chapter_name: chapters[idx].chapter_name.clone(),
                                        text: String::new(),
                                        error: build_error.clone(),
                                    });
                                }
                            }
                        }
                        return Ok(());
                    }
                    let mut context = build.unwrap();
                    let budget = Duration::from_millis(budget_ms.max(1_000));
                    loop {
                        let idx = next.fetch_add(1, Ordering::SeqCst);
                        if idx >= chapters.len() {
                            break;
                        }
                        let chapter = &chapters[idx];
                        let args = json!([chapter, book]);
                        let args_json = serde_json::to_string(&args).map_err(|e| format!("参数编码失败: {e}"))?;
                        let outcome = try_call(&mut context, "bookContent", &args_json, budget);
                        let result = match outcome {
                            Ok(settled) => {
                                // 期望返回纯文本字符串
                                let value: Value =
                                    serde_json::from_str(&settled).unwrap_or(Value::String(settled));
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
                            Err(error) => ChapterContentResult {
                                ok: false,
                                chapter_name: chapter.chapter_name.clone(),
                                text: String::new(),
                                error,
                            },
                        };
                        if let Some(slot) = slots.get(idx) {
                            if let Ok(mut guard) = slot.lock() {
                                *guard = Some(result);
                            }
                        }
                    }
                    Ok(())
                })
                .map_err(|e| format!("无法创建书源 worker 线程: {e}"))?,
        );
    }

    for handle in handles {
        handle
            .join()
            .map_err(|_| "书源正文 worker 线程崩溃".to_string())??;
    }

    let mut results = Vec::with_capacity(chapters.len());
    for slot in slots.iter() {
        let guard = slot.lock().map_err(|_| "结果锁异常".to_string())?;
        results.push(guard.clone().unwrap_or(ChapterContentResult {
            ok: false,
            chapter_name: String::new(),
            text: String::new(),
            error: "未知错误".to_string(),
        }));
    }
    Ok(results)
}

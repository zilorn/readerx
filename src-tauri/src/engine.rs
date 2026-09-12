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
use crate::panic_guard;
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
/// 单个函数帧允许的最大循环次数（死循环兜底）：
/// 书源 JS 里出现 `while (true) {}` 时 Boa 会一直跑，`context.eval` 永不返回——
/// 超时预算形同虚设、引擎线程被永久占住、界面一直转圈。设上限后 Boa 抛出
/// RuntimeLimitError，由 [`engine_error_message`] 转成用户可读的中文原因。
const JS_LOOP_ITERATION_LIMIT: u64 = 100_000_000;

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
    with_call(|c| c.push_log(line));
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
        return format!("{what}被中断：{reason}");
    }
    format!("{what}时引擎异常: {text}")
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
        .map_err(|e| format!("无法创建书源引擎线程: {e}"))?;

    // 兜底：线程若在兜底之外异常结束，也返回结构化失败（不 panic、不丢错误原因）
    Ok(handle.join().unwrap_or_else(|_| SourceCallResult {
        ok: false,
        value: None,
        error: Some(format!("书源函数「{fn_tag}」执行线程异常退出")),
        logs: Vec::new(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    }))
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
    // worker 异常退出时记录原因：末尾给「没人领取 / 没写回」的章节一个可读解释
    let panic_note: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let mut handles = Vec::new();
    for _ in 0..workers {
        let source_id = source_id.clone();
        let js = js.clone();
        let book = book.clone();
        let next = next.clone();
        let slots = slots.clone();
        let panic_note = panic_note.clone();
        let chapters = chapters.to_vec();
        handles.push(
            std::thread::Builder::new()
                .name("booksource-content".to_string())
                .spawn(move || {
                    // 每个 worker 的整段执行都做 panic 兜底：单个 worker 因意外异常
                    // 退出时，未领取的章节仍会被其它 worker 处理，已取回的结果也不会丢。
                    let outcome = panic_guard::catch_result("书源正文引擎", || -> Result<(), String> {
                        install_call_ctx(&source_id);
                        let mut context = match build_context(&js) {
                            Ok(context) => context,
                            Err(build_error) => {
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
                        };
                        let budget = Duration::from_millis(budget_ms.max(1_000));
                        loop {
                            let idx = next.fetch_add(1, Ordering::SeqCst);
                            if idx >= chapters.len() {
                                break;
                            }
                            let chapter = &chapters[idx];
                            // 用 to_value 而不是 json!：json! 对表达式内部会 unwrap，
                            // 这里显式把编码失败变成该章的 error 文本
                            let args = serde_json::to_value((chapter, &book))
                                .map_err(|e| format!("参数编码失败: {e}"))?;
                            let args_json =
                                serde_json::to_string(&args).map_err(|e| format!("参数编码失败: {e}"))?;
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

    // 没有任何 worker 写回结果的章节：用实际原因（异常原因 / 通用兜底）说明
    let fallback = panic_note
        .lock()
        .ok()
        .and_then(|note| note.clone())
        .unwrap_or_else(|| "该书源未返回本章内容".to_string());
    let mut results = Vec::with_capacity(chapters.len());
    for slot in slots.iter() {
        let guard = slot.lock().map_err(|_| "结果锁异常".to_string())?;
        results.push(guard.clone().unwrap_or_else(|| ChapterContentResult {
            ok: false,
            chapter_name: String::new(),
            text: String::new(),
            error: fallback.clone(),
        }));
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
}

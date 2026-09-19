//! Linux（WebKitGTK）上的原生求值：把脚本送进**页面主世界**执行。
//!
//! 为什么需要它：Tauri 的 `WebviewWindow::eval` / `eval_with_callback` 在 WebKitGTK 上是
//! `webkit_web_view_run_javascript`，**跑在隔离世界**——那个世界有自己的 `localStorage`
//! （实测：页面世界 `len=1 v=page-value` 的同时，隔离世界 `len=0`；宿主自己写进去的值
//! 也读不回来）。书源登录常把凭证写在 localStorage 里，隔离世界等于永远读不到。
//!
//! 原生入口 [`webkit2gtk::WebViewExt::evaluate_javascript`] 带 `world_name` 参数：
//! **传 `None` 就是页面主世界**，与页面自己的脚本共享存储与 DOM。因此桌面登录窗口的
//! 存储探针与「完成」标记都走这里，而不是 `WebviewWindow::eval`。
//!
//! 回调是异步的（结果在 GLib 主循环里回来），所以这里用一次性 channel 把结果带回调用线程
//! ——调用方（登录窗口的轮询线程）本来就在等，不会阻塞主线程。

use std::sync::mpsc;
use std::time::Duration;

// javascriptcore-rs 与 webkit2gtk 用同一版本（=1.1），求值结果就是它的 `Value`
use javascriptcore_rs::{Value, ValueExt};
use soup3::Cookie as SoupCookie;
use tauri::webview::Cookie;
use webkit2gtk::{gio, CookieManagerExt, WebContextExt, WebViewExt};



/// 在页面主世界里求值 `script`，取回字符串结果（超时 / 出错返回 None）。
///
/// - 返回值会被转成字符串：字符串原样，其余走 JSON 序列化；`undefined` / `null` 视为没有结果。
/// - **必须在登录窗口上调用**（需要该窗口的原生 WebView 句柄）。
pub fn eval_in_page(
    window: &tauri::WebviewWindow,
    script: &str,
    timeout: Duration,
) -> Option<String> {
    let (tx, rx) = mpsc::channel::<String>();
    let script = script.to_string();
    // 原生句柄只能在主线程用：`with_webview` 把闭包投给事件循环（发送即返回，不阻塞调用线程），
    // 求值结果再由 GLib 主循环回调送回这里的 channel。
    let dispatched = window
        .with_webview(move |webview| {
            let view = webview.inner();
            let tx = tx.clone();
            view.evaluate_javascript(
                &script,
                // None = 页面主世界（隔离世界读不到页面存储，见模块头注释）
                None,
                None,
                gio::Cancellable::NONE,
                move |result| {
                    let text = match result {
                        Ok(value) => js_value_to_text(&value),
                        Err(err) => {
                            eprintln!("[readerx] 主世界求值失败：{err}");
                            String::new()
                        }
                    };
                    let _ = tx.send(text);
                },
            );
        })
        .is_ok();
    if !dispatched {
        return None;
    }
    rx.recv_timeout(timeout).ok().filter(|text| !text.is_empty())
}

/// 该站点的 Cookie：WebKitGTK **原生 CookieManager**（含 httpOnly 的 `cf_clearance`）。
///
/// 不用 `WebviewWindow::cookies_for_url`：那条路同样要经运行时消息，正好是这次卡住的地方；
/// 原生句柄已经在手上，直接按「host → 逐级父域」查 Cookie 库即可。
pub fn cookies_in_store(
    window: &tauri::WebviewWindow,
    urls: &[String],
    timeout: Duration,
) -> Option<Vec<Cookie<'static>>> {
    let (tx, rx) = mpsc::channel::<Vec<Cookie<'static>>>();
    let urls: Vec<String> = urls.to_vec();
    let dispatched = window
        .with_webview(move |webview| {
            let view = webview.inner();
            let manager = match view.web_context().and_then(|context| context.cookie_manager()) {
                Some(manager) => manager,
                None => {
                    let _ = tx.send(Vec::new());
                    return;
                }
            };
            let mut out: Vec<Cookie<'static>> = Vec::new();
            for uri in &urls {
                for cookie in query_cookies(&manager, uri) {
                    let mut cookie = cookie;
                    let name = cookie.name().map(|v| v.to_string()).unwrap_or_default();
                    let value = cookie.value().map(|v| v.to_string()).unwrap_or_default();
                    if name.is_empty() || value.is_empty() {
                        continue;
                    }
                    let domain = cookie.domain().map(|v| v.to_string()).unwrap_or_default();
                    let path = cookie.path().map(|v| v.to_string()).unwrap_or_default();
                    if out.iter().any(|c| {
                        c.name() == name
                            && c.domain().unwrap_or_default() == domain
                            && c.path().unwrap_or_default() == path
                    }) {
                        continue;
                    }
                    let mut item = Cookie::new(name, value);
                    item.set_domain(domain);
                    item.set_path(path);
                    item.set_secure(cookie.is_secure());
                    item.set_http_only(cookie.is_http_only());
                    out.push(item);
                }
            }
            let _ = tx.send(out);
        })
        .is_ok();
    if !dispatched {
        return None;
    }
    rx.recv_timeout(timeout).ok()
}

/// 阻塞式查询一个 URI 下的 Cookie：WebKit 只给异步接口（回调在主上下文里跑），
/// 这里手动迭代主上下文把它转成同步 —— 查询本机 Cookie 库很快，给一个迭代上限兜底。
fn query_cookies(manager: &webkit2gtk::CookieManager, uri: &str) -> Vec<SoupCookie> {
    let collected: std::rc::Rc<std::cell::RefCell<Vec<SoupCookie>>> =
        std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let done = std::rc::Rc::new(std::cell::RefCell::new(false));
    {
        let collected = collected.clone();
        let done = done.clone();
        manager.cookies(uri, gio::Cancellable::NONE, move |result| {
            if let Ok(list) = result {
                collected.borrow_mut().extend(list);
            }
            *done.borrow_mut() = true;
        });
    }
    let context = webkit2gtk::glib::MainContext::default();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while !*done.borrow() && std::time::Instant::now() < deadline {
        while context.pending() {
            let _ = context.iteration(false);
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    let result = collected.borrow().clone();
    result
}

/// JS 值 → 字符串：字符串原样（探针与标记都是字符串），其余走 JSON 序列化；
/// `undefined` / `null` 视为「没有结果」。
fn js_value_to_text(value: &Value) -> String {
    if value.is_string() {
        return value.to_str().to_string();
    }
    if value.is_undefined() || value.is_null() {
        return String::new();
    }
    value
        .to_json(0)
        .map(|json| json.to_string())
        .unwrap_or_default()
}

/// 当前页面地址（主世界里读 `location.href`，收尾定位站点用）
pub fn current_url(window: &tauri::WebviewWindow, timeout: Duration) -> Option<String> {
    eval_in_page(window, "String(location.href)", timeout)
}


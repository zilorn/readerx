//! WebKitGTK 认证后端：在**真实浏览器内核**里打开页面，人工完成登录 / Cloudflare 挑战，
//! 然后把该站点的 Cookie（含 httpOnly 的 `cf_clearance`、`__cf_bm`）与**非 Cookie 登录
//! 信息**（localStorage / sessionStorage / IndexedDB）抓回书源会话。
//!
//! 为什么需要它：`cf_clearance` 与 **IP + UA + TLS 指纹**绑定，靠纯 HTTP 客户端拿不到；
//! 而 WebKitGTK 就是 Linux 上 Tauri 用的同一套内核，验证一次即可在 CLI 里反复离线调试
//! （见 docs/cloudflare.md）。
//!
//! 运行要求：需要有显示环境（X11 / Wayland）。纯无头机器可以：
//! - `xvfb-run -a readerx-source … auth webkit`，或
//! - 改用 `--auth cdp` 连接已有 Chrome。

use crate::auth::LoginOutcome;
use crate::host::ScopedCookie;
use crate::storage::{self, StorageSnapshot};
use gtk::glib::ControlFlow;
use gtk::prelude::*;
use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};
use webkit2gtk::{
    CookieManagerExt, SettingsExt, WebContext, WebContextExt, WebView, WebViewExt,
};

/// 当前环境是否有可用的显示（X11 / Wayland）。
///
/// 注意 `DISPLAY=`（空串）在 shell 里很常见（例如 `DISPLAY= cmd` 或容器里预置的空变量），
/// 它**不是**「有显示」——`var_os` 会返回 `Some("")`，只看 `is_some()` 会误判成可用，
/// 结果一路走到 GTK 初始化才报错。这里统一按「非空」判断，供 CLI 提前给出可读提示。
pub fn display_available() -> bool {
    ["DISPLAY", "WAYLAND_DISPLAY"].iter().any(|key| {
        std::env::var_os(key)
            .map(|value| !value.is_empty())
            .unwrap_or(false)
    })
}

/// 用 WebKitGTK 打开 `url` 让用户完成认证，返回捕获到的 Cookie。
///
/// - `wait_secs`：最长等待时间（到点自动取当前 Cookie 并关窗）；
/// - `user_agent`：非空时覆盖 WebView 的 UA（应与书源 UA 一致，否则 `cf_clearance` 不匹配）。
pub fn authenticate(
    source_id: &str,
    url: &str,
    wait_secs: u64,
    user_agent: &str,
) -> Result<LoginOutcome, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持 http/https 的认证地址".to_string());
    }
    if !display_available() {
        return Ok(LoginOutcome::failure(
            url,
            "没有可用的显示环境：无头机器请用 xvfb-run 运行，或改用 --auth cdp 连接已有 Chrome",
        ));
    }
    gtk::init().map_err(|e| format!("初始化 GTK 失败: {e}"))?;

    // 会话化上下文：认证产生的 Cookie 只活在本次窗口里，不落系统 WebKit 数据目录
    let context = WebContext::new_ephemeral();
    let view = WebView::with_context(&context);
    if !user_agent.trim().is_empty() {
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_user_agent(Some(user_agent.trim()));
        }
    }
    view.load_uri(&url);

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_title(&format!("ReaderX 认证 — {source_id}"));
    window.set_default_size(1000, 800);

    // 结果槽：按钮 / 关窗 / 超时三条路都写这里，主循环退出后统一取出
    let result: Rc<RefCell<Option<Result<LoginOutcome, String>>>> = Rc::new(RefCell::new(None));
    let finished = Rc::new(RefCell::new(false));

    let bar = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    bar.set_margin_top(6);
    bar.set_margin_bottom(6);
    bar.set_margin_start(8);
    bar.set_margin_end(8);
    let hint = gtk::Label::new(Some("完成登录 / 人机验证后点右侧按钮（或直接关窗）"));
    hint.set_xalign(0.0);
    bar.pack_start(&hint, true, true, 0);
    let button = gtk::Button::with_label("完成");
    bar.pack_end(&button, false, false, 0);

    let container = gtk::Box::new(gtk::Orientation::Vertical, 0);
    container.pack_start(&view, true, true, 0);
    container.pack_start(&bar, false, false, 0);
    window.add(&container);
    window.show_all();

    // 共用的「收尾」：读当前地址 → 抓 Cookie 与存储 → 写结果槽 → 退出主循环
    //
    // 存储只能异步取（`evaluate_javascript` 是回调式），所以这里分两步：先把同步的 Cookie
    // 收好，再等探针；探针拿不到（超时 / 被页面策略挡住）也照常以只有 Cookie 的登录态收尾。
    let collect = {
        let view = view.clone();
        let url = url.clone();
        let result = result.clone();
        let finished = finished.clone();
        move || {
            // 用独立的槽装 outcome：FnMut 闭包可能被调用多次，值不能被 move 进去
            let outcome: Rc<RefCell<Option<LoginOutcome>>> = Rc::new(RefCell::new(None));
            {
                if *finished.borrow() {
                    return;
                }
                *finished.borrow_mut() = true;
                let final_url = view
                    .uri()
                    .map(|u| u.to_string())
                    .unwrap_or_else(|| url.clone());
                match collect_cookies(&view, &final_url) {
                    Ok(list) => {
                        let mut login =
                            LoginOutcome::success(&final_url, cookie_header(&list), list.len());
                        login.url = final_url.clone();
                        *outcome.borrow_mut() = Some(login);
                    }
                    Err(err) => {
                        *result.borrow_mut() = Some(Err(err));
                        gtk::main_quit();
                        return;
                    }
                }
            }

            let slot: Rc<RefCell<Option<StorageSnapshot>>> = Rc::new(RefCell::new(None));
            collect_storage(&view, &url, slot.clone());

            let deadline = Instant::now() + Duration::from_secs(4);
            let done = result.clone();
            let outcome_slot = outcome.clone();
            gtk::glib::timeout_add_local(Duration::from_millis(150), move || {
                if let Some(snapshot) = slot.borrow_mut().take() {
                    if let Some(login) = outcome_slot.borrow_mut().as_mut() {
                        login.storage = Some(snapshot);
                    }
                } else if Instant::now() < deadline {
                    // 探针（IndexedDB 异步枚举）还没回来，继续等
                    return ControlFlow::Continue;
                }
                // 到这里无论有没有快照都要收尾：快照只是登录态的一部分，不能拖住用户
                if let Some(login) = outcome_slot.borrow_mut().take() {
                    *done.borrow_mut() = Some(Ok(login));
                }
                gtk::main_quit();
                ControlFlow::Break
            });
        }
    };

    {
        let collect = collect.clone();
        button.connect_clicked(move |_| collect());
    }
    {
        let collect = collect.clone();
        window.connect_delete_event(move |_, _| {
            collect();
            gtk::glib::Propagation::Proceed
        });
    }
    {
        // 超时兜底：用户忘了点按钮时也能拿到 Cookie，并说明是超时取到的
        let collect = collect.clone();
        let deadline = Instant::now() + Duration::from_secs(wait_secs.max(10));
        gtk::glib::timeout_add_seconds_local(1, move || {
            if *finished.borrow() {
                return ControlFlow::Break;
            }
            if Instant::now() >= deadline {
                eprintln!("readerx-source: 认证等待超时，取当前 Cookie 并关闭窗口");
                collect();
                return ControlFlow::Break;
            }
            ControlFlow::Continue
        });
    }

    gtk::main();
    let outcome = result.borrow_mut().take();
    outcome.unwrap_or_else(|| Ok(LoginOutcome::failure(url, "认证窗口已关闭，且没有取到 Cookie")))
}

/// 采集页面里的非 Cookie 登录信息（localStorage / sessionStorage / IndexedDB）。
///
/// 只能读**当前页面 origin** 的存储，且 WebKitGTK 侧的 Web Storage 没有可用的宿主 API
/// （键值不在 `WebKitWebsiteDataManager` 里），所以统一走页面内的 JS 探针；探针异步
/// （IndexedDB 枚举），这里起一个轮询把它取回塞进 `slot`，调用方负责超时收尾。
fn collect_storage(view: &WebView, url: &str, slot: Rc<RefCell<Option<StorageSnapshot>>>) {
    let origin = storage::origin_of(url).unwrap_or_default();
    let extra: Vec<String> = if origin.is_empty() {
        Vec::new()
    } else {
        vec![origin]
    };
    let script = storage::probe_script(&extra);
    let world = format!("readerx_storage_{}", now_millis());
    view.evaluate_javascript(
        &script,
        Some(&world),
        None,
        gtk::gio::Cancellable::NONE,
        |_| {},
    );

    // 轮询结果：不依赖探针的返回值（它是异步的），只看窗口上的完成标记。
    // 调用方另有硬超时，这里只负责「拿到就写、拿不到就算了」。
    let deadline = Instant::now() + Duration::from_secs(5);
    let probe = view.clone();
    gtk::glib::timeout_add_local(Duration::from_millis(150), move || {
        if slot.borrow().is_some() {
            return ControlFlow::Break;
        }
        if Instant::now() >= deadline {
            return ControlFlow::Break;
        }
        let inner = slot.clone();
        probe.evaluate_javascript(
            storage::JS_PROBE_READ,
            Some(&world),
            None,
            gtk::gio::Cancellable::NONE,
            move |result| {
                let text = result
                    .ok()
                    .map(|value| value.to_string().to_string())
                    .unwrap_or_default();
                if let Ok(snapshot) = storage::parse_probe_eval(&text) {
                    if !snapshot.is_empty() {
                        *inner.borrow_mut() = Some(snapshot);
                    }
                }
            },
        );
        ControlFlow::Continue
    });
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 取该站点（含父域）在 WebKit 会话里的 Cookie
fn collect_cookies(view: &WebView, url: &str) -> Result<Vec<ScopedCookie>, String> {
    let context = view
        .web_context()
        .ok_or_else(|| "WebView 没有 WebContext".to_string())?;
    let manager = context
        .cookie_manager()
        .ok_or_else(|| "WebContext 没有 CookieManager".to_string())?;
    let mut cookies: Vec<ScopedCookie> = Vec::new();
    for candidate in domain_candidates(url) {
        for mut cookie in query_cookies(&manager, &candidate) {
            let name = cookie.name().map(|v| v.to_string()).unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let domain = cookie.domain().map(|v| v.to_string()).unwrap_or_default();
            let path = cookie.path().map(|p| p.to_string()).unwrap_or_default();
            // 同一 Cookie 可能在多个候选域查询里重复命中
            if cookies
                .iter()
                .any(|c| c.name == name && c.domain.eq_ignore_ascii_case(&domain) && c.path == path)
            {
                continue;
            }
            cookies.push(ScopedCookie {
                name,
                value: cookie.value().map(|v| v.to_string()).unwrap_or_default(),
                domain,
                path,
                secure: cookie.is_secure(),
                expires: cookie
                    .expires()
                    .map(|time| time.to_unix())
                    .filter(|v| *v > 0)
                    .map(|v| v as u64)
                    .unwrap_or(0),
            });
        }
    }
    Ok(cookies)
}

/// 阻塞式查询一个 URI 下的 Cookie。
///
/// WebKit 只提供异步接口（回调在主上下文里跑）。这里**手动迭代主上下文**而不是嵌套
/// 一个 `MainLoop`：嵌套主循环会让窗口同时继续处理事件，容易出现「关不掉 / 结果写两次」
/// 的竞态。查询本机 cookie jar 很快，给一个迭代上限当超时兜底。
fn query_cookies(manager: &webkit2gtk::CookieManager, uri: &str) -> Vec<soup::Cookie> {
    let collected: Rc<RefCell<Vec<soup::Cookie>>> = Rc::new(RefCell::new(Vec::new()));
    let done = Rc::new(RefCell::new(false));
    {
        let collected = collected.clone();
        let done = done.clone();
        manager.cookies(uri, gtk::gio::Cancellable::NONE, move |result| {
            if let Ok(list) = result {
                collected.borrow_mut().extend(list);
            }
            *done.borrow_mut() = true;
        });
    }
    let context = gtk::glib::MainContext::default();
    let deadline = Instant::now() + Duration::from_secs(3);
    while !*done.borrow() && Instant::now() < deadline {
        while context.pending() {
            let _ = context.iteration(false);
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    let result = collected.borrow().clone();
    result
}

/// 待查询的域候选：host、去掉最左标签的父域、站点根
fn domain_candidates(url: &str) -> Vec<String> {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return Vec::new();
    };
    let Some(host) = parsed.host_str() else {
        return Vec::new();
    };
    let scheme = parsed.scheme();
    let mut out: Vec<String> = Vec::new();
    let mut labels: Vec<&str> = host.split('.').collect();
    while labels.len() >= 2 {
        out.push(format!("{scheme}://{}/", labels.join(".")));
        labels.remove(0);
    }
    if out.is_empty() {
        out.push(format!("{scheme}://{host}/"));
    }
    out
}

/// Cookie 列表 → `k=v; k2=v2`（登录态整行注入与持久化都用这个文本）
fn cookie_header(cookies: &[ScopedCookie]) -> String {
    cookies
        .iter()
        .map(|cookie| format!("{}={}", cookie.name, cookie.value))
        .collect::<Vec<String>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_candidates_walk_up_labels() {
        let list = domain_candidates("https://www.a.example.com/path");
        assert_eq!(
            list,
            vec![
                "https://www.a.example.com/",
                "https://a.example.com/",
                "https://example.com/",
            ]
        );
    }
}

//! 桌面端（Linux / Windows）网页登录窗口：真实内核里登录 / 过 Cloudflare，
//! 抓回含 httpOnly 的 Cookie 与非 Cookie 登录信息（localStorage / sessionStorage / IndexedDB）。
//!
//! 与 Android 浮层的差别只在「登录界面怎么摆」：Android 是在 Activity 上叠一个原生 `WebView`，
//! 桌面端开一个独立窗口（Tauri 多 WebView 窗口在移动端不受支持，桌面端才是常规做法）。
//! 抓取口径两边一致：
//! - **Cookie** 走内核的 Cookie 库 —— Linux 直接用 WebKitGTK 原生 `CookieManager`
//!   （含 httpOnly 的 `cf_clearance` / `__cf_bm`），其它平台用 `WebviewWindow::cookies_for_url`；
//! - **非 Cookie 登录信息**走宿主给的页面探针（`PlatformLoginRequest::probe`，脚本原样执行，
//!   本模块不认识探针的内部结构）。各平台能采到什么见 [`request_probe_result`] 的实测说明。
//!
//! 交互设计：
//! - 窗口里注入一条悬浮「完成」条（页面右下角），用户登录完点它即收尾；
//!   点击只做一件事——把 [`DONE_FLAG`] 置为 `true`，Rust 侧轮询这个标记即可
//!   （不走窗口标题：真实站点加载后会覆盖宿主设的标题，信号会丢）；
//! - 用户直接关窗也当「完成」处理；等待超时则取当前 Cookie 收尾并说明原因。
//!
//! 会话隔离：登录窗口与主窗口共用应用自己的 WebView 数据目录（Tauri 在 Linux 上只允许
//! 首次创建窗口前指定 `data_directory`，主窗口已经建好了），因此登录态不会污染系统浏览器；
//! 站点 Cookie 按域名隔离，跨源不会互相串。

use crate::{LoginOutcome, PlatformLoginRequest};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
#[cfg(not(target_os = "linux"))]
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::webview::Cookie;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// 页面求值（Linux 走 WebKitGTK 原生入口，见 `desktop_main_world`）。
///
/// 用原生入口而不是 Tauri 的 `eval`：原生那条带 `world_name` 参数（`None` = 页面世界），
/// 是唯一有可能读到页面存储的入口 —— 实测 WebKitGTK 上仍被隔离，见 [`request_probe_result`]；
/// 「完成」标记这类页面变量不受影响，且不再依赖 Tauri eval 的回调时序。
#[cfg(target_os = "linux")]
fn eval_page_text(window: &WebviewWindow, script: &str, timeout: Duration) -> Option<String> {
    crate::desktop_main_world::eval_in_page(window, script, timeout)
}

/// 页面求值（Windows / macOS：WebView2 / WKWebView 的脚本注入与求值都在页面主世界）
#[cfg(not(target_os = "linux"))]
fn eval_page_text(window: &WebviewWindow, script: &str, timeout: Duration) -> Option<String> {
    eval_text(window, script, timeout)
}

/// 完成条在被点击时写入的页面标记（Rust 侧轮询它判断用户点了「完成」）。
///
/// 不用窗口标题：真实站点加载后会把自己的标题写进窗口，宿主设的标题会被覆盖，
/// 「点完成」这个信号就丢了。页面变量不受页面自身脚本影响。
const DONE_FLAG: &str = "__rxLoginDone";
/// 页面标题 / 探针的轮询间隔
const POLL_INTERVAL: Duration = Duration::from_millis(400);
/// 探针（IndexedDB 异步枚举）等待上限
const STORAGE_WAIT: Duration = Duration::from_secs(4);
/// 关窗后等内核把 Cookie 写进 Cookie 库的时间
const COOKIE_SETTLE: Duration = Duration::from_millis(600);
/// 读 Cookie 库的等待上限（原生句柄派发到主线程 + 查库）
const COOKIE_READ_WAIT: Duration = Duration::from_secs(5);

/// 在独立窗口里完成一次登录（阻塞直到完成 / 关窗 / 超时）。
pub fn authenticate(
    app: &tauri::AppHandle,
    url: &str,
    request: &PlatformLoginRequest,
) -> Result<LoginOutcome, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        // 登录地址可能带 token 之类的查询参数，完整地址不进日志：这里只记长度
        log::warn!(
            "桌面登录只支持 http/https 地址，收到 {} 字符的地址",
            url.chars().count()
        );
        return Err("仅支持 http/https 的登录地址".to_string());
    }
    let label = label_for(&request.source_id);
    if app.get_webview_window(&label).is_some() {
        log::warn!(
            "已有登录窗口在开着（source={}），本次不再打开",
            request.source_id
        );
        return Ok(LoginOutcome::failure(
            url,
            "已经有一个登录窗口开着，请先在窗口里完成或关闭它",
        ));
    }
    log::info!(
        "打开桌面登录窗口 source={} host={} timeout={}s",
        request.source_id,
        url_host(&url),
        request.timeout_secs
    );

    let done = Arc::new(AtomicBool::new(false));
    let parsed = url
        .parse()
        .map_err(|err| format!("登录地址无法解析：{err}"))?;
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
        .title(&format!("ReaderX 登录 — {}", request.source_id))
        .inner_size(1040.0, 820.0)
        .min_inner_size(560.0, 480.0)
        .center()
        // 完成条只在顶层文档注入：iframe 里画不出「整体完成」的语义
        .initialization_script(completion_bar_script());
    if !request.user_agent.trim().is_empty() {
        // UA 必须与书源请求一致（cf_clearance 与 UA 绑定），记下来供比对
        log::debug!(
            "登录窗口使用宿主 UA source={} ua={}",
            request.source_id,
            request.user_agent.trim()
        );
        builder = builder.user_agent(request.user_agent.trim());
    }
    for script in &request.scripts {
        // 探针要覆盖所有框架：登录凭证常写在 iframe 自己的 origin 上
        log::debug!(
            "注入登录窗口脚本 source={} script={} 字符",
            request.source_id,
            script.chars().count()
        );
        builder = builder.initialization_script_for_all_frames(script);
    }

    let window = builder
        .build()
        .map_err(|err| format!("打开登录窗口失败：{err}"))?;
    log::debug!("登录窗口已创建 source={} label={label}", request.source_id);
    {
        let done = done.clone();
        window.on_window_event(move |event| {
            // 用户直接关窗＝「我登录好了」；销毁则只是催一下轮询线程
            if matches!(
                event,
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
            ) {
                done.store(true, Ordering::SeqCst);
            }
        });
    }
    if let Err(err) = window.set_focus() {
        log::warn!("登录窗口聚焦失败：{err}");
    }

    let outcome = wait_for_completion(&window, &done, &url, request);
    if let Err(err) = window.close() {
        log::warn!("关闭登录窗口失败：{err}");
    }
    log::debug!(
        "登录窗口已收尾 source={} ok={} cookie={}",
        request.source_id,
        outcome.ok,
        outcome.count
    );
    Ok(outcome)
}

/// 轮询标题等待用户完成；到点 / 关窗即收尾（取 Cookie + 探针结果）。
fn wait_for_completion(
    window: &WebviewWindow,
    done: &AtomicBool,
    fallback_url: &str,
    request: &PlatformLoginRequest,
) -> LoginOutcome {
    let timeout_secs = request.timeout_secs;
    let wait = Duration::from_secs(timeout_secs.max(10));
    let start = Instant::now();
    let mut closed = false;
    let mut timed_out = false;
    loop {
        std::thread::sleep(POLL_INTERVAL);
        let poll_started = Instant::now();
        let finished = eval_page_text(
            window,
            &format!("String({DONE_FLAG} === true)"),
            POLL_INTERVAL,
        )
        .map(|text| text.contains("true"))
        .unwrap_or(false);
        if poll_started.elapsed() > POLL_INTERVAL {
            log::warn!(
                "登录窗口主世界求值耗时 {:?}（超过轮询间隔，页面可能过重）",
                poll_started.elapsed()
            );
        }
        if finished {
            log::debug!("用户点了「完成」，开始收尾");
            break;
        }
        if done.load(Ordering::SeqCst) {
            closed = true;
            break;
        }
        if start.elapsed() >= wait {
            timed_out = true;
            break;
        }
    }
    // 关窗后内核还要一点时间把 Cookie 落进 Cookie 库
    if closed {
        std::thread::sleep(COOKIE_SETTLE);
    }

    let final_url = window
        .url()
        .map(|value| value.to_string())
        .unwrap_or_else(|_| fallback_url.to_string());
    let cookies = match collect_cookies(window, &final_url) {
        Ok(list) => list,
        Err(err) => {
            log::warn!("读取登录 Cookie 失败：{err}");
            return LoginOutcome::failure(final_url, format!("读取 Cookie 失败：{err}"));
        }
    };
    // 只记条数与主机名：Cookie 值绝不进日志，最终地址也可能带 token
    log::debug!(
        "登录窗口 Cookie 库读取完成 n={} host={}",
        cookies.len(),
        url_host(&final_url)
    );
    if cookies.is_empty() {
        log::warn!("登录窗口没有取到任何 Cookie（closed={closed} timed_out={timed_out}）");
        return LoginOutcome::failure(
            final_url,
            if closed {
                "登录窗口已关闭，且没有取到任何 Cookie（站点若用 localStorage 记登录态，请点窗口里的「完成」收尾）"
                    .to_string()
            } else {
                "没有取到任何 Cookie，请确认已在窗口里完成登录".to_string()
            },
        );
    }
    let mut outcome =
        LoginOutcome::success(&final_url, cookie_header(&cookies), cookies.len() as u64);
    outcome.probe_result = request_probe_result(window, fallback_url, request.probe.as_ref());
    if timed_out {
        outcome.message = format!(
            "等待超过 {timeout_secs} 秒，已按当前状态收尾（Cookie {} 条）",
            outcome.count
        );
    }
    outcome
}

/// URL 的主机名（**日志专用**：登录地址可能带 token 之类的查询参数，完整地址不进日志）
fn url_host(url: &str) -> String {
    tauri::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_string()))
        .unwrap_or_default()
}

/// 读内核 Cookie 库里的该站点 Cookie（含 httpOnly）。
///
/// 按「host → 逐级父域」逐个查询：`cookies_for_url` 只给该 URL 可见的 Cookie，
/// 而站点的登录 Cookie 常挂在父域（`.example.com`）上。
fn collect_cookies(window: &WebviewWindow, url: &str) -> Result<Vec<Cookie<'static>>, String> {
    let candidates = domain_candidates(url);
    // Linux：直接用 WebKitGTK 原生 CookieManager（含 httpOnly），不经运行时消息
    #[cfg(target_os = "linux")]
    {
        if let Some(list) =
            crate::desktop_main_world::cookies_in_store(window, &candidates, COOKIE_READ_WAIT)
        {
            // 只记条数：Cookie 值绝不进日志
            log::debug!("原生 Cookie 库读取完成 n={}", list.len());
            return Ok(list);
        }
        log::warn!("原生 Cookie 库读取没有响应，回退到运行时接口");
    }
    let mut list: Vec<Cookie<'static>> = Vec::new();
    for candidate in candidates {
        let Ok(parsed) = candidate.parse() else {
            continue;
        };
        let found = window
            .cookies_for_url(parsed)
            .map_err(|err| err.to_string())?;
        for cookie in found {
            if cookie.name().is_empty() || cookie.value().is_empty() {
                continue;
            }
            let duplicate = list.iter().any(|item| {
                item.name() == cookie.name()
                    && item.domain() == cookie.domain()
                    && item.path() == cookie.path()
            });
            if !duplicate {
                list.push(cookie);
            }
        }
    }
    Ok(list)
}

/// Cookie 列表 → `k=v; k2=v2`（存入登录态、注入会话用的就是这段文本）
fn cookie_header(cookies: &[Cookie<'static>]) -> String {
    cookies
        .iter()
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<String>>()
        .join("; ")
}

/// 待查询的域候选：host、去掉最左标签的父域，直到站点根
fn domain_candidates(url: &str) -> Vec<String> {
    let Ok(parsed) = tauri::Url::parse(url) else {
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

/// 每个书源一个窗口标签：重复点击按钮时能识别、用户在任务栏里也能认出是哪个源
fn label_for(source_id: &str) -> String {
    let sanitized: String = source_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    format!("readerx-login-{sanitized}")
}

/// 悬浮「完成」条：页面右下角一枚按钮，点一下把 [`DONE_FLAG`] 置为 `true`。
///
/// 只做这一个副作用：Rust 侧轮询这个页面变量即可，不必把结果跨平台地传回来。
fn completion_bar_script() -> String {
    format!(
        r#"(function () {{
  function install() {{
    if (document.getElementById('__rx_login_bar')) return;
    if (!document.body) return;
    var bar = document.createElement('div');
    bar.id = '__rx_login_bar';
    bar.setAttribute('style', [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'gap:10px',
      'padding:8px 10px 8px 14px', 'border-radius:12px',
      'background:rgba(20,22,26,0.9)', 'color:#fff',
      'font:500 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,0.32)'
    ].join(';'));
    var hint = document.createElement('span');
    hint.textContent = '登录完成后点右侧按钮';
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = '完成';
    button.setAttribute('style', [
      'border:0', 'cursor:pointer', 'padding:6px 14px', 'border-radius:9px',
      'background:#e8590c', 'color:#fff', 'font:600 13px/1.2 inherit'
    ].join(';'));
    button.onclick = function () {{
      window.{flag} = true;
      button.textContent = '已提交，请稍候…';
      button.disabled = true;
    }};
    bar.appendChild(hint);
    bar.appendChild(button);
    document.body.appendChild(bar);
  }}
  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', install);
  }} else {{
    install();
  }}
}})()"#,
        flag = DONE_FLAG
    )
}

// ---------------------------------------------------------------------------
// 存储探针：只按宿主给的三段脚本执行，不解析结果
// ---------------------------------------------------------------------------

/// 采集页面里的非 Cookie 登录信息（localStorage / sessionStorage / IndexedDB）。
///
/// 探针脚本由宿主提供（本模块只原样执行）：`init` 在页面加载前注入，这里求值 `run`
/// 触发采集、轮询 `read` 取回结果（`pending` = 还没采完，IndexedDB 枚举是异步的）。
///
/// ## 各平台的实际能力（Linux 上已逐条实测）
///
/// | 平台 | 注入脚本跑在哪 | 能否读到页面 localStorage |
/// | --- | --- | --- |
/// | Windows（WebView2 `AddScriptToExecuteOnDocumentCreated`） | 页面主世界 | 能 |
/// | macOS（`WKUserScript`，未指定 content world） | 页面主世界 | 能 |
/// | Linux（WebKitGTK，Tauri 的 `initialization_script`） | 隔离世界 | **不能** |
///
/// Linux 的隔离是内核行为，宿主侧三条路都试过：Tauri 的 `eval` / `eval_with_callback`、
/// 注入脚本、以及原生 `webkit_web_view_evaluate_javascript(world_name = NULL)`
/// —— 三者看到的 `localStorage` 都是空的那一份（实测：页面自己的脚本读到 `len=1`，
/// 这三种路径都读到 `len=0`，且宿主自己写进去再读也是空）。WebKitGTK 公开 API 里
/// 也没有读 Web Storage 值的入口（`WebsiteDataManager::fetch` 只给 origin / 类型 / 大小）。
/// 因此该平台只能以 Cookie 为登录态来源；本地存储型登录需要开一次 WebKit 的
/// Web Inspector 手工核对，或在书源代码里用 `webview.storage()` 的降级分支处理。
///
/// 采不到不报错、也不拖住收尾：只带 Cookie 的登录态也比没有强。
fn request_probe_result(
    window: &WebviewWindow,
    url: &str,
    probe: Option<&readerx_source::auth::ProbeScript>,
) -> Option<String> {
    let Some(probe) = probe else {
        log::debug!("本次登录没有存储探针（宿主未提供），只收 Cookie");
        return None;
    };
    if !probe.is_ready() {
        log::warn!("存储探针脚本不完整（四段缺一），只收 Cookie");
        return None;
    }
    log::debug!("存储探针开始 host={}", url_host(url));
    // 先触发采集（`run`），再轮询读回（`read`）
    if eval_page_text(window, &probe.run, STORAGE_WAIT).is_none() {
        log::warn!("触发存储探针没有得到响应 host={}", url_host(url));
    }
    let start = Instant::now();
    loop {
        match eval_page_text(window, &probe.read, POLL_INTERVAL) {
            // 非空且不是「还没采完」才是结果；空串可能是首轮尚未写入，继续等
            Some(text) if !text.trim().is_empty() && !text.contains(&probe.pending) => {
                // 探针内容是登录凭证，只记长度不记内容
                log::debug!("存储探针已返回结果 bytes={}", text.len());
                return Some(text);
            }
            _ => {}
        }
        if start.elapsed() >= STORAGE_WAIT {
            // 采不到不是错误：页面本来就可能没有存储（纯 Cookie 登录），也可能是内核隔离
            log::debug!(
                "存储探针在 {STORAGE_WAIT:?} 内没有结果，只收 Cookie（host={}）",
                url_host(url)
            );
            return None;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// 求值一段 JS 并取回字符串结果（Tauri 的 eval；在 WebKitGTK 上跑隔离世界）。
///
/// 只作为**非 Linux** 平台的主世界求值实现（WebView2 / WKWebView 的注入脚本本就在主世界）。
#[cfg(not(target_os = "linux"))]
fn eval_text(window: &WebviewWindow, script: &str, timeout: Duration) -> Option<String> {
    let slot = Arc::new(Mutex::new(String::new()));
    let pending = Arc::new(AtomicBool::new(true));
    let writer = slot.clone();
    let flag = pending.clone();
    window
        .eval_with_callback(script, move |text| {
            if let Ok(mut guard) = writer.lock() {
                *guard = text;
            }
            flag.store(false, Ordering::SeqCst);
        })
        .ok()?;
    let deadline = Instant::now() + timeout;
    while pending.load(Ordering::SeqCst) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    if pending.load(Ordering::SeqCst) {
        return None;
    }
    slot.lock().ok().map(|guard| guard.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_candidates_walk_up_labels() {
        assert_eq!(
            domain_candidates("https://www.a.example.com/path"),
            vec![
                "https://www.a.example.com/",
                "https://a.example.com/",
                "https://example.com/",
            ]
        );
    }

    #[test]
    fn window_label_is_filesystem_safe() {
        assert_eq!(label_for("demo.src/1"), "readerx-login-demo-src-1");
        assert_eq!(label_for("abc"), "readerx-login-abc");
    }

    /// 完成条的脚本必须自洽：点击写的是完成标记、按钮 id 稳定
    #[test]
    fn completion_bar_script_embeds_flag() {
        let script = completion_bar_script();
        assert!(script.contains(&format!("window.{DONE_FLAG} = true")));
        assert!(script.contains("__rx_login_bar"));
    }

    /// 探针完整性判定：四段脚本缺一段都不能用
    /// （缺 `init` 就注不进页面世界，缺 `run`/`read` 则采不到 / 读不回）
    #[test]
    fn probe_script_readiness() {
        let full = readerx_source::auth::ProbeScript {
            init: "init".into(),
            run: "run".into(),
            read: "read".into(),
            pending: "pending".into(),
        };
        assert!(full.is_ready());
        for broken in [
            readerx_source::auth::ProbeScript {
                init: String::new(),
                ..full.clone()
            },
            readerx_source::auth::ProbeScript {
                run: String::new(),
                ..full.clone()
            },
            readerx_source::auth::ProbeScript {
                read: String::new(),
                ..full
            },
        ] {
            assert!(!broken.is_ready());
        }
    }
}

//! Chrome DevTools Protocol 认证后端：在**真实 Chrome** 里过登录 / Cloudflare 挑战，
//! 再把该站点的 Cookie（含 `cf_clearance`、httpOnly）与**非 Cookie 登录信息**
//! （localStorage / sessionStorage / IndexedDB）抓回来交给书源会话。
//!
//! 为什么是 CDP 而不是自己实现挑战求解：`cf_clearance` 与 **IP + UA + TLS 指纹**绑定，
//! 只有真实浏览器内核能拿到有效令牌（见 docs/cloudflare.md 的「手动兜底」）。
//!
//! 两种用法：
//! - **连已开的 Chrome**：`--cdp http://127.0.0.1:9222`
//!   （先在浏览器里带 `--remote-debugging-port=9222` 启动，或使用专门调好的实例）；
//! - **由本工具拉起浏览器**：`--browser /path/to/chrome [--user-data-dir <目录>]`
//!   会以独立用户数据目录启动并打开目标页。
//!
//! 流程：浏览器打开目标页 → 用户完成登录 / 人机验证 → 回车（或等待超时）→
//! `Network.getAllCookies` + `DOMStorage` / 页面探针抓取 → 保存为该书源登录态并注入会话。

use crate::auth::LoginOutcome;
use crate::host::ScopedCookie;
use crate::storage::{self, StorageSnapshot};
use serde_json::{json, Value};
use std::io::{BufRead, IsTerminal};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tungstenite::Message;

/// CDP 认证参数（由 CLI 装配）
#[derive(Debug, Clone)]
pub struct Options {
    /// DevTools HTTP 端点，如 `http://127.0.0.1:9222`
    pub endpoint: String,
    /// 浏览器可执行文件（端点不可达时拉起它）
    pub browser: Option<String>,
    /// 拉起浏览器时使用的用户数据目录（默认临时目录，登录态不落进系统配置）
    pub user_data_dir: Option<PathBuf>,
    /// 最长等待时间（秒）：用户完成验证的窗口
    pub wait_secs: u64,
    /// 打开页面时使用的 User-Agent（与书源保持一致，避免令牌与 UA 不匹配）
    pub user_agent: String,
    /// 静默模式（CLI `--json` 时不打印交互提示）
    pub quiet: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            endpoint: "http://127.0.0.1:9222".to_string(),
            browser: None,
            user_data_dir: None,
            wait_secs: 300,
            user_agent: crate::profile::DEFAULT_UA.to_string(),
            quiet: false,
        }
    }
}

/// 执行一次 CDP 认证。`source_id` 仅用于日志。
pub fn authenticate(source_id: &str, url: &str, options: &Options) -> Result<LoginOutcome, String> {
    let started = Instant::now();
    let mut session = CdpSession::connect(options)?;
    if let Some(note) = session.note.clone() {
        log::info!("{note}");
    }
    session.open_page(url)?;
    if !options.quiet {
        // 交互提示：用户要按回车才会继续，不能只进日志文件
        log::info!(
            "已在浏览器打开 {}；完成登录 / 人机验证后按回车取回 Cookie（最长 {} 秒；超时自动取当前 Cookie）",
            readerx_log::redact::url(url),
            options.wait_secs
        );
    }
    session.wait_for_user(options.wait_secs);
    // 关浏览器之前先抓存储（localStorage / sessionStorage / IndexedDB 只能在页面里读）
    let snapshot = session.collect_storage(url);
    let cookies = session.all_cookies()?;
    session.close_spawned();

    let host = url_host(url);
    let matched: Vec<ScopedCookie> = cookies
        .into_iter()
        .filter(|cookie| domain_hits(&cookie.domain, &host))
        .collect();
    if matched.is_empty() {
        log::warn!(
            "CDP 认证未取到该站点的 Cookie source={source_id} host={host}（验证没做完 / 页面没加载完）"
        );
        return Ok(LoginOutcome::failure(
            url,
            format!(
                "浏览器里没有 {host} 的 Cookie：可能验证没做完 / 页面没加载完（source={source_id}）"
            ),
        ));
    }
    let text = matched
        .iter()
        .map(|cookie| format!("{}={}", cookie.name, cookie.value))
        .collect::<Vec<String>>()
        .join("; ");
    // 抓到的 Cookie 直接写进会话（profile 落盘由 CLI 的 auth 流程负责）
    if let Ok(state) = crate::host::source_state(source_id) {
        let handle = crate::host::SessionHandle::from_state(state);
        handle.set_scoped_cookies(&matched);
    }
    // 同时按整行注入：部分站点 Cookie 没有域信息时也能生效
    crate::host::http_set_cookie(source_id, &text);
    log::debug!(
        "CDP 认证完成 source={source_id} host={host} cookie={} storage={} ms={}",
        matched.len(),
        if snapshot.is_some() { "有" } else { "无" },
        started.elapsed().as_millis()
    );
    Ok(LoginOutcome::success(url, text, matched.len()).with_storage(snapshot))
}

/// 页面里的一个 frame（采集存储时逐 frame 处理：内嵌的登录框常在自己的 origin 里）
struct Frame {
    id: String,
    origin: String,
}

/// 拍平 `Page.getFrameTree` 的结果（origin 缺失时退回用 URL 推）
fn flatten_frames(tree: Option<&Value>, out: &mut Vec<Frame>, depth: usize) {
    // 深度兜底：畸形 / 自引用结构不至于把栈打爆
    if depth > 8 {
        return;
    }
    let Some(node) = tree else {
        return;
    };
    if let Some(frame) = node.get("frame") {
        let id = frame
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let origin = frame
            .get("securityOrigin")
            .and_then(|v| v.as_str())
            .map(String::from)
            .or_else(|| {
                frame
                    .get("url")
                    .and_then(|v| v.as_str())
                    .and_then(storage::origin_of)
            })
            .unwrap_or_default();
        // 只处理能当存储作用域用的 http(s) origin：`null`（沙箱 iframe）、`file://` 都没有
        // 可读写的 Web Storage，留着只会往快照里塞垃圾条目
        if !id.is_empty() && storage::origin_of(&origin).is_some() {
            out.push(Frame { id, origin });
        }
    }
    if let Some(children) = node.get("childFrames").and_then(|v| v.as_array()) {
        for child in children {
            flatten_frames(Some(child), out, depth + 1);
        }
    }
}

/// 探针表达式：在指定执行上下文里跑一遍存储探针，直接返回它产出的 JSON 文本
fn probe_expr(origin: &str, login_url: &str) -> String {
    let script = storage::probe_script(&[origin.to_string()]);
    let json = serde_json::to_string(&script).unwrap_or_else(|_| "\"\"".to_string());
    let fallback = serde_json::to_string(login_url).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(async function () {{ \
             const r = await (0, eval)({json}); \
             if (typeof r === \"string\" && r) return r; \
             for (let i = 0; i < 40; i++) {{ \
                 await new Promise(function (done) {{ setTimeout(done, 100); }}); \
                 if (window.__rxStorageProbeDone) {{ \
                     const t = window.__rxStorageProbeResult || \"\"; \
                     window.__rxStorageProbeDone = false; \
                     window.__rxStorageProbeResult = \"\"; \
                     return t; \
                 }} \
             }} \
             return JSON.stringify({{ version: 1, updatedAt: Date.now(), origins: [{{ \
                 origin: {origin_json}, url: {fallback}, localStorage: [], sessionStorage: [], indexedDb: [] \
             }}] }}); \
         }})()",
        origin_json = serde_json::to_string(origin).unwrap_or_else(|_| "\"\"".to_string()),
    )
}

/// CDP 读到的键值对 → 快照条目（超长值按与探针一致的规则截断）
fn entries(pairs: Vec<(String, String)>) -> Vec<storage::StorageEntry> {
    pairs
        .into_iter()
        .take(storage::MAX_ENTRIES_PER_ORIGIN)
        .map(|(key, value)| {
            let truncated = value.chars().count() > storage::MAX_VALUE_CHARS;
            storage::StorageEntry {
                key,
                value: if truncated {
                    value.chars().take(storage::MAX_VALUE_CHARS).collect()
                } else {
                    value
                },
                truncated,
            }
        })
        .collect()
}

/// 域名匹配（`.example.com` 命中 `www.example.com`；`www.` 前缀视为同站）
fn domain_hits(cookie_domain: &str, host: &str) -> bool {
    let domain = cookie_domain.trim().trim_start_matches('.').to_ascii_lowercase();
    if domain.is_empty() || host.is_empty() {
        return true;
    }
    let host = host.trim_start_matches("www.").to_ascii_lowercase();
    let domain_bare = domain.trim_start_matches("www.");
    host == domain_bare
        || host.ends_with(&format!(".{domain_bare}"))
        || domain_bare.ends_with(&format!(".{host}"))
}

fn url_host(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|h| h.to_string()))
        .unwrap_or_default()
}

/// 一个最短可用的 CDP 会话（只用到目标管理 + 网络 Cookie + 页面存储）
struct CdpSession {
    socket: tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
    next_id: u64,
    /// 本次由我们拉起的浏览器（退出时关闭）
    spawned: Option<Child>,
    /// 本次由我们创建的标签页 id（退出时关闭）
    created_target: Option<String>,
    /// 给用户看的一句话（连上了哪个浏览器 / 拉起了什么）
    note: Option<String>,
}

impl CdpSession {
    fn connect(options: &Options) -> Result<Self, String> {
        let (endpoint, spawned, note) = match probe(&options.endpoint) {
            Ok(_) => (
                options.endpoint.trim_end_matches('/').to_string(),
                None,
                Some(format!("已连接 Chrome DevTools：{}", options.endpoint)),
            ),
            Err(probe_error) => {
                let browser = options
                    .browser
                    .clone()
                    .or_else(|| std::env::var("READERX_CHROME").ok())
                    .ok_or_else(|| {
                        format!(
                            "{probe_error}\n用 --cdp <地址> 指定已开调试端口的 Chrome，\
                             或用 --browser <可执行文件> 让本工具拉起一个"
                        )
                    })?;
                let (child, endpoint) = spawn_browser(&browser, options)?;
                (
                    endpoint,
                    Some(child),
                    Some(format!("已拉起浏览器：{browser}（调试端口见上）")),
                )
            }
        };

        // 浏览器刚启动时 DevTools 端口要等几百毫秒
        let mut last_error = String::new();
        for _ in 0..40 {
            match fetch_json(&format!("{endpoint}/json/version")) {
                Ok(_) => break,
                Err(err) => {
                    last_error = err;
                    std::thread::sleep(Duration::from_millis(250));
                }
            }
        }
        log::debug!(
            "CDP 调试端点就绪 endpoint={} 本次拉起浏览器={}",
            readerx_log::redact::url(&endpoint),
            spawned.is_some()
        );

        // 优先连「浏览器级」端点：可以用 Target.createTarget 精确控制我们打开的标签页
        let ws_url = browser_ws_url(&endpoint).or_else(|_| {
            fetch_json(&format!("{endpoint}/json"))
                .ok()
                .and_then(|value| {
                    value
                        .as_array()
                        .and_then(|list| list.iter().find(|item| item["type"] == "page"))
                        .and_then(|page| page["webSocketDebuggerUrl"].as_str().map(String::from))
                })
                .ok_or_else(|| format!("{endpoint}/json 里没有可用的页面目标（{last_error}）"))
        })?;
        let (socket, _) = tungstenite::connect(ws_url.as_str())
            .map_err(|e| format!("连接 DevTools WebSocket 失败: {e}"))?;
        match socket.get_ref() {
            tungstenite::stream::MaybeTlsStream::Plain(stream) => {
                stream
                    .set_read_timeout(Some(Duration::from_millis(500)))
                    .map_err(|e| format!("设置 DevTools 读超时失败: {e}"))?;
            }
            _ => {
                return Err("DevTools 端点应为本机 http（不支持 wss）".to_string());
            }
        }
        Ok(Self {
            socket,
            next_id: 1,
            spawned,
            created_target: None,
            note,
        })
    }

    /// 打开目标页：新建标签页（浏览器级端点）或复用已有页面
    fn open_page(&mut self, url: &str) -> Result<(), String> {
        log::debug!("CDP 打开页面 url={}", readerx_log::redact::url(url));
        match self.send("Target.createTarget", json!({ "url": url })) {
            Ok(value) => {
                if let Some(id) = value.get("targetId").and_then(|v| v.as_str()) {
                    self.created_target = Some(id.to_string());
                    // 新标签页需要 attach 才能对它发 Network.getAllCookies
                    let _ = self.send(
                        "Target.attachToTarget",
                        json!({ "targetId": id, "flatten": true }),
                    );
                }
                Ok(())
            }
            Err(err) => {
                // 端点不支持浏览器级命令（例如直接连的页面 WebSocket）：改用 Page.navigate
                log::debug!("Target.createTarget 不可用，改用 Page.navigate：{err}");
                let _ = self.send("Page.enable", json!({}));
                self.send("Page.navigate", json!({ "url": url }))
                    .map(|_| ())
                    .map_err(|nav_error| format!("{err}；改用 Page.navigate 也失败：{nav_error}"))
            }
        }
    }

    /// 等到用户按回车或超时（非交互环境直接等到超时的一半，避免无人值守时干等）
    fn wait_for_user(&mut self, wait_secs: u64) {
        let done = Arc::new(AtomicBool::new(false));
        let interactive = std::io::stdin().is_terminal();
        if interactive {
            let flag = done.clone();
            std::thread::spawn(move || {
                let stdin = std::io::stdin();
                let mut line = String::new();
                // 用户敲回车（或关闭 stdin）即结束等待
                let _ = stdin.lock().read_line(&mut line);
                flag.store(true, Ordering::SeqCst);
            });
        }
        let deadline = Instant::now() + Duration::from_secs(wait_secs.max(5));
        if !interactive {
            // 非交互：给页面 8 秒加载 + 站点自动放行的时间，然后取 Cookie
            let soft = Instant::now() + Duration::from_secs(8);
            while Instant::now() < soft && !done.load(Ordering::SeqCst) {
                self.pump();
                std::thread::sleep(Duration::from_millis(200));
            }
            log::debug!("CDP 非交互等待结束（约 8 秒加载窗口），开始收尾取 Cookie");
            return;
        }
        while Instant::now() < deadline && !done.load(Ordering::SeqCst) {
            self.pump();
            std::thread::sleep(Duration::from_millis(200));
        }
        if done.load(Ordering::SeqCst) {
            log::debug!("CDP 认证等待被用户回车结束，开始收尾取 Cookie");
        } else {
            // 超时不是失败：仍然把浏览器里已有的 Cookie 取回来
            log::info!("CDP 认证等待超时（{wait_secs} 秒），按当前状态取 Cookie 收尾");
        }
    }

    /// 驱动一次 WebSocket 读（顺带处理 CDP 事件，保持连接活跃）
    fn pump(&mut self) {
        match self.socket.read() {
            Ok(Message::Close(_)) => {}
            Ok(_) => {}
            Err(tungstenite::Error::Io(err))
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => {}
        }
    }

    /// 发一条 CDP 命令并等它的响应（跳过事件消息）
    fn send(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = json!({ "id": id, "method": method, "params": params }).to_string();
        self.socket
            .send(Message::Text(payload))
            .map_err(|e| format!("发送 CDP 命令 {method} 失败: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if Instant::now() > deadline {
                return Err(format!("CDP 命令 {method} 超时"));
            }
            match self.socket.read() {
                Ok(Message::Text(text)) => {
                    let Ok(value) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    if value.get("id").and_then(|v| v.as_u64()) != Some(id) {
                        continue; // 事件或别的响应
                    }
                    if let Some(error) = value.get("error") {
                        return Err(format!("CDP 命令 {method} 失败: {error}"));
                    }
                    return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                }
                Ok(_) => continue,
                Err(tungstenite::Error::Io(err))
                    if matches!(
                        err.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue
                }
                Err(err) => return Err(format!("CDP 连接中断: {err}")),
            }
        }
    }

    /// 取浏览器里全部 Cookie（含 httpOnly；本机调试端口可读）
    fn all_cookies(&mut self) -> Result<Vec<ScopedCookie>, String> {
        let result = self.send("Network.getAllCookies", json!({}))?;
        let list = result
            .get("cookies")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::new();
        for item in list {
            let Some(name) = item.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            out.push(ScopedCookie {
                name: name.to_string(),
                value: item
                    .get("value")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                domain: item
                    .get("domain")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                path: item
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                secure: item.get("secure").and_then(|v| v.as_bool()).unwrap_or(false),
                expires: item
                    .get("expires")
                    .and_then(|v| v.as_f64())
                    .filter(|v| *v > 0.0)
                    .map(|v| v as u64)
                    .unwrap_or(0),
            });
        }
        // 只记条数：Cookie 值绝不进日志
        log::debug!("CDP 读取 Cookie 库 n={}", out.len());
        Ok(out)
    }

    /// 采集页面里的非 Cookie 登录信息（localStorage / sessionStorage / IndexedDB）。
    ///
    /// LocalStorage 由 CDP 原生接口读取（不依赖页面脚本，localStorage 被页面改写也照样读得到）；
    /// IndexedDB 只能异步枚举，交给统一的 JS 探针（见 `crate::storage::probe_script`）在页面
    /// 上下文里跑，带超时兜底。任何一步失败都只是「少一部分快照」，不影响 Cookie 与登录本身。
    fn collect_storage(&mut self, login_url: &str) -> Option<StorageSnapshot> {
        let contexts = self.frame_contexts();
        if contexts.is_empty() {
            log::warn!(
                "CDP 存储采集跳过：没有可用的页面执行上下文 url={}",
                readerx_log::redact::url(login_url)
            );
            return None;
        }
        let mut snapshot = StorageSnapshot::default();
        for (frame_id, context_id, origin) in contexts {
            let local = self.dom_storage_items(&origin, true).unwrap_or_default();
            let session = self.dom_storage_items(&origin, false).unwrap_or_default();
            // 探针只用来拿 IndexedDB 库清单（键值已由 CDP 直读）
            let probe_page = match context_id {
                Some(context_id) => self
                    .eval_json(context_id, &probe_expr(&origin, login_url))
                    .and_then(|value| {
                        let text = value.as_str().map(String::from).or_else(|| {
                            value
                                .get("value")
                                .and_then(|v| v.as_str())
                                .map(String::from)
                        })?;
                        storage::parse_probe(&text).ok()
                    })
                    .and_then(|probe| probe.origin(&origin).cloned()),
                // 拿不到执行上下文时，至少把 CDP 直接读到的键值留下来
                None => None,
            };
            if context_id.is_some() && probe_page.is_none() {
                // 只是「少了 IndexedDB 库清单」，localStorage 仍由 CDP 直读，不影响登录本身
                log::warn!(
                    "CDP 存储探针没有结果 origin={origin}（仅缺 IndexedDB 清单，其余存储照收）"
                );
            }
            let _ = frame_id;
            let page = probe_page.unwrap_or_default();
            if local.is_empty() && session.is_empty() && page.indexed_db.is_empty() {
                continue;
            }
            // 只记条数：存储内容就是登录凭证，绝不进日志
            log::debug!(
                "CDP 存储采集 origin={origin} local={} session={} indexeddb={}",
                local.len(),
                session.len(),
                page.indexed_db.len()
            );
            snapshot.origins.push(storage::StorageOrigin {
                origin: origin.clone(),
                url: if page.url.trim().is_empty() {
                    login_url.to_string()
                } else {
                    page.url
                },
                local_storage: entries(local),
                session_storage: entries(session),
                indexed_db: page.indexed_db,
            });
        }
        snapshot.normalize();
        log::debug!(
            "CDP 存储采集结束 origins={} 结果={}",
            snapshot.origins.len(),
            if snapshot.is_empty() { "空" } else { "有" }
        );
        (!snapshot.is_empty()).then_some(snapshot)
    }

    /// 页面里的执行上下文：`(frameId, contextId?, origin)`。
    /// 优先建一个隔离世界（探针不会污染页面自己的全局变量）；失败则退回主世界。
    fn frame_contexts(&mut self) -> Vec<(String, Option<i64>, String)> {
        let _ = self.send("Page.enable", json!({}));
        let tree = match self.send("Page.getFrameTree", json!({})) {
            Ok(tree) => tree,
            Err(err) => {
                log::warn!("CDP 取页面框架树失败，本次不采存储：{err}");
                return Vec::new();
            }
        };
        let mut frames = Vec::new();
        flatten_frames(tree.get("frameTree"), &mut frames, 0);
        let mut out = Vec::new();
        for frame in frames {
            let context_id = self
                .send(
                    "Page.createIsolatedWorld",
                    json!({
                        "frameId": frame.id,
                        "worldName": format!("readerx_storage_{}", self.next_id),
                        "grantUniveralAccess": true,
                    }),
                )
                .ok()
                .and_then(|value| value.get("executionContextId").and_then(|v| v.as_i64()));
            out.push((frame.id, context_id, frame.origin));
        }
        out
    }

    /// 该 origin 的 localStorage / sessionStorage 键值（CDP 原生读取，不执行页面脚本）
    fn dom_storage_items(&mut self, origin: &str, local: bool) -> Result<Vec<(String, String)>, String> {
        // DOMStorage 需要先 enable 才认这个 storageId
        let _ = self.send("DOMStorage.enable", json!({}));
        let result = match self.send(
            "DOMStorage.getDOMStorageItems",
            json!({
                "storageId": {
                    "securityOrigin": origin,
                    "isLocalStorage": local,
                }
            }),
        ) {
            Ok(result) => result,
            Err(err) => {
                // 单类存储读不到不影响 Cookie 与登录本身，但「少采了什么」要留痕
                log::warn!(
                    "CDP 读取{}失败 origin={origin} reason={err}",
                    if local { " localStorage" } else { " sessionStorage" }
                );
                return Err(err);
            }
        };
        let entries = result
            .get("entries")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(entries
            .iter()
            .filter_map(|pair| {
                let list = pair.as_array()?;
                let key = list.first()?.as_str()?.to_string();
                let value = list.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string();
                Some((key, value))
            })
            .collect())
    }

    /// 在指定执行上下文里求值，返回 JS 值（`awaitPromise`：探针的 IndexedDB 枚举是异步的）
    fn eval_json(&mut self, context_id: i64, expression: &str) -> Option<Value> {
        let result = self
            .send(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "contextId": context_id,
                    "returnByValue": true,
                    "awaitPromise": true,
                    "silent": true,
                }),
            )
            .ok()?;
        if result.get("exceptionDetails").is_some() {
            return None;
        }
        result.get("result").cloned()
    }

    /// 关掉本次拉起的浏览器与新建标签页（连别人浏览器时不动它）
    fn close_spawned(&mut self) {
        if let Some(id) = self.created_target.clone() {
            let _ = self.send("Target.closeTarget", json!({ "targetId": id }));
            log::debug!("CDP 已关闭本次创建的标签页");
        }
        if let Some(mut child) = self.spawned.take() {
            let _ = child.kill();
            let _ = child.wait();
            log::debug!("CDP 已关闭本次拉起的浏览器");
        }
    }
}

impl Drop for CdpSession {
    fn drop(&mut self) {
        self.close_spawned();
    }
}

// ---------------------------------------------------------------------------
// HTTP / 进程辅助
// ---------------------------------------------------------------------------

/// 探测调试端点是否可用，返回 `/json/version` 内容
fn probe(endpoint: &str) -> Result<Value, String> {
    fetch_json(&format!("{}/json/version", endpoint.trim_end_matches('/')))
}

fn fetch_json(url: &str) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("创建 DevTools HTTP 客户端失败: {e}"))?;
    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("DevTools 端点不可达（{url}）：{e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("读取 DevTools 端点响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("DevTools 端点返回 {status}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("解析 DevTools 响应失败: {e}"))
}

/// 浏览器级 WebSocket 地址（/json/version 的 webSocketDebuggerUrl）
fn browser_ws_url(endpoint: &str) -> Result<String, String> {
    let value = fetch_json(&format!("{}/json/version", endpoint.trim_end_matches('/')))?;
    value
        .get("webSocketDebuggerUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "DevTools 端点没有 webSocketDebuggerUrl".to_string())
}

/// 找可用的调试端口（从 9222 起顺延；避免与已开的实例冲突）
fn pick_port(preferred: u16) -> u16 {
    for port in preferred..preferred.saturating_add(20) {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    preferred
}

/// 拉起浏览器：独立用户数据目录 + 调试端口 + 目标页
fn spawn_browser(binary: &str, options: &Options) -> Result<(Child, String), String> {
    let endpoint = options.endpoint.trim_end_matches('/').to_string();
    let port = reqwest::Url::parse(&endpoint)
        .ok()
        .and_then(|url| url.port_or_known_default())
        .unwrap_or(9222);
    let port = pick_port(port);
    let profile_dir = options
        .user_data_dir
        .clone()
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("readerx-cdp-{}", std::process::id()))
        });
    std::fs::create_dir_all(&profile_dir)
        .map_err(|e| format!("创建浏览器用户数据目录失败: {e}"))?;
    let child = Command::new(binary)
        .arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg(format!("--user-agent={}", options.user_agent))
        .arg("about:blank")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动浏览器 {binary} 失败: {e}"))?;
    // UA 必须与书源请求一致（cf_clearance 绑定 UA），这里记下来供对照；Cookie 值不记
    log::debug!(
        "CDP 已拉起浏览器 binary={binary} port={port} profile={} ua={}",
        profile_dir.display(),
        options.user_agent
    );
    Ok((child, format!("http://127.0.0.1:{port}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_matching_is_host_scoped() {
        assert!(domain_hits(".example.com", "www.example.com"));
        assert!(domain_hits("cf.example.com", "cf.example.com"));
        assert!(domain_hits("", "example.com"));
        assert!(!domain_hits("example.com", "notexample.com"));
        assert!(!domain_hits("example.com", "example.com.evil.net"));
    }
}

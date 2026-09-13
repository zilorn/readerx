//! CLI 子命令：`auth` / `login`——浏览器标志与登录态。
//!
//! 三条建立登录态的路子：
//!
//! - `auth cookie`：导入浏览器导出的 Cookie（按书源站点过滤）；
//! - `auth webkit`：系统 WebKitGTK 里人工过挑战 / 登录；
//! - `auth cdp`：连已有 Chrome 的 DevTools 端口取 Cookie。
//!
//! 另有 `auth show` / `auth clear` 查看与清理。

use crate::auth::{self, AuthProvider};
use crate::cli::args::Cli;
use crate::cli::render as out;
use crate::cli::source::{
    apply_profile, apply_saved_profile, clear_login_state, count_cookies, load_source, profile_path,
    read_profile_cookies,
};
use crate::host::{self, ScopedCookie};
use crate::models::BookSource;
use crate::profile::Profile;
use crate::store;
use serde_json::json;
use std::sync::Arc;

// auth / login：浏览器标志与登录态
// ---------------------------------------------------------------------------

pub fn cmd_auth(cli: &Cli, provider: Option<Arc<dyn AuthProvider>>) -> Result<(), String> {
    let mode = if cli.command == "login" {
        "webkit".to_string()
    } else {
        cli.positionals
            .first()
            .cloned()
            .unwrap_or_else(|| "show".to_string())
    };
    let source = load_source(cli)?;
    host::prepare_source(&source)?;
    let session = host::SessionHandle::open(&source)?;

    match mode.as_str() {
        "cookie" => {
            if cli.profile.cookies.is_empty() && cli.profile.headers.iter().all(|(k, _)| k != "__raw_cookie__") {
                return Err(
                    "用法：auth cookie --cookie-file <Netscape|JSON> 或 --cookie '<k=v; …>'".to_string(),
                );
            }
            apply_profile(cli, &source, &session);
            let cookie_text = cli
                .profile
                .headers
                .iter()
                .filter(|(k, _)| k == "__raw_cookie__")
                .map(|(_, v)| v.clone())
                .collect::<Vec<String>>()
                .join("; ");
            let scoped = filter_cookies_for_source(cli, &source, &cli.profile.cookies);
            save_login_state(&source, &cookie_text, &scoped, cli, &session)?;
            Ok(())
        }
        "webkit" | "cdp" => {
            let provider = provider
                .ok_or_else(|| "认证后端已禁用（--auth none）".to_string())?;
            let url = login_url(cli, &source)?;
            // 显式指定了未编译进来的后端时，直接说清重建方式（比 CDP 连不上更好懂）
            if mode == "webkit" && !cfg!(feature = "webkit") {
                return Err(
                    "本二进制未编译 webkit 后端：请用 `cargo build -p readerx-source --features \"cli webkit\"` 重新构建（需要 webkit2gtk-4.1 开发包），或改用 --auth cdp"
                        .to_string(),
                );
            }
            if !provider.supported() {
                return Err(format!(
                    "认证后端不可用：{}",
                    if mode == "webkit" {
                        "没有可用的显示环境（无 DISPLAY / WAYLAND_DISPLAY）；无头环境请用 --auth cdp 连已有 Chrome"
                    } else {
                        "CDP 后端不可用"
                    }
                ));
            }
            if !cli.json {
                println!("打开浏览器认证：{url}");
                if mode == "webkit" {
                    println!("在弹出的窗口里完成登录 / 人机验证，然后点「完成」或直接关窗（最长 {} 秒）", cli.wait_secs);
                } else {
                    println!("在浏览器里完成登录 / 人机验证（最长 {} 秒）；完成后回车即取 Cookie", cli.wait_secs);
                }
            }
            let mut outcome = provider.authenticate(&source.id, &url)?;
            if let Err(err) = auth::persist_login_outcome(&source.id, &mut outcome) {
                eprintln!("readerx-source: 保存登录 Cookie 失败：{err}");
            }
            // 后端自己也会写盘，这里重新打开会话来读最新状态
            let session = host::SessionHandle::open(&source)?;
            if cli.json {
                out::print_json(&json!({
                    "source": source.id,
                    "backend": mode,
                    "ok": outcome.ok,
                    "url": outcome.url,
                    "count": outcome.count,
                    "message": outcome.message,
                    "scopedCookies": session.scoped_cookie_count(),
                }));
            } else if outcome.ok {
                println!(
                    "认证完成：捕获 {} 条 Cookie，已保存为该源登录态（后续 call / run 自动携带）",
                    outcome.count
                );
                if !outcome.message.trim().is_empty() {
                    println!("提示：{}", outcome.message);
                }
            } else {
                eprintln!("readerx-source: 认证未完成：{}", outcome.message);
                return Err("EXIT_FAILURE".to_string());
            }
            Ok(())
        }
        "show" => {
            let saved = store::read_login_cookie(&source.id)?;
            let profile_file = profile_path(&source.id);
            let profile_cookies = read_profile_cookies(&profile_file);
            // 与 `call` / `run` 完全同一套身份：先 CLI/身份文件，再已保存登录态。
            // 这里必须都套上，否则「show 出来的」和「请求真正带的」不是一回事
            apply_profile(cli, &source, &session);
            apply_saved_profile(cli, &source, &session);
            let headers = session.header_snapshot();
            let ua = effective_user_agent(&session);
            if cli.json {
                out::print_json(&json!({
                    "source": source.id,
                    "dataDir": store::data_root().display().to_string(),
                    "savedLogin": saved,
                    "savedProfile": if profile_file.is_file() {
                        profile_file.display().to_string()
                    } else {
                        String::new()
                    },
                    "savedScopedCookies": profile_cookies.len(),
                    "rawCookieLines": session.legacy_cookie_lines(),
                    "scopedCookies": session.scoped_cookie_names(),
                    "baseHeaders": headers
                        .into_iter()
                        .map(|(k, v)| json!({"name": k, "value": v}))
                        .collect::<Vec<_>>(),
                }));
            } else {
                println!("书源：{} [{}]", source.name, source.id);
                println!("数据目录：{}", store::data_root().display());
                match &saved {
                    Some(cookie) => println!("已保存登录态：{} 条（整行）", count_cookies(cookie)),
                    None => println!("已保存登录态：无整行 Cookie"),
                }
                if profile_file.is_file() {
                    println!(
                        "已保存登录态：{} 条（作用域，来自 {}）",
                        profile_cookies.len(),
                        profile_file.display()
                    );
                }
                if saved.is_none() && !profile_file.is_file() {
                    println!("（用 auth cookie / auth webkit / auth cdp 建立登录态）");
                }
                println!("请求将带上：");
                for (name, value) in headers {
                    println!("  {name}: {value}");
                }
                if ua != crate::profile::DEFAULT_UA && ua != source.user_agent.trim() {
                    println!("  （UA 来自 --profile / 已保存登录态）");
                }
                for name in session.scoped_cookie_names() {
                    println!("  Cookie {name}");
                }
            }
            Ok(())
        }
        "clear" => {
            // 登录态分两处落盘（整行 + 作用域），两处都要删干净——只删一处的话，
            // `call` / `run` / `auth show` 里的 apply_saved_profile 会把 profile 重新套回会话
            let cleared = clear_login_state(&source.id)?;
            // 「本次会话」也清干净：内存里的整行 / 作用域 Cookie 与会话 jar
            session.clear_cookies();
            if cli.json {
                out::print_json(&json!({
                    "source": source.id,
                    "removedCookies": cleared.total(),
                    "removedLegacyCookies": cleared.legacy_cookies,
                    "removedScopedCookies": cleared.scoped_cookies,
                    "removedFiles": cleared.removed_files,
                }));
            } else if cleared.is_empty() {
                println!("该书源本来就没有登录态（source_sessions / profiles 均无文件）");
            } else {
                println!(
                    "已清空该书源登录态：{} 条 Cookie（整行 {} + 作用域 {}），会话也已清空",
                    cleared.total(),
                    cleared.legacy_cookies,
                    cleared.scoped_cookies
                );
                for file in &cleared.removed_files {
                    println!("  已删除 {file}");
                }
            }
            Ok(())
        }
        other => Err(format!(
            "未知的 auth 方式 `{other}`（可选 cookie / webkit / cdp / show / clear）"
        )),
    }
}

/// 导入 Cookie 时按书源站点筛选。
///
/// 浏览器导出的 Cookie 文件往往包含**所有站点**的 Cookie（几百条），整份存进某个书源的
/// 登录态既无用又容易误发。这里按书源站点（host 及其父域）过滤；用户显式给了 `--url`
/// 就以它为准，`--url` 为空串则明确表示「整份都收」。
fn filter_cookies_for_source(
    cli: &Cli,
    source: &BookSource,
    cookies: &[ScopedCookie],
) -> Vec<ScopedCookie> {
    let selector = match cli.url.as_deref() {
        Some(url) => url.trim().to_string(),
        None => source.book_source_url.trim().to_string(),
    };
    if selector.is_empty() {
        return cookies.to_vec();
    }
    let Some(host) = reqwest::Url::parse(&selector)
        .ok()
        .and_then(|url| url.host_str().map(|h| h.to_string()))
    else {
        return cookies.to_vec();
    };
    let host = host.trim_start_matches("www.").to_ascii_lowercase();
    let kept: Vec<ScopedCookie> = cookies
        .iter()
        .filter(|cookie| {
            let domain = cookie.domain.trim_start_matches('.').to_ascii_lowercase();
            // 无域名的条目无法判断归属，保留（整行注入时仍受 sent 限制）
            domain.is_empty()
                || domain == host
                || host.ends_with(&format!(".{domain}"))
                || domain.ends_with(&format!(".{host}"))
        })
        .cloned()
        .collect();
    if kept.len() < cookies.len() && cli.verbose {
        eprintln!(
            "readerx-source: 按 {} 过滤 Cookie：{} → {} 条（用 --url <地址> 可换站点，--url '' 收全部）",
            host,
            cookies.len(),
            kept.len()
        );
    }
    kept
}

/// 认证地址：`--url` > 身份文件 auth_url > 书源主页
fn login_url(cli: &Cli, source: &BookSource) -> Result<String, String> {
    if let Some(url) = cli.url.clone().filter(|u| !u.trim().is_empty()) {
        return Ok(url.trim().to_string());
    }
    let from_profile = cli.profile.auth_url.trim().to_string();
    if !from_profile.is_empty() {
        return Ok(from_profile);
    }
    let url = source.book_source_url.trim();
    if url.is_empty() {
        return Err("书源没有 bookSourceUrl，请用 --url 指定认证地址".to_string());
    }
    Ok(url.to_string())
}

/// 把导入的浏览器 Cookie 保存为该源登录态：
/// - 无域名作用域的整行 Cookie 写进 `source_sessions/<id>.json`（与 App 同格式，App 也会用）；
/// - 带作用域的 Cookie 存到数据目录的 `profiles/<id>.json`，CLI 每次运行时套用。
fn save_login_state(
    source: &BookSource,
    raw_cookie_text: &str,
    scoped: &[ScopedCookie],
    cli: &Cli,
    session: &host::SessionHandle,
) -> Result<(), String> {
    let mut saved: Vec<String> = Vec::new();
    if !raw_cookie_text.trim().is_empty() {
        store::write_login_cookie(source.id.as_str(), &source.book_source_url, raw_cookie_text)?;
        saved.push(format!(
            "整行 Cookie 1 组（{} 条）",
            count_cookies(raw_cookie_text)
        ));
    }
    if !scoped.is_empty() {
        let path = profile_path(&source.id);
        let profile = Profile {
            name: format!("{} 登录态", source.name),
            // 只记「外部覆盖」的 UA（CLI --ua / 身份文件）：书源自带的 UA 留在书源里，
            // 复制进登录态会在之后盖住书源自身的修改
            user_agent: effective_user_agent_if_external(cli, session),
            headers: cli
                .profile
                .headers
                .iter()
                .filter(|(k, _)| k != "__raw_cookie__")
                .cloned()
                .collect(),
            cookies: scoped.to_vec(),
            auth_url: source.book_source_url.clone(),
        };
        profile.save(&path)?;
        saved.push(format!(
            "作用域 Cookie {} 条 → {}",
            scoped.len(),
            path.display()
        ));
    }
    if cli.json {
        out::print_json(&json!({"source": source.id, "saved": saved}));
    } else if saved.is_empty() {
        println!("没有可保存的 Cookie");
    } else {
        for line in saved {
            println!("已保存：{line}");
        }
        println!("后续 call / run 会自动套用（同名 Cookie 以最新导入为准）");
    }
    Ok(())
}

/// 会话当前生效的 UA：外部覆盖 > 书源自带 > 内置默认（与 `host::session_base_headers` 一致）
fn effective_user_agent(session: &host::SessionHandle) -> String {
    let (ua, _) = session.user_agent_state();
    if ua.trim().is_empty() {
        crate::profile::DEFAULT_UA.to_string()
    } else {
        ua
    }
}

/// 会话当前生效的 UA，**仅当它是外部覆盖**（CLI `--ua` / 身份文件）时返回；
/// 书源自带或内置默认返回空串（登录态里不必重复记录）。
fn effective_user_agent_if_external(cli: &Cli, session: &host::SessionHandle) -> String {
    if !cli.profile.user_agent.trim().is_empty() {
        return cli.profile.user_agent.trim().to_string();
    }
    let (ua, external) = session.user_agent_state();
    if external {
        ua
    } else {
        String::new()
    }
}

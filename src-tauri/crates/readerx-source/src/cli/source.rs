//! 书源装载、身份套用与入口函数调用——`call` / `run` / `test` / `auth` 共用的流水线。
//!
//! 与 App 内 `readerx_source_call` 保持同一行为：建会话 → 套身份（UA / 请求头 / Cookie）
//! → 播种已保存登录态 → 在 Boa 引擎里执行入口函数。

use crate::cli::args::{Cli, ENTRY_FUNCTIONS};
use crate::cli::render as out;
use crate::auth;
use crate::engine;
use crate::host;
use crate::models::{BookSource, SourceCallResult};
use crate::profile::Profile;
use crate::store;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// 装载并校验书源：`--source` 可以是 JSON 文件（含导出包）或已安装书源
pub fn load_source(cli: &Cli) -> Result<BookSource, String> {
    let selector = cli
        .source
        .as_deref()
        .ok_or_else(|| "缺少 --source <文件|id|名称>".to_string())?;
    let path = Path::new(selector);
    let source = if path.is_file() {
        load_source_file(path)?
    } else {
        store::resolve_source(selector)?
    };
    if source.id.trim().is_empty() {
        return Err(format!("书源「{}」没有 id", source.name));
    }
    if !store::valid_component(&source.id) {
        return Err(format!(
            "书源 id `{}` 不能用作文件名（只允许字母数字与 . _ -）",
            source.id
        ));
    }
    Ok(source)
}

/// 读取书源文件：单个书源对象、书源数组、或 `{ "sources": [...] }` 导出包。
/// 多书源时取第一个并提示——CLI 一次只跑一个源，选择器交给 `--source`。
pub fn load_source_file(path: &Path) -> Result<BookSource, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("读取书源文件 {} 失败: {e}", path.display()))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| format!("解析书源文件 {} 失败: {e}", path.display()))?;
    let list = value
        .get("sources")
        .and_then(|v| v.as_array())
        .cloned()
        .or_else(|| value.as_array().cloned());
    match list {
        Some(items) if !items.is_empty() => {
            let first = serde_json::from_value::<BookSource>(items[0].clone())
                .map_err(|e| format!("解析书源失败: {e}"))?;
            if items.len() > 1 {
                eprintln!(
                    "readerx-source: 文件里有 {} 个书源，只运行第一个「{}」（可用 --source <id> 指定已安装书源）",
                    items.len(),
                    first.name
                );
            }
            Ok(first)
        }
        Some(_) => Err(format!("书源文件 {} 里没有书源", path.display())),
        None => serde_json::from_value(value).map_err(|e| format!("解析书源失败: {e}")),
    }
}

/// 把身份（UA / 请求头 / Cookie）套到书源会话上。
///
/// 顺序：书源自带默认头 → CLI/身份文件的头 → 整行 Cookie → 作用域 Cookie。
/// 书源里已有的 `user-agent` / `cookie` 仍由会话基础头负责（见 host::session_base_headers），
/// 这里是**追加**，同名后者覆盖前者——即「命令行比书源优先级高」。
pub fn apply_profile(cli: &Cli, source: &BookSource, session: &host::SessionHandle) {
    let profile = &cli.profile;
    if !profile.user_agent.is_empty() {
        session.set_user_agent(&profile.user_agent);
    }
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut raw_cookies: Vec<String> = Vec::new();
    for (key, value) in &profile.headers {
        if key == "__raw_cookie__" {
            raw_cookies.push(value.clone());
        } else {
            headers.push((key.clone(), value.clone()));
        }
    }
    session.set_headers(&headers);
    for line in raw_cookies {
        host::http_set_cookie(&source.id, &line);
    }
    if !profile.cookies.is_empty() {
        let (added, replaced) = session.set_scoped_cookies(&profile.cookies);
        if cli.verbose {
            eprintln!(
                "readerx-source: 注入浏览器 Cookie {} 条（新增 {added}，覆盖 {replaced}）",
                profile.cookies.len()
            );
        }
    }
}

/// 执行一次入口函数（与 App 的 readerx_source_call 同一路径）
pub fn call_source(
    cli: &Cli,
    source: &BookSource,
    fn_name: &str,
    args: &Value,
) -> Result<SourceCallResult, String> {
    if !ENTRY_FUNCTIONS.contains(&fn_name) {
        return Err(format!(
            "不支持的入口函数 `{fn_name}`（可选：{}）",
            ENTRY_FUNCTIONS.join(" / ")
        ));
    }
    check_capability(source, fn_name)?;
    let budget = cli.timeout_ms.unwrap_or(if fn_name == "bookContent" {
        engine::DEFAULT_CHAPTER_BUDGET_MS
    } else {
        engine::DEFAULT_CALL_BUDGET_MS
    });
    engine::call_source_function(&source.id, &source.js, fn_name, args, budget)
}

/// 能力开关门控（与 App 一致：关掉的能力不允许调用）
pub fn check_capability(source: &BookSource, fn_name: &str) -> Result<(), String> {
    let caps = &source.capabilities;
    let enabled = match fn_name {
        "searchBook" => caps.search,
        "discoverBooks" | "discoverCategories" => caps.discover,
        "bookDetail" => caps.detail,
        "bookToc" => caps.toc,
        "bookContent" => caps.content,
        _ => true,
    };
    if !enabled {
        return Err(format!("书源「{}」已禁用「{fn_name}」能力", source.name));
    }
    Ok(())
}

/// 建会话 → 套身份 → 播种登录态 → 调用（call / test / run 共用）
pub fn prepare_and_call(
    cli: &Cli,
    source: &BookSource,
    fn_name: &str,
    args: &Value,
) -> Result<SourceCallResult, String> {
    if !source.enabled {
        return Err(format!("书源「{}」已禁用（enabled=false）", source.name));
    }
    host::prepare_source(source)?;
    let session = host::SessionHandle::open(source)?;
    apply_profile(cli, source, &session);
    // CLI 侧保存的登录态（auth cookie / auth webkit / auth cdp 的产物）
    apply_saved_profile(cli, source, &session);
    // 已保存的登录态（App 里网页登录过 / CLI auth 存过）自动注入，与 App 行为一致
    let seeded = auth::seed_source_session(&source.id)?;
    if cli.verbose {
        let ua = if cli.profile.user_agent.is_empty() {
            source.user_agent.clone()
        } else {
            cli.profile.user_agent.clone()
        };
        eprintln!(
            "readerx-source: 会话已就绪（UA {}，整行 Cookie {}，作用域 Cookie {}，已存登录态{}）",
            if ua.is_empty() { "内置默认" } else { ua.as_str() },
            session.legacy_cookie_lines().len(),
            session.scoped_cookie_count(),
            if seeded { "已注入" } else { "无" }
        );
    }
    call_source(cli, source, fn_name, args)
}

pub fn call_and_print(cli: &Cli, fn_name: &str, args: &Value) -> Result<(), String> {
    let source = load_source(cli)?;
    if !cli.json {
        println!("书源：{} [{}]", source.name, source.id);
        println!("函数：{fn_name}  参数：{}", compact(args));
    }
    let started = Instant::now();
    let result = prepare_and_call(cli, &source, fn_name, args)?;
    if cli.json {
        out::print_json(&json!({
            "source": {"id": source.id, "name": source.name},
            "fn": fn_name,
            "args": args,
            "ok": result.ok,
            "elapsedMs": result.elapsed_ms,
            "value": result.value,
            "error": result.error,
            "logs": result.logs,
        }));
    } else {
        if cli.verbose && !result.logs.is_empty() {
            println!("--- 日志（{}）---", result.logs.len());
            for line in &result.logs {
                println!("  {line}");
            }
        }
        match (&result.ok, &result.value, &result.error) {
            (true, Some(value), _) => out::print_value(value),
            (true, None, _) => println!("（返回空）"),
            (_, _, Some(error)) => eprintln!("readerx-source: 调用失败：{error}"),
            _ => println!("（失败：未返回原因）"),
        }
        println!("耗时 {} ms", started.elapsed().as_millis());
    }
    if !result.ok {
        // 失败由 main 统一收口成退出码（不在深层调用里直接 exit，便于编译成库时复用）
        return Err("EXIT_FAILURE".to_string());
    }
    Ok(())
}

/// JSON 单行化（打印参数 / 检查详情用）
pub fn compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

/// 每源登录态身份文件路径（有作用域 Cookie 时使用）
pub fn profile_path(source_id: &str) -> PathBuf {
    store::data_root()
        .join("profiles")
        .join(format!("{source_id}.json"))
}

/// Cookie 条数（`k=v; k2=v2` 文本里含等号的段数）
pub fn count_cookies(text: &str) -> usize {
    text.split(';').filter(|part| part.contains('=')).count()
}

/// 把已保存的登录态身份文件（`profiles/<源id>.json`）套用到会话。
///
/// `auth cookie` / `auth webkit` / `auth cdp` 的产物都落在这个文件里，
/// 每次 `call` / `run` / `auth show` 都按它补齐作用域 Cookie、请求头与 UA。
pub fn apply_saved_profile(cli: &Cli, source: &BookSource, session: &host::SessionHandle) {
    let path = profile_path(&source.id);
    if !path.is_file() {
        return;
    }
    match Profile::load(&path) {
        Ok(profile) => {
            if !profile.cookies.is_empty() {
                let (added, replaced) = session.set_scoped_cookies(&profile.cookies);
                if cli.verbose {
                    eprintln!(
                        "readerx-source: 套用已保存登录态（{} 条 Cookie：新增 {added}，覆盖 {replaced}）",
                        profile.cookies.len()
                    );
                }
            }
            if !profile.headers.is_empty() {
                session.set_headers(&profile.headers);
            }
            if !profile.user_agent.is_empty() && cli.profile.user_agent.is_empty() {
                session.set_user_agent(&profile.user_agent);
            }
        }
        Err(err) => eprintln!("readerx-source: 读取登录态 {} 失败：{err}", path.display()),
    }
}

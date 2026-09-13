//! 命令行参数解析（手写，零依赖：CLI 需要精确控制「哪些参数算全局」）。
//!
//! 全局参数（数据目录 / 书源 / 身份 / 认证 / 输出）**在子命令前后都可写**：
//!
//! ```text
//! readerx-source call --source demo.json searchBook '["关键词"]'
//! readerx-source --source demo.json call searchBook '["关键词"]'
//! ```
//!
//! 两种写法等价——参数按名字归位，不按位置。

use crate::profile::Profile;
use std::path::PathBuf;

pub const ENTRY_FUNCTIONS: &[&str] = &[
    "searchBook",
    "discoverBooks",
    "discoverCategories",
    "bookDetail",
    "bookToc",
    "bookContent",
];

/// 用法说明（`--help` 与参数错误时输出）
pub const USAGE: &str = r#"readerx-source —— ReaderX 书源引擎独立运行器

用法：
  readerx-source [全局参数] <命令> [命令参数]

命令：
  sources                          列出已安装书源（--data-dir 目录下）
  call   <函数> [参数JSON]          调用一个书源入口函数
  run    [关键词]                   端到端跑一遍：搜索 → 目录 → 正文
  test                             冒烟测试：JS 语法 / 入口函数 / 能力开关 / 参数构造
  auth   <方式>                     浏览器标志与登录态（cookie / webkit / cdp / clear / show）
  login  <url>                      打开网页登录（等价 auth webkit --url）

全局参数：
  --source <文件|id|名称>   书源：JSON 文件（含导出包）或已安装书源的 id / 名称
  --data-dir <目录>         数据目录（书源 + 登录态）；默认 $READERX_SOURCE_HOME
                            或 ~/.local/share/readerx-source；可与 App 共用
  --profile <文件>          浏览器身份 JSON（UA / 请求头 / Cookie 一起给）
  --ua <字符串>             覆盖 User-Agent（默认 Android Chrome，与内置一致）
  --header '<K: V>'         追加 / 覆盖一个默认请求头（可重复）
  --cookie '<k=v; …>'       追加整行 Cookie（无域名作用域，等同于书源自带 Cookie）
  --cookie-file <文件>     浏览器导出的 Cookie：Netscape / JSON / Cookie 头文本
  --auth <backend>          认证后端：auto / webkit / cdp / none（默认 auto）
  --cdp <url>               Chrome DevTools 地址，默认 http://127.0.0.1:9222
  --browser <路径>          浏览器可执行文件（--auth cdp 且未开调试端口时拉起它）
  --user-data-dir <目录>    拉起浏览器时使用的用户数据目录（默认临时目录，不动系统配置）
  --timeout <秒>            单次调用预算（默认 45；bookContent 默认 30）
  --concurrency <n>         正文并发（1-8，默认 3）
  --chapters <n>            run：最多拉多少章正文（默认 3；0 = 只跑目录）
  --json                    只输出 JSON（不打印进度与日志）
  --verbose                 打印书源 console 日志与请求细节
  -h, --help                显示本说明

认证方式（auth 子命令）：
  cookie   --cookie-file <文件> [--url <站点>]  导入浏览器 Cookie 并保存为该源登录态
                                             （默认按书源站点过滤；--url '' 收整份）
  webkit   [--url <地址>] [--wait <秒>]      用系统 WebKit 内核打开页面，人工过一次挑战
  cdp      [--url <地址>] [--wait <秒>]      连已有 Chrome（需 --remote-debugging-port）取 Cookie
  show                                        查看当前会话 / 已保存的登录态
  clear                                       清空该源登录态（文件 + 本次会话）

示例：
  readerx-source sources
  readerx-source --source ./demo.json test
  readerx-source --source demo call searchBook '["剑来"]' --verbose
  readerx-source --source demo run 剑来 --chapters 5 --json
  readerx-source --source demo auth cookie --cookie-file ~/cookies.txt
  readerx-source --source demo auth webkit --wait 180
  readerx-source --source demo auth cdp --cdp http://127.0.0.1:9222
"#;

/// 认证后端选择
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthKind {
    /// 按可用性自动挑：先 webkit（能开窗口时），否则 cdp
    Auto,
    Webkit,
    Cdp,
    None,
}

impl AuthKind {
    fn parse(text: &str) -> Result<Self, String> {
        match text.trim().to_ascii_lowercase().as_str() {
            "auto" => Ok(AuthKind::Auto),
            "webkit" => Ok(AuthKind::Webkit),
            "cdp" => Ok(AuthKind::Cdp),
            "none" | "off" => Ok(AuthKind::None),
            other => Err(format!("未知认证后端 `{other}`（可选 auto/webkit/cdp/none）")),
        }
    }
}

/// 命令行整体
#[derive(Debug, Clone)]
pub struct Cli {
    pub command: String,
    pub positionals: Vec<String>,
    pub source: Option<String>,
    pub data_dir: Option<PathBuf>,
    pub profile_file: Option<PathBuf>,
    pub profile: Profile,
    pub auth: AuthKind,
    pub cdp: Option<String>,
    pub browser: Option<String>,
    pub user_data_dir: Option<PathBuf>,
    pub timeout_ms: Option<u64>,
    pub concurrency: usize,
    pub chapters: usize,
    pub json: bool,
    pub verbose: bool,
    pub wait_secs: u64,
    pub url: Option<String>,
    pub clear_cookies: bool,
    pub batch: Option<PathBuf>,
}

impl Default for Cli {
    fn default() -> Self {
        Self {
            command: String::new(),
            positionals: Vec::new(),
            source: None,
            data_dir: None,
            profile_file: None,
            profile: Profile::default(),
            auth: AuthKind::Auto,
            cdp: None,
            browser: None,
            user_data_dir: None,
            timeout_ms: None,
            concurrency: 3,
            chapters: 3,
            json: false,
            verbose: false,
            wait_secs: 300,
            url: None,
            clear_cookies: false,
            batch: None,
        }
    }
}

/// 需要取值的长参数（用于「少给一个值」的友好报错）
const VALUE_FLAGS: &[&str] = &[
    "--source", "--data-dir", "--profile", "--ua", "--header", "--cookie", "--cookie-file",
    "--auth", "--cdp", "--browser", "--user-data-dir", "--timeout", "--concurrency", "--chapters",
    "--wait", "--url", "--batch",
];

impl Cli {
    /// 解析命令行；`-h/--help` 由调用方处理（返回 Err 时打印用法）
    pub fn parse(args: &[String]) -> Result<Self, String> {
        let mut cli = Cli::default();
        let mut iter = args.iter().peekable();
        let mut positionals: Vec<String> = Vec::new();
        while let Some(arg) = iter.next() {
            let arg = arg.as_str();
            // 取值的参数支持 `--flag value` 与 `--flag=value`
            let (flag, inline) = match arg.split_once('=') {
                Some((name, value)) if name.starts_with("--") => (name, Some(value.to_string())),
                _ => (arg, None),
            };
            let mut take_value = |name: &str| -> Result<String, String> {
                if let Some(value) = inline.clone() {
                    return Ok(value);
                }
                match iter.next() {
                    Some(value) => Ok(value.clone()),
                    None => Err(format!("参数 {name} 缺少取值")),
                }
            };
            match flag {
                "--source" | "-s" => cli.source = Some(take_value("--source")?),
                "--data-dir" => cli.data_dir = Some(PathBuf::from(take_value("--data-dir")?)),
                "--profile" => cli.profile_file = Some(PathBuf::from(take_value("--profile")?)),
                "--ua" | "--user-agent" => cli.profile.user_agent = take_value("--ua")?,
                "--header" => cli.profile.headers.push(split_header(&take_value("--header")?)?),
                "--cookie" => cli.profile.headers.push(("__raw_cookie__".to_string(), take_value("--cookie")?)),
                "--cookie-file" => {
                    let path = PathBuf::from(take_value("--cookie-file")?);
                    let (cookies, lines) = crate::profile::parse_cookie_file(&path)?;
                    cli.profile.cookies.extend(cookies);
                    for line in lines {
                        cli.profile
                            .headers
                            .push(("__raw_cookie__".to_string(), line));
                    }
                }
                "--auth" => cli.auth = AuthKind::parse(&take_value("--auth")?)?,
                "--cdp" => {
                    cli.cdp = Some(take_value("--cdp")?);
                    if cli.auth == AuthKind::Auto {
                        cli.auth = AuthKind::Cdp;
                    }
                }
                "--browser" => {
                    cli.browser = Some(take_value("--browser")?);
                    if cli.auth == AuthKind::Auto {
                        cli.auth = AuthKind::Cdp;
                    }
                }
                "--user-data-dir" => cli.user_data_dir = Some(PathBuf::from(take_value("--user-data-dir")?)),
                "--timeout" => {
                    let secs: f64 = take_value("--timeout")?
                        .parse()
                        .map_err(|_| "参数 --timeout 需要秒数（可为小数）".to_string())?;
                    if !(secs.is_finite() && secs > 0.0) {
                        return Err("参数 --timeout 必须是正数".to_string());
                    }
                    cli.timeout_ms = Some((secs * 1000.0) as u64);
                }
                "--concurrency" => {
                    cli.concurrency = take_value("--concurrency")?
                        .parse()
                        .map_err(|_| "参数 --concurrency 需要整数".to_string())?;
                    cli.concurrency = cli.concurrency.clamp(1, 8);
                }
                "--chapters" => {
                    cli.chapters = take_value("--chapters")?
                        .parse()
                        .map_err(|_| "参数 --chapters 需要整数".to_string())?;
                }
                "--wait" => {
                    cli.wait_secs = take_value("--wait")?
                        .parse()
                        .map_err(|_| "参数 --wait 需要秒数".to_string())?;
                }
                "--url" => cli.url = Some(take_value("--url")?),
                "--batch" => cli.batch = Some(PathBuf::from(take_value("--batch")?)),
                "--json" => cli.json = true,
                "--verbose" | "-v" => cli.verbose = true,
                "--clear-cookies" => cli.clear_cookies = true,
                // App 在「测试」面板调用本二进制时会带上自己的 API 地址；独立运行忽略
                "--app" | "--endpoint" => {
                    let _ = take_value(flag);
                }
                "-h" | "--help" => return Err(USAGE.to_string()),
                other if other.starts_with('-') && other.len() > 1 && other != "-" => {
                    let hint = if VALUE_FLAGS.contains(&other) {
                        format!("（{other} 需要一个取值）")
                    } else {
                        String::new()
                    };
                    return Err(format!("未知参数：{other}{hint}"));
                }
                other => positionals.push(other.to_string()),
            }
        }
        if positionals.is_empty() {
            return Err(USAGE.to_string());
        }
        cli.command = positionals.remove(0);
        cli.positionals = positionals;
        // 身份文件作为基底，命令行参数覆盖它
        if let Some(path) = cli.profile_file.clone() {
            let base = Profile::load(&path)?;
            cli.profile = merge_profile(base, cli.profile);
        }
        Ok(cli)
    }
}

/// 命令行覆盖身份文件（同名以命令行优先；Cookie 与请求头为追加）
fn merge_profile(base: Profile, cli: Profile) -> Profile {
    let mut merged = base;
    if !cli.user_agent.is_empty() {
        merged.user_agent = cli.user_agent;
    }
    for (key, value) in cli.headers {
        match merged.headers.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => merged.headers.push((key, value)),
        }
    }
    for cookie in cli.cookies {
        match merged.cookies.iter_mut().find(|existing| {
            existing.name == cookie.name && existing.domain.eq_ignore_ascii_case(&cookie.domain)
        }) {
            Some(slot) => *slot = cookie,
            None => merged.cookies.push(cookie),
        }
    }
    merged
}

/// `K: V` / `K=V` → (k, v)
fn split_header(text: &str) -> Result<(String, String), String> {
    let text = text.trim();
    let split = text
        .split_once(':')
        .or_else(|| text.split_once('='))
        .ok_or_else(|| format!("请求头 `{text}` 格式应为 '名字: 值'"))?;
    let key = split.0.trim();
    let value = split.1.trim();
    if key.is_empty() {
        return Err(format!("请求头 `{text}` 缺少名字"));
    }
    Ok((key.to_string(), value.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Cli {
        Cli::parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn global_flags_before_and_after_command() {
        let a = parse(&["--source", "demo", "call", "searchBook", "[\"x\"]"]);
        let b = parse(&["call", "--source", "demo", "searchBook", "[\"x\"]"]);
        assert_eq!(a.source, b.source);
        assert_eq!(a.command, "call");
        assert_eq!(a.positionals, vec!["searchBook", "[\"x\"]"]);
        let c = parse(&["call", "--source=demo", "searchBook"]);
        assert_eq!(c.source.as_deref(), Some("demo"));
    }

    #[test]
    fn cookie_header_goes_to_raw_lines() {
        let cli = parse(&["--cookie", "a=1; b=2", "sources"]);
        assert_eq!(cli.profile.headers[0].0, "__raw_cookie__");
        assert_eq!(cli.profile.headers[0].1, "a=1; b=2");
    }

    #[test]
    fn unknown_flag_is_reported() {
        let args = vec!["--nope".to_string(), "sources".to_string()];
        assert!(Cli::parse(&args).unwrap_err().contains("未知参数"));
    }
}

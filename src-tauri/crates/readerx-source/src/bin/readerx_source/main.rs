//! 书源引擎独立二进制（readerx-source）。
//!
//! 目标：**不启动 App 也能跑书源**——离线调试规则、批量验证站点、带登录态（浏览器
//! Cookie / 真实内核过 Cloudflare 挑战）复现线上问题。
//!
//! 引擎与 App 完全同一份代码（`readerx-source` crate 的 `engine` / `host`），
//! 因此这里跑通的结果与 App 内「测试」面板一致。

use std::sync::Arc;

use readerx_source::auth::{self, AuthProvider, LoginOutcome};
use readerx_source::cli::args::{AuthKind, Cli, USAGE};
use readerx_source::cli::{auth_cmd, commands};
use readerx_source::profile::DEFAULT_UA;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match run(&args) {
        Ok(()) => 0,
        Err(message) => {
            match message.as_str() {
                // 用法说明原样打印（没有「错误」前缀）
                usage if usage.starts_with("readerx-source ——") => {
                    println!("{usage}");
                    0
                }
                // 书源调用失败 / 认证未完成：原因已就地打印，这里只回退出码
                "EXIT_FAILURE" => 1,
                _ => {
                    eprintln!("readerx-source: {message}");
                    2
                }
            }
        }
    };
    std::process::exit(code);
}

fn run(args: &[String]) -> Result<(), String> {
    let mut cli = Cli::parse(args)?;
    // `READERX_DATA_DIR` 是给包装脚本用的便捷覆盖（优先级低于 --data-dir）
    if cli.data_dir.is_none() {
        if let Some(dir) = std::env::var_os("READERX_DATA_DIR").filter(|v| !v.is_empty()) {
            cli.data_dir = Some(std::path::PathBuf::from(dir));
        }
    }
    dispatch(cli)
}

fn dispatch(cli: Cli) -> Result<(), String> {
    // 数据根必须在任何 store 调用之前确定
    let root = cli
        .data_dir
        .clone()
        .unwrap_or_else(readerx_source::default_data_root);
    readerx_source::store::init_data_root(&root);

    match cli.command.as_str() {
        "sources" | "list" => commands::cmd_sources(&cli),
        "call" => commands::cmd_call(&cli),
        "run" => commands::cmd_run(&cli),
        "test" => commands::cmd_test(&cli),
        "auth" => auth_cmd::cmd_auth(&cli, install_auth_provider(&cli)),
        "login" => auth_cmd::cmd_auth(&cli, install_auth_provider(&cli)),
        other => Err(format!("未知命令 `{other}`\n\n{USAGE}")),
    }
}

/// 按 `--auth` 装配认证后端：
/// - `auto`：有显示环境就用 webkit 内核（最贴近真实浏览器），否则回落到 CDP；
/// - `webkit` / `cdp`：显式指定；需要时注册一个「不支持」的占位后端，
///   让书源调用拿到可读原因（而不是「后端尚未初始化」）。
fn install_auth_provider(cli: &Cli) -> Option<Arc<dyn AuthProvider>> {
    let provider: Arc<dyn AuthProvider> = match cli.auth {
        AuthKind::None => return None,
        AuthKind::Webkit => Arc::new(WebkitProvider::new(cli)),
        AuthKind::Cdp => Arc::new(CdpProvider::new(cli)),
        AuthKind::Auto => {
            if cfg!(feature = "webkit") && WebkitProvider::display_available() {
                Arc::new(WebkitProvider::new(cli))
            } else {
                Arc::new(CdpProvider::new(cli))
            }
        }
    };
    auth::install_provider(provider.clone());
    Some(provider)
}

// ---------------------------------------------------------------------------
// 认证后端适配（把 backend_* 的选项收进 cli）
// ---------------------------------------------------------------------------

#[cfg(feature = "webkit")]
struct WebkitProvider {
    wait_secs: u64,
    user_agent: String,
}

#[cfg(feature = "webkit")]
impl WebkitProvider {
    fn new(cli: &Cli) -> Self {
        Self {
            wait_secs: cli.wait_secs,
            user_agent: cli.profile.user_agent.clone(),
        }
    }

    /// 是否有可用显示（空串环境变量不算，判定逻辑与后端保持一致）
    fn display_available() -> bool {
        readerx_source::backend_webkit::display_available()
    }
}

#[cfg(feature = "webkit")]
impl AuthProvider for WebkitProvider {
    fn supported(&self) -> bool {
        Self::display_available()
    }

    fn authenticate(&self, source_id: &str, url: &str) -> Result<LoginOutcome, String> {
        readerx_source::backend_webkit::authenticate(source_id, url, self.wait_secs, &self.user_agent)
    }
}

#[cfg(not(feature = "webkit"))]
struct WebkitProvider;

#[cfg(not(feature = "webkit"))]
impl WebkitProvider {
    fn new(_cli: &Cli) -> Self {
        Self
    }

    fn display_available() -> bool {
        false
    }
}

#[cfg(not(feature = "webkit"))]
impl AuthProvider for WebkitProvider {
    fn supported(&self) -> bool {
        false
    }
    fn authenticate(&self, _source_id: &str, url: &str) -> Result<LoginOutcome, String> {
        Ok(LoginOutcome::failure(
            url,
            "本二进制未编译 webkit 后端（构建时加 --features webkit，需要 webkit2gtk-4.1 开发包）",
        ))
    }
}

#[cfg(feature = "cdp")]
struct CdpProvider {
    endpoint: String,
    browser: Option<String>,
    user_data_dir: Option<std::path::PathBuf>,
    wait_secs: u64,
    user_agent: String,
}

#[cfg(feature = "cdp")]
impl CdpProvider {
    fn new(cli: &Cli) -> Self {
        Self {
            endpoint: cli
                .cdp
                .clone()
                .unwrap_or_else(|| "http://127.0.0.1:9222".to_string()),
            browser: cli.browser.clone(),
            user_data_dir: cli.user_data_dir.clone(),
            wait_secs: cli.wait_secs,
            user_agent: cli.profile.user_agent.clone(),
        }
    }
}

#[cfg(feature = "cdp")]
impl AuthProvider for CdpProvider {
    fn supported(&self) -> bool {
        true
    }

    fn authenticate(&self, source_id: &str, url: &str) -> Result<LoginOutcome, String> {
        readerx_source::backend_cdp::authenticate(
            source_id,
            url,
            &readerx_source::backend_cdp::Options {
                endpoint: self.endpoint.clone(),
                browser: self.browser.clone(),
                user_data_dir: self.user_data_dir.clone(),
                wait_secs: self.wait_secs,
                user_agent: if self.user_agent.is_empty() {
                    DEFAULT_UA.to_string()
                } else {
                    self.user_agent.clone()
                },
                quiet: false,
            },
        )
    }
}

#[cfg(not(feature = "cdp"))]
struct CdpProvider;

#[cfg(not(feature = "cdp"))]
impl AuthProvider for CdpProvider {
    fn supported(&self) -> bool {
        false
    }
    fn authenticate(&self, _source_id: &str, url: &str) -> Result<LoginOutcome, String> {
        Ok(LoginOutcome::failure(url, "本二进制未编译 cdp 后端"))
    }
}

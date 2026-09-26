//! 独立二进制 `readerx-sync`：不启动 App 也能在两台机器上跑通局域网同步。
//!
//! 与 `readerx-source` 的 CLI 同样的定位：**用同一个 crate 的库代码**，
//! 只是把「建库 → 改数据 → 起服务 → 发现对端 → 同步 → 看冲突」串成命令行，
//! 便于在没有 App 接入的情况下验证协议与冲突语义（也便于真机联调）。
//!
//! 数据目录与库代码一致：`--data-dir` > `$READERX_SYNC_HOME` > 默认路径。
//! 输出分两路：**结果走标准输出**（便于脚本处理），日志走标准错误。
//!
//! ```text
//! readerx-sync --data-dir /tmp/a init --name 手机
//! readerx-sync --data-dir /tmp/a create book --set 'title=三体'
//! readerx-sync --data-dir /tmp/b init --name 台式机 --join '<配对码>'
//! readerx-sync --data-dir /tmp/b serve            # 终端 2
//! readerx-sync --data-dir /tmp/a sync 127.0.0.1:47821
//! readerx-sync --data-dir /tmp/a ls
//! ```

pub mod commands;
pub mod parse;

use std::path::PathBuf;
use std::time::Duration;

use crate::engine::{EngineOptions, SyncEngine};
use crate::error::{Result, SyncError};
use parse::Flags;

pub use parse::USAGE_TEXT;

/// 内部哨兵：`run` 返回它表示「该打印用法说明」
const USAGE_SENTINEL: &str = "__usage__";

/// 解析后的命令行。
#[derive(Clone, Debug)]
pub struct Cli {
    pub command: String,
    pub positional: Vec<String>,
    pub flags: Flags,
    pub data_dir: PathBuf,
    pub device_name: String,
}

/// 顶层入口：解析 → 执行 → 把错误变成可读消息。
pub fn main(args: &[String]) -> i32 {
    readerx_log::init(
        readerx_log::LogConfig::new("readerx-sync").with_level(if args.iter().any(|a| a == "--verbose") {
            "debug".to_string()
        } else {
            "warn".to_string()
        }),
    );
    let code = match run(args) {
        Ok(()) => 0,
        Err(message) => {
            if message == USAGE_SENTINEL {
                println!("{USAGE_TEXT}");
                0
            } else {
                eprintln!("{message}");
                2
            }
        }
    };
    if let Some(logger) = readerx_log::logger() {
        logger.flush();
    }
    code
}

fn run(args: &[String]) -> std::result::Result<(), String> {
    let cli = Cli::parse(args)?;
    commands::dispatch(&cli).map_err(|e| e.to_string())
}

impl Cli {
    /// 解析参数（全局参数可以写在子命令前后）。
    pub fn parse(args: &[String]) -> std::result::Result<Cli, String> {
        let (positional, flags) = parse::split(args)?;
        let mut iter = positional.into_iter();
        let command = match iter.next() {
            Some(command) => command,
            None => return Err(USAGE_SENTINEL.to_string()),
        };
        let rest: Vec<String> = iter.collect();

        let data_dir = flags
            .get("data-dir")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("READERX_SYNC_HOME")
                    .filter(|v| !v.is_empty())
                    .map(PathBuf::from)
            })
            .unwrap_or_else(crate::default_data_root);
        // 没给 --name 就用空串：SyncStore::open 会沿用已保存的设备名，
        // 而不是把用户起的名字冲掉（首次初始化时为空则用默认名）
        let device_name = flags.get("name").unwrap_or_default();

        Ok(Cli {
            command,
            positional: rest,
            data_dir,
            device_name,
            flags,
        })
    }

    /// 打开（必要时初始化）本机数据目录。
    pub fn open_engine(&self) -> Result<SyncEngine> {
        let mut options = EngineOptions::new(&self.device_name)
            .with_schemas(crate::SchemaRegistry::readerx_defaults());
        if self.flags.is_set("force-unlock") {
            options = options.force_unlock();
        }
        SyncEngine::open(&self.data_dir, options)
    }

    /// 只读打开（查看数据用：同步服务在跑时也能看）。
    pub fn open_engine_read_only(&self) -> Result<SyncEngine> {
        SyncEngine::open(
            &self.data_dir,
            EngineOptions::new(&self.device_name)
                .with_schemas(crate::SchemaRegistry::readerx_defaults())
                .read_only(),
        )
    }

    /// `--timeout`（秒）。
    pub fn timeout(&self) -> Duration {
        Duration::from_secs(self.flags.get_u64("timeout").unwrap_or(20))
    }

    /// `--discovery-port`。
    pub fn discovery_port(&self) -> u16 {
        self.flags
            .get_u64("discovery-port")
            .unwrap_or(crate::DEFAULT_DISCOVERY_PORT as u64) as u16
    }

    /// 取一个必填的位置参数。
    pub fn arg(&self, index: usize, what: &str) -> Result<String> {
        self.positional
            .get(index)
            .cloned()
            .ok_or_else(|| SyncError::Invalid(format!("缺少参数：{what}")))
    }
}

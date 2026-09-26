//! # readerx-sync —— ReaderX 局域网同步框架（**尚未接入 App 使用**）
//!
//! 目标：让同一个 ReaderX 的两台设备（手机 + 桌面）在**局域网内**直接互相同步，
//! 不需要云服务、不需要账号体系。这个 crate 只提供同步所需的地基与协议，
//! 不依赖 Tauri / GUI，也不改动 App 的任何现有行为（接入方式见 `docs/sync.md`）。
//!
//! ## 为什么不是「谁覆盖谁」
//!
//! 两台设备各自离线改数据，联网后互相推送——核心问题不是「谁的更新更新」，
//! 而是**先判断两次更新是否并发，再按数据类型语义合并**：
//!
//! 1. 全局唯一 id（[`id`]）：避免各自新增时主键撞车；
//! 2. 操作日志（[`model::Operation`]）而不是只存最终值：判断并发需要「改的时候看到了什么」；
//! 3. 版本向量（[`version`]）判断**是否并发**，混合逻辑时钟（[`hlc`]）解决时钟不准与回拨；
//! 4. 字段级合并（[`merge`]）：甲改书名、乙改简介不算冲突；
//! 5. 冲突显式化（[`model::Conflict`]）：不能自动裁决的进冲突队列，**不静默丢数据**；
//! 6. 幂等（op_id 去重）与墓碑删除（[`model::Tombstone`]）。
//!
//! ## 模块地图
//!
//! | 模块 | 职责 |
//! | --- | --- |
//! | [`id`] | ULID 生成与解析（时间有序、无需 uuid crate） |
//! | [`hlc`] | 混合逻辑时钟（本地事件 / 观察远端事件） |
//! | [`version`] | 版本向量：因果关系与增量同步游标 |
//! | [`model`] | 操作、实体、字段状态、墓碑、冲突的数据结构 |
//! | [`schema`] | 每种实体类型的字段合并策略与约束 |
//! | [`merge`] | 把一条操作并进实体，按字段策略裁决冲突 |
//! | [`order`] | 有序列表的位置键（分数索引） |
//! | [`store`] | 数据目录、JSONL 操作日志、快照与格式迁移 |
//! | [`engine`] | 门面：本地写入、应用远端操作、冲突队列、级联删除 |
//! | [`proto`] | 线协议消息（局域网对端之间的请求 / 响应） |
//! | [`session`] | 双向增量同步会话（版本向量求差、断点续传） |
//! | [`net`] | TCP 传输、HMAC 握手鉴权、UDP 广播发现 |
//!
//! ## 快速上手（框架自测 / CLI）
//!
//! ```no_run
//! use readerx_sync::{EngineOptions, SchemaRegistry, SyncEngine};
//!
//! # fn main() -> Result<(), readerx_sync::SyncError> {
//! let mut engine = SyncEngine::open(
//!     "/tmp/readerx-sync-demo",
//!     EngineOptions::new("手机").with_schemas(SchemaRegistry::readerx_defaults()),
//! )?;
//! let id = engine.create_entity("book", None, [("title", serde_json::json!("三体"))])?;
//! engine.set_field(&id, "title", serde_json::json!("三体（重制版）"))?;
//! engine.flush()?;
//! # Ok(())
//! # }
//! ```

#[cfg(feature = "cli")]
pub mod cli;
pub mod crypto;
pub mod engine;
pub mod error;
pub mod hlc;
pub mod id;
pub mod merge;
pub mod model;
pub mod net;
pub mod order;
pub mod proto;
pub mod schema;
pub mod session;
pub mod store;
pub mod version;

pub use engine::{ApplyResult, BatchOutcome, EngineOptions, EngineStatus, SyncEngine};
pub use error::{Result, SyncError};
pub use hlc::{Hlc, HlcClock};
pub use id::{new_id, Ulid};
pub use model::{
    Conflict, ConflictReason, ConflictStatus, Entity, FieldState, OpKind, Operation, Resolution,
    Tombstone,
};
pub use schema::{CascadeAction, CascadeRule, DeletePolicy, MergeKind, Schema, SchemaRegistry};
pub use proto::{Request, Response};
pub use session::{sync_with, sync_with_addr, SyncReport};
pub use store::{DeviceConfig, EntitySnapshot, PeerState, SyncStore, FORMAT_VERSION};
pub use version::{Relation, VersionVector};

/// 协议版本：握手时双方必须一致，否则拒绝同步（避免一边新语义一边旧语义）。
pub const PROTOCOL_VERSION: &str = "readerx-sync/1";

/// 本 crate 支持的 schema 版本上限；op 里带了更高版本说明对端更新，先缓冲不合并。
pub const SCHEMA_VERSION: u32 = 1;

/// 默认监听端口（局域网对端直连用；0 表示让系统分配）。
pub const DEFAULT_PORT: u16 = 47_821;

/// 默认发现端口（UDP 广播）。
pub const DEFAULT_DISCOVERY_PORT: u16 = 47_822;

/// 默认数据根：`$READERX_SYNC_HOME` > `$XDG_DATA_HOME/readerx-sync` > `~/.local/share/readerx-sync`。
///
/// 与书源引擎（`readerx-source`）同样的约定：App 接入时用应用数据目录调用
/// [`engine::SyncEngine::open`]，CLI 用 `--data-dir`，两边可以指向同一份数据。
pub fn default_data_root() -> std::path::PathBuf {
    if let Some(dir) = std::env::var_os("READERX_SYNC_HOME") {
        if !dir.is_empty() {
            return std::path::PathBuf::from(dir);
        }
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|v| !v.is_empty())
                .map(|home| std::path::PathBuf::from(home).join(".local/share"))
        })
        .unwrap_or_else(std::env::temp_dir);
    base.join("readerx-sync")
}

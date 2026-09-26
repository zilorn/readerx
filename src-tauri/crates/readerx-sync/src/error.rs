//! 统一错误类型。
//!
//! 全部是**可展示给用户 / 可写进日志**的字符串型错误：同步框架横跨磁盘、网络、
//! 协议三层，错误最终要么落进 `last_error` 供状态页展示，要么让一次同步整体失败并
//! 由调用方决定重试，因此区分「哪一层出错」比区分错误种类更有用。

use std::fmt;

/// 同步框架的错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    /// 磁盘 I/O（打开 / 读写 / 重命名）
    Io(String),
    /// 序列化 / 反序列化失败（多半意味着文件被外部改坏或格式版本不认识）
    Json(String),
    /// 找不到的对象（实体 / 冲突 / 设备）
    NotFound(String),
    /// 调用方给的数据非法（字段类型不匹配、id 为空等）
    Invalid(String),
    /// 违反 schema 约束（唯一键、不可变字段、级联阻止）
    Schema(String),
    /// 协议层错误（握手、帧格式、版本不匹配、重放）
    Protocol(String),
    /// 鉴权失败（群组不匹配、proof 错误、不在信任名单）
    Auth(String),
    /// 网络错误（连接、超时、对端提前关闭）
    Transport(String),
    /// 存储格式版本比本程序新，拒绝加载（防「旧程序写坏新数据」）
    Unsupported(String),
}

impl SyncError {
    /// 稳定的短标签，用于日志与状态展示（不进 i18n 词典，属于诊断信息）
    pub fn code(&self) -> &'static str {
        match self {
            SyncError::Io(_) => "io",
            SyncError::Json(_) => "json",
            SyncError::NotFound(_) => "not_found",
            SyncError::Invalid(_) => "invalid",
            SyncError::Schema(_) => "schema",
            SyncError::Protocol(_) => "protocol",
            SyncError::Auth(_) => "auth",
            SyncError::Transport(_) => "transport",
            SyncError::Unsupported(_) => "unsupported",
        }
    }

    /// 该错误是否值得立刻重试（网络抖动）还是应当退避
    pub fn is_transient(&self) -> bool {
        matches!(self, SyncError::Transport(_))
    }
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SyncError::Io(m) => write!(f, "磁盘错误：{m}"),
            SyncError::Json(m) => write!(f, "数据格式错误：{m}"),
            SyncError::NotFound(m) => write!(f, "找不到：{m}"),
            SyncError::Invalid(m) => write!(f, "参数非法：{m}"),
            SyncError::Schema(m) => write!(f, "schema 约束：{m}"),
            SyncError::Protocol(m) => write!(f, "协议错误：{m}"),
            SyncError::Auth(m) => write!(f, "鉴权失败：{m}"),
            SyncError::Transport(m) => write!(f, "网络错误：{m}"),
            SyncError::Unsupported(m) => write!(f, "版本不支持：{m}"),
        }
    }
}

impl std::error::Error for SyncError {}

impl From<std::io::Error> for SyncError {
    fn from(e: std::io::Error) -> Self {
        SyncError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for SyncError {
    fn from(e: serde_json::Error) -> Self {
        SyncError::Json(e.to_string())
    }
}

/// 同步框架的 `Result` 别名。
pub type Result<T> = std::result::Result<T, SyncError>;

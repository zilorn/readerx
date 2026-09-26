//! 统一错误类型。
//!
//! 全部是**可展示给用户 / 可写进日志**的字符串型错误：同步框架横跨磁盘、网络、
//! 协议三层，错误最终要么落进 `last_error` 供状态页展示，要么让一次同步整体失败并
//! 由调用方决定重试，因此区分「哪一层出错」比区分错误种类更有用。
//!
//! 少数错误还需要**跨进程稳定标识**（见 [`Code`]）：一条「群组不一致」要让界面补上
//! 「用配对码重新加入」这种可操作引导，而且换成英语界面也要说得清 —— 靠中文提示文本
//! 匹配是做不到的，因此这类错误以 `码|提示` 的形式承载（[`SyncError::coded`]）。

use std::fmt;

/// 需要稳定标识的错误码（错误串的 `码|提示` 前缀）。
///
/// 用途只有一个：**界面按码给出可操作的引导，并可翻译**。日志与调试读提示文本，
/// 前端读码翻文案（见 `src/lib/sync.ts` 的 `syncErrorText`）。
///
/// 握手阶段线协议上另有一份 [`crate::proto::HandshakeCode`]：对端拒绝时先把码发过来，
/// 本机再经 [`SyncError::from`] 落成 [`SyncError::Coded`]。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    /// 对端与本机不在同一个同步群组（配对码不同 / 有一台清空过同步数据）
    GroupMismatch,
    /// 对端把本机「删除设备」过，握手即拒（要显式重新接受）
    RemovedByPeer,
    /// 本机不在对端的信任名单里
    NotTrusted,
    /// 双方协议版本不一致（一台升级了）
    ProtocolMismatch,
    /// 对端连接数已满
    Busy,
    /// 群组密钥不对（proof 校验失败）
    AuthFailed,
    /// 对端消息不符合协议（期望 hello / auth 却收到别的）
    UnexpectedMessage,
    /// 数据格式版本比本程序新
    UnsupportedVersion,
    /// 对端报文读不出来（多半是连到了别的程序，不是 ReaderX）
    NotReaderx,
}

impl Code {
    /// 稳定短码（写进错误串、供前端映射文案）
    pub const fn as_str(self) -> &'static str {
        match self {
            Code::GroupMismatch => "group_mismatch",
            Code::RemovedByPeer => "removed_by_peer",
            Code::NotTrusted => "not_trusted",
            Code::ProtocolMismatch => "protocol_mismatch",
            Code::Busy => "busy",
            Code::AuthFailed => "auth_failed",
            Code::UnexpectedMessage => "unexpected_message",
            Code::UnsupportedVersion => "unsupported_version",
            Code::NotReaderx => "not_readerx",
        }
    }
}

/// 错误串里码与提示的分隔符（见 [`SyncError::coded`]）。
///
/// 只用一个 ASCII 竖线：中文提示、设备名与地址里都不会出现，前端 `split_once` 足够。
const CODE_SEPARATOR: char = '|';

/// 握手段由**对端**判定的失败原因（线协议上的 `code` 字段）。
///
/// 服务端拒绝时给出这个原因，客户端据此构造 [`SyncError::Coded`]；两端的字符串取值
/// 必须一致（见 [`crate::proto::HandshakeCode`] 与 `src/lib/sync.ts` 的 `SyncErrorCode`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireError {
    ProtocolMismatch,
    GroupMismatch,
    NotTrusted,
    RemovedByPeer,
    Busy,
    AuthFailed,
    Unexpected,
    Unsupported,
    NotReaderx,
}

impl WireError {
    /// 线上的稳定短码
    pub const fn as_str(self) -> &'static str {
        match self {
            WireError::ProtocolMismatch => "protocol_mismatch",
            WireError::GroupMismatch => "group_mismatch",
            WireError::NotTrusted => "not_trusted",
            WireError::RemovedByPeer => "removed_by_peer",
            WireError::Busy => "busy",
            WireError::AuthFailed => "auth_failed",
            WireError::Unexpected => "unexpected_message",
            WireError::Unsupported => "unsupported_version",
            WireError::NotReaderx => "not_readerx",
        }
    }

    /// 线上短码 → 错误码；不认识的码按「协议不符」处理（对端更新、本机还旧）
    pub fn from_wire(code: &str) -> WireError {
        match code {
            "protocol_mismatch" => WireError::ProtocolMismatch,
            "group_mismatch" => WireError::GroupMismatch,
            "not_trusted" => WireError::NotTrusted,
            "removed_by_peer" => WireError::RemovedByPeer,
            "busy" => WireError::Busy,
            "auth_failed" => WireError::AuthFailed,
            "unsupported_version" => WireError::Unsupported,
            "not_readerx" => WireError::NotReaderx,
            _ => WireError::Unexpected,
        }
    }

    /// 对应到内部错误码
    pub const fn to_code(self) -> Code {
        match self {
            WireError::ProtocolMismatch => Code::ProtocolMismatch,
            WireError::GroupMismatch => Code::GroupMismatch,
            WireError::NotTrusted => Code::NotTrusted,
            WireError::RemovedByPeer => Code::RemovedByPeer,
            WireError::Busy => Code::Busy,
            WireError::AuthFailed => Code::AuthFailed,
            WireError::Unexpected => Code::UnexpectedMessage,
            WireError::Unsupported => Code::UnsupportedVersion,
            WireError::NotReaderx => Code::NotReaderx,
        }
    }
}

impl From<WireError> for SyncError {
    /// 本地兜底提示：**界面按码出文案**（中英各一份），这里只是一句能看的排障文本，
    /// 因此不追求逐字对应，也不进 i18n 词典。
    fn from(error: WireError) -> Self {
        let hint = match error {
            WireError::ProtocolMismatch => "两台设备的同步协议版本不一致：把 ReaderX 升级到同一版本",
            WireError::GroupMismatch => "两台设备不在同一同步群组（配对码不同）",
            WireError::NotTrusted => "本机不在对端的信任名单里",
            WireError::RemovedByPeer => "本机已被对端从同步设备里移除",
            WireError::Busy => "对端同步连接数已满",
            WireError::AuthFailed => "群组密钥校验失败：两台设备的配对码不同",
            WireError::Unexpected => "对端返回了不符合协议的握手消息",
            WireError::Unsupported => "对端的数据格式版本比本程序新",
            WireError::NotReaderx => "对端不是 ReaderX 同步服务",
        };
        SyncError::coded(error.to_code(), hint)
    }
}

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
    /// 带稳定错误码的失败：展示给用户的是 `码|提示`（提示是给人看的兜底文本，
    /// 界面优先按码翻文案，见 `src/lib/sync.ts`）
    Coded(Code, String),
}

impl SyncError {
    /// 构造一条带稳定错误码的失败（提示里不要出现分隔符）。
    pub fn coded(code: Code, hint: impl Into<String>) -> SyncError {
        let hint = hint.into();
        debug_assert!(
            !hint.contains(CODE_SEPARATOR),
            "错误提示里不能出现分隔符 {CODE_SEPARATOR}：{hint}"
        );
        SyncError::Coded(code, hint)
    }

    /// 稳定的短标签，用于日志与状态展示。
    ///
    /// 带码的错误返回**码本身**（`group_mismatch` 这类），其余按「哪一层出错」归类；
    /// 都不进 i18n 词典 —— 这是诊断信息，不是界面文案。
    pub fn code(&self) -> String {
        match self {
            SyncError::Io(_) => "io".to_string(),
            SyncError::Json(_) => "json".to_string(),
            SyncError::NotFound(_) => "not_found".to_string(),
            SyncError::Invalid(_) => "invalid".to_string(),
            SyncError::Schema(_) => "schema".to_string(),
            SyncError::Protocol(_) => "protocol".to_string(),
            SyncError::Auth(_) => "auth".to_string(),
            SyncError::Transport(_) => "transport".to_string(),
            SyncError::Unsupported(_) => "unsupported".to_string(),
            SyncError::Coded(code, _) => code.as_str().to_string(),
        }
    }

    /// 该错误是否值得立刻重试（网络抖动）还是应当退避
    pub fn is_transient(&self) -> bool {
        matches!(self, SyncError::Transport(_))
    }

    /// 补一段诊断上下文（对端回了什么、本机版本是多少）。
    ///
    /// 只影响**日志与排障**：带码的错误在界面上是按码翻文案的，上下文不会顶掉那句
    /// 可操作的引导。
    pub fn with_context(self, context: impl AsRef<str>) -> SyncError {
        let context = context.as_ref();
        match self {
            SyncError::Coded(code, hint) => SyncError::Coded(code, format!("{hint}（{context}）")),
            SyncError::Protocol(message) => SyncError::Protocol(format!("{message}（{context}）")),
            other => other,
        }
    }

    /// 从 `码|提示` 里取码；没有前缀（老路径 / 纯提示）时回退成 [`Self::code`] 的归类。
    ///
    /// 给「错误在进程间只以字符串传递」的场合用（Tauri command 的 `Err(String)`）。
    pub fn code_of(text: &str) -> &str {
        match text.split_once(CODE_SEPARATOR) {
            Some((code, _)) if !code.is_empty() => code,
            _ => "unknown",
        }
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
            // 码在前、提示在后：界面按码翻文案，原始提示仍留给日志与排障
            SyncError::Coded(code, hint) => write!(f, "{}{CODE_SEPARATOR}{hint}", code.as_str()),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coded_errors_carry_the_code_in_front_of_the_hint() {
        let error = SyncError::coded(Code::GroupMismatch, "两台设备不在同一同步群组");
        assert_eq!(error.to_string(), "group_mismatch|两台设备不在同一同步群组");
        assert_eq!(error.code(), "group_mismatch");
        assert_eq!(SyncError::code_of(&error.to_string()), "group_mismatch");
    }

    #[test]
    fn plain_errors_keep_their_layer_label() {
        let error = SyncError::Auth("群组不一致".to_string());
        assert_eq!(error.code(), "auth");
        assert_eq!(error.to_string(), "鉴权失败：群组不一致");
        // 没有码前缀的文本不进「按码翻文案」那条路
        assert_eq!(SyncError::code_of("鉴权失败：群组不一致"), "unknown");
    }
}

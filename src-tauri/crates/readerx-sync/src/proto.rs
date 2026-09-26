//! 线协议：局域网对端之间的请求 / 响应消息。
//!
//! 帧格式（[`crate::net::frame`]）：`[u32 大端长度][JSON 消息]`，未鉴权前最大 256 KiB、
//! 鉴权后 16 MiB（批量操作）。消息本身用 serde 的 tag 形式，加字段对旧版本是兼容的
//! （未知字段被忽略），因此协议演进不需要额外握手协商——但 [`PROTOCOL_VERSION`]
//! 不一致仍然直接拒绝：语义变了（比如字段合并规则改了）不能靠忽略字段兜住。
//!
//! [`PROTOCOL_VERSION`]: crate::PROTOCOL_VERSION

use serde::{Deserialize, Serialize};

use crate::content::{BookDigest, ChapterContent, ChapterDigest};
use crate::id::{DeviceId, OpId};
use crate::model::Operation;
use crate::version::VersionVector;

/// 单帧上限（8 MiB）：一次 Push 的批量操作远小于它。
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// 握手阶段（还没鉴权）的单帧上限：只有短消息，给小的就够。
pub const MAX_HANDSHAKE_BYTES: usize = 64 * 1024;

/// 一次 Pull / Push 的默认批量条数。
pub const DEFAULT_BATCH: usize = 200;

/// 一批正文的字节上限（协议帧上限 8 MiB，留出 JSON 包装与其它字段的余量）。
/// 两端都用它装箱：客户端决定推多少、服务端决定回多少。
pub const CONTENT_BATCH_BYTES: usize = 4 * 1024 * 1024;

/// 一批正文最多几章（避免一堆极短章节把 JSON 数组本身撑大）。
pub const CONTENT_BATCH_CHAPTERS: usize = 100;

/// 客户端 → 服务端。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    /// 打招呼：协议版本、群组、设备身份、我方已知版本、随机数
    Hello {
        protocol: String,
        group: String,
        device: DeviceId,
        name: String,
        knowledge: VersionVector,
        nonce: String,
        /// 本机同步服务的**监听端口**；`0` = 本机没有在监听。
        ///
        /// 对端据此记住「怎么主动连回来」。**不能用 TCP 连接的源端口**：那是内核
        /// 临时分配的，连接一断就回收，拿它当地址会让对方下次连到一个不存在的服务。
        /// `default` 让不带该字段的旧对端仍能握手（按「没在监听」处理）。
        #[serde(default)]
        port: u16,
        /// 本机是否参与**正文**同步（注册了正文来源）。
        ///
        /// 缺字段的旧对端按 `false` 处理：新版本因此既不会向旧版本发起正文对账
        /// （它会把未知请求当协议错误断连接），也不会收到旧版本发来的正文请求 ——
        /// 版本不一致时数据照旧同步，只是正文这条通道不启用。
        #[serde(default)]
        content: bool,
    },
    /// 鉴权应答：`proof = HMAC(密钥, 握手文本)`
    Auth { proof: String },
    /// 拉取：我缺 `since` 之后的操作
    Pull { since: VersionVector, limit: usize },
    /// 推送：我这边有你缺的操作
    Push { ops: Vec<Operation> },
    /// 正文对账：这是我的逐本总览（先比总量，没必要为每本没变的书都传清单）
    ContentIndex { books: Vec<BookDigest> },
    /// 正文对账：某本书的逐章指纹
    ChapterDigests { book: String },
    /// 推正文：这几章的正文给你
    PushChapters { book: String, items: Vec<ChapterContent> },
    /// 拉正文：把这几章的正文给我
    PullChapters { book: String, cids: Vec<String> },
    /// 查询对端状态（CLI `discover` / 状态页用）
    Stat,
    Ping,
}

impl Request {
    /// 短标签（日志用）。
    pub fn kind(&self) -> &'static str {
        match self {
            Request::Hello { .. } => "hello",
            Request::Auth { .. } => "auth",
            Request::Pull { .. } => "pull",
            Request::Push { .. } => "push",
            Request::ContentIndex { .. } => "content_index",
            Request::ChapterDigests { .. } => "chapter_digests",
            Request::PushChapters { .. } => "push_chapters",
            Request::PullChapters { .. } => "pull_chapters",
            Request::Stat => "stat",
            Request::Ping => "ping",
        }
    }
}

/// 服务端 → 客户端。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    /// 对 Hello 的回应（`ok=false` 时带上原因，随后连接关闭）
    Hello {
        ok: bool,
        protocol: String,
        group: String,
        device: DeviceId,
        name: String,
        nonce: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        /// 拒绝原因码（见 [`HandshakeCode`]）；旧对端不带该字段，按纯提示文本处理
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        /// 本机是否参与正文同步（与 [`Request::Hello`] 同一口径；旧对端缺字段 = false）
        #[serde(default)]
        content: bool,
    },
    /// 对 Auth 的回应（含服务端自己的 proof，做双向认证）
    Auth {
        ok: bool,
        proof: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        /// 拒绝原因码（`ok=false` 时用）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    /// Pull 的应答：一批操作 + 服务端已知版本 + 是否还有
    Ops {
        ops: Vec<Operation>,
        knowledge: VersionVector,
        has_more: bool,
    },
    /// Push 的应答
    Ack {
        accepted: usize,
        #[serde(default)]
        rejected: Vec<RejectedOp>,
        /// 本次应用新产生的冲突条数
        #[serde(default)]
        conflicts: usize,
        /// 应用之后的版本（客户端据此继续发下一批）
        knowledge: VersionVector,
    },
    /// 对端状态
    Stat {
        device: DeviceId,
        name: String,
        protocol: String,
        entities: u64,
        ops: u64,
        conflicts: u64,
        pending_conflicts: u64,
        knowledge: VersionVector,
    },
    /// 正文对账的应答：本机对这几本书的逐本总览（只回本机有正文的那些书）
    ContentIndex { books: Vec<BookDigest> },
    /// 某本书的逐章指纹。`known` = 本机有这本书（没有时对端不该把正文推过来：
    /// 推过来也无处可落）
    ChapterDigests {
        book: String,
        #[serde(default)]
        known: bool,
        chapters: Vec<ChapterDigest>,
    },
    /// 拉正文的应答：按帧预算装得下的章节（装不下的下次同步再来）
    Chapters { book: String, items: Vec<ChapterContent> },
    /// 推正文的应答
    ContentAck {
        /// 真正写进暂存区的章数（内容重复的章节不算）
        stored: usize,
    },
    Pong {
        at_ms: u64,
    },
    Error {
        code: String,
        message: String,
    },
}

impl Response {
    /// 短标签（日志用）。
    pub fn kind(&self) -> &'static str {
        match self {
            Response::Hello { .. } => "hello",
            Response::Auth { .. } => "auth",
            Response::Ops { .. } => "ops",
            Response::Ack { .. } => "ack",
            Response::Stat { .. } => "stat",
            Response::ContentIndex { .. } => "content_index",
            Response::ChapterDigests { .. } => "chapter_digests",
            Response::Chapters { .. } => "chapters",
            Response::ContentAck { .. } => "content_ack",
            Response::Pong { .. } => "pong",
            Response::Error { .. } => "error",
        }
    }

    /// 构造一条错误响应。
    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Response {
        Response::Error { code: code.into(), message: message.into() }
    }
}

/// 握手被拒绝的原因码。
///
/// 握手是**唯一**会跨进程传「为什么拒绝」的地方，而拒绝理由直接决定用户下一步做什么
/// （换配对码 / 重新接受设备 / 升级程序），因此这些码属于线协议的一部分：
/// 两端各自按码出文案，不靠中文提示互相对齐（见 [`crate::error::Code`]）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandshakeCode {
    ProtocolMismatch,
    GroupMismatch,
    NotTrusted,
    RemovedByPeer,
    Busy,
    AuthFailed,
    Unexpected,
}

impl HandshakeCode {
    /// 线上的稳定短码
    pub const fn as_str(self) -> &'static str {
        match self {
            HandshakeCode::ProtocolMismatch => "protocol_mismatch",
            HandshakeCode::GroupMismatch => "group_mismatch",
            HandshakeCode::NotTrusted => "not_trusted",
            HandshakeCode::RemovedByPeer => "removed_by_peer",
            HandshakeCode::Busy => "busy",
            HandshakeCode::AuthFailed => "auth_failed",
            HandshakeCode::Unexpected => "unexpected_message",
        }
    }
}

/// 被拒绝的单条操作。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RejectedOp {
    pub op_id: OpId,
    /// [`crate::merge::Rejection::code`] 或 `schema_too_new`
    pub code: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hlc::Hlc;
    use crate::id::new_id;
    use crate::model::OpKind;

    #[test]
    fn request_json_roundtrip() {
        let request = Request::Pull {
            since: VersionVector::from_pairs([("A", 3)]),
            limit: DEFAULT_BATCH,
        };
        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains("\"type\":\"pull\""));
        assert_eq!(serde_json::from_str::<Request>(&json).unwrap(), request);
    }

    #[test]
    fn push_roundtrip_with_ops() {
        let op = Operation {
            op_id: new_id(),
            origin: "A".into(),
            seq: 1,
            hlc: Hlc::new(1, 0, "A"),
            entity_id: "book-1".into(),
            kind: "book".into(),
            field: "title".into(),
            op: OpKind::Set { value: serde_json::json!("三体") },
            base: VersionVector::new(),
            schema_ver: 1,
            at_ms: 1,
        };
        let request = Request::Push { ops: vec![op] };
        let json = serde_json::to_string(&request).unwrap();
        assert_eq!(serde_json::from_str::<Request>(&json).unwrap(), request);
    }

    #[test]
    fn unknown_fields_are_ignored_for_forward_compat() {
        // 新版本多带一个字段：旧版本必须还能解析（协议演进靠这个）
        let json = r#"{"type":"ping","future_field":42}"#;
        assert_eq!(serde_json::from_str::<Request>(json).unwrap(), Request::Ping);
    }

    #[test]
    fn kind_labels_are_stable() {
        assert_eq!(Request::Stat.kind(), "stat");
        assert_eq!(Response::error("x", "y").kind(), "error");
    }
}

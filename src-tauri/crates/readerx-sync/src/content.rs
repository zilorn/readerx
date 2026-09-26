//! 正文（书籍正文）通道：**指纹对账 + 按章搬运**，与操作日志分开走。
//!
//! 为什么不把正文塞进操作日志 / 实体快照：那是「一行一条 JSON、每次 flush 整份重写」
//! 的存储，一本几百 MB 的书会让操作日志与快照各膨胀一份，每翻一页都要重写一遍。
//! 因此正文只借鉴引擎的**版本向量思路**：两边各算一份「我有哪些章、指纹是什么」，
//! 差集就是要搬的东西。
//!
//! ```text
//! 本机：ContentSource（App 读 books/<id>/content.json）+ 暂存区（对端刚发来、还没落地）
//! 对端：同样一份摘要
//! → 只搬「对端没有」或「两边指纹不同（按设备 id 定胜负）」的章节
//! ```
//!
//! 收到的正文先落在**暂存区**（`<同步目录>/content/<书实体 id>/`），由宿主在下一次
//! 落地时写进书库 —— 引擎不认识 App 的书库布局，也不该替它决定怎么建书。
//!
//! 指纹只覆盖**正文**（段落与结构化块），不含标题 / 地址 / 字数：那些是目录（结构）
//! 实体的职责，改标题不该触发一次正文重传。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// 一章正文。`blocks` 对引擎是不透明的 JSON（App 的结构化正文块），原样透传 ——
/// 引擎不需要理解标题 / 插图这些业务字段，只需要能算指纹、能存能取。
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChapterContent {
    pub cid: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub paragraphs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Value>,
}

impl ChapterContent {
    /// 这一章是否**真的有正文**（空章节不参与正文同步：没有东西可搬）。
    pub fn has_body(&self) -> bool {
        self.paragraphs.iter().any(|text| !text.trim().is_empty())
            || self.blocks.as_ref().is_some_and(has_content)
    }

    /// 正文指纹（不含标题 / 地址）：两台设备对同一段正文算出同一个值。
    pub fn fingerprint(&self) -> String {
        body_fingerprint(&self.paragraphs, self.blocks.as_ref())
    }

    /// 正文的粗略字节量（会话预算用；不追求精确，够用来限流即可）。
    pub fn body_bytes(&self) -> u64 {
        let paragraphs: usize = self.paragraphs.iter().map(|text| text.len() + 1).sum();
        let blocks = self
            .blocks
            .as_ref()
            .map(|value| serde_json::to_string(value).map(|text| text.len()).unwrap_or(0))
            .unwrap_or(0);
        (paragraphs + blocks) as u64
    }
}

/// 结构化块里是否有真正的正文（`img` 之类的纯图片块不算）。
fn has_content(blocks: &Value) -> bool {
    match blocks {
        Value::Array(items) => items.iter().any(has_content),
        Value::Object(map) => map
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty()),
        _ => false,
    }
}

/// 正文指纹：`sha256(段落 ‖ 规范化 JSON(结构化块))`。
///
/// 结构化块先做**规范化**（对象键排序）再序列化：两台设备上同一份块只要内容相同，
/// 哪怕键的书写顺序不同也能算出同一个指纹，否则会一直误判成「正文不一样」而反复重传。
pub fn body_fingerprint(paragraphs: &[String], blocks: Option<&Value>) -> String {
    let mut hasher = Sha256::new();
    for paragraph in paragraphs {
        hasher.update(paragraph.as_bytes());
        hasher.update([0u8]);
    }
    hasher.update([1u8]);
    if let Some(blocks) = blocks {
        hasher.update(canonical_json(blocks).as_bytes());
    }
    hex(&hasher.finalize())
}

/// 规范化 JSON：对象键排序、去掉无意义的空白，便于跨设备比较。
fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = String::from("{");
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push(':');
                out.push_str(&canonical_json(&map[*key]));
            }
            out.push('}');
            out
        }
        Value::Array(items) => {
            let mut out = String::from("[");
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&canonical_json(item));
            }
            out.push(']');
            out
        }
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 一章正文的摘要（对账用）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterDigest {
    pub cid: String,
    /// 正文指纹（见 [`body_fingerprint`]）；空串 = 本机没有这一章的正文
    #[serde(default)]
    pub hash: String,
}

/// 一本书的正文总览：先比一个数，避免为每本书都传逐章清单。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookDigest {
    /// 书实体 id
    pub book: String,
    /// 有正文的章节数
    #[serde(default)]
    pub chapters: u32,
    /// 逐章指纹的汇总（cid + hash 排序后哈希）
    #[serde(default)]
    pub digest: String,
}

/// 一本书的逐章指纹 → 汇总（顺序无关：按 cid 排序后再算）。
pub fn book_digest(book: &str, chapters: &[ChapterDigest]) -> BookDigest {
    let mut items: Vec<&ChapterDigest> = chapters
        .iter()
        .filter(|chapter| !chapter.hash.is_empty())
        .collect();
    items.sort_by(|a, b| a.cid.cmp(&b.cid));
    let mut hasher = Sha256::new();
    hasher.update(book.as_bytes());
    for chapter in &items {
        hasher.update(chapter.cid.as_bytes());
        hasher.update([0u8]);
        hasher.update(chapter.hash.as_bytes());
        hasher.update([0u8]);
    }
    BookDigest {
        book: book.to_string(),
        chapters: items.len() as u32,
        digest: hex(&hasher.finalize()),
    }
}

/// 宿主提供的正文来源（App 实现：读 `books/<id>/content.json`，只读）。
///
/// 引擎不问「正文存在哪」，只问「有哪些章、拿一章的正文给我」；CLI 没有书库，
/// 注册为空实现即可（能力协商见 [`crate::net::PeerInfo::content`]）。
pub trait ContentSource: Send + Sync + 'static {
    /// 某本书本机**有正文**的章节摘要。
    fn digests(&self, book: &str) -> Vec<ChapterDigest>;

    /// 取若干章的正文（对端要的、或本机要推的）。取不到的章节直接不出现在结果里。
    fn load(&self, book: &str, cids: &[String]) -> Vec<ChapterContent>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chapter(cid: &str, text: &str) -> ChapterContent {
        ChapterContent {
            cid: cid.to_string(),
            title: format!("第{cid}章"),
            url: None,
            paragraphs: vec![text.to_string()],
            blocks: None,
        }
    }

    #[test]
    fn fingerprint_covers_body_not_title() {
        let a = chapter("c0001", "正文");
        let mut b = a.clone();
        b.title = "改过的标题".to_string();
        b.url = Some("https://example.com/1".to_string());
        assert_eq!(a.fingerprint(), b.fingerprint(), "标题 / 地址不参与正文指纹");

        let c = chapter("c0001", "另一段正文");
        assert_ne!(a.fingerprint(), c.fingerprint());
        // cid 也不参与：同一段正文换到别的章号，指纹一致（内容才是身份）
        let d = chapter("c0002", "正文");
        assert_eq!(a.fingerprint(), d.fingerprint());
    }

    #[test]
    fn fingerprint_is_key_order_insensitive_for_blocks() {
        let one = ChapterContent {
            cid: "c1".into(),
            title: String::new(),
            url: None,
            paragraphs: vec![],
            blocks: Some(json!([{ "kind": "p", "text": "正文" }])),
        };
        let two = ChapterContent {
            blocks: Some(json!([{ "text": "正文", "kind": "p" }])),
            ..one.clone()
        };
        assert_eq!(one.fingerprint(), two.fingerprint(), "键序不同不该算两段正文");
        assert!(one.has_body());
    }

    #[test]
    fn empty_or_image_only_chapters_have_no_body() {
        assert!(!chapter("c1", "").has_body());
        let empty = ChapterContent::default();
        assert!(!empty.has_body());
        let image_only = ChapterContent {
            cid: "c1".into(),
            paragraphs: vec![],
            blocks: Some(json!([{ "kind": "img", "src": "https://example.com/a.png" }])),
            ..ChapterContent::default()
        };
        assert!(!image_only.has_body(), "纯图片块不算正文");
    }

    #[test]
    fn book_digest_ignores_order_and_empty_chapters() {
        let one = vec![
            ChapterDigest { cid: "c0001".into(), hash: "aa".into() },
            ChapterDigest { cid: "c0002".into(), hash: "bb".into() },
            ChapterDigest { cid: "c0003".into(), hash: String::new() },
        ];
        let two = vec![
            ChapterDigest { cid: "c0003".into(), hash: String::new() },
            ChapterDigest { cid: "c0002".into(), hash: "bb".into() },
            ChapterDigest { cid: "c0001".into(), hash: "aa".into() },
        ];
        let a = book_digest("b-1", &one);
        assert_eq!(a, book_digest("b-1", &two));
        assert_eq!(a.chapters, 2, "没有正文的章节不计入");
        assert_ne!(a, book_digest("b-2", &one), "书不同，汇总值不同");
        let changed = vec![
            ChapterDigest { cid: "c0001".into(), hash: "aa".into() },
            ChapterDigest { cid: "c0002".into(), hash: "cc".into() },
        ];
        assert_ne!(a, book_digest("b-1", &changed));
    }
}

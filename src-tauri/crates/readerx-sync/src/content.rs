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
//!
//! 二进制资源（封面 / 章节插图）走同一层里的 [`crate::assets`]：它们连「一章一份 JSON」
//! 都不适合，因此只共用这里的「指纹对账 + 按需搬运」思路与书实体 id 口径。

use base64::Engine;
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

/// 结构化块里是否有可阅读内容：文字与图片引用都算，扫描 PDF / 漫画也需要搬运。
fn has_content(blocks: &Value) -> bool {
    match blocks {
        Value::Array(items) => items.iter().any(has_content),
        Value::Object(map) => map
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
            || (map.get("kind").and_then(Value::as_str) == Some("img")
                && ["local", "src", "remote"].iter().any(|key| {
                    map.get(*key).and_then(Value::as_str).is_some_and(|v| !v.trim().is_empty())
                }))
            || map.get("imgs").is_some_and(has_content),
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

// ---------------------------------------------------------------------------
// 章节插图：设备无关的资源名
//
// 插图字节存在宿主自己的目录里，章节块只留一个文件引用。**这个引用是跨设备传输的**
// （它在正文块里），因此它必须是设备无关的：本机书 id 进不了名字，否则两台设备对
// 同一段正文算出两个指纹，正文通道会一直认为「两边正文不一样」而反复重传。
//
//   identity = 插图地址（`remote`，旧数据用 data URL 自身）
//   name     = sha256(identity) 前 40 位 hex + 扩展名
//
// 主机用同一个 name 定位本地文件（见 `ContentSource::resolve_asset` 的实际实现），
// 于是「正文里的引用」与「资源通道里的名字」是同一个字符串，落地时不需要额外翻译。
// ---------------------------------------------------------------------------

/// 插图地址 → 设备无关的资源名（`<sha1(地址)>.<ext>`）。
///
/// 用 **sha1** 是为了与 App 落盘的文件名同一套：资源名就是本地副本的文件名
/// （`images/<资源名>`），旧数据里的 `<本机书 id>_<sha1>.<ext>` 只要剥掉前缀就归一到它，
/// 不需要重新下载或改名以外的任何换算。
///
/// `ext` 是**地址上的扩展名**（不带点）：同一张图在两台设备上从同一个地址推导出
/// 同一个扩展名，因此名字一致；认不出来时留空，两端也一样。
pub fn image_asset_name(identity: &str) -> String {
    // 查询串 / 片段先剥掉：同一张图常带不同的追踪参数，不该被当成两张
    let path = identity.split(['?', '#']).next().unwrap_or(identity);
    let (ext, key) = match image_ext(path) {
        Some(ext) => {
            // 扩展名大小写不参与身份（`B.JPG` 与 `B.jpg` 是同一张图）：
            // 哈希输入换成小写扩展名，长度与路径一致，不会与别的地址撞
            let stem = &path[..path.len() - ext.len()];
            (ext.clone(), format!("{stem}{ext}"))
        }
        None => (String::new(), path.to_string()),
    };
    let hash = sha1_hex(key.as_bytes());
    if ext.is_empty() {
        hash
    } else {
        format!("{hash}.{ext}")
    }
}

/// sha1 十六进制（40 位小写）——图片名字用的哈希（与 App 侧 `host::sha1_hex` 同口径）。
fn sha1_hex(bytes: &[u8]) -> String {
    use sha1::{Digest as _, Sha1};
    let digest = Sha1::digest(bytes);
    let mut out = String::with_capacity(40);
    for byte in digest.iter() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 地址里认得出的图片扩展名（小写、不含点）。
fn image_ext(path: &str) -> Option<String> {
    let ext = path.rsplit_once('.')?.1.to_ascii_lowercase();
    if ext.is_empty() || ext.len() > 5 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext)
}

/// 一个资源引用映射出的身份与资源名。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetRef {
    /// 资源名（[`image_asset_name`] 的结果）
    pub name: String,
    /// 身份（在线图是地址；旧数据是 data URL 自身）
    pub identity: String,
}

/// 一个章节块里的图片引用 → 资源引用（不是图片 / 认不出身份时返回 `None`）。
///
/// 块是宿主的结构化正文（引擎不认识业务字段，只按约定取 `kind` / `remote` / `src`）：
/// 整行图是 `{"kind":"img",…}`，段内插图是 `imgs` 数组里与它同口径的对象。
fn asset_ref_of(block: &Value, inline: bool) -> Option<AssetRef> {
    if !inline && block.get("kind").and_then(Value::as_str) != Some("img") {
        return None;
    }
    let text = |key: &str| block.get(key).and_then(Value::as_str).filter(|v| !v.is_empty());
    // 身份优先取网络地址：它有内容以外的语义（旧数据里 src 可能只是 data URL）
    let identity = match text("remote").or_else(|| text("src")) {
        Some(identity) => identity,
        None => {
            let local = text("local")?;
            let (stem, ext) = local.rsplit_once('.')?;
            let hash = stem.rsplit('_').next()?;
            if hash.len() != 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit())
                || ext.is_empty() || !ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
                return None;
            }
            return Some(AssetRef { name: format!("{hash}.{ext}"), identity: local.to_string() });
        }
    };
    Some(AssetRef { name: image_asset_name(identity), identity: identity.to_string() })
}

/// 遍历一段结构化正文块，收集其中的资源引用（按名字去重，顺序稳定）。
pub fn collect_asset_refs(blocks: &Value) -> Vec<AssetRef> {
    let mut refs: Vec<AssetRef> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut push = |entry: AssetRef| {
        if seen.insert(entry.name.clone()) {
            refs.push(entry);
        }
    };
    if let Value::Array(items) = blocks {
        for item in items {
            if let Some(entry) = asset_ref_of(item, false) {
                push(entry);
            }
            if let Some(Value::Array(inline)) = item.get("imgs") {
                for image in inline {
                    if let Some(entry) = asset_ref_of(image, true) {
                        push(entry);
                    }
                }
            }
        }
    }
    refs
}

/// 一章正文里的资源引用（引擎按书请求正文时用同一套口径）。
pub fn chapter_asset_refs(chapter: &ChapterContent) -> Vec<AssetRef> {
    chapter.blocks.as_ref().map(collect_asset_refs).unwrap_or_default()
}

/// 资源内容的指纹（sha256）：两台设备上同一张图算出同一个值。
pub fn asset_digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(&hasher.finalize())
}

/// 资源**身份**的指纹（sha256(名字)）：插图对账用。
///
/// 插图的字节在宿主手里（图片目录），为了对账把整库图片读一遍是不可接受的；
/// 而插图的名字本身就是「图片地址的哈希」，因此名字相同 = 同一张图。
/// 代价是**地址内的内容变了不会被发现**（同一个 URL 换图）——这类图本来也没有稳定的
/// 内容语义，真要换就是换地址、名字跟着变（见 docs/sync.md 第 7.10 节）。
pub fn identity_digest(name: &str) -> String {
    asset_digest(name.as_bytes())
}

/// base64 编码（资源字节上线协议时用）
pub fn encode_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// 见 [`encode_base64`]；非法载荷返回 `None`。
pub fn decode_base64(payload: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(payload.trim()).ok()
}

/// 宿主提供的正文来源（App 实现：读 `books/<id>/content.json`，只读）。
///
/// 引擎不问「正文存在哪」，只问「有哪些章、拿一章的正文给我」；CLI 没有书库，
/// 注册为空实现即可（能力协商见 [`crate::net::PeerInfo::content`]）。
///
/// 二进制资源（封面 / 插图）也挂在这里：它们与正文一样「引擎不认识宿主的目录布局」，
/// 只是多了一个「按名字取字节」的入口（[`ContentSource::load_assets`]）。
pub trait ContentSource: Send + Sync + 'static {
    /// 某本书本机**有正文**的章节摘要。
    fn digests(&self, book: &str) -> Vec<ChapterDigest>;

    /// 取若干章的正文（对端要的、或本机要推的）。取不到的章节直接不出现在结果里。
    fn load(&self, book: &str, cids: &[String]) -> Vec<ChapterContent>;

    // ---- 资源通道（默认空实现：不参与 = 这台设备既不推也不收资源）----

    /// 本机有内容的资源（封面 + 插图）。**没有的不要列进来**：缺了就是缺了。
    fn assets(&self, _book: &str) -> Vec<crate::assets::AssetDigest> {
        Vec::new()
    }

    /// 取若干资源的字节 / 内容。取不到的直接不出现在结果里。
    fn load_assets(&self, _book: &str, _names: &[String]) -> Vec<crate::assets::Asset> {
        Vec::new()
    }

    /// 这份来源读的是哪个数据根（`None` = 宿主默认的那一份）。
    ///
    /// 宿主落地时要按**同一个根**写回去；一个进程里跑两台设备时（集成测试），
    /// 没有这条信息就没法知道「这批资源属于哪台设备」。
    fn data_root(&self) -> Option<std::path::PathBuf> {
        None
    }

    /// 本机这本书**在正文里引用到的**资源名（不管字节在不在手里）。
    ///
    /// 与 [`ContentSource::assets`] 的差别是「引用」与「内容」：换设备后本机可能
    /// 已经引用了某张图却还没有它的字节（正文先到、图后到），这种名字也要能被对端知道，
    /// 否则资源通道永远不知道本机缺什么。默认空实现 = 不参与。
    fn names(&self, _book: &str) -> Vec<String> {
        Vec::new()
    }
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
    fn empty_chapters_have_no_body_but_images_are_readable() {
        assert!(!chapter("c1", "").has_body());
        let empty = ChapterContent::default();
        assert!(!empty.has_body());
        let image_only = ChapterContent {
            cid: "c1".into(),
            paragraphs: vec![],
            blocks: Some(json!([{ "kind": "img", "src": "https://example.com/a.png" }])),
            ..ChapterContent::default()
        };
        assert!(image_only.has_body(), "纯图片章也需要同步");
    }

    /// 插图资源名必须**设备无关**：只有地址进名字，本机书 id / 章节号都不进 ——
    /// 两台设备对同一段正文才会算出同一个名字。
    #[test]
    fn image_names_depend_on_the_address_only() {
        let name = image_asset_name("https://img.example.com/a/b.jpg");
        assert_eq!(name.len(), 40 + 4, "40 位 hex + 扩展名：{name}");
        assert!(name.ends_with(".jpg"));
        assert_eq!(name, image_asset_name("https://img.example.com/a/b.jpg"));
        assert_ne!(name, image_asset_name("https://img.example.com/a/c.jpg"), "地址不同即不同");

        // 查询串 / 片段不进名字（同一张图带不同的追踪参数不该当成两张）
        assert_eq!(
            image_asset_name("https://img.example.com/a/b.jpg?token=1"),
            image_asset_name("https://img.example.com/a/b.jpg#x")
        );
        // 扩展名归一：大小写不同仍是同一张图
        assert_eq!(
            image_asset_name("https://img.example.com/a/b.JPG"),
            image_asset_name("https://img.example.com/a/b.jpg")
        );
        // 认不出扩展名时不留尾巴，两端一致
        let bare = image_asset_name("https://img.example.com/a/b");
        assert_eq!(bare.len(), 40);
        assert!(bare.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn asset_refs_cover_block_and_inline_images() {
        let blocks = json!([
            { "kind": "p", "text": "正文" },
            { "kind": "h", "text": "标题" },
            { "kind": "img", "remote": "https://img/1.png", "local": "book-1_aaaa.png" },
            { "kind": "img", "src": "https://img/2.png" },
            // 没有身份（既无 remote 也无 src）：认不出是哪张图，不进通道
            { "kind": "img", "local": "book-1_bbbb.png" },
            { "kind": "p", "text": "他指着说道", "imgs": [
                { "at": 3, "remote": "https://img/3.png" },
                { "at": 5, "remote": "https://img/1.png" },
            ]},
        ]);
        let refs = collect_asset_refs(&blocks);
        let names: Vec<&str> = refs.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names.len(), 3, "段内图与整行图同一口径，且按名字去重：{names:?}");
        assert!(names.contains(&image_asset_name("https://img/1.png").as_str()));
        assert!(names.contains(&image_asset_name("https://img/2.png").as_str()));
        assert!(names.contains(&image_asset_name("https://img/3.png").as_str()));
        assert_eq!(refs[0].identity, "https://img/1.png", "身份是地址本身");

        // 纯文字 / 空块没有资源
        assert!(collect_asset_refs(&json!([{ "kind": "p", "text": "正文" }])).is_empty());
        assert!(collect_asset_refs(&json!({})).is_empty());
    }

    /// 旧数据：图片只有 data URL（没有网络地址）时，身份取 data URL 自身 ——
    /// 两台设备迁移出来的名字仍然一致。
    #[test]
    fn legacy_data_url_images_still_get_a_stable_name() {
        let data_url = "data:image/png;base64,AAAA";
        let blocks = json!([{ "kind": "img", "src": data_url }]);
        let refs = collect_asset_refs(&blocks);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].identity, data_url);
        assert_eq!(refs[0].name, image_asset_name(data_url));
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

/// 按完整章节 JSON 的字节分片；正文结构与 UTF-8 字符可跨片，重组后统一解码。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChapterChunk {
    pub cid: String,
    pub hash: String,
    pub offset: u64,
    pub total: u64,
    #[serde(with = "crate::assets::base64_bytes")]
    pub bytes: Vec<u8>,
}

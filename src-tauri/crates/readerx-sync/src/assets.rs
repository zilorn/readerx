//! 二进制资源通道（封面 / 章节插图）：**指纹对账 + 按需搬运**。
//!
//! 与 [`crate::content`]（正文）同一套路子，理由也一样：资源不该进操作日志 / 实体快照。
//! 一本漫画书的几百张插图、每本书几千字节到几十千字节的封面，进了「一行一条 JSON、
//! 每次 flush 整份重写」的存储，就会让日志与快照各膨胀一份，且每次写入都要重写一遍。
//!
//! ```text
//! 本机：ContentSource::assets（封面 + 插图，指纹 = sha256(字节)）
//!     + 暂存区（<同步目录>/assets/<书实体 id>/，对端刚发来、还没落地）
//! 一次会话：逐本比总览 → 不一样的书比逐个资源的指纹 → 推「对端没有的」、拉「本机没有的」
//! 落地：宿主在下一次 materialize 里写进书库（封面写回元信息，插图写进图片目录）
//! ```
//!
//! **名字是设备无关的**：插图用 [`crate::content::image_asset_name`]（地址的哈希），
//! 封面固定叫 [`COVER_ASSET`]。名字同时出现在正文块（引用）与资源通道（内容）里，
//! 因此落地时不需要在两张表之间翻译。
//!
//! **内容即身份**：指纹是字节的 sha256，不是地址 / 名字的哈希 ——
//! 同一个名字下内容不同（换过封面、同一个地址换了图）时，按设备 id 定胜负后收敛，
//! 而不是各留各的。

use serde::{Deserialize, Serialize};

use crate::content::asset_digest;

/// 封面的资源名（固定值：一本书只有一个封面，两端必须用同一个名字）。
pub const COVER_ASSET: &str = "cover";

/// 资源类别：宿主据此决定「落到哪里」。引擎只做搬运，不解释落法。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    /// 书籍封面（落在书籍元信息里）
    Cover,
    /// 章节插图（落在图片目录里）；缺字段时的兜底
    #[default]
    Illustration,
}

impl AssetKind {
    /// 线上的稳定短码（日志用）
    pub const fn as_str(self) -> &'static str {
        match self {
            AssetKind::Cover => "cover",
            AssetKind::Illustration => "illustration",
        }
    }
}

/// 单个资源的摘要（对账用）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDigest {
    /// 资源名（封面固定为 [`COVER_ASSET`]；插图见 [`crate::content::image_asset_name`]）
    pub name: String,
    /// 内容的 sha256；**空串 = 本机没有这个资源**
    #[serde(default)]
    pub hash: String,
}

impl AssetDigest {
    /// 本机有内容？
    pub fn present(&self) -> bool {
        !self.hash.is_empty()
    }
}

/// 一本书的资源总览：先比一个数，避免为每本没变的书都传逐个资源的清单。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookAssets {
    /// 书实体 id
    pub book: String,
    /// 有内容的资源数
    #[serde(default)]
    pub assets: u32,
    /// 逐个资源指纹的汇总（名字 + 指纹排序后哈希）
    #[serde(default)]
    pub digest: String,
    /// 这份清单算过没有。
    ///
    /// 对账用的清单只列**有资源**的书（没必要为一本没图的书传一个大数），于是
    /// 「应答里没有这本书」既可能是「对端也没资源」，也可能是「对端有资源但没在这份
    /// 清单里」——**后者会把封面永远挡在门外**（封面没有任何正文引用可依）。
    /// 双方各自把「我点过名的书」标成 `true` 发给对端，对端就能分清缺的那本该不该查。
    /// 旧对端不带这个字段（= false），按「没算过」处理：多查一次，不会漏。
    #[serde(default)]
    pub indexed: bool,
}

/// 一本书的资源清单 → 汇总（顺序无关：按名字排序后再算）。
pub fn book_assets(book: &str, assets: &[AssetDigest]) -> BookAssets {
    let mut items: Vec<&AssetDigest> = assets.iter().filter(|asset| asset.present()).collect();
    items.sort_by(|a, b| a.name.cmp(&b.name));
    let mut text = String::new();
    text.push_str(book);
    for asset in &items {
        text.push('\u{0}');
        text.push_str(&asset.name);
        text.push('\u{0}');
        text.push_str(&asset.hash);
    }
    BookAssets {
        book: book.to_string(),
        assets: items.len() as u32,
        digest: asset_digest(text.as_bytes()),
        indexed: true,
    }
}

/// 一份资源的内容：字节 + 它的来源信息。
///
/// 引擎只搬运，不解释内容，因此这里除了字节只带三样对端落地需要的东西：名字、类别、
/// MIME / 扩展名。`data_url` 给宿主留了一条**原样搬运**的路：封面在本机就是一段
/// data URL，转成字节再转回来只会引入一次无意义的编解码（见 [`Asset::same_data`]）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub name: String,
    pub kind: AssetKind,
    /// MIME（`image/jpeg` 等）；未知留空
    #[serde(default)]
    pub mime: String,
    /// 文件扩展名（不含点）；封面这类「不落成文件」的资源留空
    #[serde(default)]
    pub ext: String,
    /// 原始字节（上线协议时编成 base64，见下方 `bytes_b64`）
    #[serde(default, rename = "bytes_b64", with = "base64_bytes")]
    pub bytes: Vec<u8>,
    /// 内容指纹（sha256(字节)）。**不进线协议**：对端只信自己手里的字节，
    /// 传过去也没人采信（对账用的是 [`AssetDigest`] 里的那一份）。
    #[serde(skip)]
    pub digest: String,
    /// 内容的**原文**（目前只有封面的 data URL）。
    ///
    /// 用原文而不是「字节 + MIME 再拼一遍」，是为了让封面同步真正做到字节级无损：
    /// 拼回来的 data URL 只要差一个字符，本机就会把它当成「封面变了」反复写盘。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
}

impl Asset {
    /// 一组字节 → 一份资源（指纹按字节现算）。
    pub fn new(name: &str, kind: AssetKind, mime: &str, ext: &str, bytes: Vec<u8>) -> Asset {
        Asset {
            name: name.to_string(),
            kind,
            mime: mime.to_string(),
            ext: ext.to_string(),
            digest: asset_digest(&bytes),
            bytes,
            data_url: None,
        }
    }

    /// 一份「原文」资源（封面的 data URL）：比对用原文，落盘用字节。
    pub fn with_data_url(mut self, data_url: Option<String>) -> Asset {
        self.data_url = data_url;
        self
    }

    /// 本机已有的那一份与这一份**内容相同**？（对账命中时跳过写盘）
    ///
    /// 比字节而不是比指纹：指纹是对端算的，本机只信自己手里的字节。
    pub fn same_data(&self, other: &Asset) -> bool {
        match (&self.data_url, &other.data_url) {
            (Some(mine), Some(theirs)) => mine == theirs,
            _ => self.bytes == other.bytes,
        }
    }

    /// 资源体积（会话预算用）。
    pub fn size(&self) -> u64 {
        self.bytes.len() as u64
    }
}

/// 资源名 → 类别（宿主没显式给 kind 时的兜底；封面是唯一有固定名字的资源）。
pub fn derive_kind(name: &str) -> AssetKind {
    if name == COVER_ASSET {
        AssetKind::Cover
    } else {
        AssetKind::Illustration
    }
}

/// 一份资源是否值得搬运（名字合法、字节不为空）。
///
/// 名字要能当文件名用：它来自 [`crate::content::image_asset_name`] 或 [`COVER_ASSET`]，
/// 都不含路径分隔符；这里只做防御性检查，别让对端用一个 `../` 决定本机往哪写。
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// 按帧预算装箱：返回（装得下的资源, 它们的字节数）。
///
/// 单个超过预算的资源直接跳过并留日志：**不静默丢**，但也不能让一个超大文件
/// 卡住整条通道（下一次同步还会重算差集，用户能自己决定删掉那张图）。
pub fn fit_batch(items: Vec<Asset>, max_bytes: u64, max_items: usize) -> (Vec<Asset>, u64) {
    let mut out = Vec::new();
    let mut bytes = 0u64;
    for item in items {
        let size = item.size();
        if size > max_bytes {
            log::warn!("资源超过单帧预算，跳过 name={} bytes={size}", item.name);
            continue;
        }
        if out.len() >= max_items || bytes + size > max_bytes {
            break;
        }
        bytes += size;
        out.push(item);
    }
    (out, bytes)
}

/// 与 [`crate::content::AssetRef`] 一起用的辅助：把「宿主没有这一份」也表达成一条摘要。
pub fn missing(name: &str) -> AssetDigest {
    AssetDigest { name: name.to_string(), hash: String::new() }
}

/// 资源字节的 serde 形态：线上是 base64，内存里是 `Vec<u8>`。
mod base64_bytes {
    use serde::de::Error as _;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&crate::content::encode_base64(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let payload = String::deserialize(deserializer)?;
        crate::content::decode_base64(&payload)
            .ok_or_else(|| D::Error::custom("资源字节不是合法的 base64"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str, bytes: &[u8]) -> Asset {
        Asset::new(name, derive_kind(name), "image/png", "png", bytes.to_vec())
    }

    /// 收下一份资源：字节按 base64 过线，指纹按本机手里的字节现算（不信对端说的）。
    fn received(item: &Asset) -> Asset {
        let mut back: Asset =
            serde_json::from_str(&serde_json::to_string(item).unwrap()).expect("资源可解析");
        back.digest = asset_digest(&back.bytes);
        back
    }

    #[test]
    fn asset_json_roundtrip_uses_base64_and_recomputes_digest() {
        let item = asset("abc.png", b"\x89PNG\r\n\x1a\npayload");
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"bytes_b64\":\""), "字节要编成 base64：{json}");
        assert!(json.contains("\"kind\":\"illustration\""));
        assert!(!json.contains("digest"), "指纹不进线协议：{json}");
        assert_eq!(received(&item), item);
    }

    /// 指纹是字节的 sha256，不是地址 / 名字的哈希：换了封面内容就是另一份。
    #[test]
    fn digest_tracks_the_bytes_not_the_name() {
        assert_eq!(asset("cover", b"real").digest, asset_digest(b"real"));
        assert_ne!(asset("cover", b"real").digest, asset("cover", b"other").digest);
    }

    /// 对账清单的原样 vs 只列有资源的书：`indexed` 是区分「没有」与「没问」的唯一线索。
    #[test]
    fn book_assets_marks_whether_it_was_computed() {
        assert!(book_assets("b-1", &[]).indexed, "算过的清单要标 indexed");
        let request = BookAssets {
            book: "b-1".into(),
            assets: 0,
            digest: String::new(),
            indexed: false,
        };
        assert!(!request.indexed);
        // 旧对端不带这个字段：解析成 false（当作没算过，多查一次不会漏）
        let legacy: BookAssets =
            serde_json::from_str(r#"{"book":"b-1","assets":1,"digest":"aa"}"#).unwrap();
        assert!(!legacy.indexed);
    }

    #[test]
    fn book_assets_ignores_order_and_missing() {
        let one = vec![
            AssetDigest { name: "b".into(), hash: "22".into() },
            AssetDigest { name: "a".into(), hash: "11".into() },
            missing("c"),
        ];
        let two = vec![
            missing("c"),
            AssetDigest { name: "a".into(), hash: "11".into() },
            AssetDigest { name: "b".into(), hash: "22".into() },
        ];
        let a = book_assets("b-1", &one);
        assert_eq!(a, book_assets("b-1", &two));
        assert_eq!(a.assets, 2, "没有内容的资源不计入");
        assert_ne!(a, book_assets("b-2", &one), "书不同，汇总值不同");
        let changed = vec![AssetDigest { name: "a".into(), hash: "33".into() }];
        assert_ne!(a, book_assets("b-1", &changed));
    }

    /// 封面的「原文」比对：data URL 一模一样就不该再写一次盘；
    /// 只比字节时（插图）走字节比对。
    #[test]
    fn same_data_prefers_the_original_text_for_covers() {
        let bytes = b"cover".to_vec();
        let mine = asset(COVER_ASSET, &bytes).with_data_url(Some("data:image/jpeg;base64,Y292ZXI=".into()));
        let same = asset(COVER_ASSET, &bytes).with_data_url(Some("data:image/jpeg;base64,Y292ZXI=".into()));
        assert!(mine.same_data(&same));

        let other_text =
            asset(COVER_ASSET, &bytes).with_data_url(Some("data:image/png;base64,Y292ZXI=".into()));
        assert!(!mine.same_data(&other_text), "原文不同就是不同（哪怕字节相同）");

        let by_bytes = asset("x.png", &bytes);
        assert!(by_bytes.same_data(&asset("x.png", &bytes)));
        assert!(!by_bytes.same_data(&asset("x.png", b"other")));
    }

    #[test]
    fn names_are_validated_before_they_become_file_names() {
        assert!(valid_name("cover"));
        assert!(valid_name("0123456789abcdef0123456789abcdef01234567.jpg"));
        assert!(!valid_name(""));
        assert!(!valid_name(".."));
        assert!(!valid_name("../escape.png"));
        assert!(!valid_name("a/b.png"));
        assert!(!valid_name(&"x".repeat(129)));
    }

    #[test]
    fn fit_batch_skips_oversized_and_stops_at_the_budget() {
        let items = vec![asset("a", &[0u8; 8]), asset("big", &[0u8; 64]), asset("b", &[0u8; 8])];
        let (batch, bytes) = fit_batch(items, 20, 10);
        assert_eq!(batch.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!(bytes, 16, "被跳过的资源不计入预算");
    }
}

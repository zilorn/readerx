//! 与前端共享的数据模型（App 侧）。
//!
//! 仅负责结构与序列化，不包含任何 I/O 或业务逻辑。
//! **书源 / 在线书模型**（BookSource、BookItem、ChapterItem、调用结果等）已随书源引擎
//! 迁到 `readerx-source` crate，这里原样再导出，App 内 `crate::models::X` 的写法不变。

pub use readerx_source::models::{
    BookItem, BookSource, BookSourceSummary, ChapterContentResult, ChapterItem, FetchedImage,
    SourceCallResult,
};

use serde::{Deserialize, Serialize};

/// 图片引用：块级插图（`ChapterBlock` 上的 src/alt/remote/local）与段内插图
/// （`ChapterBlock::imgs` 锚点）共用同一组字段，语义完全一致。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterInlineImage {
    /// 图片插在段落文本的第 `at` 个字符之前。
    /// UTF-16 偏移（与前端 JS string 下标、书签/进度口径一致）；
    /// **图片本身不占字符**，因此段内图片不影响既有字符偏移。
    pub at: u32,
    /// 可直接渲染的地址：在线书未下载时为网络地址，下载后仍保留网络地址
    /// （本地副本由 `local` 指向的文件提供，避免把图片字节写进书籍 JSON）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    /// 在线书：图片原始网络地址（图片身份：下载去重 / 失败重试按它对应）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    /// 本地副本文件名（位于应用数据目录 images/ 下，见 book_images.rs）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterBlock {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<u32>,
    /// 可直接渲染的地址：在线书未下载时为网络地址，下载后仍保留网络地址
    /// （本地副本由 `local` 指向的文件提供，避免把图片字节写进书籍 JSON）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    /// 在线书：图片原始网络地址（图片身份：下载去重 / 失败重试按它对应）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    /// 本地副本文件名（位于应用数据目录 images/ 下，见 book_images.rs）：
    /// 图片下载成功后只把引用写回章节，图片字节留在文件里
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<String>,
    /// p 块的段内插图锚点（图文混排）：图片留在段落文字流里，不另起一段。
    /// 只有 p 块会用；缺失 = 纯文字段落（旧数据与新解析的纯文字段落都不写该字段）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imgs: Option<Vec<ChapterInlineImage>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBookChapter {
    /// 章节稳定 id，如 c0001、c0002 …；旧数据缺失时前端回填
    #[serde(default)]
    pub cid: String,
    pub title: String,
    pub paragraphs: Vec<String>,
    /// 结构化正文块（EPUB 含标题/图片）；旧数据缺失时前端退回 paragraphs
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<ChapterBlock>>,
    /// 在线书章节来源地址（书源 bookToc 返回的 chapterUrl）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAudio {
    /// 音频字节（base64 编码，由前端解码为 Blob）
    pub data: String,
    /// 音频 MIME（如 audio/mpeg / audio/wav）
    pub mime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsCacheStat {
    /// 有缓存音频的书籍 id
    pub book_id: String,
    /// 该书的音频条目数
    pub files: u64,
    /// 该书的音频字节数
    pub bytes: u64,
}

/// 听书缓存总览：统计 + 当前生效的每本书条目上限（0 = 不限）。
/// 上限由后端按 `readerx.ttsCacheLimit` 归一化后回传，前端据此校正本地值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsCacheOverview {
    pub limit: u64,
    pub books: Vec<TtsCacheStat>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBook {
    pub id: String,
    pub title: String,
    pub author: String,
    /// 书籍简介（导入时 EPUB/在线书若带简介自动带入；详情页可编辑）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intro: Option<String>,
    pub format: String,
    pub file_name: String,
    pub size: u64,
    pub imported_at: u64,
    pub hue: u32,
    pub split_desc: String,
    /// EPUB 封面缩略图（data URL，导入时从 EPUB 提取）；无封面时为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    pub chapters: Vec<LocalBookChapter>,
    /// 所属书架分组 id；未分组时为 null
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// 导入来源：WebDAV 导入为 "webdav"；本地导入或旧数据缺失时为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// 在线书：来源书源 id（书源删除后书籍保留，仅失去更新能力）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_source_id: Option<String>,
    /// 在线书：书源侧全书地址（与 sourceId 一起构成在线书稳定身份）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_url: Option<String>,
    /// 标签（书源搜索/详情返回或用户在书籍详情页手编；本地导入与在线书通用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// 上次由书源写入的标签（tags 里属于书源的那部分）：在线书「重新拉取书籍信息」据此
    /// 只增删书源来源的标签，用户手编的标签始终保留。旧数据缺失时前端退化为并集合并。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_tags: Option<Vec<String>>,
}

/// 章节「轻量头」：书库列表 / 书架 / 目录进度所需的章节信息，不含正文。
/// chars 为章节正文镜像字符数（UTF-16 口径，与前端 string.length 一致），
/// 用于书架进度百分比与详情「字数」统计，避免启动时把全文搬运进 WebView。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterHead {
    pub cid: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub chars: u64,
}

/// 书库元数据（不含章节正文）：
/// 与 LocalBook 字段同构，仅 chapters 替换为轻量头。启动只拉这份，正文按需取单本。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookMeta {
    pub id: String,
    pub title: String,
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intro: Option<String>,
    pub format: String,
    pub file_name: String,
    pub size: u64,
    pub imported_at: u64,
    pub hue: u32,
    pub split_desc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    pub chapters: Vec<ChapterHead>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_tags: Option<Vec<String>>,
}

/// 一次「只回写单章正文」的下标 + 章节数据（在线书逐批下载用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookChapterPatch {
    pub index: usize,
    pub chapter: LocalBookChapter,
}

/// 双层 Option 字段的反序列化：区分「字段缺省」（不改动）与「显式 null」（清除）。
/// serde 默认把两者都解析成外层 `None`，补丁里所有「清空标签 / 移除封面 / 移出分组 /
/// 清掉书源标签标记」的写法就都成了空操作（前端内存里改了、磁盘上没改，重启即回退）。
fn deserialize_double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
}

/// 书籍「元信息补丁」（书架分组 / 详情页编辑用）：
/// 只改书文件里的元信息字段，正文整体保留在磁盘，不经过 IPC 传回 WebView。
/// 外层 Option 缺省 = 不改动；内层 null = 清除（intro / cover / tags / sourceTags / groupId）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BookMetaPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub intro: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub cover: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub tags: Option<Option<Vec<String>>>,
    #[serde(
        default,
        deserialize_with = "deserialize_double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_tags: Option<Option<Vec<String>>>,
    #[serde(
        default,
        deserialize_with = "deserialize_double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub group_id: Option<Option<String>>,
}

impl BookMetaPatch {
    /// 应用到整书（只动本补丁涉及字段；返回值表示是否有任何字段被改动）。
    pub fn apply_to(&self, book: &mut LocalBook) -> bool {
        let mut changed = false;
        if let Some(title) = &self.title {
            let title = title.trim().to_string();
            let title = if title.is_empty() {
                "未命名书籍".to_string()
            } else {
                title
            };
            if book.title != title {
                book.title = title;
                changed = true;
            }
        }
        if let Some(author) = &self.author {
            let author = author.trim().to_string();
            let author = if author.is_empty() { "佚名".to_string() } else { author };
            if book.author != author {
                book.author = author;
                changed = true;
            }
        }
        if let Some(intro) = &self.intro {
            let next = intro.as_deref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            let next = next.unwrap_or_default();
            let prev = book.intro.clone().unwrap_or_default();
            if prev != next {
                book.intro = if next.is_empty() { None } else { Some(next) };
                changed = true;
            }
        }
        if let Some(cover) = &self.cover {
            let prev = book.cover.clone();
            let next = cover.clone().unwrap_or_default();
            let prev = prev.unwrap_or_default();
            if prev != next {
                book.cover = if next.is_empty() { None } else { Some(next) };
                changed = true;
            }
        }
        if let Some(tags) = &self.tags {
            let next = tags.clone().unwrap_or_default();
            let prev = book.tags.clone().unwrap_or_default();
            if prev != next {
                book.tags = if next.is_empty() { None } else { Some(next) };
                changed = true;
            }
        }
        if let Some(source_tags) = &self.source_tags {
            let next = source_tags.clone().unwrap_or_default();
            let prev = book.source_tags.clone().unwrap_or_default();
            if prev != next {
                book.source_tags = if next.is_empty() { None } else { Some(next) };
                changed = true;
            }
        }
        if let Some(group_id) = &self.group_id {
            let prev = book.group_id.clone();
            let next = group_id.clone();
            if prev != next {
                book.group_id = next;
                changed = true;
            }
        }
        changed
    }
}

/// 章节插图下载并落盘后的结果：只回传「本地引用 + 尺寸」，不回传图片字节
/// （图片字节经 IPC 传给 WebView 会成倍占用内存，大量图片时直接把应用撑崩）。
/// 仅 App 使用：独立二进制不落盘，直接把字节写到输出文件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookImageFile {
    pub ok: bool,
    /// 本地副本文件名（应用数据目录 images/ 下）；失败时为空
    #[serde(default)]
    pub local: String,
    /// 原始像素宽 / 高（读文件头解析，不解码；解析不出为 0）
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    /// 图片字节数
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub error: String,
}

/// 已落盘章节图片的尺寸 / 体积（排版按真实尺寸，无需在 WebView 里解码整章图片）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookImageInfo {
    pub local: String,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试基线：一本带简介 / 封面 / 分组 / 标签 / 书源标签的在线书
    fn test_book() -> LocalBook {
        LocalBook {
            id: "local-1".into(),
            title: "书".into(),
            author: "佚名".into(),
            intro: Some("简介".into()),
            format: "online".into(),
            file_name: "书.txt".into(),
            size: 0,
            imported_at: 1,
            hue: 0,
            split_desc: "书源：某源".into(),
            cover: Some("data:image/png;base64,AAAA".into()),
            chapters: Vec::new(),
            group_id: Some("g1".into()),
            source: Some("online".into()),
            book_source_id: Some("src-1".into()),
            book_url: Some("https://example.com/1".into()),
            tags: Some(vec!["玄幻".into(), "手编".into()]),
            source_tags: Some(vec!["玄幻".into()]),
        }
    }

    fn patch_of(json: &str) -> BookMetaPatch {
        serde_json::from_str(json).unwrap()
    }

    /// 老数据（本字段上线前落盘的书籍 JSON）不带 sourceTags，必须照常解析
    #[test]
    fn old_book_json_without_source_tags_loads() {
        let json = r#"{
            "id": "local-1", "title": "书", "author": "佚名",
            "format": "online", "fileName": "书.txt", "size": 0,
            "importedAt": 1, "hue": 10, "splitDesc": "书源：某源",
            "chapters": [], "tags": ["玄幻"]
        }"#;
        let book: LocalBook = serde_json::from_str(json).unwrap();
        assert_eq!(book.tags.as_deref(), Some(&["玄幻".to_string()][..]));
        assert!(book.source_tags.is_none());
        // 序列化不回写空字段（老文件不会因此变大）
        let out = serde_json::to_string(&book).unwrap();
        assert!(!out.contains("sourceTags"));
    }

    /// 书源标签标记的补丁语义：缺省不动、数组替换、null 清除
    /// （前端手编标签只发 tags，不该动到 sourceTags）
    #[test]
    fn patch_source_tags() {
        // 缺省：手编标签补丁不应改动书源标签标记
        let mut book = test_book();
        let patch = patch_of(r#"{"tags":["玄幻","手编","新加"]}"#);
        assert!(patch.apply_to(&mut book));
        assert_eq!(
            book.tags.as_deref(),
            Some(&["玄幻".to_string(), "手编".to_string(), "新加".to_string()][..])
        );
        assert_eq!(book.source_tags.as_deref(), Some(&["玄幻".to_string()][..]));

        // 非空数组：替换标记
        let mut book = test_book();
        let patch = patch_of(r#"{"tags":["玄幻","手编"],"sourceTags":["玄幻","新加"]}"#);
        assert!(patch.apply_to(&mut book));
        assert_eq!(
            book.source_tags.as_deref(),
            Some(&["玄幻".to_string(), "新加".to_string()][..])
        );

        // null：清除标记（回到「无从区分手编与书源」的老数据状态）
        let mut book = test_book();
        let patch = patch_of(r#"{"sourceTags":null}"#);
        assert!(patch.apply_to(&mut book));
        assert!(book.source_tags.is_none());

        // 无变化时不算改动（避免无谓写盘）
        let mut book = test_book();
        let patch = patch_of(r#"{"sourceTags":["玄幻"]}"#);
        assert!(!patch.apply_to(&mut book));
    }

    /// 补丁的「清除」语义：缺省不动、显式 null 清除（serde 默认会把 null 与缺省一起
    /// 解析成外层 None，那样移除封面 / 清空标签 / 移出分组在磁盘上全是空操作）
    #[test]
    fn patch_null_clears_optional_fields() {
        let mut book = test_book();

        // 缺省字段一律不动
        let patch = patch_of(r#"{"title":"新书名"}"#);
        assert_eq!(patch.intro, None);
        assert_eq!(patch.cover, None);
        assert_eq!(patch.tags, None);
        assert_eq!(patch.source_tags, None);
        assert_eq!(patch.group_id, None);
        assert!(patch.apply_to(&mut book));
        assert_eq!(book.title, "新书名");
        assert_eq!(book.intro.as_deref(), Some("简介"));
        assert!(book.cover.is_some());
        assert!(book.tags.is_some());
        assert!(book.source_tags.is_some());
        assert_eq!(book.group_id.as_deref(), Some("g1"));

        // 显式 null = 清除
        let patch = patch_of(
            r#"{"intro":null,"cover":null,"tags":null,"sourceTags":null,"groupId":null}"#,
        );
        assert_eq!(patch.intro, Some(None));
        assert_eq!(patch.cover, Some(None));
        assert_eq!(patch.tags, Some(None));
        assert_eq!(patch.source_tags, Some(None));
        assert_eq!(patch.group_id, Some(None));
        assert!(patch.apply_to(&mut book));
        assert!(book.intro.is_none());
        assert!(book.cover.is_none());
        assert!(book.tags.is_none());
        assert!(book.source_tags.is_none());
        assert!(book.group_id.is_none());

        // 清除后再发一次同样的 null：没有可改的东西 → 不写盘
        assert!(!patch.apply_to(&mut book));
    }

    /// 空数组按清除处理（前端「清空标签」经 updateBookInfo 转成 null，这里覆盖空数组写法）
    #[test]
    fn patch_tags_empty_array_clears() {
        let mut book = test_book();
        let patch = patch_of(r#"{"tags":[],"sourceTags":[]}"#);
        assert!(patch.apply_to(&mut book));
        assert!(book.tags.is_none());
        assert!(book.source_tags.is_none());
    }
}

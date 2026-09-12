//! 与前端共享的数据模型。
//! 仅负责结构与序列化，不包含任何 I/O 或业务逻辑。

use serde::{Deserialize, Serialize};

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
}

/// 一次「只回写单章正文」的下标 + 章节数据（在线书逐批下载用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookChapterPatch {
    pub index: usize,
    pub chapter: LocalBookChapter,
}

/// 书籍「元信息补丁」（书架分组 / 详情页编辑用）：
/// 只改书文件里的元信息字段，正文整体保留在磁盘，不经过 IPC 传回 WebView。
/// 外层 Option 缺省 = 不改动；内层 null = 清除（intro / cover / tags / groupId）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BookMetaPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intro: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Option<Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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

// ---------------------------------------------------------------------------
// 书源（Book Source）
// ---------------------------------------------------------------------------

fn yes() -> bool {
    true
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookSourceCapabilities {
    #[serde(default = "yes")]
    pub search: bool,
    #[serde(default = "yes")]
    pub discover: bool,
    #[serde(default = "yes")]
    pub detail: bool,
    #[serde(default = "yes")]
    pub toc: bool,
    #[serde(default = "yes")]
    pub content: bool,
}

impl Default for BookSourceCapabilities {
    fn default() -> Self {
        Self {
            search: true,
            discover: true,
            detail: true,
            toc: true,
            content: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookSource {
    #[serde(default = "one")]
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub book_source_url: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub capabilities: BookSourceCapabilities,
    /// 是否允许自动网页认证（登录 / Cloudflare 挑战）：引擎请求命中 CF 挑战时自动
    /// 拉起应用内 WebView 认证并重试；书源代码的 `webview.login` 也受此开关约束。
    /// 编辑页手动「网页登录」不受影响。默认开启，可单独关闭。
    #[serde(default = "yes")]
    pub auto_auth: bool,
    /// 所属书源分组 id（分组清单由前端偏好存 `readerx.sourceGroups`）。
    /// 纯本机归属：导出时不带该 id，只带可读的 `groupName`（见 docs/book-source-spec.md）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// 缺省请求 UA（空 = 使用内置默认）
    #[serde(default)]
    pub user_agent: String,
    /// 每请求合并的默认请求头（可含 Cookie）
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub update_time: u64,
    /// 书源 JS 代码（定义 searchBook/bookToc 等入口函数）
    pub js: String,
}

impl BookSource {
    /// 去除超长字段后的摘要（列表页用；不携带 js 正文）
    pub fn to_summary(&self) -> BookSourceSummary {
        BookSourceSummary {
            schema_version: self.schema_version,
            id: self.id.clone(),
            name: self.name.clone(),
            book_source_url: self.book_source_url.clone(),
            author: self.author.clone(),
            version: self.version.clone(),
            enabled: self.enabled,
            capabilities: self.capabilities.clone(),
            group_id: self.group_id.clone(),
            update_time: self.update_time,
            js_length: self.js.chars().count() as u64,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookSourceSummary {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub book_source_url: String,
    pub author: String,
    pub version: String,
    pub enabled: bool,
    pub capabilities: BookSourceCapabilities,
    /// 所属书源分组 id；未分组 / 分组已被删除时为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    pub update_time: u64,
    pub js_length: u64,
}

// ---------------------------------------------------------------------------
// 在线书（书源函数之间传递的对象）
// ---------------------------------------------------------------------------

/// 书源入口函数返回/接收的“书”对象
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookItem {
    pub book_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intro: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_time: Option<String>,
    pub book_url: String,
    /// 发现列表所属分类（翻页时回传）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_url: Option<String>,
    /// 作品标签（搜索/发现/详情可返回；加入书架时随书保存）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

/// 书源 bookToc 返回的章节项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterItem {
    pub chapter_name: String,
    pub chapter_url: String,
}

/// 批量拉取正文的单章结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterContentResult {
    pub ok: bool,
    pub chapter_name: String,
    /// 正文（原始文本；前端统一做段落规范化）
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub error: String,
}

/// 经书源会话下载一张正文插图的结果（正文图片可能带防盗链，必须走该书源的
/// cookie / 默认头 / UA，因此放到 Rust 侧用与 bookContent 相同的会话请求）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedImage {
    pub ok: bool,
    /// 图片 MIME（如 image/jpeg）；失败时为空
    #[serde(default)]
    pub mime: String,
    /// 图片字节（base64）；失败时为空
    #[serde(default)]
    pub data: String,
    #[serde(default)]
    pub error: String,
}

/// 章节插图下载并落盘后的结果：只回传「本地引用 + 尺寸」，不回传图片字节
/// （图片字节经 IPC 传给 WebView 会成倍占用内存，大量图片时直接把应用撑崩）。
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

/// 一次书源函数调用的统一结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCallResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub logs: Vec<String>,
    pub elapsed_ms: u64,
}

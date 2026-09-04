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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
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

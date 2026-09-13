//! 在线书与书源的数据模型（与前端 / 书源 JSON 共享）。
//! 仅负责结构与序列化，不包含任何 I/O 或业务逻辑。

use serde::{Deserialize, Serialize};

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

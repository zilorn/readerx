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
    pub format: String,
    pub file_name: String,
    pub size: u64,
    pub imported_at: u64,
    pub hue: u32,
    pub split_desc: String,
    pub chapters: Vec<LocalBookChapter>,
    /// 所属书架分组 id；未分组时为 null
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// 导入来源：WebDAV 导入为 "webdav"；本地导入或旧数据缺失时为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

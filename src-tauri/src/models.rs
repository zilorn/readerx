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
    pub title: String,
    pub paragraphs: Vec<String>,
    /// 结构化正文块（EPUB 含标题/图片）；旧数据缺失时前端退回 paragraphs
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<ChapterBlock>>,
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
    /// 来自 TransBook 云端下载时的来源引用；用于“重新获取章节”
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_ref: Option<CloudRef>,
}

/// TransBook 云端下载的来源引用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRef {
    pub server_url: String,
    pub remote_id: String,
}

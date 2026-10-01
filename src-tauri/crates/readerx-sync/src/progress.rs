//! 同步会话进度：只报告计数与书名，不包含正文或凭据。

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub phase: String,
    pub peer_name: String,
    pub book_title: Option<String>,
    pub book_index: usize,
    pub book_count: usize,
    /// 当前书籍、当前通道的已传输数量；总量未知时使用 None。
    pub completed: usize,
    pub total: Option<usize>,
    pub content_pushed: usize,
    pub content_pulled: usize,
    pub assets_pushed: usize,
    pub assets_pulled: usize,
    pub bytes: u64,
}

//! 正文来源：把 App 的书库接到同步引擎的**正文通道**上（见 `readerx_sync::content`）。
//!
//! 引擎只认识「书实体 id + 章节 cid」，不认识 App 的 `books/<id>/content.json` 布局，
//! 也不知道本机书 id 与书实体 id 的对应关系 —— 这一层就干这两件事：
//!
//! ```text
//! 引擎问：这本书有哪些章？          → 读 books/<id>/digest.json（小文件，写正文时顺手更新）
//! 引擎说：把这几章的正文给我        → 顺序扫 content.json，只留命中的章节
//! ```
//!
//! 收到对端的正文不在这里落地（那是 [`super::bridge`] 的事）：引擎先存进自己的暂存区，
//! 宿主在一次落地里统一写进书库 —— 写书库要能顺带建书、翻分组、改书源归属，
//! 这些都是 App 的语义，不该塞进引擎。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use readerx_sync::content::{ChapterContent, ChapterDigest, ContentSource};
use tauri::AppHandle;

use crate::book_store;
use crate::models::LocalBookChapter;

use super::bridge;

/// App 侧的正文来源。
pub struct AppContent<R: tauri::Runtime> {
    app: AppHandle<R>,
    /// 书实体 id → 本机书 id（懒建；查不到时重建一次，书被加了 / 删了能跟上）
    books: Mutex<HashMap<String, String>>,
}

impl<R: tauri::Runtime> AppContent<R> {
    pub fn new(app: AppHandle<R>) -> Arc<AppContent<R>> {
        Arc::new(AppContent { app, books: Mutex::new(HashMap::new()) })
    }

    /// 书实体 id → 本机书 id（未命中时重建一次索引）。
    fn local_id(&self, uid: &str) -> Option<String> {
        if let Ok(map) = self.books.lock() {
            if let Some(id) = map.get(uid) {
                return Some(id.clone());
            }
        }
        let rebuilt = self.rebuild();
        let hit = rebuilt.get(uid).cloned();
        if let Ok(mut map) = self.books.lock() {
            *map = rebuilt;
        }
        // 重建之后仍没有：这本书本机确实没有（还没同步过来 / 已经删了）
        if hit.is_none() {
            log::debug!("正文通道里没有这本书的本机副本 uid={uid}");
        }
        hit
    }

    /// 扫一遍书库元信息，算出「书实体 id → 本机书 id」。
    fn rebuild(&self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        match book_store::list_sync_meta(&self.app) {
            Ok(books) => {
                for meta in books {
                    let uid = bridge::book_uid_of(&self.app, &meta);
                    map.insert(uid, meta.id);
                }
            }
            Err(error) => log::warn!("正文通道无法列出书库：{error}"),
        }
        map
    }
}

impl<R: tauri::Runtime> ContentSource for AppContent<R> {
    fn digests(&self, book: &str) -> Vec<ChapterDigest> {
        let Some(local_id) = self.local_id(book) else {
            return Vec::new();
        };
        match book_store::read_sync_digests(&self.app, &local_id) {
            Ok(digests) => digests,
            Err(error) => {
                // 读不出来就当作「本机没有正文」：宁可不搬，也不要把坏数据当成好数据发出去
                log::warn!("读取章节指纹失败（{local_id}）：{error}");
                Vec::new()
            }
        }
    }

    fn load(&self, book: &str, cids: &[String]) -> Vec<ChapterContent> {
        let Some(local_id) = self.local_id(book) else {
            return Vec::new();
        };
        match book_store::read_chapters_by_cid(&self.app, &local_id, cids) {
            Ok(chapters) => chapters.into_iter().map(chapter_content).collect(),
            Err(error) => {
                log::warn!("读取章节正文失败（{local_id}）：{error}");
                Vec::new()
            }
        }
    }
}

/// 本地章节 → 引擎的正文载荷（结构化块原样透传）。
fn chapter_content(chapter: LocalBookChapter) -> ChapterContent {
    let blocks = chapter
        .blocks
        .as_ref()
        .and_then(|blocks| serde_json::to_value(blocks).ok());
    ChapterContent {
        cid: chapter.cid,
        title: chapter.title,
        url: chapter.url,
        paragraphs: chapter.paragraphs,
        blocks,
    }
}

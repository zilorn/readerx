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
//!
//! **二进制资源（封面 / 插图）挂同一个来源上**（`readerx_sync::assets`）：它们与正文
//! 一样「引擎不认识宿主的目录布局」，只是多了一个「按名字取字节」的入口。两样东西
//! 各有各的存法，这里负责翻译成引擎认识的资源：
//!
//! ```text
//! 封面    bookdetail.json 里的 data URL   → 名字固定 `cover`
//! 插图    images/<设备无关的名字>.png      → 名字 = 图片地址的哈希（正文块里就是这么引用的）
//! ```
//!
//! 插图的**名字来自正文块里的引用**（`ChapterBlock.local` / `ChapterInlineImage.local`
//! 经 `book_images::asset_name` 归一），而不是扫图片目录：只有被引用的图才值得搬 ——
//! 扫目录会把本机历史遗留的孤儿文件也推给对端，那边就多出一堆没人引用的图。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use readerx_sync::assets::{Asset, AssetDigest, AssetKind, COVER_ASSET};
use readerx_sync::content::{identity_digest, ChapterContent, ChapterDigest, ContentSource};
use tauri::AppHandle;

use crate::book_store;
use crate::models::LocalBookChapter;

use super::bridge;

/// App 侧的正文来源。
pub struct AppContent<R: tauri::Runtime> {
    app: AppHandle<R>,
    /// 这份来源读哪个数据根（`None` = 本机应用数据目录）。
    ///
    /// 集成测试会在一个进程里跑两台设备，两台都要有**真实书库**（资源通道两端都得能
    /// 「按名字读出字节」），因此根必须固定在这份来源上：靠环境变量在调用时切换是不可靠的
    /// —— 引擎在任何时刻才去读对端的书库，读到哪一份取决于当时变量是什么。
    root: Option<PathBuf>,
    /// 书实体 id → 本机书 id（懒建；查不到时重建一次，书被加了 / 删了能跟上）
    books: Mutex<BookCache>,
}

/// 连续查询缺失书籍时最多每秒重建一次，避免逐书逐通道扫描整个书库。
#[derive(Default)]
struct BookCache {
    ids: HashMap<String, String>,
    refreshed: Option<Instant>,
}

impl<R: tauri::Runtime> AppContent<R> {
    pub fn new(app: AppHandle<R>) -> Arc<AppContent<R>> {
        Arc::new(AppContent {
            app,
            root: None,
            books: Mutex::new(BookCache::default()),
        })
    }

    /// 读另一份数据根的来源（同步夹具里的「另一台设备」）。
    pub fn at(app: AppHandle<R>, root: impl Into<PathBuf>) -> Arc<AppContent<R>> {
        Arc::new(AppContent {
            app,
            root: Some(root.into()),
            books: Mutex::new(BookCache::default()),
        })
    }

    /// 这份来源的数据根参数（见 `storage::data_root_at`）。
    fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    /// 见 [`ContentSource::data_root`]。
    fn own_root(&self) -> Option<PathBuf> {
        self.root.clone()
    }

    /// 书实体 id → 本机书 id（未命中时重建一次索引）。
    fn local_id(&self, uid: &str) -> Option<String> {
        // 迁移后的书直接按同步 ID 定位，新增 / 恢复书籍不受旧索引节流影响。
        if super::book_ids::canonical_id(uid)
            && crate::storage::data_root_at(&self.app, self.root()).ok()?
                .join("books").join(uid).join("bookdetail.json").is_file()
        {
            return Some(uid.to_string());
        }
        let mut cache = self
            .books
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(id) = cache.ids.get(uid) {
            return Some(id.clone());
        }
        if cache
            .refreshed
            .is_some_and(|time| time.elapsed() < Duration::from_secs(1))
        {
            return None;
        }
        cache.ids = self.rebuild();
        cache.refreshed = Some(Instant::now());
        cache.ids.get(uid).cloned()
    }

    /// 一本书正文里引用到的插图：资源名（设备无关）+ 本地副本文件名。
    ///
    /// 读章节指纹缓存，不解析正文：资源对账每次同步都会跑一遍。
    fn images(&self, local_id: &str) -> Vec<(String, String)> {
        match book_store::read_sync_asset_refs_at(&self.app, self.root(), local_id) {
            Ok(refs) => refs,
            Err(error) => {
                log::debug!("读取插图引用失败（{local_id}）：{error}");
                Vec::new()
            }
        }
    }

    /// 扫一遍书库元信息，算出「书实体 id → 本机书 id」。
    fn rebuild(&self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        match book_store::list_sync_meta_at(&self.app, self.root()) {
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
        match book_store::read_sync_digests_at(&self.app, self.root(), &local_id) {
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
        match book_store::read_chapters_by_cid_at(&self.app, self.root(), &local_id, cids) {
            Ok(chapters) => chapters.into_iter().map(chapter_content).collect(),
            Err(error) => {
                log::warn!("读取章节正文失败（{local_id}）：{error}");
                Vec::new()
            }
        }
    }

    // ---- 资源通道（封面 / 插图，见 `readerx_sync::assets`）----

    fn assets(&self, book: &str) -> Vec<AssetDigest> {
        let Some(local_id) = self.local_id(book) else {
            return Vec::new();
        };
        let mut out: Vec<AssetDigest> = Vec::new();
        if let Some(cover) = cover_asset(&self.app, self.root(), &local_id) {
            out.push(AssetDigest {
                name: COVER_ASSET.to_string(),
                hash: cover.digest,
            });
        }
        for (name, local) in self.images(&local_id) {
            // 正文引用了这个名字，但**字节不一定在手里**：图还没下载下来时引用照样在
            // 正文里。有文件才算「有内容」（指纹 = 身份的哈希，不是文件字节：
            // 对账每次都跑，不能为了对账把整库图片读一遍），没有就报空指纹 ——
            // 报成「有」会让本机永远不去对端取这张图（正文里的引用一直断着）。
            let present = crate::book_images::images_root_at(&self.app, self.root())
                .map(|root| crate::book_images::exists(&root, &local))
                .unwrap_or(false);
            out.push(AssetDigest {
                name: name.clone(),
                hash: if present {
                    identity_digest(&name)
                } else {
                    String::new()
                },
            });
        }
        out
    }

    fn load_assets(&self, book: &str, names: &[String]) -> Vec<Asset> {
        let Some(local_id) = self.local_id(book) else {
            return Vec::new();
        };
        let mut out: Vec<Asset> = Vec::new();
        if names.iter().any(|name| name == COVER_ASSET) {
            if let Some(cover) = cover_asset(&self.app, self.root(), &local_id) {
                out.push(cover);
            }
        }
        let wanted: Vec<&String> = names
            .iter()
            .filter(|name| name.as_str() != COVER_ASSET)
            .collect();
        if wanted.is_empty() {
            return out;
        }
        let Ok(root) = crate::book_images::images_root_at(&self.app, self.root()) else {
            return out;
        };
        // 「名字 → 本地文件名」只在这里查一次：对端通常一次要一章的图，几十份
        let refs = self.images(&local_id);
        let by_name: HashMap<&str, &str> = refs
            .iter()
            .map(|(name, local)| (name.as_str(), local.as_str()))
            .collect();
        for name in wanted {
            let Some(local) = by_name.get(name.as_str()) else {
                continue;
            };
            // 名字是给对端看的（设备无关），本地文件可能还叫旧名字：`read_asset` 负责归一
            match crate::book_images::read_asset(&root, name, Some(local)) {
                Ok((mime, bytes)) => {
                    let ext = name.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
                    out.push(Asset::new(name, AssetKind::Illustration, &mime, ext, bytes));
                }
                Err(error) => {
                    // 文件不在了：这一份这次搬不过去，对端下次同步还会再要
                    log::debug!("插图读取失败（{local}）：{error}");
                }
            }
        }
        out
    }

    fn data_root(&self) -> Option<PathBuf> {
        self.own_root()
    }

    fn names(&self, book: &str) -> Vec<String> {
        let Some(local_id) = self.local_id(book) else {
            return Vec::new();
        };
        self.images(&local_id)
            .into_iter()
            .map(|(name, _)| name)
            .collect()
    }
}

/// 一本书的封面资源（没有封面 / 不是图片 data URL 时返回 `None`）。
fn cover_asset<R: tauri::Runtime>(
    app: &AppHandle<R>,
    root: Option<&Path>,
    local_id: &str,
) -> Option<Asset> {
    let data_url = book_store::get_cover_at(app, root, local_id)
        .ok()
        .flatten()?;
    let (mime, bytes) = crate::book_images::image_data_url_bytes(&data_url)?;
    if bytes.is_empty() {
        // 空载荷（`data:image/png;base64,`）当作**没有封面**：否则资源清单里会多出一条
        // 「没有内容的封面」，对账时它会被当成「本机有封面」而与对端来回搬
        log::debug!("封面 data URL 没有内容，按没有封面处理 book={local_id}");
        return None;
    }
    Some(Asset::new(COVER_ASSET, AssetKind::Cover, &mime, "", bytes).with_data_url(Some(data_url)))
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

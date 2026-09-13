//! 核心 crate 的数据模型。
//!
//! - [`book_source`]：书源定义与书源函数之间传递的对象（在线书、章节、调用结果）；
//! - App 侧的**本地书**模型（书架 / 导入）留在 `src-tauri/src/models.rs`，
//!   它不属于书源引擎，独立二进制也不需要。

pub mod book_source;

pub use book_source::{
    BookItem, BookSource, BookSourceCapabilities, BookSourceSummary, ChapterContentResult,
    ChapterItem, FetchedImage, SourceCallResult,
};

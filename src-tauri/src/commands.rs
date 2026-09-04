//! 供 WebView 调用的 Tauri command 处理器。
//! 仅负责承接 invoke 参数、把同步 I/O 放到 blocking 线程池，不直接触碰磁盘。

use crate::engine;
use crate::host;
use crate::models::{
    BookItem, BookSource, BookSourceSummary, ChapterContentResult, ChapterItem, CachedAudio,
    LocalBook, SourceCallResult, TtsCacheStat,
};
use crate::storage;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::Value;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_fs::FsExt;

#[tauri::command]
pub async fn readerx_state_get(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || storage::read_state(&app, &key))
        .await
        .map_err(|e| format!("状态读取任务失败: {e}"))?
}

#[tauri::command]
pub async fn readerx_state_set(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || storage::write_state(&app, &key, &value))
        .await
        .map_err(|e| format!("状态写入任务失败: {e}"))?
}

#[tauri::command]
pub async fn readerx_state_remove(app: AppHandle, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || storage::remove_state(&app, &key))
        .await
        .map_err(|e| format!("状态删除任务失败: {e}"))?
}

#[tauri::command]
pub async fn readerx_book_put(app: AppHandle, book: LocalBook) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || storage::put_book(&app, &book))
        .await
        .map_err(|e| format!("书籍写入任务失败: {e}"))?
}

#[tauri::command]
pub async fn readerx_book_list(app: AppHandle) -> Result<Vec<LocalBook>, String> {
    tauri::async_runtime::spawn_blocking(move || storage::list_books(&app))
        .await
        .map_err(|e| format!("书籍读取任务失败: {e}"))?
}

#[tauri::command]
pub async fn readerx_book_delete(app: AppHandle, id: String) -> Result<(), String> {
    spawn_blocking(move || storage::delete_book(&app, &id))
        .await
        .map_err(|e| format!("书籍删除任务失败: {e}"))?
}

#[tauri::command]
pub async fn readerx_tts_cache_put(
    app: AppHandle,
    book_id: String,
    key: String,
    // 音频字节（base64）
    data: String,
    // 音频 MIME
    mime: String,
) -> Result<(), String> {
    let bytes = B64
        .decode(data)
        .map_err(|e| format!("音频缓存数据不是合法 base64: {e}"))?;
    spawn_blocking(move || storage::put_tts_audio(&app, &book_id, &key, &mime, &bytes))
        .await
        .map_err(|e| format!("音频缓存写入任务失败: {e}"))?
}

/// 读取一句缓存音频；未命中返回 null
#[tauri::command]
pub async fn readerx_tts_cache_get(
    app: AppHandle,
    book_id: String,
    key: String,
) -> Result<Option<CachedAudio>, String> {
    spawn_blocking(move || -> Result<Option<CachedAudio>, String> {
        Ok(storage::get_tts_audio(&app, &book_id, &key)?.map(|(mime, bytes)| CachedAudio {
            data: B64.encode(bytes),
            mime,
        }))
    })
    .await
    .map_err(|e| format!("音频缓存读取任务失败: {e}"))?
}

async fn spawn_blocking<F, T>(f: F) -> Result<T, tauri::Error>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await
}

/// 各书籍的听书缓存统计（用于设置页展示与清理）
#[tauri::command]
pub async fn readerx_tts_cache_stats(app: AppHandle) -> Result<Vec<TtsCacheStat>, String> {
    spawn_blocking(move || storage::list_tts_cache(&app))
        .await
        .map_err(|e| format!("听书缓存统计任务失败: {e}"))?
}

/// 清除听书缓存；book_id 为 null 时清空全部书籍
#[tauri::command]
pub async fn readerx_tts_cache_clear(
    app: AppHandle,
    book_id: Option<String>,
) -> Result<(), String> {
    spawn_blocking(move || storage::clear_tts_cache(&app, book_id.as_deref()))
        .await
        .map_err(|e| format!("听书缓存清理任务失败: {e}"))?
}

/// 读取随应用打包的 LICENSE（配置在 bundle.resources，运行期位于 resource 目录）。
/// Android 的 resource 目录是 APK asset（asset:// 前缀），统一走 fs 插件读取。
#[tauri::command]
pub async fn readerx_license_text(app: AppHandle) -> Result<String, String> {
    spawn_blocking(move || -> Result<String, String> {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("无法定位资源目录: {e}"))?;
        let license_path = resource_dir.join("LICENSE");
        app.fs()
            .read_to_string(license_path)
            .map_err(|e| format!("读取开源许可失败: {e}"))
    })
    .await
    .map_err(|e| format!("开源许可读取任务失败: {e}"))?
}

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// ---------------------------------------------------------------------------
// 书源（Book Source）
// ---------------------------------------------------------------------------

/// 列出全部书源（摘要，不含 js 正文）
#[tauri::command]
pub async fn readerx_sources_list(app: AppHandle) -> Result<Vec<BookSourceSummary>, String> {
    spawn_blocking(move || {
        let sources = storage::list_book_sources(&app)?;
        Ok(sources.into_iter().map(|s| s.to_summary()).collect::<Vec<_>>())
    })
    .await
    .map_err(|e| format!("书源列表读取任务失败: {e}"))?
}

/// 读取单个书源（含 js，供编辑）
#[tauri::command]
pub async fn readerx_source_get(app: AppHandle, id: String) -> Result<Option<BookSource>, String> {
    spawn_blocking(move || storage::get_book_source(&app, &id))
        .await
        .map_err(|e| format!("书源读取任务失败: {e}"))?
}

fn validate_source(source: &BookSource) -> Result<(), String> {
    if source.name.trim().is_empty() {
        return Err("书源名称不能为空".to_string());
    }
    if source.name.trim().chars().count() > 60 {
        return Err("书源名称过长（最多 60 字）".to_string());
    }
    if source.book_source_url.trim().is_empty() {
        return Err("书源站点地址不能为空".to_string());
    }
    if source.js.trim().is_empty() {
        return Err("书源 JS 代码不能为空".to_string());
    }
    if source.js.chars().count() > 2_000_000 {
        return Err("书源 JS 代码过大（超过 200 万字符）".to_string());
    }
    Ok(())
}

/// 新建 / 覆盖保存一个书源
#[tauri::command]
pub async fn readerx_source_put(app: AppHandle, source: BookSource) -> Result<(), String> {
    spawn_blocking(move || {
        validate_source(&source)?;
        storage::put_book_source(&app, &source)
    })
    .await
    .map_err(|e| format!("书源写入任务失败: {e}"))?
}

/// 删除一个书源
#[tauri::command]
pub async fn readerx_source_delete(app: AppHandle, id: String) -> Result<(), String> {
    spawn_blocking(move || storage::delete_book_source(&app, &id))
        .await
        .map_err(|e| format!("书源删除任务失败: {e}"))?
}

/// 入口函数 → 能力开关 映射（调用前校验对应能力已启用）
fn capability_gate(source: &BookSource, fn_name: &str) -> Result<(), String> {
    if !engine::ENTRY_FUNCTIONS.contains(&fn_name) {
        return Err(format!("不支持的书源函数: {fn_name}"));
    }
    let caps = &source.capabilities;
    let enabled = match fn_name {
        "searchBook" => caps.search,
        "discoverBooks" | "discoverCategories" => caps.discover,
        "bookDetail" => caps.detail,
        "bookToc" => caps.toc,
        "bookContent" => caps.content,
        _ => true, // ENTRY_FUNCTIONS 已过滤
    };
    if !enabled {
        return Err(format!("书源「{}」已禁用「{fn_name}」能力", source.name));
    }
    Ok(())
}

/// 执行一次书源入口函数（搜索 / 发现 / 详情 / 目录 / 正文）
#[tauri::command]
pub async fn readerx_source_call(
    app: AppHandle,
    source_id: String,
    fn_name: String,
    args: serde_json::Value,
) -> Result<SourceCallResult, String> {
    spawn_blocking(move || -> Result<SourceCallResult, String> {
        let source = storage::get_book_source(&app, &source_id)?
            .ok_or_else(|| "书源不存在".to_string())?;
        if !source.enabled {
            return Err("书源已禁用".to_string());
        }
        capability_gate(&source, &fn_name)?;
        host::prepare_source(&source)?;
        let budget = if fn_name == "bookContent" {
            engine::DEFAULT_CHAPTER_BUDGET_MS
        } else {
            engine::DEFAULT_CALL_BUDGET_MS
        };
        engine::call_source_function(&source.id, &source.js, &fn_name, &args, budget)
    })
    .await
    .map_err(|e| format!("书源调用任务失败: {e}"))?
}

/// 批量拉取正文（按用户“书源并发”设置控制单源内部并行请求数）
#[tauri::command]
pub async fn readerx_source_fetch_contents(
    app: AppHandle,
    source_id: String,
    book: BookItem,
    chapters: Vec<ChapterItem>,
) -> Result<Vec<ChapterContentResult>, String> {
    spawn_blocking(move || -> Result<Vec<ChapterContentResult>, String> {
        let source = storage::get_book_source(&app, &source_id)?
            .ok_or_else(|| "书源不存在".to_string())?;
        if !source.enabled {
            return Err("书源已禁用".to_string());
        }
        if !source.capabilities.content {
            return Err(format!("书源「{}」已禁用正文能力", source.name));
        }
        host::prepare_source(&source)?;
        // 全局用户设置：readerx.onlineConcurrency（一次运行多少书源/并行请求），1-8，默认 3
        let concurrency = storage::read_state(&app, "readerx.onlineConcurrency")
            .ok()
            .flatten()
            .and_then(|v| v.as_u64())
            .unwrap_or(3)
            .clamp(1, 8) as usize;
        engine::fetch_chapter_contents(
            &source.id,
            &source.js,
            &book,
            &chapters,
            concurrency,
            engine::DEFAULT_CHAPTER_BUDGET_MS,
        )
    })
    .await
    .map_err(|e| format!("书源正文拉取任务失败: {e}"))?
}

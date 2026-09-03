//! 供 WebView 调用的 Tauri command 处理器。
//! 仅负责承接 invoke 参数、把同步 I/O 放到 blocking 线程池，不直接触碰磁盘。

use crate::models::{CachedAudio, LocalBook, TtsCacheStat};
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

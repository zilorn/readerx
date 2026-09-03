//! 供 WebView 调用的 Tauri command 处理器。
//! 仅负责承接 invoke 参数、把同步 I/O 放到 blocking 线程池，不直接触碰磁盘。

use crate::models::LocalBook;
use crate::storage;
use serde_json::Value;
use tauri::AppHandle;

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
    tauri::async_runtime::spawn_blocking(move || storage::delete_book(&app, &id))
        .await
        .map_err(|e| format!("书籍删除任务失败: {e}"))?
}

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

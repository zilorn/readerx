// ReaderX 的后端数据层：
// - 偏好 / 书架 / 分章规则等状态按 key 存为 JSON 文件；
// - 本地书籍按 id 存为独立 JSON 文件。
// 所有持久化都由 Rust 侧完成，WebView 只负责调用 command。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalBookChapter {
    title: String,
    paragraphs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalBook {
    id: String,
    title: String,
    author: String,
    format: String,
    file_name: String,
    size: u64,
    imported_at: u64,
    hue: u32,
    split_desc: String,
    chapters: Vec<LocalBookChapter>,
}

fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    Ok(dir)
}

fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))
}

fn ensure_state_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_root(app)?.join("state");
    ensure_dir(&dir)?;
    Ok(dir)
}

fn ensure_books_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_root(app)?.join("books");
    ensure_dir(&dir)?;
    Ok(dir)
}

fn valid_state_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 80
        && !key.contains("..")
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn valid_component(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.len() <= 160
        && !name.contains(['/', '\\'])
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

#[tauri::command]
async fn readerx_state_get(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_state_key(&key) {
            return Err("非法的状态 key".to_string());
        }
        let path = ensure_state_dir(&app)?.join(format!("{key}.json"));
        if !path.exists() {
            return Ok(None);
        }
        let text = fs::read_to_string(&path).map_err(|e| format!("读取状态失败: {e}"))?;
        let value = serde_json::from_str(&text).map_err(|e| format!("解析状态失败: {e}"))?;
        Ok(Some(value))
    })
    .await
    .map_err(|e| format!("状态读取任务失败: {e}"))?
}

#[tauri::command]
async fn readerx_state_set(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_state_key(&key) {
            return Err("非法的状态 key".to_string());
        }
        let path = ensure_state_dir(&app)?.join(format!("{key}.json"));
        let text = serde_json::to_string_pretty(&value).map_err(|e| format!("序列化失败: {e}"))?;
        fs::write(&path, text).map_err(|e| format!("写入状态失败: {e}"))
    })
    .await
    .map_err(|e| format!("状态写入任务失败: {e}"))?
}

#[tauri::command]
async fn readerx_state_remove(app: AppHandle, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_state_key(&key) {
            return Err("非法的状态 key".to_string());
        }
        let path = ensure_state_dir(&app)?.join(format!("{key}.json"));
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("删除状态失败: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("状态删除任务失败: {e}"))?
}

#[tauri::command]
async fn readerx_book_put(app: AppHandle, book: LocalBook) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_component(&book.id) {
            return Err("非法的书籍 id".to_string());
        }
        let dir = ensure_books_dir(&app)?;
        let path = dir.join(format!("{}.json", book.id));
        let text = serde_json::to_string(&book).map_err(|e| format!("序列化失败: {e}"))?;
        fs::write(&path, text).map_err(|e| format!("写入书籍失败: {e}"))
    })
    .await
    .map_err(|e| format!("书籍写入任务失败: {e}"))?
}

#[tauri::command]
async fn readerx_book_list(app: AppHandle) -> Result<Vec<LocalBook>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = ensure_books_dir(&app)?;
        let mut books = Vec::new();
        let entries = fs::read_dir(&dir).map_err(|e| format!("读取书库失败: {e}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(book) = serde_json::from_str::<LocalBook>(&text) {
                    books.push(book);
                }
            }
        }
        books.sort_by_key(|book| std::cmp::Reverse(book.imported_at));
        Ok(books)
    })
    .await
    .map_err(|e| format!("书籍读取任务失败: {e}"))?
}

#[tauri::command]
async fn readerx_book_delete(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_component(&id) {
            return Err("非法的书籍 id".to_string());
        }
        let dir = ensure_books_dir(&app)?;
        let path = dir.join(format!("{id}.json"));
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("删除书籍失败: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("书籍删除任务失败: {e}"))?
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            readerx_state_get,
            readerx_state_set,
            readerx_state_remove,
            readerx_book_put,
            readerx_book_list,
            readerx_book_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

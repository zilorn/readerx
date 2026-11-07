//! 书签 JSON 文件的系统保存 / 选择。
//!
//! 与备份导出同一套跨平台文件句柄（见 `data_transfer::archive`）：桌面端是普通路径，
//! Android 的 SAF 给的是 `content://` 地址，不能直接用 `std::fs` 打开。文件内容由前端
//! 生成 / 校验，这里只负责让用户选位置并读写 UTF-8 文本，不解析书签结构。

use crate::data_transfer::archive;
use serde::Serialize;
use std::io::{Read, Write};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FilePath;

/// 书签文件只保存文字与少量定位字段，16 MB 足够容纳数万条书签。
const MAX_BOOKMARK_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// 选中的书签 JSON 文件（前端负责解析数组）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedBookmarkFile {
    pub file_name: String,
    pub contents: String,
}

/// 原生选择器给出的路径（桌面端是普通路径，Android 是 `content://` 地址）。
fn path_to_string(path: FilePath) -> String {
    match path {
        FilePath::Url(url) => url.to_string(),
        FilePath::Path(path) => path.to_string_lossy().into_owned(),
    }
}

/// 从选择器返回值里取文件名；Android 的 `content://` 末段是文档 id，回落到建议名。
fn file_name_of(raw: &str, fallback: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let usable = last.to_lowercase().ends_with(".json") && !last.contains(':');
    if usable && !last.is_empty() {
        last.to_string()
    } else {
        fallback.to_string()
    }
}

/// 导出书签：弹保存框并写入前端生成的 JSON。用户取消返回 `Ok(None)`。
#[tauri::command]
pub async fn readerx_bookmarks_export(
    app: AppHandle,
    file_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    if contents.len() as u64 > MAX_BOOKMARK_FILE_BYTES {
        return Err("书签文件过大".to_string());
    }
    let picked = app
        .dialog()
        .file()
        .set_file_name(&file_name)
        .add_filter("书签 JSON", &["json"])
        .blocking_save_file();
    let Some(picked) = picked else {
        log::debug!("用户取消了书签导出");
        return Ok(None);
    };
    let raw = path_to_string(picked);
    let mut file = archive::open_destination(&app, &raw)?;
    file.write_all(contents.as_bytes())
        .map_err(|e| format!("写入书签文件失败: {e}"))?;
    Ok(Some(file_name_of(&raw, &file_name)))
}

/// 选择并读取书签 JSON 文件。用户取消返回 `Ok(None)`。
#[tauri::command]
pub async fn readerx_bookmarks_import_pick(
    app: AppHandle,
) -> Result<Option<PickedBookmarkFile>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("书签 JSON", &["json"])
        .blocking_pick_file();
    let Some(picked) = picked else {
        log::debug!("用户取消了书签导入");
        return Ok(None);
    };
    let raw = path_to_string(picked);
    let file = archive::open_source(&app, &raw)?;
    let mut bytes = Vec::new();
    file.take(MAX_BOOKMARK_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取书签文件失败: {e}"))?;
    if bytes.len() as u64 > MAX_BOOKMARK_FILE_BYTES {
        return Err("书签文件过大".to_string());
    }
    let contents = String::from_utf8(bytes).map_err(|_| "书签文件不是 UTF-8 文本".to_string())?;
    Ok(Some(PickedBookmarkFile {
        file_name: file_name_of(&raw, "bookmarks.json"),
        contents: contents.trim_start_matches('\u{feff}').to_string(),
    }))
}

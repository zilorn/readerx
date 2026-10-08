//! 导出：采集本地数据 → 写成一个 zip 归档。
//!
//! 采集口径与 `data_transfer/mod.rs` 的文件头一致：书籍（元信息 / 正文 / 书签）、
//! 状态文件、插图、书源，外加**按需**的书源登录态。听书缓存、日志、同步目录不进来。
//!
//! 数据库生成一致快照后流式写入归档，文件资源用 `std::io::copy`。
//! 不为导出复制整本或整库正文。

use super::{archive, ExportOptions, ExportSummary, Manifest, BACKUP_FORMAT};
use super::{IMAGES_DIR, SESSIONS_DIR, SOURCES_DIR, STATE_DIR};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 状态文件里装着凭据的那一个（不含登录信息导出时要抹掉密码）
const WEBDAV_SERVERS_KEY: &str = "readerx.webdavServers";

/// 一个待写入归档的条目
struct Entry {
    /// 归档内相对路径（`/` 分隔）
    name: String,
    /// 本地绝对路径
    path: PathBuf,
    /// 是否需要改写内容
    strip_webdav_passwords: bool,
}

/// 采集 + 写归档。`report(类别, 已完成, 总数)` 用于向前端推进度。
pub(super) fn export_to<R: tauri::Runtime>(
    app: &AppHandle<R>,
    destination: File,
    options: ExportOptions,
    report: &mut dyn FnMut(&str, u64, u64),
) -> Result<ExportSummary, String> {
    let root = crate::storage::data_root(app)?;
    // Migration may archive the old global bookmark state; enumerate files afterwards.
    let books = crate::book_store::backup_books(app)?;
    let book_count = books.ids()?.len() as u64;
    let mut state = Vec::new();
    walk(&root.join(STATE_DIR), STATE_DIR, &is_state_file, &mut state)?;
    let mut images = Vec::new();
    walk(
        &root.join(IMAGES_DIR),
        IMAGES_DIR,
        &is_data_file,
        &mut images,
    )?;
    let mut sources = Vec::new();
    walk(
        &root.join(SOURCES_DIR),
        SOURCES_DIR,
        &is_id_file,
        &mut sources,
    )?;
    let mut sessions = Vec::new();
    if options.include_credentials {
        walk(
            &root.join(SESSIONS_DIR),
            SESSIONS_DIR,
            &is_id_file,
            &mut sessions,
        )?;
    }
    for list in [&mut state, &mut images, &mut sources, &mut sessions] {
        list.sort_by(|a, b| a.name.cmp(&b.name));
    }

    let manifest = Manifest {
        format: BACKUP_FORMAT.to_string(),
        app_version: app.package_info().version.to_string(),
        created_at: super::now_ms(),
        credentials: options.include_credentials,
        books: book_count,
        images: images.len() as u64,
        sources: sources.len() as u64,
        state_keys: state.len() as u64,
    };

    let mut zip = archive::writer(destination);
    archive::write_manifest(&mut zip, &manifest)?;
    if !options.include_credentials {
        for entry in &mut state {
            if entry.name == format!("{STATE_DIR}/{WEBDAV_SERVERS_KEY}.json") {
                entry.strip_webdav_passwords = true;
            }
        }
    }

    for (category, entries) in [
        ("state", &state),
        ("images", &images),
        ("sources", &sources),
        ("sessions", &sessions),
    ] {
        write_entries(&mut zip, entries, category, report)?;
    }

    books.write_zip(&mut zip, report)?;

    let file = zip.finish().map_err(|e| format!("写入备份文件失败: {e}"))?;
    let bytes = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    log::info!(
        "数据导出完成 书籍={} 插图={} 书源={} 状态={} 登录信息={} 字节={}",
        manifest.books,
        manifest.images,
        manifest.sources,
        manifest.state_keys,
        manifest.credentials,
        bytes
    );
    Ok(ExportSummary {
        file_name: String::new(), // 由命令层填上（它才知道用户选的文件名）
        bytes,
        books: manifest.books,
        images: manifest.images,
        sources: manifest.sources,
        state_keys: manifest.state_keys,
        credentials: manifest.credentials,
    })
}

fn write_entries(
    zip: &mut zip::ZipWriter<File>,
    entries: &[Entry],
    category: &str,
    report: &mut dyn FnMut(&str, u64, u64),
) -> Result<(), String> {
    let total = entries.len() as u64;
    report(category, 0, total);
    for (index, entry) in entries.iter().enumerate() {
        let options = if entry.name.starts_with(IMAGES_DIR) {
            archive::image_options(Some(&entry.path))
        } else {
            archive::text_options(Some(&entry.path))
        };
        zip.start_file(&entry.name, options)
            .map_err(|e| format!("写入备份条目失败: {e}"))?;
        if entry.strip_webdav_passwords {
            let bytes = redacted_webdav(&entry.path)?;
            zip.write_all(&bytes)
                .map_err(|e| format!("写入备份条目失败: {e}"))?;
        } else {
            let mut file = File::open(&entry.path).map_err(|e| format!("读取文件失败: {e}"))?;
            std::io::copy(&mut file, zip).map_err(|e| format!("写入备份条目失败: {e}"))?;
        }
        let done = index as u64 + 1;
        // 每 8 个报一次（上千张插图时不必让界面重绘上千次），最后一个必报
        if done.is_multiple_of(8) || done == total {
            report(category, done, total);
        }
    }
    Ok(())
}

/// 不含登录信息时，WebDAV 服务器配置里的密码要抹掉再写进归档：
/// 服务地址与用户名不是凭据，留着对恢复有用；密码是。
fn redacted_webdav(path: &Path) -> Result<Vec<u8>, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("读取状态失败: {e}"))?;
    let mut value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析状态失败: {e}"))?;
    if let Some(list) = value.as_array_mut() {
        for server in list.iter_mut() {
            if let Some(object) = server.as_object_mut() {
                if object.contains_key("password") {
                    object.insert(
                        "password".to_string(),
                        serde_json::Value::String(String::new()),
                    );
                }
            }
        }
    }
    let text = serde_json::to_string_pretty(&value).map_err(|e| format!("序列化状态失败: {e}"))?;
    Ok(text.into_bytes())
}

/// 状态文件：`<key>.json`，key 必须合法（与 `readerx_state_get` 同一口径）
fn is_state_file(name: &str) -> bool {
    name.strip_suffix(".json")
        .map(crate::storage::valid_state_key)
        .unwrap_or(false)
}

/// 书源 / 登录态文件：`<id>.json`
fn is_id_file(name: &str) -> bool {
    name.strip_suffix(".json")
        .map(crate::storage::valid_component)
        .unwrap_or(false)
}

/// 插图目录里的普通数据文件（写盘中途留下的临时文件不要）
fn is_data_file(name: &str) -> bool {
    !name.starts_with('.') && !name.ends_with(".tmp") && !name.ends_with(".migrated")
}

/// 递归收集目录下的普通文件（相对路径用 `/` 连接）。
///
/// 目录不存在（比如从没下载过插图）不是错误：那类数据本来就是可选的。
fn walk(
    root: &Path,
    prefix: &str,
    accept: &dyn Fn(&str) -> bool,
    out: &mut Vec<Entry>,
) -> Result<(), String> {
    if !root.is_dir() {
        return Ok(());
    }
    let mut pending = vec![(root.to_path_buf(), prefix.to_string())];
    while let Some((dir, relative)) = pending.pop() {
        let listing =
            fs::read_dir(&dir).map_err(|e| format!("读取目录 {} 失败: {e}", dir.display()))?;
        for item in listing.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = item.file_type() else {
                continue;
            };
            let child = format!("{relative}/{name}");
            if kind.is_dir() {
                pending.push((item.path(), child));
            } else if kind.is_file() && accept(&name) {
                out.push(Entry {
                    name: child,
                    path: item.path(),
                    strip_webdav_passwords: false,
                });
            }
        }
    }
    Ok(())
}

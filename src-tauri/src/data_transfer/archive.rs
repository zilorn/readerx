//! 归档读写：zip 封装、清单、以及「目标 / 来源文件句柄」。
//!
//! 目标与来源都可能是两种东西：
//!
//! - 桌面端：系统文件选择器给的是**普通路径**，`std::fs` 直接开；
//! - Android：SAF 给的是 `content://` 地址（`ACTION_CREATE_DOCUMENT` / `ACTION_GET_CONTENT`），
//!   普通文件 API 打不开，要走 `tauri-plugin-fs` 的移动端实现拿文件描述符
//!   （`Fs::open` 内部处理 `content://`，与前端 fs 插件读写 SAF 文件是同一套）。
//!
//! 除了这两条分支，导出的 I/O 全部是普通 `File`，因此解压 / 压缩逻辑对两端完全一致，
//! 也能在单元测试里直接用真实文件跑。

use super::{is_safe_entry, Manifest, MANIFEST_NAME};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use tauri::AppHandle;
use tauri_plugin_fs::FilePath;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// 归档内的文件条目
#[derive(Debug)]
pub(super) struct ArchiveScan {
    pub manifest: Manifest,
    /// 归档文件大小（字节）
    pub bytes: u64,
    /// 全部条目名（归档顺序）
    pub entries: Vec<String>,
    /// 书籍 id（目录布局；旧布局 `books/<id>.json` 不在此列，导入时跳过）
    pub books: Vec<String>,
    /// 图片文件名
    pub images: Vec<String>,
    /// 书源 id
    pub sources: Vec<String>,
    /// 书源登录态 id
    pub sessions: Vec<String>,
    /// 状态 key
    pub state_keys: Vec<String>,
}

/// 打开写目标（导出）。
pub(super) fn open_destination<R: tauri::Runtime>(
    app: &AppHandle<R>,
    raw: &str,
) -> Result<File, String> {
    open_file(app, raw, true)
}

/// 打开读来源（导入 / 预览）。
pub(super) fn open_source<R: tauri::Runtime>(
    app: &AppHandle<R>,
    raw: &str,
) -> Result<File, String> {
    open_file(app, raw, false)
}

fn open_file<R: tauri::Runtime>(
    app: &AppHandle<R>,
    raw: &str,
    write: bool,
) -> Result<File, String> {
    if raw.trim().is_empty() {
        return Err("文件路径为空".to_string());
    }
    // `FilePath` 自己分辨「普通路径」与「URL（file:// / content://）」：两端的差异只在
    // `content://` 这一支，其余一律走标准库。
    let path = match raw.parse::<FilePath>() {
        Ok(path) => path,
        Err(never) => match never {},
    };
    if let FilePath::Path(local) = &path {
        return if write {
            File::create(local).map_err(|e| format!("创建文件失败: {e}"))
        } else {
            File::open(local).map_err(|e| format!("打开文件失败: {e}"))
        };
    }
    open_url(app, path, write)
}

/// `content://`（Android SAF）等 URL 形态的来源 / 目标。
#[cfg(target_os = "android")]
fn open_url<R: tauri::Runtime>(
    app: &AppHandle<R>,
    path: FilePath,
    write: bool,
) -> Result<File, String> {
    use tauri::Manager;
    use tauri_plugin_fs::OpenOptions;
    // 插件在 setup 时把 Fs 交给应用状态管理（见 tauri-plugin-fs 的 android::init）
    let fs = app
        .try_state::<tauri_plugin_fs::Fs<R>>()
        .ok_or_else(|| "文件访问插件不可用".to_string())?;
    let mut options = OpenOptions::new();
    if write {
        options.write(true).create(true).truncate(true);
    } else {
        options.read(true);
    }
    fs.open(path, options)
        .map_err(|e| format!("打开所选文件失败: {e}"))
}

/// 非 Android 平台不该出现 `content://`；`file://` 则退回普通路径。
#[cfg(not(target_os = "android"))]
fn open_url<R: tauri::Runtime>(
    _app: &AppHandle<R>,
    path: FilePath,
    write: bool,
) -> Result<File, String> {
    let local = path
        .into_path()
        .map_err(|_| "该文件地址不是本机可以打开的路径".to_string())?;
    if write {
        File::create(&local).map_err(|e| format!("创建文件失败: {e}"))
    } else {
        File::open(&local).map_err(|e| format!("打开文件失败: {e}"))
    }
}

/// 新建归档写入器
pub(super) fn writer(file: File) -> ZipWriter<File> {
    ZipWriter::new(file)
}

/// 文本类条目（JSON）的压缩参数
pub(super) fn text_options(source: Option<&Path>) -> SimpleFileOptions {
    file_options(source, CompressionMethod::Deflated)
}

/// 图片条目的压缩参数：JPEG / PNG 已经是压缩格式，再走 deflate 只是白烧 CPU
pub(super) fn image_options(source: Option<&Path>) -> SimpleFileOptions {
    file_options(source, CompressionMethod::Stored)
}

fn file_options(source: Option<&Path>, method: CompressionMethod) -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(method)
        .last_modified_time(modified_time(source))
        .unix_permissions(0o644)
}

/// 条目时间戳：用源文件的修改时间（清单这类没有源文件的用当前时间）。
///
/// zip 的默认值是 1980-01-01：用户解开备份看到一整套「1980 年的文件」只会以为文件坏了。
/// `DateTime` 的可表示区间是 1980–2107，越界的时钟值夹到区间内（不因此让导出失败）。
fn modified_time(source: Option<&Path>) -> zip::DateTime {
    let system = source
        .and_then(|path| fs::metadata(path).ok())
        .and_then(|meta| meta.modified().ok())
        .unwrap_or_else(std::time::SystemTime::now);
    let offset = time::UtcOffset::current_local_offset().unwrap_or(time::UtcOffset::UTC);
    let local = time::OffsetDateTime::from(system).to_offset(offset);
    zip::DateTime::from_date_and_time(
        local.year().clamp(1980, 2107) as u16,
        u8::from(local.month()),
        local.day(),
        local.hour(),
        local.minute(),
        local.second(),
    )
    .unwrap_or_default()
}

/// 写入清单（归档的第一个条目）
pub(super) fn write_manifest(zip: &mut ZipWriter<File>, manifest: &Manifest) -> Result<(), String> {
    let text =
        serde_json::to_string_pretty(manifest).map_err(|e| format!("序列化备份清单失败: {e}"))?;
    zip.start_file(MANIFEST_NAME, text_options(None))
        .map_err(|e| format!("写入备份清单失败: {e}"))?;
    zip.write_all(text.as_bytes())
        .map_err(|e| format!("写入备份清单失败: {e}"))
}

/// 读归档：清单 + 全部条目名的分类结果（不解压正文）。
///
/// 预览与实际导入都用它：预览只取清单与文件大小，导入再多读具体条目。
pub(super) fn scan<R: tauri::Runtime>(
    app: &AppHandle<R>,
    path: &str,
) -> Result<ArchiveScan, String> {
    let file = open_source(app, path)?;
    let bytes = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let mut zip = open_zip_from(file)?;
    let manifest = read_manifest(&mut zip)?;
    Ok(classify(&mut zip, manifest, bytes))
}

/// 把文件当 zip 打开（列条目 / 读单个条目都从这里开始）
pub(super) fn open_zip_from(file: File) -> Result<ZipArchive<File>, String> {
    ZipArchive::new(file).map_err(|e| format!("无法读取备份文件（{e}）"))
}

pub(super) fn read_manifest(zip: &mut ZipArchive<File>) -> Result<Manifest, String> {
    let mut entry = zip
        .by_name(MANIFEST_NAME)
        .map_err(|_| "这不是 ReaderX 备份文件（缺少清单）".to_string())?;
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|e| format!("读取备份清单失败: {e}"))?;
    let manifest: Manifest =
        serde_json::from_str(&text).map_err(|e| format!("备份清单无法解析: {e}"))?;
    if !super::format_supported(&manifest.format) {
        return Err("备份格式版本不受支持（可能由更新版本的 ReaderX 导出）".to_string());
    }
    Ok(manifest)
}

/// 把条目名按顶层目录分类，顺带做安全校验（见 [`is_safe_entry`]）。
pub(super) fn classify(zip: &mut ZipArchive<File>, manifest: Manifest, bytes: u64) -> ArchiveScan {
    let mut books: Vec<String> = Vec::new();
    let mut images: Vec<String> = Vec::new();
    let mut sources: Vec<String> = Vec::new();
    let mut sessions: Vec<String> = Vec::new();
    let mut state_keys: Vec<String> = Vec::new();
    let mut entries: Vec<String> = Vec::new();

    for name in zip.file_names() {
        if name == MANIFEST_NAME {
            continue;
        }
        if !is_safe_entry(name) {
            // 归档是用户给的文件：不安全的条目名直接不认，也不让它参与后面的任何写入
            log::warn!("备份里有不安全的条目名，已忽略");
            continue;
        }
        entries.push(name.to_string());
        let mut parts = name.splitn(3, '/');
        let top = parts.next().unwrap_or_default();
        let second = parts.next().unwrap_or_default();
        let third = parts.next();
        match top {
            super::STATE_DIR => {
                let Some(key) = second.strip_suffix(".json") else {
                    continue;
                };
                if third.is_none() && valid_state_key(key) {
                    state_keys.push(key.to_string());
                }
            }
            super::BOOKS_DIR => {
                if let Some(file) = third {
                    // 目录布局：`books/<id>/<file>`（书籍目录里只有一层文件，更深的不要）
                    if file.is_empty() || file.contains('/') || !valid_key(second) {
                        continue;
                    }
                    if !books.iter().any(|id| id == second) {
                        books.push(second.to_string());
                    }
                } else if second.ends_with(".json") {
                    // 旧布局 `books/<id>.json`：导出侧已经在读的时候迁移过，出现它说明
                    // 归档来自更老的版本；导入不认这种条目（宁可少一本也不半懂地写）
                    log::warn!("备份里存在旧布局的书籍条目，已跳过");
                }
            }
            super::IMAGES_DIR => {
                if third.is_none() && valid_image(second) {
                    images.push(second.to_string());
                }
            }
            super::SOURCES_DIR => {
                if let Some(id) = second.strip_suffix(".json") {
                    if third.is_none() && valid_key(id) {
                        sources.push(id.to_string());
                    }
                }
            }
            super::SESSIONS_DIR => {
                if let Some(id) = second.strip_suffix(".json") {
                    if third.is_none() && valid_key(id) {
                        sessions.push(id.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    let sort_unique = |list: &mut Vec<String>| {
        list.sort();
        list.dedup();
    };
    sort_unique(&mut books);
    sort_unique(&mut images);
    sort_unique(&mut sources);
    sort_unique(&mut sessions);
    sort_unique(&mut state_keys);
    entries.sort();

    ArchiveScan {
        manifest,
        bytes,
        entries,
        books,
        images,
        sources,
        sessions,
        state_keys,
    }
}

/// 读一个条目的全部字节；条目不存在返回 `Ok(None)`
pub(super) fn read_entry(
    zip: &mut ZipArchive<File>,
    name: &str,
) -> Result<Option<Vec<u8>>, String> {
    let mut entry = match zip.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(format!("读取备份条目失败: {error}")),
    };
    // ZIP 的解压大小来自不可信元数据；仅按实际读到的内容增长，避免畸形声明触发巨量分配。
    let mut bytes = Vec::new();
    entry
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取备份条目失败: {e}"))?;
    Ok(Some(bytes))
}

/// 读一个条目并解析成 JSON；不存在返回 `Ok(None)`，内容坏了返回错误。
pub(super) fn read_entry_json(
    zip: &mut ZipArchive<File>,
    name: &str,
) -> Result<Option<serde_json::Value>, String> {
    let Some(bytes) = read_entry(zip, name)? else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("备份条目 {name} 无法解析: {e}"))
}

/// 书籍 / 书源 / 登录态的 id 是否可安全用作文件名（与 `storage::valid_component` 同口径）
fn valid_key(name: &str) -> bool {
    crate::storage::valid_component(name)
}

/// 状态 key 的合法性（与 `readerx_state_get` 同一口径）
fn valid_state_key(key: &str) -> bool {
    crate::storage::valid_state_key(key)
}

/// 图片文件名合法性（`<bookId>_<sha1hex>.<ext>`，由 `book_images` 定义）
fn valid_image(name: &str) -> bool {
    crate::book_images::valid_local_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_allocation_ignores_declared_uncompressed_size() {
        let dir = std::env::temp_dir().join(format!("readerx-archive-size-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("backup.zip");
        for method in [CompressionMethod::Stored, CompressionMethod::Deflated] {
            let mut writer = writer(File::create(&path).unwrap());
            writer
                .start_file(
                    "state/readerx.shelf.json",
                    SimpleFileOptions::default().compression_method(method),
                )
                .unwrap();
            writer.write_all(b"{}").unwrap();
            writer.finish().unwrap();

            // 只篡改中央目录中的解压大小，实际压缩数据与 CRC 保持有效。
            let mut raw = fs::read(&path).unwrap();
            let central = raw
                .windows(4)
                .position(|bytes| bytes == b"PK\x01\x02")
                .unwrap();
            let declared_size = u32::MAX - 1;
            raw[central + 24..central + 28].copy_from_slice(&declared_size.to_le_bytes());
            fs::write(&path, raw).unwrap();

            let mut zip = open_zip_from(File::open(&path).unwrap()).unwrap();
            assert_eq!(
                zip.by_name("state/readerx.shelf.json").unwrap().size(),
                u64::from(declared_size)
            );
            let bytes = read_entry(&mut zip, "state/readerx.shelf.json")
                .unwrap()
                .unwrap();
            assert_eq!(bytes, b"{}");
            assert!(bytes.capacity() < 64 * 1024, "不应按声明大小预分配");
            assert_eq!(read_entry(&mut zip, "missing.json").unwrap(), None);
            assert_eq!(
                read_entry_json(&mut zip, "state/readerx.shelf.json").unwrap(),
                Some(serde_json::json!({}))
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }

    /// zip 的默认时间戳是 1980-01-01：解开备份看到一整套「1980 年的文件」会被当成文件坏了，
    /// 因此条目时间取源文件的修改时间，没有源文件的取当前时间。
    #[test]
    fn timestamps_never_fall_back_to_the_1980_default() {
        let dir = std::env::temp_dir().join(format!("readerx-archive-time-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("sample.json");
        fs::write(&file, b"{}").expect("写临时文件");
        assert!(modified_time(Some(&file)).year() >= 2020, "源文件时间");
        assert!(modified_time(None).year() >= 2020, "没有源文件时用当前时间");
        let _ = fs::remove_dir_all(&dir);
    }
}

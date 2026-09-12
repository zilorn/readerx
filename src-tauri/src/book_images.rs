//! 章节插图的本地文件存储。
//!
//! 图片**不再以 data URL 存进书籍 JSON**：下载完成后字节落到
//! `<应用数据目录>/images/<bookId>_<sha1(图片地址)>.<ext>`，章节块里只留文件名
//! （`ChapterBlock.local`）。这样：
//! - 书籍 JSON 体积与「图片总量」解耦，读写 / 解析不再分配几百 MB 的 base64；
//! - 图片字节不过 IPC、不进 WebView 的 JS 字符串，内存占用与图片数量解耦；
//! - 渲染时由自定义协议 `readerx-img://`（Android 上为 `http://readerx-img.localhost/`）
//!   直接从文件流式读取，WebView 仍能离线显示。
//!
//! 旧数据（`src` 是 data URL，或 Rust 侧回写丢过 `remote` 字段）在书籍读取 / 回写时
//! 由 [`migrate_book`] 就地迁移：写成文件后只留引用，失败则原样保留（不丢图）。

use crate::models::{BookImageFile, BookImageInfo, LocalBook};
use base64::Engine;
use std::fs;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use tauri::http;
use tauri::{AppHandle, Manager};

/// 图片文件名里的哈希长度（sha1 hex）：`<bookId>_<40 位 hex>.<ext>`
const HASH_LEN: usize = 40;

/// 章节图片根目录：`<应用数据目录>/images`（所有函数都按「根目录 + 文件名」工作，
/// 与 Tauri 解耦，便于单测直接用临时目录验证存储 / 迁移）
pub(crate) fn images_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?
        .join("images");
    fs::create_dir_all(&dir).map_err(|e| format!("创建图片目录失败: {e}"))?;
    Ok(dir)
}

/// 书籍 id 是否可安全用作文件名前缀（与 storage::valid_component 同口径）
fn valid_book_id(book_id: &str) -> bool {
    !book_id.is_empty()
        && book_id != "."
        && book_id != ".."
        && book_id.len() <= 160
        && book_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// 本地副本文件名是否合法：必须是本模块写出的 `<bookId>_<sha1hex>.<ext>` 形态
/// （文件名即 URL 路径段，直接用于自定义协议，必须严格校验，杜绝路径穿越）
fn valid_local_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    if ext.is_empty() || ext.len() > 8 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    let Some((book_id, hash)) = stem.rsplit_once('_') else {
        return false;
    };
    valid_book_id(book_id)
        && hash.len() == HASH_LEN
        && hash
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// 图片 MIME → 文件扩展名（未知按 bin，仍可落盘；渲染时由响应头 MIME 兜底）
fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        _ => "bin",
    }
}

/// MIME → 响应 Content-Type（落盘扩展名未知时按 bin 存，这里反向补回）
fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// 落盘一张图片，返回本地副本文件名（幂等：同一地址已存在则不重复写）。
/// 落盘一张图片，返回本地副本文件名。
/// 文件名由图片身份（地址）哈希决定，因此**同一地址始终对应同一个文件**：
/// 重新下载（占位框「重试」）会覆盖旧文件，不会留下新旧两份。
/// `identity` 为图片身份（在线图为原始网络地址，旧数据迁移时为 data URL 自身）。
pub(crate) fn store(
    root: &Path,
    book_id: &str,
    identity: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<String, String> {
    if !valid_book_id(book_id) {
        return Err("非法的书籍 id".to_string());
    }
    let name = format!(
        "{book_id}_{}.{}",
        crate::host::sha1_hex(identity),
        ext_for_mime(mime)
    );
    fs::create_dir_all(root).map_err(|e| format!("创建图片目录失败: {e}"))?;
    fs::write(root.join(&name), bytes).map_err(|e| format!("写入图片失败: {e}"))?;
    Ok(name)
}

/// 本地副本文件名 → 绝对路径（严格校验，越界一律拒绝）
pub(crate) fn resolve(root: &Path, local: &str) -> Result<PathBuf, String> {
    if !valid_local_name(local) {
        return Err("非法的图片引用".to_string());
    }
    Ok(root.join(local))
}

/// 本地副本是否已存在
pub(crate) fn exists(root: &Path, local: &str) -> bool {
    match resolve(root, local) {
        Ok(path) => path.is_file(),
        Err(_) => false,
    }
}

/// 读取若干本地副本的尺寸 / 体积（只读文件头，不解码整张图）
pub(crate) fn info(root: &Path, locals: &[String]) -> Vec<BookImageInfo> {
    let mut out = Vec::with_capacity(locals.len());
    // 复用同一块头缓冲：一章几百张图时不至于为每张图各分配一次
    let mut head = vec![0u8; 64 * 1024];
    for local in locals {
        let Ok(path) = resolve(root, local) else {
            continue;
        };
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let read = fs::File::open(&path)
            .and_then(|mut file| file.read(&mut head))
            .unwrap_or(0);
        let (width, height) = crate::host::image_dimensions(&head[..read]).unwrap_or((0, 0));
        out.push(BookImageInfo {
            local: local.clone(),
            width,
            height,
            bytes: metadata.len(),
        });
    }
    out
}

/// 删除某本书的全部图片文件（书籍删除时调用）；返回删除的文件数
pub(crate) fn remove_book(root: &Path, book_id: &str) -> u64 {
    let prefix = format!("{book_id}_");
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with(&prefix)
            && valid_local_name(name)
            && fs::remove_file(entry.path()).is_ok()
        {
            removed += 1;
        }
    }
    removed
}

/// 自定义协议 `readerx-img` 的响应：把 `<local>` 映射到 images/ 下的文件。
/// 只接受本模块写出的文件名，任何非法引用都返回 403，不做目录浏览 / 路径拼接。
pub(crate) fn serve(root: &Path, request: &http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
    let plain = |status: http::StatusCode, body: &str| {
        http::Response::builder()
            .status(status)
            .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(body.as_bytes().to_vec())
            .unwrap_or_else(|_| http::Response::new(Vec::new()))
    };
    let path = request.uri().path().trim_start_matches('/');
    let name = percent_decode(path);
    if !valid_local_name(&name) {
        return plain(http::StatusCode::FORBIDDEN, "非法的图片引用");
    }
    let Ok(file) = resolve(root, &name) else {
        return plain(http::StatusCode::FORBIDDEN, "非法的图片引用");
    };
    match fs::read(&file) {
        Ok(bytes) => {
            let ext = name.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
            http::Response::builder()
                .status(http::StatusCode::OK)
                .header(http::header::CONTENT_TYPE, mime_for_ext(ext))
                .header(http::header::CACHE_CONTROL, "no-store")
                .body(bytes)
                .unwrap_or_else(|_| http::Response::new(Vec::new()))
        }
        Err(_) => plain(http::StatusCode::NOT_FOUND, "图片不存在"),
    }
}

/// 最小 percent 解码（自定义协议路径只会有我们自己写出的文件名，
/// 这里兜住 WebView 可能带上的转义；非法转义按原样保留）
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(value) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// data URL（`data:image/png;base64,…`）→ (MIME, 原始字节)
fn decode_data_url(data_url: &str) -> Option<(String, Vec<u8>)> {
    let (mime, payload) = split_data_url(data_url)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .ok()?;
    Some((mime, bytes))
}

/// data URL → (MIME, base64 载荷)；非 base64 形式 / 非图片返回 None
fn split_data_url(data_url: &str) -> Option<(String, &str)> {
    let rest = data_url.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    if !meta.contains("base64") {
        return None;
    }
    let mime = meta.split(';').next().unwrap_or("").trim().to_string();
    if !mime.starts_with("image/") {
        return None;
    }
    Some((mime, payload))
}

// ---------------------------------------------------------------------------
// 超大书籍文件的「流式」迁移
//
// 旧版本把图片以 data URL 写进章节，一本漫画书的 JSON 可能几百 MB：先整本解析成
// LocalBook 再迁移，等于要在内存里放下一整本书的 base64（正是崩溃的原因）。
// 这里按字节流重写文件、边读边把图片抽成文件，内存占用只与「单张图片」同级：
//   "src":"data:image/png;base64,AAAA…"  →  "src":"","local":"<bookId>_<sha1>.png"
// 任何异常（畸形 JSON / 载荷过大）都放弃迁移并保留原文件，绝不让书变得更糟。
// ---------------------------------------------------------------------------

/// 触发流式迁移的书籍文件下限：更小的书直接走内存路径（解析一遍再迁移），
/// 避免为了几 MB 的文件多读多写一遍；达到这个量级的旧书才可能把内存撑爆。
pub(crate) const STREAM_MIGRATE_MIN_BYTES: u64 = 24 * 1024 * 1024;
/// 单张 data URL 的 base64 载荷上限（超过视为畸形，放弃迁移）
const MAX_DATA_URL_PAYLOAD: usize = 32 * 1024 * 1024;
/// 流式扫描的读缓冲大小
const STREAM_CHUNK: usize = 64 * 1024;

/// `"src":"…"` 成员的键前缀（值为 data URL 时会被就地替换）
const SRC_KEY: &[u8] = b"\"src\":";
/// 内嵌图片的字节特征：文件里完全没有它就不必重写
const DATA_IMAGE_MARK: &[u8] = b"data:image/";

/// 只读预检：文件里是否还有以 data URL 内嵌的图片（跨读缓冲边界也认得出）。
/// 大到需要流式迁移的书多为纯文本巨书，先扫一遍可以避免无谓地整本重写。
pub(crate) fn file_has_data_image(path: &Path) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut reader = BufReader::with_capacity(STREAM_CHUNK, file);
    let mut buf = vec![0u8; STREAM_CHUNK];
    // 上一块末尾的若干字节要留下来，避免特征被读缓冲切成两半而漏判
    let mut carry: Vec<u8> = Vec::new();
    loop {
        let read = match reader.read(&mut buf) {
            Ok(read) => read,
            Err(_) => return false,
        };
        if read == 0 {
            return false;
        }
        carry.extend_from_slice(&buf[..read]);
        if carry
            .windows(DATA_IMAGE_MARK.len())
            .any(|window| window == DATA_IMAGE_MARK)
        {
            return true;
        }
        let keep = DATA_IMAGE_MARK.len() - 1;
        if carry.len() > keep {
            let cut = carry.len() - keep;
            carry.drain(..cut);
        }
    }
}

/// 在缓冲区里找下一个 `"src":` 的位置
fn find_src_key(buf: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i + SRC_KEY.len() <= buf.len() {
        let rel = buf[i..].iter().position(|&b| b == b'"')?;
        let at = i + rel;
        if at + SRC_KEY.len() <= buf.len() && &buf[at..at + SRC_KEY.len()] == SRC_KEY {
            return Some(at);
        }
        i = at + 1;
    }
    None
}

/// 从 `"src":` 之后解析字符串值。返回 (闭引号之后的下标, 值)；
/// 缓冲区里还没有闭引号时返回 None（调用方继续读文件）。
fn parse_string_at(buf: &[u8], after_key: usize) -> Option<(usize, &str)> {
    let mut i = after_key;
    while i < buf.len() && matches!(buf[i], b' ' | b'\t' | b'\r' | b'\n') {
        i += 1;
    }
    if i >= buf.len() || buf[i] != b'"' {
        return None;
    }
    let start = i + 1;
    let rel = buf[start..].iter().position(|&b| b == b'"')?;
    let end = start + rel;
    std::str::from_utf8(&buf[start..end])
        .ok()
        .map(|value| (end + 1, value))
}

fn write_failed(error: std::io::Error) -> String {
    format!("写入书籍失败: {error}")
}

/// 一个 `"src"` 值对应的替换结果：Some(本地文件名) 表示已抽成文件，None 表示原样保留
fn image_local_for(root: &Path, book_id: &str, value: &str) -> Result<Option<String>, String> {
    if !value.starts_with("data:image/") {
        return Ok(None);
    }
    // 非 base64 的 data URL（如 data:image/svg+xml,<svg…>）保持原样，不认识的形态不动它
    let Some((mime, payload)) = split_data_url(value) else {
        return Ok(None);
    };
    if payload.len() > MAX_DATA_URL_PAYLOAD {
        return Err("图片 data URL 过大，跳过图片迁移".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("图片 base64 解析失败: {e}"))?;
    // 图片身份用 data URL 自身（旧数据里没有网络地址可作身份）
    store(root, book_id, value, &mime, &bytes).map(Some)
}

/// 边读边写地重写一本书 JSON（内部实现，见 [`migrate_book_file`]）；返回是否有替换
fn stream_rewrite_images(
    root: &Path,
    book_id: &str,
    reader: &mut BufReader<fs::File>,
    writer: &mut BufWriter<fs::File>,
    carry: &mut Vec<u8>,
    chunk: &mut [u8],
) -> Result<bool, String> {
    let mut changed = false;
    loop {
        let read = reader
            .read(chunk)
            .map_err(|e| format!("读取书籍失败: {e}"))?;
        let eof = read == 0;
        if !eof {
            carry.extend_from_slice(&chunk[..read]);
        }
        let mut emitted = 0usize;
        loop {
            let Some(at) = find_src_key(&carry[emitted..]).map(|rel| emitted + rel) else {
                // 没有更多候选：留下可能是半个 `"src":` 的尾巴，其余原样写出
                let keep = (SRC_KEY.len() - 1).min(carry.len() - emitted);
                let safe = carry.len() - emitted - keep;
                writer
                    .write_all(&carry[emitted..emitted + safe])
                    .map_err(write_failed)?;
                emitted += safe;
                break;
            };
            let Some((value_end, value)) = parse_string_at(carry, at + SRC_KEY.len()) else {
                if eof {
                    // 文件不完整 / 畸形：放弃迁移（临时文件会被丢掉，原书一字未改）
                    return Err("书籍文件不完整，跳过图片迁移".to_string());
                }
                // 值还没读全：先写出 `"src":` 之前的部分，保留后半段继续读
                writer
                    .write_all(&carry[emitted..at])
                    .map_err(write_failed)?;
                emitted = at;
                break;
            };
            let replacement = image_local_for(root, book_id, value)?;
            writer
                .write_all(&carry[emitted..at])
                .map_err(write_failed)?;
            match replacement {
                Some(local) => {
                    changed = true;
                    // 图片身份未知（旧数据 src 里只有 base64）：src 置空，渲染按 local 读文件
                    writer
                        .write_all(format!("\"src\":\"\",\"local\":\"{local}\"").as_bytes())
                        .map_err(write_failed)?;
                }
                // 原样保留（含 `"src": "…"` 之间的空白）
                None => writer
                    .write_all(&carry[at..value_end])
                    .map_err(write_failed)?,
            }
            emitted = value_end;
        }
        carry.drain(..emitted);
        if eof {
            // 收尾：没有更多数据了，尾部残余字节（含可能是半个 `"src":` 的尾巴）原样写出
            writer.write_all(carry).map_err(write_failed)?;
            carry.clear();
            break;
        }
        // 单个值始终读不到闭引号（畸形文件）：不让缓冲区无限增长
        if carry.len() > MAX_DATA_URL_PAYLOAD + STREAM_CHUNK * 2 {
            return Err("图片 data URL 过大，跳过图片迁移".to_string());
        }
    }
    Ok(changed)
}

/// 流式迁移一本书文件里的 data URL 图片（见上方说明）。返回是否有改动。
/// 出错或无改动时都会删掉临时文件，原书保持不变。
pub(crate) fn migrate_book_file(root: &Path, book_id: &str, path: &Path) -> Result<bool, String> {
    if !valid_book_id(book_id) {
        return Err("非法的书籍 id".to_string());
    }
    let tmp = path.with_extension("json.tmp");
    let input = fs::File::open(path).map_err(|e| format!("读取书籍失败: {e}"))?;
    let output = fs::File::create(&tmp).map_err(|e| format!("写入书籍失败: {e}"))?;
    let mut reader = BufReader::with_capacity(STREAM_CHUNK, input);
    let mut writer = BufWriter::new(output);
    let mut carry: Vec<u8> = Vec::with_capacity(STREAM_CHUNK * 2);
    let mut chunk = vec![0u8; STREAM_CHUNK];

    let outcome = stream_rewrite_images(
        root,
        book_id,
        &mut reader,
        &mut writer,
        &mut carry,
        &mut chunk,
    );
    let changed = match outcome {
        Ok(changed) => changed,
        Err(error) => {
            drop(writer);
            let _ = fs::remove_file(&tmp);
            return Err(error);
        }
    };
    if !changed {
        drop(writer);
        let _ = fs::remove_file(&tmp);
        return Ok(false);
    }
    if let Err(error) = writer.flush() {
        drop(writer);
        let _ = fs::remove_file(&tmp);
        return Err(format!("写入书籍失败: {error}"));
    }
    drop(writer);
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("写入书籍失败: {e}")
    })?;
    Ok(true)
}

/// 图片块的旧数据迁移与自愈（幂等）：
/// 1. `local` 指向的文件不在了 → 清掉引用（下次读到本章重新下载，而不是永远裂图）；
/// 2. 网络地址存在但 `remote` 缺失（旧版 Rust 回写会把未知字段丢掉）→ 补回 `remote`；
/// 3. `src` 还是 data URL（旧版把图片塞进章节）→ 写成文件，只留 `local` 引用。
///
/// 写盘失败时保留原 data URL（图片不丢，只是这次没瘦身）。返回是否有改动。
pub(crate) fn migrate_book(root: &Path, book: &mut LocalBook) -> bool {
    let book_id = book.id.clone();
    if !valid_book_id(&book_id) {
        return false;
    }
    let mut changed = false;
    for chapter in &mut book.chapters {
        let Some(blocks) = chapter.blocks.as_mut() else {
            continue;
        };
        for block in blocks.iter_mut() {
            if block.kind != "img" {
                continue;
            }
            if let Some(local) = block.local.clone() {
                if !exists(root, &local) {
                    block.local = None;
                    changed = true;
                }
            }
            if block.remote.is_none() {
                if let Some(src) = block.src.clone() {
                    if src.starts_with("http://") || src.starts_with("https://") {
                        block.remote = Some(src);
                        changed = true;
                    }
                }
            }
            let Some(src) = block.src.clone() else {
                continue;
            };
            if !src.starts_with("data:image/") {
                continue;
            }
            let Some((mime, bytes)) = decode_data_url(&src) else {
                continue;
            };
            let identity = block.remote.clone().unwrap_or_else(|| src.clone());
            match store(root, &book_id, &identity, &mime, &bytes) {
                Ok(local) => {
                    block.local = Some(local);
                    // 正文里不再保留图片字节：有网络地址就留网络地址，否则留空
                    block.src = block.remote.clone();
                    changed = true;
                }
                Err(_) => continue,
            }
        }
    }
    changed
}

/// 下载结果 → 回给前端的 `BookImageFile`：落盘并读出尺寸（失败也以 ok:false 收场，
/// 让阅读页显示可重试的占位而不是抛异常）。
pub(crate) fn fetch_result(
    root: &Path,
    book_id: &str,
    identity: &str,
    mime: &str,
    bytes: &[u8],
) -> BookImageFile {
    match store(root, book_id, identity, mime, bytes) {
        Ok(local) => {
            let (width, height) = crate::host::image_dimensions(bytes).unwrap_or((0, 0));
            BookImageFile {
                ok: true,
                local,
                width,
                height,
                bytes: bytes.len() as u64,
                error: String::new(),
            }
        }
        Err(error) => BookImageFile {
            ok: false,
            local: String::new(),
            width: 0,
            height: 0,
            bytes: 0,
            error,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ChapterBlock, LocalBookChapter};

    /// 临时目录（测试自己创建 / 清理；不依赖 tauri 的路径解析）
    fn temp_root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("readerx-book-images-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn image_block(src: &str, remote: Option<&str>, local: Option<&str>) -> ChapterBlock {
        ChapterBlock {
            kind: "img".to_string(),
            text: None,
            level: None,
            src: Some(src.to_string()),
            alt: None,
            remote: remote.map(|v| v.to_string()),
            local: local.map(|v| v.to_string()),
        }
    }

    fn book_with(blocks: Vec<ChapterBlock>) -> LocalBook {
        LocalBook {
            id: "book-1".to_string(),
            title: "书".to_string(),
            author: "作者".to_string(),
            intro: None,
            format: "online".to_string(),
            file_name: "book".to_string(),
            size: 0,
            imported_at: 0,
            hue: 0,
            split_desc: "在线书".to_string(),
            cover: None,
            chapters: vec![LocalBookChapter {
                cid: "c0001".to_string(),
                title: "第一章".to_string(),
                paragraphs: vec![],
                blocks: Some(blocks),
                url: Some("https://example.com/1".to_string()),
            }],
            group_id: None,
            source: Some("online".to_string()),
            book_source_id: Some("src-1".to_string()),
            book_url: None,
            tags: None,
        }
    }

    fn png_bytes() -> Vec<u8> {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&300u32.to_be_bytes());
        png.extend_from_slice(&200u32.to_be_bytes());
        png
    }

    fn data_url(mime: &str, bytes: &[u8]) -> String {
        format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    #[test]
    fn local_names_are_strictly_validated() {
        let hash = "a".repeat(HASH_LEN);
        assert!(valid_local_name(&format!("c0001_{hash}.jpg")));
        assert!(valid_local_name(&format!("book-1_x_{hash}.webp")));
        assert!(!valid_local_name("../etc/passwd"));
        assert!(!valid_local_name(&format!("c0001_{hash}")));
        assert!(!valid_local_name(&format!(
            "c0001_{}.jpg",
            "z".repeat(HASH_LEN)
        )));
        assert!(!valid_local_name(&format!(
            "c0001_{}.jpg",
            "A".repeat(HASH_LEN)
        )));
        assert!(!valid_local_name("c0001_short.jpg"));
        assert!(!valid_local_name(&format!("c0001_{hash}.jp/eg")));
    }

    #[test]
    fn data_url_roundtrip() {
        let raw = b"\x89PNG\r\n\x1a\npayload";
        let url = data_url("image/png", raw);
        let (mime, bytes) = decode_data_url(&url).expect("decode");
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, raw);
        assert!(decode_data_url("data:text/plain;base64,aGk=").is_none());
        assert!(decode_data_url("data:image/png,notbase64").is_none());
    }

    #[test]
    fn percent_decode_handles_escapes_and_garbage() {
        assert_eq!(percent_decode("c0001_abc.jpg"), "c0001_abc.jpg");
        assert_eq!(percent_decode("c0001%5Fabc.jpg"), "c0001_abc.jpg");
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("100%zz"), "100%zz");
    }

    #[test]
    fn store_keeps_one_file_per_identity() {
        let root = temp_root("store");
        let bytes = png_bytes();
        let first = store(&root, "book-1", "https://img/1.png", "image/png", &bytes).unwrap();
        let again = store(&root, "book-1", "https://img/1.png", "image/png", &bytes).unwrap();
        assert_eq!(
            first, again,
            "同一地址始终对应同一个文件名（重下覆盖，不留新旧两份）"
        );
        assert!(root.join(&first).is_file());
        assert!(exists(&root, &first));
        assert!(!exists(&root, "../escape.png"));

        let info = info(&root, &[first.clone(), "bad name.png".to_string()]);
        assert_eq!(info.len(), 1);
        assert_eq!((info[0].width, info[0].height), (300, 200));

        assert_eq!(remove_book(&root, "book-1"), 1);
        assert!(!exists(&root, first.as_str()));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_extracts_legacy_data_urls_and_repairs_remote() {
        let root = temp_root("migrate");
        let bytes = png_bytes();
        let legacy = data_url("image/png", &bytes);
        let mut book = book_with(vec![
            // 旧数据：图片字节在 src 里，remote 被早期 Rust 回写丢掉了
            image_block(&legacy, None, None),
            // 旧数据：remote 还在（图片身份可保留，迁移后仍能重试）
            image_block(&legacy, Some("https://img/2.png"), None),
            // 已经有本地副本但文件不在了：应清掉引用（下次重新下载）
            image_block(
                "https://img/3.png",
                Some("https://img/3.png"),
                Some("book-1_missing.png"),
            ),
            // 正常网络地址：只补 remote
            image_block("https://img/4.png", None, None),
        ]);

        assert!(migrate_book(&root, &mut book));
        let blocks = book.chapters[0].blocks.as_ref().unwrap();

        // 1) data URL → 文件，src 不再保留图片字节
        let local0 = blocks[0].local.clone().expect("迁移后应有本地副本");
        assert!(exists(&root, &local0));
        assert_eq!(blocks[0].src, None, "无网络地址时 src 置空，渲染走本地副本");
        assert_eq!(fs::read(root.join(&local0)).unwrap(), bytes);

        // 2) 有 remote：保留图片身份，src 回到网络地址
        assert!(blocks[1].local.is_some());
        assert_eq!(blocks[1].src.as_deref(), Some("https://img/2.png"));
        assert_eq!(blocks[1].remote.as_deref(), Some("https://img/2.png"));

        // 3) 本地副本丢失 → 清引用（下次读到本章会重新下载）
        assert_eq!(blocks[2].local, None);
        assert_eq!(blocks[2].remote.as_deref(), Some("https://img/3.png"));

        // 4) remote 补齐（旧版回写丢字段的自愈）
        assert_eq!(blocks[3].remote.as_deref(), Some("https://img/4.png"));

        // 幂等：再跑一次不应再有改动
        assert!(!migrate_book(&root, &mut book));
        let _ = fs::remove_dir_all(&root);
    }

    /// 流式迁移：把章节里的 data URL 图片抽成文件，JSON 只留引用
    /// 只读预检：认得出内嵌图片，跨读缓冲边界也认得出；纯文本巨书不误判
    #[test]
    fn data_image_precheck_detects_embedded_images() {
        let root = temp_root("precheck");
        let path = root.join("book-1.json");

        fs::write(&path, r#"{"blocks":[{"kind":"p","text":"正文"}]}"#).unwrap();
        assert!(!file_has_data_image(&path));

        fs::write(&path, r#"{"src":"data:image/png;base64,AAAA"}"#).unwrap();
        assert!(file_has_data_image(&path));

        // 特征被读缓冲切成两半（正好跨 STREAM_CHUNK 边界）
        let json = format!(
            r#"{{"fill":"{}","src":"data:image/png;base64,AAAA"}}"#,
            "x".repeat(STREAM_CHUNK - 12)
        );
        fs::write(&path, &json).unwrap();
        assert!(file_has_data_image(&path));

        // 不存在的文件按「没有」处理，不 panic
        assert!(!file_has_data_image(&root.join("nope.json")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stream_migration_rewrites_legacy_book_file() {
        let root = temp_root("stream");
        let bytes = png_bytes();
        let legacy = data_url("image/png", &bytes);
        let json = format!(
            r#"{{"id":"book-1","title":"书","chapters":[{{"cid":"c0001","title":"第一章","blocks":[{{"kind":"p","text":"正文"}},{{"kind":"img","src":"{legacy}"}},{{"kind":"img","src":"https://img/2.png","remote":"https://img/2.png"}}]}}]}}"#
        );
        let path = root.join("book-1.json");
        fs::write(&path, &json).unwrap();

        assert!(migrate_book_file(&root, "book-1", &path).unwrap());
        let rewritten = fs::read_to_string(&path).unwrap();
        assert!(!rewritten.contains("data:image/"), "data URL 应被替换掉");
        assert!(rewritten.contains(r#""src":"","local":"book-1_"#));
        // 网络图片的 src 原样保留
        assert!(rewritten.contains(r#""src":"https://img/2.png""#));
        // 重写后的 JSON 仍是合法 JSON，且图片文件真的写出来了
        let parsed: serde_json::Value = serde_json::from_str(&rewritten).expect("合法 JSON");
        let block = &parsed["chapters"][0]["blocks"][1];
        assert!(block.get("local").is_some(), "应补上本地副本引用: {block}");
        assert!(
            block.get("src").is_none() || block["src"] == "",
            "src 不应再保留图片字节: {block}"
        );
        let local = block["local"].as_str().unwrap().to_string();
        assert!(exists(&root, &local));
        assert_eq!(fs::read(root.join(&local)).unwrap(), bytes);

        // 幂等：再跑一次没有可替换的内容
        assert!(!migrate_book_file(&root, "book-1", &path).unwrap());
        // 不留临时文件
        assert!(!root.join("book-1.json.tmp").exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// 流式迁移必须能处理「模式 / 值跨读缓冲边界」的情况（真实大文件一定会遇到）
    #[test]
    fn stream_migration_handles_chunk_boundaries() {
        let root = temp_root("stream-boundary");
        // 让 `"src":` 与 data URL 分别落在缓冲边界两侧：用两种长度的正文填空
        for pad in [
            STREAM_CHUNK - 6,
            STREAM_CHUNK - 3,
            STREAM_CHUNK - 1,
            STREAM_CHUNK,
            STREAM_CHUNK + 5,
        ] {
            let payload = "A".repeat(300_000);
            let json = format!(
                r#"{{"fill":"{}","blocks":[{{"kind":"img","src":"data:image/png;base64,{payload}"}}]}}"#,
                "x".repeat(pad)
            );
            let path = root.join("book-1.json");
            fs::write(&path, &json).unwrap();
            assert!(
                migrate_book_file(&root, "book-1", &path).unwrap(),
                "pad={pad}"
            );
            let rewritten = fs::read_to_string(&path).unwrap();
            assert!(!rewritten.contains("data:image/"), "pad={pad}");
            assert!(rewritten.contains(r#""local":"book-1_"#), "pad={pad}");
            assert!(
                serde_json::from_str::<serde_json::Value>(&rewritten).is_ok(),
                "pad={pad}"
            );
        }
        let _ = fs::remove_dir_all(&root);
    }

    /// 流式迁移：畸形 / 无法处理的内容一律放弃，原文件保持不变
    #[test]
    fn stream_migration_keeps_original_on_trouble() {
        let root = temp_root("stream-abort");
        let path = root.join("book-1.json");

        // 没有图片：不算改动，文件原样
        let plain = r#"{"id":"book-1","chapters":[{"blocks":[{"kind":"p","text":"正文"}]}]}"#;
        fs::write(&path, plain).unwrap();
        assert!(!migrate_book_file(&root, "book-1", &path).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), plain);

        // 非 base64 的 data URL：不认识的形态不动它
        let inline_svg = r#"{"blocks":[{"kind":"img","src":"data:image/svg+xml,<svg/>"}]}"#;
        fs::write(&path, inline_svg).unwrap();
        assert!(!migrate_book_file(&root, "book-1", &path).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), inline_svg);

        // 字符串没有闭合（文件截断）：放弃迁移，原文件一字未改
        let truncated = r#"{"blocks":[{"kind":"img","src":"data:image/png;base64,AAAA"#;
        fs::write(&path, truncated).unwrap();
        assert!(migrate_book_file(&root, "book-1", &path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), truncated);
        assert!(!root.join("book-1.json.tmp").exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// 流式迁移不认「正文里出现的相同字样」：JSON 转义后的引号不构成 `"src":`
    #[test]
    fn stream_migration_ignores_escaped_text() {
        let root = temp_root("stream-text");
        // 正文里的引号在 JSON 里是转义的，序列化后是 \"src\" 而非 "src"
        let json =
            r#"{"blocks":[{"kind":"p","text":"他说：\"src\":\"data:image/png;base64,AAAA\""}]}"#;
        let path = root.join("book-1.json");
        fs::write(&path, json).unwrap();
        assert!(!migrate_book_file(&root, "book-1", &path).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), json);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn serve_reads_only_own_file_names() {
        let root = temp_root("serve");
        let bytes = png_bytes();
        let local = store(&root, "book-1", "https://img/1.png", "image/png", &bytes).unwrap();
        let request = |uri: &str| {
            http::Request::builder()
                .uri(uri)
                .body(Vec::new())
                .expect("request")
        };
        let ok = serve(&root, &request(&format!("/{local}")));
        assert_eq!(ok.status(), http::StatusCode::OK);
        assert_eq!(ok.headers()[http::header::CONTENT_TYPE], "image/png");
        assert_eq!(ok.body(), &bytes);

        // 路径穿越 / 非法引用一律 403，绝不读到别的文件
        for bad in [
            "/../books/book-1.json",
            "/book-1.json",
            "/%2E%2E%2Fetc%2Fpasswd",
        ] {
            let res = serve(&root, &request(bad));
            assert_eq!(res.status(), http::StatusCode::FORBIDDEN, "{bad}");
        }
        assert_eq!(
            serve(
                &root,
                &request("/book-1_0000000000000000000000000000000000000000.png")
            )
            .status(),
            http::StatusCode::NOT_FOUND
        );
        let _ = fs::remove_dir_all(&root);
    }
}

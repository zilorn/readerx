//! 供 WebView 调用的 Tauri command 处理器。
//! 仅负责承接 invoke 参数、把同步 I/O 放到 blocking 线程池，不直接触碰磁盘。
//!
//! 所有命令统一走 [`blocking`]：既保证磁盘 / 网络 / 书源引擎跑在 blocking 线程池
//! （不阻塞 IPC 事件循环），又把内部 panic 收敛成前端可读的错误字符串 —— 任何一处
//! 意外异常只让这次调用失败，用户能看到原因，而不是应用直接闪退。

use crate::book_images;
use crate::engine;
use crate::host;
use crate::models::{
    BookChapterPatch, BookImageFile, BookImageInfo, BookItem, BookMeta, BookSource,
    BookSourceSummary, CachedAudio, ChapterContentResult, ChapterItem, FetchedImage, LocalBook,
    SourceCallResult, TtsCacheStat,
};
use crate::panic_guard;
use crate::storage;
use crate::webview_login;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::Value;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_fs::FsExt;
use tauri_plugin_webview_login::LoginOutcome;

/// 统一的 blocking 任务入口。
///
/// `what` 同时用于错误前缀（与历史文案保持一致）与 panic 兜底文案；
/// 工作线程内的 panic 会被转成 `"{what}内部异常: …"` 由前端展示。
async fn blocking<F, T>(what: &'static str, task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || panic_guard::catch_result(what, task))
        .await
        .map_err(|e| format!("{what}任务失败: {e}"))?
}

#[tauri::command]
pub async fn readerx_state_get(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    blocking("状态读取", move || storage::read_state(&app, &key)).await
}

#[tauri::command]
pub async fn readerx_state_set(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    blocking("状态写入", move || storage::write_state(&app, &key, &value)).await
}

#[tauri::command]
pub async fn readerx_state_remove(app: AppHandle, key: String) -> Result<(), String> {
    blocking("状态删除", move || storage::remove_state(&app, &key)).await
}

#[tauri::command]
pub async fn readerx_book_put(app: AppHandle, book: LocalBook) -> Result<(), String> {
    blocking("书籍写入", move || storage::put_book(&app, &book)).await
}

/// 只回写一本书的若干章节（在线书逐批下载正文用）：整本 JSON 仍在 Rust 侧读写，
/// 经 IPC 只传本次变动章节，避免把大书（含 data URL 图片）反复整本拷贝到 WebView。
#[tauri::command]
pub async fn readerx_book_chapters_put(
    app: AppHandle,
    book_id: String,
    updates: Vec<BookChapterPatch>,
) -> Result<(), String> {
    blocking("章节写入", move || {
        storage::put_book_chapters(&app, &book_id, &updates)
    })
    .await
}

/// 书库元数据列表（章节仅留标题/字数，不含正文）。
/// 应用启动 / 书架渲染只调用它——正文经 readerx_book_get 按需单本拉取。
#[tauri::command]
pub async fn readerx_book_list_meta(app: AppHandle) -> Result<Vec<BookMeta>, String> {
    blocking("书库元数据读取", move || storage::list_book_meta(&app)).await
}

/// 读取单本书全文（阅读页打开时按需调用）；文件不存在返回 null。
#[tauri::command]
pub async fn readerx_book_get(app: AppHandle, id: String) -> Result<Option<LocalBook>, String> {
    blocking("书籍读取", move || storage::get_book(&app, &id)).await
}

/// 单本元信息补丁（分组 / 书名 / 封面 / 标签…）：正文整体留在磁盘，不整本传回 WebView。
#[tauri::command]
pub async fn readerx_book_patch_meta(
    app: AppHandle,
    id: String,
    patch: crate::models::BookMetaPatch,
) -> Result<(), String> {
    blocking("书籍元信息写入", move || {
        storage::patch_book_meta(&app, &id, &patch)
    })
    .await
}

#[tauri::command]
pub async fn readerx_book_delete(app: AppHandle, id: String) -> Result<(), String> {
    blocking("书籍删除", move || storage::delete_book(&app, &id)).await
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
    blocking("音频缓存写入", move || {
        storage::put_tts_audio(&app, &book_id, &key, &mime, &bytes)
    })
    .await
}

/// 读取一句缓存音频；未命中返回 null
#[tauri::command]
pub async fn readerx_tts_cache_get(
    app: AppHandle,
    book_id: String,
    key: String,
) -> Result<Option<CachedAudio>, String> {
    blocking("音频缓存读取", move || -> Result<Option<CachedAudio>, String> {
        Ok(storage::get_tts_audio(&app, &book_id, &key)?.map(|(mime, bytes)| CachedAudio {
            data: B64.encode(bytes),
            mime,
        }))
    })
    .await
}

/// 各书籍的听书缓存统计（用于设置页展示与清理）
#[tauri::command]
pub async fn readerx_tts_cache_stats(app: AppHandle) -> Result<Vec<TtsCacheStat>, String> {
    blocking("听书缓存统计", move || storage::list_tts_cache(&app)).await
}

/// 清除听书缓存；book_id 为 null 时清空全部书籍
#[tauri::command]
pub async fn readerx_tts_cache_clear(
    app: AppHandle,
    book_id: Option<String>,
) -> Result<(), String> {
    blocking("听书缓存清理", move || {
        storage::clear_tts_cache(&app, book_id.as_deref())
    })
    .await
}

/// 读取随应用打包的 LICENSE（配置在 bundle.resources，运行期位于 resource 目录）。
/// Android 的 resource 目录是 APK asset（asset:// 前缀），统一走 fs 插件读取。
#[tauri::command]
pub async fn readerx_license_text(app: AppHandle) -> Result<String, String> {
    blocking("开源许可读取", move || -> Result<String, String> {
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
    blocking("书源列表读取", move || {
        let sources = storage::list_book_sources(&app)?;
        Ok(sources.into_iter().map(|s| s.to_summary()).collect::<Vec<_>>())
    })
    .await
}

/// 读取单个书源（含 js，供编辑）
#[tauri::command]
pub async fn readerx_source_get(app: AppHandle, id: String) -> Result<Option<BookSource>, String> {
    blocking("书源读取", move || storage::get_book_source(&app, &id)).await
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
    if let Some(group_id) = &source.group_id {
        if group_id.trim().is_empty() || group_id.chars().count() > 64 {
            return Err("非法的书源分组 id".to_string());
        }
    }
    Ok(())
}

/// 新建 / 覆盖保存一个书源
#[tauri::command]
pub async fn readerx_source_put(app: AppHandle, source: BookSource) -> Result<(), String> {
    blocking("书源写入", move || {
        validate_source(&source)?;
        storage::put_book_source(&app, &source)
    })
    .await
}

/// 删除一个书源
#[tauri::command]
pub async fn readerx_source_delete(app: AppHandle, id: String) -> Result<(), String> {
    blocking("书源删除", move || storage::delete_book_source(&app, &id)).await
}

/// 书源分组被删除：把全部书源上指向该分组的归属清空，返回受影响的书源数量
#[tauri::command]
pub async fn readerx_source_group_clear(app: AppHandle, group_id: String) -> Result<u64, String> {
    let group_id = group_id.trim().to_string();
    if group_id.is_empty() || group_id.chars().count() > 64 {
        return Err("非法的书源分组 id".to_string());
    }
    blocking("书源分组清理", move || {
        storage::clear_book_source_group(&app, &group_id)
    })
    .await
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
    blocking("书源调用", move || -> Result<SourceCallResult, String> {
        let source = storage::get_book_source(&app, &source_id)?
            .ok_or_else(|| "书源不存在".to_string())?;
        if !source.enabled {
            return Err("书源已禁用".to_string());
        }
        capability_gate(&source, &fn_name)?;
        host::prepare_source(&source)?;
        // 重启后把该书源已保存的登录 Cookie 注入会话（进程内幂等）
        let _ = webview_login::seed_source_session(&app, &source.id);
        let budget = if fn_name == "bookContent" {
            engine::DEFAULT_CHAPTER_BUDGET_MS
        } else {
            engine::DEFAULT_CALL_BUDGET_MS
        };
        engine::call_source_function(&source.id, &source.js, &fn_name, &args, budget)
    })
    .await
}

/// 批量拉取正文（按用户“书源并发”设置控制单源内部并行请求数）
#[tauri::command]
pub async fn readerx_source_fetch_contents(
    app: AppHandle,
    source_id: String,
    book: BookItem,
    chapters: Vec<ChapterItem>,
) -> Result<Vec<ChapterContentResult>, String> {
    blocking("书源正文拉取", move || -> Result<Vec<ChapterContentResult>, String> {
        let source = storage::get_book_source(&app, &source_id)?
            .ok_or_else(|| "书源不存在".to_string())?;
        if !source.enabled {
            return Err("书源已禁用".to_string());
        }
        if !source.capabilities.content {
            return Err(format!("书源「{}」已禁用正文能力", source.name));
        }
        host::prepare_source(&source)?;
        // 重启后把该书源已保存的登录 Cookie 注入会话（进程内幂等）
        let _ = webview_login::seed_source_session(&app, &source.id);
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
}

/// 用书源会话下载一张**章节插图**并落盘，只回传本地引用与尺寸（不回传图片字节）。
/// 图片字节经 IPC 进 WebView 会以 base64 + JS 字符串的形式成倍占用内存，
/// 一章几百张图时足以把应用撑崩 —— 因此正文图片一律走这里存成文件，
/// 渲染时由 `readerx-img` 自定义协议直接从文件读取（见 book_images.rs）。
///
/// `book_id` 仅用于给文件命名与删除时清理；`url` 为图片身份（去重 / 重试按它对应）。
/// 请求失败 / 写盘失败都返回 ok:false（不抛 command 错误），便于阅读页显示可重试占位。
#[tauri::command]
pub async fn readerx_book_image_fetch(
    app: AppHandle,
    source_id: String,
    book_id: String,
    url: String,
    referer: Option<String>,
) -> Result<BookImageFile, String> {
    blocking("图片下载", move || -> Result<BookImageFile, String> {
        let source = storage::get_book_source(&app, &source_id)?
            .ok_or_else(|| "书源不存在".to_string())?;
        if !source.enabled {
            return Err("书源已禁用".to_string());
        }
        host::prepare_source(&source)?;
        // 重启后把该书源已保存的登录 Cookie 注入会话（进程内幂等）
        let _ = webview_login::seed_source_session(&app, &source.id);
        let root = book_images::images_root(&app)?;
        match host::fetch_image_bytes(&source.id, &url, referer.as_deref().unwrap_or("")) {
            Ok((mime, bytes)) => Ok(book_images::fetch_result(
                &root, &book_id, &url, &mime, &bytes,
            )),
            Err(error) => Ok(BookImageFile {
                ok: false,
                local: String::new(),
                width: 0,
                height: 0,
                bytes: 0,
                error,
            }),
        }
    })
    .await
}

/// 取若干张已落盘章节插图的尺寸 / 体积（只读文件头，不解码）。
/// 分页排版需要每张图的真实尺寸：由 Rust 读文件头给出，
/// WebView 因此不必为了量尺寸把整章图片解码一遍。
#[tauri::command]
pub async fn readerx_book_image_info(
    app: AppHandle,
    locals: Vec<String>,
) -> Result<Vec<BookImageInfo>, String> {
    blocking("读取图片信息", move || {
        let root = book_images::images_root(&app)?;
        Ok(book_images::info(&root, &locals))
    })
    .await
}

/// 用书源会话下载一张图片（正文插图 / 整章图片 / 书源封面），返回 base64 与 MIME。
/// 失败时返回 ok:false（不抛 command 错误），便于调用方做占位 / 整章失败判定。
/// 只校验书源整体启停——正文插图走 content 能力流程、封面走 search/discover/detail
/// 能力流程，都不该因另一个能力开关被关而失效，故不做单项能力门控。
///
/// 仅供**书源封面**使用：封面会在 WebView 里压成几百 px 的缩略图再随书保存，
/// 体积可控；章节插图请用 [`readerx_book_image_fetch`]（落文件，不过 IPC）。
#[tauri::command]
pub async fn readerx_source_fetch_image(
    app: AppHandle,
    source_id: String,
    url: String,
    referer: Option<String>,
) -> Result<FetchedImage, String> {
    blocking("图片下载", move || -> Result<FetchedImage, String> {
        let source = storage::get_book_source(&app, &source_id)?
            .ok_or_else(|| "书源不存在".to_string())?;
        if !source.enabled {
            return Err("书源已禁用".to_string());
        }
        host::prepare_source(&source)?;
        // 重启后把该书源已保存的登录 Cookie 注入会话（进程内幂等）
        let _ = webview_login::seed_source_session(&app, &source.id);
        match host::fetch_image_bytes(&source.id, &url, referer.as_deref().unwrap_or("")) {
            Ok((mime, bytes)) => Ok(FetchedImage {
                ok: true,
                mime,
                data: B64.encode(&bytes),
                error: String::new(),
            }),
            Err(error) => Ok(FetchedImage {
                ok: false,
                mime: String::new(),
                data: String::new(),
                error,
            }),
        }
    })
    .await
}

// ---------------------------------------------------------------------------
// 书源网页登录（WebView，仅 Android；Cookie 按源持久化）
// ---------------------------------------------------------------------------

/// 是否支持网页登录（Android 应用内为 true）。
#[tauri::command]
pub fn readerx_source_login_supported() -> bool {
    webview_login::is_supported()
}

/// 为某个书源打开网页登录浮层（阻塞直到完成/取消/超时）。
/// `url` 为登录起始页；成功后 Cookie 已持久化并注入该书源会话。
#[tauri::command]
pub async fn readerx_source_login_webview(
    source_id: String,
    url: String,
) -> Result<LoginOutcome, String> {
    blocking("网页登录", move || {
        let url = url.trim().to_string();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("仅支持 http/https 的登录地址".to_string());
        }
        if source_id.is_empty()
            || source_id
                .chars()
                .any(|c| !c.is_ascii_alphanumeric() && c != '-' && c != '_' && c != '.')
        {
            return Err("非法的书源 id".to_string());
        }
        webview_login::perform(&source_id, &url)
    })
    .await
}

/// 清空某个书源已保存的网页登录 Cookie（持久化文件 + 当前会话），返回移除的行数。
#[tauri::command]
pub async fn readerx_source_login_clear(app: AppHandle, source_id: String) -> Result<u64, String> {
    blocking("清除登录 Cookie", move || -> Result<u64, String> {
        let saved = storage::read_source_login_cookie(&app, &source_id)?;
        storage::remove_source_login_cookie(&app, &source_id)?;
        webview_login::unseed(&source_id);
        let mut removed = 0;
        if let Some(cookie) = saved {
            removed += host::http_remove_cookie(&source_id, &cookie);
        }
        Ok(removed)
    })
    .await
}

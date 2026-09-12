mod book_images;
mod commands;
mod engine;
mod host;
mod models;
mod panic_guard;
mod storage;
mod webview_login;

use std::panic::AssertUnwindSafe;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

/// 章节插图的自定义协议名：前端用 `convertFileSrc(local, "readerx-img")` 得到
/// 平台正确的完整 URL（Android/Windows 为 `http://readerx-img.localhost/…`，
/// 其余平台为 `readerx-img://localhost/…`），由 [`book_images::serve`] 直接读文件应答。
/// 图片不进 IPC、不进 WebView 的 JS 字符串，内存占用与图片数量解耦。
const BOOK_IMAGE_PROTOCOL: &str = "readerx-img";

/// 推给前端的「内部异常」事件名（前端监听见 src/lib/errorReport.ts）。
/// 处理不了的异常必须让用户看到原因，而不是只留在日志里。
const INTERNAL_ERROR_EVENT: &str = "readerx-internal-error";

/// panic hook 用的 AppHandle（setup 时写入）。
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// 兜底提示 + 日志：任何漏网的 panic 都先把「消息 + 位置」打出来（Android 上可在 logcat 看到），
/// 再推给前端弹提示；即使异常无法补救，用户也知道发生了什么。
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
            .unwrap_or_else(|| "未知位置".to_string());
        eprintln!("[readerx] 内部异常 @ {location}: {info}");
        // 交给独立线程推送：panic 线程可能正持有 Tauri 内部锁，在 hook 里直接
        // emit 有阻塞风险；这里立即返回，让 unwind / 收场流程照常进行。
        let message = format!("{}（{location}）", info);
        let _ = std::thread::Builder::new()
            .name("readerx-panic-report".to_string())
            .spawn(move || {
                // 提示本身再出错也不能 panic（会二次触发 hook）
                let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
                    if let Some(app) = APP_HANDLE.get() {
                        let _ = app.emit(INTERNAL_ERROR_EVENT, message);
                    }
                }));
            });
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_tts::init())
        .plugin(tauri_plugin_webview_login::init())
        // 章节插图：按本地文件名直接读文件应答（只接受本应用写出的图片文件名）
        .register_uri_scheme_protocol(BOOK_IMAGE_PROTOCOL, |ctx, request| {
            match book_images::images_root(ctx.app_handle()) {
                Ok(root) => book_images::serve(&root, &request),
                Err(error) => tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::INTERNAL_SERVER_ERROR)
                    .body(error.into_bytes())
                    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new())),
            }
        })
        .setup(|app| {
            // panic hook 需要 AppHandle 才能把内部异常推给前端
            let _ = APP_HANDLE.set(app.handle().clone());
            // 网页登录桥：把「插件(Android WebView)」接到书源会话/持久化
            webview_login::install(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::readerx_state_get,
            commands::readerx_state_set,
            commands::readerx_state_remove,
            commands::readerx_book_put,
            commands::readerx_book_chapters_put,
            commands::readerx_book_list_meta,
            commands::readerx_book_get,
            commands::readerx_book_patch_meta,
            commands::readerx_book_delete,
            commands::readerx_tts_cache_put,
            commands::readerx_tts_cache_get,
            commands::readerx_tts_cache_stats,
            commands::readerx_tts_cache_clear,
            commands::readerx_license_text,
            commands::readerx_sources_list,
            commands::readerx_source_get,
            commands::readerx_source_put,
            commands::readerx_source_delete,
            commands::readerx_source_call,
            commands::readerx_source_fetch_contents,
            commands::readerx_source_fetch_image,
            commands::readerx_book_image_fetch,
            commands::readerx_book_image_info,
            commands::readerx_source_login_supported,
            commands::readerx_source_login_webview,
            commands::readerx_source_login_clear
        ])
        .run(tauri::generate_context!());

    // 启动 / 运行失败（窗口、插件、事件循环）：打印可读原因后退出，不 panic
    if let Err(error) = result {
        eprintln!("[readerx] 应用启动失败: {error}");
        std::process::exit(1);
    }
}

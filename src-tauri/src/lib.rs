mod book_images;
mod book_store;
mod chapter_runs;
mod commands;
mod logging;
mod models;
// 桌面端单实例：重复启动只聚焦已有窗口，不开第二个进程（移动端由系统保证）
#[cfg(desktop)]
mod single_instance;
mod storage;
// 局域网同步：引擎生命周期 / 本地数据桥接 / 冲突队列都收在 sync 模块里
// （对外可见是为了让集成测试直接验证桥接，见 sync/mod.rs 的说明）
pub mod sync;
mod webview_login;

// 书源引擎（Boa 沙箱 + 宿主 API）与书源持久化实现在 readerx-source crate：
// 同一份代码也编译成独立二进制（见 crates/readerx-source 的 CLI），
// App 只保留「本地书 / 书架 / 设置」这些与界面强相关的存储与命令。
use readerx_source::{engine, host, panic_guard};

use std::panic::AssertUnwindSafe;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

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

/// 兜底提示 + 日志：任何漏网的 panic 都先记进统一日志（含位置，Android 上 logcat 与
/// 日志文件都能看到），再推给前端弹提示；即使异常无法补救，用户也知道发生了什么。
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
            .unwrap_or_else(|| "未知位置".to_string());
        log::error!("内部异常 @ {location}: {info}");
        // 立刻落盘：panic 之后进程可能马上被系统收走，缓冲区里的最后几条不能丢
        if let Some(logger) = readerx_log::logger() {
            logger.flush();
        }
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
    // 日志要最早装：启动早期（还没拿到应用数据目录）的失败同样要留下痕迹。
    // 先只打标准错误 / logcat，文件目标在 setup 里挂上（见 logging::attach_app_dir）。
    logging::init_early();
    install_panic_hook();
    let mut builder = tauri::Builder::default();

    // 单实例必须第一个注册：插件按注册顺序初始化，先拿到单实例名字的进程才是「主实例」，
    // 后启动的进程在这里交出命令行后自行退出（见 single_instance 模块）。
    #[cfg(desktop)]
    {
        builder = builder.plugin(single_instance::plugin());
    }

    let result = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        // 桌面端导入本地书：系统文件选择器（移动端不支持，插件在那边会报错，故按平台注册）
        .plugin(tauri_plugin_dialog::init())
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
            // 日志文件目标挂到应用数据目录，并把用户设置的级别应用上去
            logging::attach_app_dir(app.handle());
            // 书源引擎的数据根 = 应用数据目录：书源定义与登录态与独立二进制（CLI）
            // 用同一套路径规则，两边可以交替读写同一份数据（见 readerx-source::store）
            if let Ok(dir) = app.path().app_data_dir() {
                readerx_source::store::init_data_root(dir);
            } else {
                log::warn!("无法定位应用数据目录，书源与登录态将退回默认目录");
            }
            // 本地书的旧布局（整本 books/<id>.json、全库一份的 state/readerx.bookmarks.json）
            // 由 book_store 在首次书籍 / 书签读写时迁移（book_store::migrate_legacy_layout）：
            // 那是磁盘 I/O，跟着调用它的 blocking 线程跑，不占用启动线程。
            // 网页登录后端：把「插件（Android 原生浮层 / 桌面独立登录窗口）」注册为引擎的认证实现
            webview_login::install(app.handle().clone());
            // 局域网同步：建服务并交给界面；启用过的用户在这里开引擎、补齐落地、拉起监听。
            // 引擎与网络都在后台线程上跑，不占启动线程。
            let sync_service = sync::SyncService::new(app.handle().clone());
            app.manage(sync::SyncState(Arc::clone(&sync_service)));
            let bootstrap = Arc::clone(&sync_service);
            std::thread::Builder::new()
                .name("readerx-sync-boot".to_string())
                .spawn(move || bootstrap.bootstrap())
                .ok();
            log::info!("后端就绪，等待界面调用");
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
            commands::readerx_bookmarks_get,
            commands::readerx_bookmarks_put,
            commands::readerx_tts_cache_put,
            commands::readerx_tts_cache_get,
            commands::readerx_tts_cache_stats,
            commands::readerx_tts_cache_apply_limit,
            commands::readerx_tts_cache_clear,
            commands::readerx_license_text,
            commands::readerx_pick_book_file,
            commands::readerx_open_devtools,
            commands::readerx_third_party_notices,
            commands::readerx_sources_list,
            commands::readerx_source_get,
            commands::readerx_source_put,
            commands::readerx_source_delete,
            commands::readerx_source_group_clear,
            commands::readerx_source_call,
            commands::readerx_source_fetch_contents,
            commands::readerx_source_fetch_contents_stream,
            commands::readerx_source_chapter_run_cancel,
            commands::readerx_source_chapter_run_promote,
            commands::readerx_source_fetch_image,
            commands::readerx_book_image_fetch,
            commands::readerx_book_image_info,
            commands::readerx_book_pdf_page,
            commands::readerx_source_login_supported,
            commands::readerx_source_login_webview,
            commands::readerx_source_login_clear,
            logging::readerx_log_write,
            logging::readerx_log_tail,
            logging::readerx_log_clear,
            logging::readerx_log_set_level,
            sync::commands::readerx_sync_status,
            sync::commands::readerx_sync_enable,
            sync::commands::readerx_sync_set_auto,
            sync::commands::readerx_sync_set_device_name,
            sync::commands::readerx_sync_pairing_code,
            sync::commands::readerx_sync_join,
            sync::commands::readerx_sync_now,
            sync::commands::readerx_sync_sync_addr,
            sync::commands::readerx_sync_discover,
            sync::commands::readerx_sync_peers,
            sync::commands::readerx_sync_conflicts,
            sync::commands::readerx_sync_resolve,
            sync::commands::readerx_sync_reset
        ])
        .build(tauri::generate_context!());

    // 启动失败（窗口、插件、事件循环）：记进日志后退出，不 panic
    let app = match result {
        Ok(app) => app,
        Err(error) => {
            log::error!("应用启动失败: {error}");
            if let Some(logger) = readerx_log::logger() {
                logger.flush();
            }
            std::process::exit(1);
        }
    };

    app.run(|handle, event| {
        // 退出：停掉同步网络与自动同步线程，并把引擎快照 / 设置刷盘
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(state) = handle.try_state::<sync::SyncState>() {
                state.0.shutdown();
            }
            if let Some(logger) = readerx_log::logger() {
                logger.flush();
            }
        }
    });
}

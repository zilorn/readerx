mod commands;
mod engine;
mod host;
mod models;
mod storage;
mod webview_login;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_tts::init())
        .plugin(tauri_plugin_webview_login::init())
        .setup(|app| {
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
            commands::readerx_book_list,
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
            commands::readerx_source_login_supported,
            commands::readerx_source_login_webview,
            commands::readerx_source_login_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

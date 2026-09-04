mod commands;
mod engine;
mod host;
mod models;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_tts::init())
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
            commands::readerx_source_fetch_contents
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

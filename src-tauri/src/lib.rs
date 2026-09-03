mod commands;
mod models;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::readerx_state_get,
            commands::readerx_state_set,
            commands::readerx_state_remove,
            commands::readerx_book_put,
            commands::readerx_book_list,
            commands::readerx_book_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

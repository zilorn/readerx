//! Android 实体音量键接入：前端只在阅读正文可交互时启用，偏好仍由 store 持久化。
use tauri::{plugin::TauriPlugin, Runtime};

#[cfg(target_os = "android")]
struct VolumeKeys<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("readerx-volume-keys")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle =
                    _api.register_android_plugin("com.zilorn.readerx", "VolumeKeysPlugin")?;
                _app.manage(VolumeKeys(handle));
            }
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn readerx_volume_keys_set_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let _: serde_json::Value = app
            .state::<VolumeKeys<tauri::Wry>>()
            .0
            .run_mobile_plugin_async("setEnabled", serde_json::json!({ "enabled": enabled }))
            .await
            .map_err(|error| format!("设置音量键翻页失败: {error}"))?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = (app, enabled);
    Ok(())
}

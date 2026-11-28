//! 听书后台服务接入：朗读进行中在 Android 上启动前台服务（保活 + 通知栏），停止时关闭。
//! 桌面端没有对应的生命周期问题，命令直接空操作。
use tauri::{plugin::TauriPlugin, Runtime};

#[cfg(target_os = "android")]
struct TtsService<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("readerx-tts-service")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle =
                    _api.register_android_plugin("com.zilorn.readerx", "TtsServicePlugin")?;
                _app.manage(TtsService(handle));
            }
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn readerx_tts_service_set_active(
    app: tauri::AppHandle,
    active: bool,
    playing: bool,
    title: String,
    text: String,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let _: serde_json::Value = app
            .state::<TtsService<tauri::Wry>>()
            .0
            .run_mobile_plugin_async(
                "setActive",
                serde_json::json!({ "active": active, "playing": playing, "title": title, "text": text }),
            )
            .await
            .map_err(|error| format!("听书后台服务切换失败: {error}"))?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = (app, active, playing, title, text);
    Ok(())
}

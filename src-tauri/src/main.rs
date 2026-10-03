// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    configure_linux_renderer();
    readerx_lib::run()
}

/// 必须在 Tauri / WebKitGTK 启动线程前设置：NVIDIA 的 DMA-BUF 路径可能让
/// 前端正常执行却始终不绘制窗口。保留用户显式设置，便于驱动修复后恢复该路径。
#[cfg(target_os = "linux")]
fn configure_linux_renderer() {
    const OVERRIDE: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if should_disable_dmabuf(
        std::env::var_os(OVERRIDE).is_some(),
        std::path::Path::new("/proc/driver/nvidia/version").is_file(),
    ) {
        std::env::set_var(OVERRIDE, "1");
    }
}

#[cfg(target_os = "linux")]
fn should_disable_dmabuf(has_override: bool, has_nvidia_driver: bool) -> bool {
    !has_override && has_nvidia_driver
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::should_disable_dmabuf;

    #[test]
    fn renderer_workaround_only_defaults_for_nvidia() {
        assert!(should_disable_dmabuf(false, true));
        assert!(!should_disable_dmabuf(false, false));
        assert!(!should_disable_dmabuf(true, true));
        assert!(!should_disable_dmabuf(true, false));
    }
}

//! 同步的**设备本地**设置（`<同步数据目录>/settings.json`）。
//!
//! 这些开关只影响本机行为，**不参与同步**：手机与桌面各有各的「自动同步」偏好，
//! 把它们同步过去只会让两台设备的后台行为莫名其妙地互相改。
//!
//! 与引擎自己的 `device.json`（设备身份 / 群组 / 配对码）分开放：那份是协议数据，
//! 这份是应用偏好；引擎不认识这个文件，原样忽略。

use serde::{Deserialize, Serialize};
use std::path::Path;

use readerx_sync::SyncError;

/// 默认自动同步间隔（秒）：15 分钟档。
///
/// 界面上的档位在 `src/lib/sync.ts`（前端出选项），这里只负责把落盘的间隔收敛到合法范围。
/// 默认取中间档：局域网同步一次本身很便宜，但后台频繁唤醒对手机电量不友好，
/// 而「刚读完想换个设备接着读」的用户可以直接点同步。
pub const AUTO_INTERVAL_DEFAULT: u64 = 900;
/// 间隔下限：再短就变成「一直在同步」，手机上耗电明显
pub const AUTO_INTERVAL_MIN: u64 = 30;
/// 间隔上限（一天）
pub const AUTO_INTERVAL_MAX: u64 = 86_400;

/// 设备本地的同步设置。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncSettings {
    /// 引擎是否已启用过。
    ///
    /// 一旦启用过就保持 `true`：本地改动会持续记进操作日志（哪怕同步网络是关的），
    /// 这样「关掉同步 → 本地继续用 → 再打开」不会丢中间那段历史。
    /// 从未启用过的用户完全不付这份代价（不建引擎、不写日志）。
    pub activated: bool,
    /// 用户是否开启同步（= 监听网络 + 自动同步）。关闭时本地记账照常。
    pub enabled: bool,
    /// 是否自动同步
    pub auto_sync: bool,
    /// 自动同步间隔（秒）
    pub auto_interval_secs: u64,
    /// 已经「落地」到本地文件的操作数（操作日志只增不减，这个下标是落地进度）。
    /// 进程在同步与落地之间被杀时，下次启动据此把落下的部分补齐。
    pub materialized_ops: usize,
    /// 上次成功同步的时间（毫秒时间戳；仅用于界面展示与自动同步节流）
    pub last_sync_ms: u64,
}

impl Default for SyncSettings {
    fn default() -> Self {
        SyncSettings {
            activated: false,
            enabled: false,
            auto_sync: true,
            auto_interval_secs: AUTO_INTERVAL_DEFAULT,
            materialized_ops: 0,
            last_sync_ms: 0,
        }
    }
}

impl SyncSettings {
    /// 归一化：外部传入的间隔截断到合法范围（越界一律回落默认，不静默改成极端值）
    pub fn set_interval(&mut self, secs: u64) {
        self.auto_interval_secs = if (AUTO_INTERVAL_MIN..=AUTO_INTERVAL_MAX).contains(&secs) {
            secs
        } else {
            AUTO_INTERVAL_DEFAULT
        };
    }
}

/// settings.json 的文件名
const SETTINGS_FILE: &str = "settings.json";

/// 读取设置；文件缺失 / 解析失败都回落默认值（同步配置坏掉不该让应用起不来）。
pub fn load(root: &Path) -> SyncSettings {
    let path = root.join(SETTINGS_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return SyncSettings::default();
    };
    match serde_json::from_str::<SyncSettings>(&text) {
        Ok(settings) => settings,
        Err(error) => {
            log::warn!("同步设置解析失败，按默认值继续（{error}）");
            SyncSettings::default()
        }
    }
}

/// 写回设置（临时文件 + rename：中途失败不会留下半截配置）。
pub fn save(root: &Path, settings: &SyncSettings) -> Result<(), SyncError> {
    std::fs::create_dir_all(root)
        .map_err(|e| SyncError::Io(format!("创建同步目录失败: {e}")))?;
    let path = root.join(SETTINGS_FILE);
    let tmp = root.join("settings.json.tmp");
    let text = serde_json::to_string_pretty(settings)
        .map_err(|e| SyncError::Json(format!("同步设置序列化失败: {e}")))?;
    std::fs::write(&tmp, text).map_err(|e| SyncError::Io(format!("写入同步设置失败: {e}")))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        SyncError::Io(format!("写入同步设置失败: {e}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("readerx-sync-settings-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn missing_file_falls_back_to_defaults() {
        let root = temp_root("missing");
        let settings = load(&root);
        assert!(!settings.activated && !settings.enabled);
        assert!(settings.auto_sync);
        assert_eq!(settings.auto_interval_secs, AUTO_INTERVAL_DEFAULT);
    }

    #[test]
    fn roundtrip_keeps_values() {
        let root = temp_root("roundtrip");
        let mut settings = SyncSettings { activated: true, enabled: true, ..Default::default() };
        settings.set_interval(900);
        settings.materialized_ops = 42;
        save(&root, &settings).unwrap();

        let back = load(&root);
        assert!(back.activated && back.enabled);
        assert_eq!(back.auto_interval_secs, 900);
        assert_eq!(back.materialized_ops, 42);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn broken_file_falls_back_to_defaults() {
        let root = temp_root("broken");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(SETTINGS_FILE), "{ 不是 JSON").unwrap();
        assert!(!load(&root).activated);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn out_of_range_interval_falls_back_to_default() {
        let mut settings = SyncSettings::default();
        settings.set_interval(1);
        assert_eq!(settings.auto_interval_secs, AUTO_INTERVAL_DEFAULT);
        settings.set_interval(u64::MAX);
        assert_eq!(settings.auto_interval_secs, AUTO_INTERVAL_DEFAULT);
        settings.set_interval(AUTO_INTERVAL_MIN);
        assert_eq!(settings.auto_interval_secs, AUTO_INTERVAL_MIN);
    }
}

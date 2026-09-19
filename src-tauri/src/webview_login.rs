//! 书源「网页登录」桥接层（主 crate 侧）。
//!
//! 把「插件（Android 原生 WebView 浮层 / 桌面独立登录窗口）」接到书源引擎的认证接口上：
//! - [`install`]：app setup 时注册一次认证后端——引擎命中 Cloudflare 挑战或书源 JS 调
//!   `webview.login(url)` 时，都会走这里拉起源码侧的登录界面；
//! - [`perform`]：界面命令（编辑页「网页登录」按钮）用的阻塞入口；
//! - [`seed_source_session`] / [`unseed`]：转发核心 crate 的登录态注入（幂等）——
//!   Cookie 进请求头，localStorage / sessionStorage / IndexedDB 快照进
//!   `webview.storage()` 的读取缓存。
//!
//! 独立二进制（readerx-source CLI）注册的是另一套后端（webkit2gtk / CDP），
//! 编排、持久化与注入逻辑都在 `readerx_source::auth`，两侧完全一致。

use readerx_source::auth::{self, AuthProvider, AuthRequest, LoginOutcome};
use std::sync::Arc;
use tauri_plugin_webview_login::{LoginOutcome as PluginOutcome, PlatformLoginRequest};

/// 插件后端（Android 浮层 / 桌面窗口，由插件按平台自行选择）。
///
/// 桌面端登录窗口由 Core 之外的 GUI 线程创建，需要 `AppHandle`；Android 浮层不需要，
/// 但一起带着没有代价（字段只在桌面端编译）。
struct PluginProvider {
    app: tauri::AppHandle,
}

impl PluginProvider {
    /// 平台是否支持（iOS / 插件未初始化时为 false）
    fn platform_supported() -> bool {
        tauri_plugin_webview_login::is_supported()
    }
}

impl AuthProvider for PluginProvider {
    fn supported(&self) -> bool {
        Self::platform_supported()
    }

    fn authenticate(
        &self,
        source_id: &str,
        url: &str,
        request: &AuthRequest,
    ) -> Result<LoginOutcome, String> {
        let platform = PlatformLoginRequest {
            scripts: request.scripts.clone(),
            user_agent: request.user_agent.clone(),
            probe: request.probe.clone(),
            source_id: source_id.to_string(),
            timeout_secs: LOGIN_TIMEOUT_SECS,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            app: Some(self.app.clone()),
        };
        let outcome: PluginOutcome =
            tauri_plugin_webview_login::open_login(url, &platform).unwrap_or_else(|err| {
                PluginOutcome::failure(url, err)
            });
        Ok(LoginOutcome {
            ok: outcome.ok,
            url: outcome.url.clone(),
            cookies: outcome.cookies.clone(),
            count: outcome.count as usize,
            message: outcome.message.clone(),
            // Android 浮层直接回传结构化快照；桌面窗口回传探针原始读数，这里统一解析
            storage: storage_of(&outcome),
        })
    }
}

/// 登录窗口的最长等待时间（用户忘了关窗时的兜底）
const LOGIN_TIMEOUT_SECS: u64 = 900;

/// 插件结果里的存储快照：Android 给结构化的 `storage`，桌面给探针原始读数
fn storage_of(outcome: &PluginOutcome) -> Option<readerx_source::storage::StorageSnapshot> {
    if let Some(value) = outcome.storage.as_ref() {
        return serde_json::from_value(value.clone()).ok();
    }
    let raw = outcome.probe_result.as_deref()?;
    readerx_source::storage::parse_probe_eval(raw)
        .ok()
        .filter(|snapshot| !snapshot.is_empty())
}

/// app setup 时调用。iOS 等不支持平台下插件不可用，`supported()` 为 false，不影响其它功能。
pub fn install(app: tauri::AppHandle) {
    auth::install_provider(Arc::new(PluginProvider { app }));
}

/// 当前平台是否支持网页登录（Android 浮层 / 桌面窗口 + 插件已初始化）。
pub fn is_supported() -> bool {
    PluginProvider::platform_supported()
}

/// 阻塞执行一次网页登录（引擎线程 / spawn_blocking 内使用）。
///
/// 结果由核心 crate 统一收尾：覆盖式持久化为该书源的登录态（Cookie 旧行精确移除，
/// 存储快照一并落盘）并立即注入会话；写盘失败会把原因写进 `message`，界面据此提示。
pub fn perform(source_id: &str, url: &str) -> Result<LoginOutcome, String> {
    let mut outcome = auth::perform(source_id, url)?;
    auth::persist_login_outcome(source_id, &mut outcome)?;
    Ok(outcome)
}

/// 把该书源已保存的登录态注入会话（幂等；进程内只注入一次）。
/// 返回是否本次真正注入了新 Cookie。
pub fn seed_source_session(source_id: &str) -> Result<bool, String> {
    auth::seed_source_session(source_id)
}

/// 清空该书源登录 Cookie 后重置注入标记（下次调用再按文件内容决定）。
pub fn unseed(source_id: &str) {
    auth::unseed(source_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Kotlin 侧回传的存储快照必须能原样落进引擎的 `StorageSnapshot`：
    /// 两边字段名（`localStorage` / `sessionStorage` / `indexedDb`）对不上就会静默丢掉整份快照。
    #[test]
    fn plugin_storage_payload_maps_to_engine_snapshot() {
        let payload = serde_json::json!({
            "version": 1,
            "origins": [{
                "origin": "https://example.com",
                "url": "https://example.com/home",
                "localStorage": [{ "key": "token", "value": "jwt-1" }],
                "sessionStorage": [{ "key": "sid", "value": "s-1", "truncated": true }],
                "indexedDb": [{ "name": "app", "version": 2, "stores": ["kv"] }],
            }],
        });
        let snapshot: readerx_source::storage::StorageSnapshot =
            serde_json::from_value(payload).expect("插件回传的快照应能反序列化");
        let origin = snapshot.origin("https://example.com").expect("origin 应保留");
        assert_eq!(origin.local_storage[0].key, "token");
        assert_eq!(origin.session_storage[0].value, "s-1");
        assert!(origin.session_storage[0].truncated);
        assert_eq!(origin.indexed_db[0].stores, vec!["kv".to_string()]);
    }

    /// 旧版插件（不返回 storage）与空快照都要能正常反序列化
    #[test]
    fn missing_or_empty_storage_is_fine() {
        let empty: PluginOutcome = serde_json::from_value(serde_json::json!({
            "ok": true,
            "url": "https://example.com",
            "cookies": "sid=1",
            "count": 1,
            "message": "",
        }))
        .unwrap();
        assert!(empty.storage.is_none());
        assert!(storage_of(&empty).is_none());
        assert!(serde_json::from_value::<readerx_source::storage::StorageSnapshot>(
            serde_json::json!({ "version": 1, "origins": [] })
        )
        .unwrap()
        .is_empty());
    }

    /// 桌面端窗口回传的是探针**原始读数**（`probeResult`，浏览器里求值出来的字符串），
    /// 主 crate 必须把它解析成引擎快照——解析失败就等于桌面端登录态丢了存储那部分。
    #[test]
    fn desktop_probe_result_is_parsed() {
        let inner = serde_json::json!({
            "version": 1,
            "origins": [{
                "origin": "https://desk.test",
                "url": "https://desk.test/home",
                "localStorage": [{ "key": "token", "value": "jwt-desk" }],
                "sessionStorage": [],
                "indexedDb": [],
            }],
        })
        .to_string();
        // WebKitGTK 的回调给裸文本，WebView2 给 JSON 字面量：两种形状都要认
        for raw in [inner.clone(), serde_json::to_string(&inner).unwrap()] {
            let outcome = PluginOutcome {
                ok: true,
                probe_result: Some(raw),
                ..Default::default()
            };
            let snapshot = storage_of(&outcome).expect("桌面端探针读数应解析成快照");
            assert_eq!(
                snapshot.origin("https://desk.test").unwrap().local_storage[0].value,
                "jwt-desk"
            );
        }
        // 空读数（探针没跑 / 页面没有存储）不应产生空快照
        let blank = PluginOutcome {
            ok: true,
            probe_result: Some("\"\"".to_string()),
            ..Default::default()
        };
        assert!(storage_of(&blank).is_none());
    }
}

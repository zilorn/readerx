//! 从官方 GitHub Release 检查正式版本；下载链接只接受本仓库资产。
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    body: Option<String>,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}
#[derive(Deserialize, Serialize)]
pub struct Asset {
    name: String,
    browser_download_url: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    version: String,
    notes: String,
    assets: Vec<Asset>,
}
fn newer(tag: &str, current: &str) -> Result<bool, String> {
    let version =
        semver::Version::parse(tag.trim_start_matches('v')).map_err(|_| "无效的发布版本")?;
    let current = semver::Version::parse(current).map_err(|_| "无效的应用版本")?;
    Ok(version.pre.is_empty() && version > current)
}
fn matches_platform(name: &str, version: &str, os: &str, arch: &str) -> bool {
    let abi = if os == "android" {
        match arch {
            "aarch64" => "arm64-v8a",
            "arm" => "armeabi-v7a",
            other => other,
        }
    } else {
        arch
    };
    let prefix = format!("readerx-{version}-{os}-{abi}");
    match os {
        "android" => name == format!("{prefix}.apk"),
        "windows" => name == format!("{prefix}-setup.exe"),
        "linux" => [".AppImage", ".deb", ".rpm"]
            .iter()
            .any(|ext| name == format!("{prefix}{ext}")),
        _ => false,
    }
}
#[tauri::command]
pub async fn readerx_update_check(app: tauri::AppHandle) -> Result<Option<Update>, String> {
    let current = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .user_agent(concat!("ReaderX/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "无法创建更新请求")?;
        let response = client
            .get("https://api.github.com/repos/zilorn/readerx/releases/latest")
            .header("Accept", "application/vnd.github+json")
            .send()
            .map_err(|_| "无法连接更新服务")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let release: Release = response
            .error_for_status()
            .map_err(|_| "更新服务返回错误")?
            .json()
            .map_err(|_| "无法解析发布信息")?;
        if release.draft || release.prerelease || !newer(&release.tag_name, &current)? {
            return Ok(None);
        }
        let version = release.tag_name.trim_start_matches('v').to_string();
        let prefix = format!(
            "https://github.com/zilorn/readerx/releases/download/{}/",
            release.tag_name
        );
        let assets = release
            .assets
            .into_iter()
            .filter(|a| {
                matches_platform(
                    &a.name,
                    &version,
                    std::env::consts::OS,
                    std::env::consts::ARCH,
                ) && a.browser_download_url == format!("{prefix}{}", a.name)
            })
            .collect();
        log::info!("发现应用更新：{version}");
        Ok(Some(Update {
            version,
            notes: release.body.unwrap_or_default(),
            assets,
        }))
    })
    .await
    .map_err(|_| "更新检查线程失败")?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions() {
        assert!(newer("v0.10.0", "0.9.0").unwrap());
        assert!(!newer("v0.3.0", "0.3.0").unwrap());
        assert!(!newer("v0.2.0", "0.3.0").unwrap());
        assert!(!newer("v0.4.0-beta.1", "0.3.0").unwrap());
        assert!(newer("oops", "0.3.0").is_err());
    }
    #[test]
    fn packages() {
        assert!(matches_platform(
            "readerx-0.4.0-android-arm64-v8a.apk",
            "0.4.0",
            "android",
            "aarch64"
        ));
        assert!(matches_platform(
            "readerx-0.4.0-windows-aarch64-setup.exe",
            "0.4.0",
            "windows",
            "aarch64"
        ));
        assert!(matches_platform(
            "readerx-0.4.0-linux-x86_64.deb",
            "0.4.0",
            "linux",
            "x86_64"
        ));
        assert!(!matches_platform(
            "readerx-0.4.0-android-arm64-v8a-debug.apk",
            "0.4.0",
            "android",
            "aarch64"
        ));
        assert!(!matches_platform(
            "readerx-0.4.0-linux-x86_64.deb",
            "0.4.0",
            "linux",
            "aarch64"
        ));
    }
}

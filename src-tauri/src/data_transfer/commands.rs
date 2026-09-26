//! 数据备份 / 恢复的 Tauri command。
//!
//! 与 `commands.rs` 的其它命令同一约定：**原生文件选择器不能丢进 blocking 线程池**
//! （对话框要跑在主线程，见 `readerx_pick_book_file` 的说明），所以先在这里弹框拿到
//! 路径，再把真正的磁盘 I/O 交给 `commands::blocking`（带 panic 收敛与耗时日志）。

use super::{
    archive, export, import, ExportOptions, ExportSummary, ImportMode, ImportPreview,
    ImportSummary, PickedArchive,
};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FilePath;

/// 导出 / 导入的进度事件（线格式与 `src/lib/backup.ts` 的 `DataProgress` 对齐）。
///
/// `step` 是**稳定的类别串**（`state` / `books` / `images` / `sources` / `sessions`），
/// 不是给人看的中文 —— 文案由前端按当前语言取。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DataProgress {
    Step { step: String, done: u64, total: u64 },
}

/// 原生选择器给出的路径（桌面端是普通路径，Android 是 `content://` 地址）
fn path_to_string(path: FilePath) -> String {
    match path {
        FilePath::Url(url) => url.to_string(),
        FilePath::Path(path) => path.to_string_lossy().into_owned(),
    }
}

/// 回执里展示的文件名。
///
/// Android 上选择器给的是 `content://` 地址，末段是文档 id（`msf%3A123`）而不是文件名，
/// 这时回落到我们建议的默认名；桌面端是普通路径，直接用真实文件名（用户可以改名）。
fn file_name_of(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    if last.to_lowercase().ends_with(".zip") {
        last.to_string()
    } else {
        super::default_file_name()
    }
}

fn reporter(channel: Channel<DataProgress>) -> impl FnMut(&str, u64, u64) + Send + 'static {
    move |step: &str, done: u64, total: u64| {
        // 前端已离开页面 / WebView 已销毁：只记一条 debug，不打断导出
        if let Err(error) = channel.send(DataProgress::Step {
            step: step.to_string(),
            done,
            total,
        }) {
            log::debug!("进度回传失败（界面可能已关闭）: {error}");
        }
    }
}

/// 导出全部数据：弹保存框 → 写归档。用户取消返回 `Ok(None)`。
///
/// `include_credentials` 为真时把书源登录态与 WebDAV 密码一并写进归档（默认否）。
#[tauri::command]
pub async fn readerx_data_export(
    app: AppHandle,
    include_credentials: bool,
    on_progress: Channel<DataProgress>,
) -> Result<Option<ExportSummary>, String> {
    let picked = app
        .dialog()
        .file()
        .set_file_name(super::default_file_name())
        .add_filter("ReaderX 备份", &["zip"])
        .blocking_save_file();
    let Some(picked) = picked else {
        log::debug!("用户取消了数据导出");
        return Ok(None);
    };
    // 用户可能把默认名改掉，回执里用真实文件名
    let raw = path_to_string(picked);
    let file_name = file_name_of(&raw);
    let summary = crate::commands::blocking("数据导出", {
        let app = app.clone();
        let raw = raw.clone();
        move || {
            let destination = archive::open_destination(&app, &raw)?;
            let mut report = reporter(on_progress);
            export::export_to(
                &app,
                destination,
                ExportOptions {
                    include_credentials,
                },
                &mut report,
            )
        }
    })
    .await?;
    Ok(Some(ExportSummary {
        file_name,
        ..summary
    }))
}

/// 选一个备份文件并给出预览（**不解压正文**，只读清单）：界面据此让用户选导入方式。
#[tauri::command]
pub async fn readerx_data_import_pick(app: AppHandle) -> Result<Option<PickedArchive>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("ReaderX 备份", &["zip"])
        .blocking_pick_file();
    let Some(picked) = picked else {
        log::debug!("用户取消了备份选择");
        return Ok(None);
    };
    let raw = path_to_string(picked);
    let scan = crate::commands::blocking("备份读取", {
        let app = app.clone();
        let raw = raw.clone();
        move || archive::scan(&app, &raw)
    })
    .await?;
    let manifest = scan.manifest;
    Ok(Some(PickedArchive {
        path: raw,
        preview: ImportPreview {
            app_version: manifest.app_version,
            created_at: manifest.created_at,
            credentials: manifest.credentials,
            books: manifest.books,
            images: manifest.images,
            sources: manifest.sources,
            state_keys: manifest.state_keys,
            bytes: scan.bytes,
        },
    }))
}

/// 导入备份：`mode` 为 `merge`（默认）或 `replace`。
///
/// 路径由前端从预览里原样传回：命令本身不记隐藏状态，重复调用也不会串味。
#[tauri::command]
pub async fn readerx_data_import(
    app: AppHandle,
    path: String,
    mode: String,
    on_progress: Channel<DataProgress>,
) -> Result<ImportSummary, String> {
    let mode = ImportMode::parse(&mode)?;
    crate::commands::blocking("数据导入", move || {
        let mut report = reporter(on_progress);
        import::apply(&app, &path, mode, &mut report)
    })
    .await
}

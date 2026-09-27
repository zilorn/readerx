//! 书源「用户输入表单」桥接层（主 crate 侧）。
//!
//! 把「前端弹层」接到书源引擎的表单接口上（引擎侧编排见 `readerx_source::prompt`）：
//! - [`install`]：app setup 时注册一次后端 —— 书源 JS 调 `input.prompt({...})` 时，
//!   引擎线程阻塞在这里，等界面把用户填的值回传；
//! - `readerx-source-prompt` 事件把表单推给前端（见 `src/lib/sourcePrompt.ts`），
//!   前端提交 / 取消走 [`readerx_source_prompt_submit`]；
//! - 前端就绪得晚（表单在启动早期就弹了）时用 [`readerx_source_prompt_pending`] 补拉一次，
//!   不必依赖事件到达顺序；
//! - 用户一直不处理：到 [`PROMPT_TIMEOUT`] 自动收场并向界面推一条收起事件，
//!   否则引擎线程会永远挂着（连带那次书源调用也不结束）。
//!
//! 独立二进制（readerx-source CLI）注册的是另一套后端（终端交互读取），
//! 选项校验、值规范化与「本次运行内只问一次」的记忆都在核心 crate 里，两侧完全一致。

use readerx_source::prompt::{self, PromptField, PromptOutcome, PromptProvider, PromptRequest};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// 推给前端的表单事件（前端监听见 `src/lib/sourcePrompt.ts`）
const PROMPT_EVENT: &str = "readerx-source-prompt";
/// 表单已作废（超时）时推给前端，让弹层自己收起来
const PROMPT_CLOSE_EVENT: &str = "readerx-source-prompt-close";

/// 用户一直不处理时的最长等待：到点收场，别把引擎线程和书源调用一起挂死
const PROMPT_TIMEOUT: Duration = Duration::from_secs(600);
/// 同时挂起的表单上限（多书源并发搜索时，避免一屏接一屏地弹）
const MAX_PENDING: usize = 8;

/// 界面回传的内容
enum Reply {
    /// 用户提交（值已按字段规范化）
    Submitted(Map<String, Value>),
    /// 用户取消
    Cancelled,
}

/// 一张挂起的表单：界面按 id 回填，引擎线程在 `reply` 上等着
struct Pending {
    request: PromptRequest,
    reply: Sender<Reply>,
}

fn pending_slot() -> &'static Mutex<HashMap<u64, Pending>> {
    static PENDING: OnceLock<Mutex<HashMap<u64, Pending>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// 表单 id（单调递增；前端只把它当句柄回传，不代表顺序语义）
fn next_id() -> u64 {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    NEXT_ID.fetch_add(1, Ordering::SeqCst)
}

/// 登记一张等待中的表单；同时挂起的太多时返回原因（调用方据此直接给 `ok:false`）。
fn try_register(id: u64, request: &PromptRequest, reply: Sender<Reply>) -> Result<(), String> {
    let mut pending = pending_slot().lock().unwrap_or_else(|e| e.into_inner());
    if pending.len() >= MAX_PENDING {
        return Err("同时等待用户处理的表单过多，请先完成或取消上一个".to_string());
    }
    pending.insert(
        id,
        Pending {
            request: request.clone(),
            reply,
        },
    );
    Ok(())
}

/// 摘掉一张表单（提交成功 / 超时 / 推给界面失败都走这里）
fn unregister(id: u64) {
    pending_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
}

/// 推给前端的表单载荷（字段名与 `src/lib/sourcePrompt.ts` 的接口一一对应）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePromptEvent {
    pub id: u64,
    /// 发起表单的书源
    pub source_id: String,
    /// 书源显示名（读不到时回落到 id）
    pub source_name: String,
    pub title: String,
    pub message: String,
    pub fields: Vec<PromptField>,
}

/// 界面后端：把表单推给前端弹层并阻塞等待。
///
/// 对运行时泛型（与 `sync` 模块同一约定）：App 用 Wry，集成测试用 mock 运行时。
struct UiPromptProvider<R: tauri::Runtime> {
    app: AppHandle<R>,
}

impl<R: tauri::Runtime> UiPromptProvider<R> {
    /// 书源显示名：只用于界面抬头（读不到就用 id，不影响功能）
    fn source_name(&self, source_id: &str) -> String {
        readerx_source::store::get_source(source_id)
            .ok()
            .flatten()
            .map(|source| source.name)
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| source_id.to_string())
    }
}

impl<R: tauri::Runtime> PromptProvider for UiPromptProvider<R> {
    fn supported(&self) -> bool {
        // 界面就在 WebView 里：只要进程活着就能弹（窗口被关掉时提交永远不来，
        // 由 PROMPT_TIMEOUT 收场）
        true
    }

    fn prompt(&self, request: &PromptRequest) -> Result<PromptOutcome, String> {
        let id = next_id();
        let (reply, wait) = mpsc::channel();
        if let Err(reason) = try_register(id, request, reply) {
            log::warn!(
                "用户输入表单过多，本次直接拒绝 source={} reason={reason}",
                request.source_id
            );
            return Ok(PromptOutcome::failure(reason));
        }

        let event = SourcePromptEvent {
            id,
            source_id: request.source_id.clone(),
            source_name: self.source_name(&request.source_id),
            title: request.title.clone(),
            message: request.message.clone(),
            fields: request.fields.clone(),
        };
        if let Err(err) = self.app.emit(PROMPT_EVENT, event) {
            unregister(id);
            return Err(format!("无法把表单推给界面: {err}"));
        }

        match wait.recv_timeout(PROMPT_TIMEOUT) {
            Ok(Reply::Submitted(values)) => Ok(PromptOutcome::success(values)),
            Ok(Reply::Cancelled) => Ok(PromptOutcome::cancelled()),
            Err(RecvTimeoutError::Timeout) => {
                unregister(id);
                // 表单可能一直显示在界面上：明确通知收起，避免用户填完一个早就作废的表单
                let _ = self.app.emit(PROMPT_CLOSE_EVENT, id);
                Ok(PromptOutcome::failure("等待用户输入超时（表单已收起）"))
            }
            Err(RecvTimeoutError::Disconnected) => {
                unregister(id);
                Ok(PromptOutcome::failure("表单已失效"))
            }
        }
    }
}

/// app setup 时调用：注册界面后端（书源 `input.prompt` 从此可用）。
pub fn install<R: tauri::Runtime>(app: AppHandle<R>) {
    prompt::install_provider(std::sync::Arc::new(UiPromptProvider { app }));
}

/// 界面提交失败的原因（结构化：前端按 `code` 出本地化文案，`message` 只进日志 / 兜底展示）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSubmitError {
    /// `invalid` = 值不合法（表单仍在等待，用户改完可以再交）；`expired` = 该表单已作废
    pub code: &'static str,
    /// 具体原因（中文，供日志与兜底展示；界面按 code 出本地化文案）
    pub message: String,
}

impl PromptSubmitError {
    fn expired() -> Self {
        Self {
            code: "expired",
            message: "该输入请求已失效".to_string(),
        }
    }

    fn invalid(message: String) -> Self {
        Self {
            code: "invalid",
            message,
        }
    }
}

/// 界面提交 / 取消一张表单。
///
/// 值在这里按字段再校验一遍（界面上已经校验过，这里是兜底）：不合法就**把表单放回去**
/// 并把原因回给界面，用户不用重新填一遍；命中不存在的 id（已超时作废）返回 `expired`。
#[tauri::command]
pub fn readerx_source_prompt_submit(
    id: u64,
    values: Option<Map<String, Value>>,
    cancelled: bool,
) -> Result<(), PromptSubmitError> {
    let entry = pending_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    let Some(Pending { request, reply }) = entry else {
        return Err(PromptSubmitError::expired());
    };
    if cancelled {
        let _ = reply.send(Reply::Cancelled);
        return Ok(());
    }
    match request.normalize_values(&values.unwrap_or_default()) {
        Ok(values) => {
            let _ = reply.send(Reply::Submitted(values));
            Ok(())
        }
        Err(reason) => {
            log::debug!(
                "界面提交的表单值不合法 source={} reason={reason}",
                request.source_id
            );
            pending_slot()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id, Pending { request, reply });
            Err(PromptSubmitError::invalid(reason))
        }
    }
}

/// 仍在等待用户处理的表单（按弹出顺序）。前端订阅事件后再拉一次，补齐订阅前发出的那些。
#[tauri::command]
pub fn readerx_source_prompt_pending(app: AppHandle) -> Vec<SourcePromptEvent> {
    pending(&app)
}

/// [`readerx_source_prompt_pending`] 的实现（对运行时泛型，集成测试直接调它）。
pub fn pending<R: tauri::Runtime>(app: &AppHandle<R>) -> Vec<SourcePromptEvent> {
    let provider = UiPromptProvider { app: app.clone() };
    let mut pending: Vec<(u64, PromptRequest)> = pending_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(id, entry)| (*id, entry.request.clone()))
        .collect();
    pending.sort_by_key(|(id, _)| *id);
    pending
        .into_iter()
        .map(|(id, request)| SourcePromptEvent {
            id,
            source_name: provider.source_name(&request.source_id),
            source_id: request.source_id,
            title: request.title,
            message: request.message,
            fields: request.fields,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(source_id: &str) -> PromptRequest {
        prompt::parse_request(
            source_id,
            r#"{"title":"口令","fields":[{"key":"pwd","label":"口令","type":"password","required":true}]}"#,
        )
        .expect("选项应能解析")
    }

    /// 超时的表单要能被收掉：`submit` 之后再交同一个 id 必须失败（否则引擎线程会一直等）。
    #[test]
    fn expired_prompt_is_not_submittable() {
        assert!(readerx_source_prompt_submit(999_999, None, false).is_err());
    }

    /// 界面回传的值要按字段规范化后再交给引擎：必填留空不合法（表单留在原地），
    /// 合法时把规范化后的值送到等待方。
    #[test]
    fn submit_normalizes_and_keeps_prompt_on_invalid_values() {
        let id = 424_242;
        let (reply, wait) = mpsc::channel();
        pending_slot()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id,
                Pending {
                    request: request("prompt-submit-test"),
                    reply,
                },
            );

        // 必填留空：报错且表单仍挂在那里（界面继续显示，用户改完再交）
        let invalid = readerx_source_prompt_submit(id, None, false);
        assert!(invalid.is_err());
        assert!(
            pending_slot()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&id),
            "校验失败时表单不该被摘掉"
        );

        let mut values = Map::new();
        values.insert("pwd".to_string(), Value::String("s3cret".to_string()));
        readerx_source_prompt_submit(id, Some(values), false).expect("合法值应提交成功");
        assert!(
            !pending_slot()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&id),
            "提交成功后表单应被摘掉"
        );
        match wait.recv_timeout(Duration::from_secs(1)) {
            Ok(Reply::Submitted(values)) => assert_eq!(values["pwd"], Value::String("s3cret".into())),
            _ => panic!("等待方应收到规范化后的值"),
        }
        // 幂等性：同一个 id 不能再交第二次
        assert!(readerx_source_prompt_submit(id, None, true).is_err());
    }

    /// 取消：等待方拿到 `Cancelled`（引擎侧转成 ok:false，不抛错）
    #[test]
    fn cancel_reaches_the_waiter() {
        let id = 424_243;
        let (reply, wait) = mpsc::channel();
        pending_slot()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id,
                Pending {
                    request: request("prompt-cancel-test"),
                    reply,
                },
            );
        readerx_source_prompt_submit(id, None, true).expect("取消应被接受");
        assert!(matches!(
            wait.recv_timeout(Duration::from_secs(1)),
            Ok(Reply::Cancelled)
        ));
    }

    /// 同时挂起的表单有上限：界面一直不处理时，新来的表单直接拿到可读原因，
    /// 而不是无限堆在注册表里（每个都等着引擎线程）。
    #[test]
    fn pending_forms_are_capped() {
        let mut ids: Vec<u64> = Vec::new();
        // 等待端要一直持有，否则通道断开会让等待方提前返回
        let mut waiters: Vec<mpsc::Receiver<Reply>> = Vec::new();
        for index in 0..MAX_PENDING {
            let id = 500_000 + index as u64;
            let (reply, wait) = mpsc::channel();
            // 注册表里可能已有别的测试留下的条目：满了就提前结束（同样验证了上限生效）
            if try_register(id, &request("prompt-cap-test"), reply).is_err() {
                break;
            }
            ids.push(id);
            waiters.push(wait);
        }
        assert!(!ids.is_empty(), "至少应能登记一张表单");
        let (reply, _wait) = mpsc::channel();
        let rejected = try_register(999_999, &request("prompt-cap-test"), reply);
        assert!(rejected.is_err(), "超过上限时必须被拒绝");
        assert!(rejected.unwrap_err().contains("过多"));

        for id in ids {
            unregister(id);
        }
        drop(waiters);
    }
}

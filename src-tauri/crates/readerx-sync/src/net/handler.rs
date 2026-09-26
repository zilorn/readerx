//! 请求处理：把一条 [`Request`] 应用到引擎，产生 [`Response`]。
//!
//! 服务端（TCP）与进程内直连（[`super::loopback`]）共用这一份实现，
//! 保证「本机自测」与「真局域网」走的是同一套语义——否则测试通过了线上仍可能出问题。

use crate::engine::SyncEngine;
use crate::proto::{RejectedOp, Request, Response};
use crate::id::now_ms;
use crate::PROTOCOL_VERSION;

/// 处理一条已鉴权请求。`peer_device` 是请求方设备 id（用于冲突记录标注来源）。
///
/// 注意：`Hello` / `Auth` 属于握手，由各自的传输实现在更早的阶段处理，
/// 走到这里说明握手已完成，因此把它们当协议错误返回。
pub fn handle_request(
    engine: &mut SyncEngine,
    peer_device: Option<&str>,
    request: &Request,
) -> Response {
    match request {
        Request::Pull { since, limit } => {
            let limit = (*limit).clamp(1, 1000);
            let (ops, has_more) = engine.ops_for_peer(since, limit);
            log::debug!(
                "对端拉取：给出 {} 条（还有更多：{}）",
                ops.len(),
                has_more
            );
            Response::Ops { ops, knowledge: engine.knowledge(), has_more }
        }
        Request::Push { ops } => {
            let batch = match engine.apply_many(ops, peer_device) {
                Ok(batch) => batch,
                Err(e) => {
                    log::warn!("对端推送应用失败: {e}");
                    return Response::error("apply_failed", e.to_string());
                }
            };
            let rejected: Vec<RejectedOp> = batch
                .rejects
                .iter()
                .map(|(op_id, code, message)| RejectedOp {
                    op_id: op_id.clone(),
                    code: code.clone(),
                    message: message.clone(),
                })
                .collect();
            log::debug!(
                "对端推送：应用 {} 重复 {} 缓冲 {} 拒绝 {} 冲突 {}",
                batch.applied,
                batch.duplicates,
                batch.deferred,
                batch.rejected,
                batch.conflicts
            );
            Response::Ack {
                accepted: batch.applied,
                rejected,
                conflicts: batch.conflicts,
                knowledge: engine.knowledge(),
            }
        }
        Request::Stat => {
            let status = engine.status();
            Response::Stat {
                device: status.device_id,
                name: status.device_name,
                protocol: PROTOCOL_VERSION.to_string(),
                entities: status.live_entities as u64,
                ops: status.ops as u64,
                conflicts: status.conflicts as u64,
                pending_conflicts: status.pending_conflicts as u64,
                knowledge: status.knowledge,
            }
        }
        Request::Ping => Response::Pong { at_ms: now_ms() },
        Request::Hello { .. } | Request::Auth { .. } => {
            Response::error("unexpected", "握手阶段不允许的业务请求")
        }
    }
}

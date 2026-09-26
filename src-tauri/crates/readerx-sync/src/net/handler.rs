//! 请求处理：把一条 [`Request`] 应用到引擎，产生 [`Response`]。
//!
//! 服务端（TCP）与进程内直连（[`super::loopback`]）共用这一份实现，
//! 保证「本机自测」与「真局域网」走的是同一套语义——否则测试通过了线上仍可能出问题。

use crate::engine::SyncEngine;
use crate::proto::{
    RejectedOp, Request, Response, CONTENT_BATCH_BYTES, CONTENT_BATCH_CHAPTERS,
};
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
        // ---- 正文通道（见 crate::content）----
        Request::ContentIndex { books } => {
            // 只回本机**有正文**的书：对端据此判断哪些书要逐章对账。
            // 对端列出的书在本机没有正文时直接不出现在应答里（= 不一样）。
            let theirs: Vec<_> = books
                .iter()
                .map(|entry| engine.content_index(&entry.book))
                .filter(|digest| digest.chapters > 0)
                .collect();
            Response::ContentIndex { books: theirs }
        }
        Request::ChapterDigests { book } => {
            let known = engine
                .entity(book)
                .is_some_and(|entity| !engine.is_effectively_deleted(entity));
            Response::ChapterDigests {
                book: book.clone(),
                known,
                chapters: engine.content_digests(book),
            }
        }
        Request::PullChapters { book, cids } => {
            // 按帧预算装箱：装不下的章节这次不给，对端下次同步会重新算差集
            let bodies = engine.content_bodies(book, cids);
            let mut items = Vec::new();
            let mut bytes = 0usize;
            for body in bodies {
                let size = body.body_bytes() as usize;
                if size > CONTENT_BATCH_BYTES {
                    // 单章超过帧预算：这一章搬不过去（不静默丢，留下日志）
                    log::warn!("章节正文超过单帧预算，跳过 book={book} bytes={size}");
                    continue;
                }
                if items.len() >= CONTENT_BATCH_CHAPTERS || bytes + size > CONTENT_BATCH_BYTES {
                    break;
                }
                bytes += size;
                items.push(body);
            }
            if items.len() < cids.len() {
                log::debug!("本次只回了 {} 章正文（其余留给下次同步）", items.len());
            }
            Response::Chapters { book: book.clone(), items }
        }
        Request::PushChapters { book, items } => match engine.stage_content(book, items) {
            Ok(stored) => Response::ContentAck { stored },
            Err(error) => {
                log::warn!("暂存对端正文失败: {error}");
                Response::error("content_failed", error.to_string())
            }
        },
        Request::Ping => Response::Pong { at_ms: now_ms() },
        Request::Hello { .. } | Request::Auth { .. } => {
            Response::error("unexpected", "握手阶段不允许的业务请求")
        }
    }
}

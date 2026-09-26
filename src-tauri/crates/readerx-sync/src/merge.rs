//! 合并引擎：把一条操作并进实体，并按字段语义裁决冲突。
//!
//! **调用前提（很重要）**：只有「因果就绪」的操作才会走到这里——也就是说
//! `entity.version` 覆盖 `op.base`（作者写入时看到的操作，本地都已经并进去了）。
//! 引擎在调用前用因果缓冲保证这一点（见 [`crate::engine`]）。有了这个前提：
//!
//! - 「作者有没有见过某次写入」可以直接用 `op.base.contains(写入者的 stamp)` 判断；
//! - 于是「两次写入是否并发」= **对方没见过我这次写入**，不需要再存每字段的基线向量。
//!
//! 各字段策略的裁决方式：
//!
//! | 策略 | 并发时的结果 | 是否进冲突队列 |
//! | --- | --- | --- |
//! | `Lww` | 按 HLC 全序选一次写入 | 是（败方值留在记录里） |
//! | `MultiValue` | 多个值都保留 | 是（等人裁决） |
//! | `Frozen` | 首次写入生效 | 是 |
//! | `Counter` | 增量相加 | 否（有确定语义） |
//! | `Set` | OR-Set：add-wins / remove-wins | 否（有确定语义） |
//! | `List` | 位置键都保留，按 (位置, 元素 id) 排序 | 仅「并发移动同一元素」记一条 |
//!
//! 「进冲突队列」不等于「合并失败」：数据一定先按确定语义合并（保证各副本收敛），
//! 冲突记录只是把**被覆盖掉的那一方**原样留档，让人事后能看见、能改回来。

use serde_json::Value;
use std::collections::BTreeMap;

use crate::hlc::Hlc;
use crate::id::{new_id, EntityId};
use crate::model::{
    AddTag, Conflict, ConflictReason, ConflictSide, ConflictStatus, Entity, FieldState, ListItem,
    OpKind, Operation, SetPolicy, Stamp, StampedValue, Tombstone,
};
use crate::order;
use crate::schema::{DeletePolicy, MergeKind, Schema};

/// 唯一键查询：`(字段, 值, 当前实体 id) -> 占用该值的实体 id`。
///
/// 抽成类型别名一是为了可读性，二是让引擎侧只实现一次（见 `SyncEngine::unique_candidates`）。
pub type UniqueLookup<'a> = dyn Fn(&str, &Value, &str) -> Option<EntityId> + 'a;

/// 合并上下文。
pub struct MergeCtx<'a> {
    /// 实体类型对应的 schema（决定字段策略与删除语义）
    pub schema: &'a Schema,
    /// 本设备 id
    pub local_device: &'a str,
    /// 这条操作来自哪个对端（本地操作 / 未知来源为 `None`）
    pub peer_device: Option<&'a str>,
    /// 当前墙钟毫秒（冲突记录用）
    pub now_ms: u64,
    /// 查「同类型实体里谁已经占用了这个唯一键值」（不含当前实体）；未接入唯一键约束时为 `None`
    pub unique_lookup: Option<&'a UniqueLookup<'a>>,
}

impl<'a> MergeCtx<'a> {
    /// 最小上下文（本地应用、无唯一键约束）。
    pub fn new(schema: &'a Schema, local_device: &'a str, now_ms: u64) -> MergeCtx<'a> {
        MergeCtx { schema, local_device, peer_device: None, now_ms, unique_lookup: None }
    }

    /// 标注来源对端。
    pub fn with_peer(mut self, peer: Option<&'a str>) -> Self {
        self.peer_device = peer;
        self
    }

    /// 接入唯一键查询。
    pub fn with_unique_lookup(mut self, lookup: &'a UniqueLookup<'a>) -> Self {
        self.unique_lookup = Some(lookup);
        self
    }

    /// 构造一条冲突记录。参数确实多，但每个都是记录里的一个字段，
    /// 拆成 builder 反而让调用点更难读。
    #[allow(clippy::too_many_arguments)]
    fn conflict(
        &self,
        entity: &Entity,
        field: &str,
        reason: ConflictReason,
        local: ConflictSide,
        remote: ConflictSide,
        status: ConflictStatus,
        note: Option<String>,
    ) -> Conflict {
        Conflict {
            id: new_id(),
            entity_id: entity.id.clone(),
            kind: entity.kind.clone(),
            field: field.to_string(),
            reason,
            local,
            remote,
            status,
            detected_at_ms: self.now_ms,
            peer_device: self.peer_device.map(|p| p.to_string()),
            note,
            resolved_by_op: None,
        }
    }
}

/// 操作被拒绝的原因（数据没进实体）。
#[derive(Clone, Debug, PartialEq)]
pub enum Rejection {
    /// 唯一键被别的实体占用（两边都保留，等人处理）
    UniqueKey { field: String, owner: EntityId },
    /// 不可变字段被改写
    Immutable { field: String },
    /// 字段策略与操作类型不匹配（例如对计数器用 Set 之外的写法、对普通字段做集合操作）
    FieldKind { field: String, expected: &'static str },
    /// 同一个 id 被当成两种实体类型（业务主键撞车）
    KindMismatch { existing: String, incoming: String },
    /// 实体已删除，且 schema 不允许这次写入把它复活
    Deleted { field: String },
}

impl Rejection {
    /// 日志 / 统计用的短标签。
    pub fn code(&self) -> &'static str {
        match self {
            Rejection::UniqueKey { .. } => "unique_key",
            Rejection::Immutable { .. } => "immutable",
            Rejection::FieldKind { .. } => "field_kind",
            Rejection::KindMismatch { .. } => "kind_mismatch",
            Rejection::Deleted { .. } => "deleted",
        }
    }
}

/// 合并结果。
#[derive(Clone, Debug, Default)]
pub struct MergeOutcome {
    /// 实体是否发生了变化（决定要不要写快照）
    pub changed: bool,
    /// 产生的冲突记录（含已自动裁决的）
    pub conflicts: Vec<Conflict>,
    /// 未应用的原因（至多一个）
    pub reject: Option<Rejection>,
    /// 被这次写入**了结**的字段：写入者看到了两边状态（非并发），
    /// 因此该字段上遗留的待裁决冲突应当随之关闭（否则队列永远不会自己清空）。
    pub settled: Vec<String>,
}

impl MergeOutcome {
    fn touched(&mut self) {
        self.changed = true;
    }

    fn settle(&mut self, field: &str) {
        if !field.is_empty() && !self.settled.iter().any(|f| f == field) {
            self.settled.push(field.to_string());
        }
    }

    /// 是否有需要人工处理的冲突。
    pub fn has_pending(&self) -> bool {
        self.conflicts.iter().any(|c| c.status.is_pending())
    }
}

/// 把一条操作并进实体。
///
/// 调用方负责：确保实体已存在（不存在时先建空实体）、调用后把
/// `op.stamp()` 记进 `entity.version`、维护 `entity.updated`。
pub fn apply(entity: &mut Entity, op: &Operation, ctx: &MergeCtx) -> MergeOutcome {
    let mut out = MergeOutcome::default();

    // 同一个 id 被当成两种类型：不合并，留冲突（场景 7 的「业务主键撞车」）
    if entity.kind != op.kind {
        let local = ConflictSide::new(None, entity.created.clone(), Stamp::new(&entity.id, 0));
        let remote = ConflictSide::new(None, op.hlc.clone(), op.stamp());
        out.conflicts.push(ctx.conflict(
            entity,
            "",
            ConflictReason::DuplicateEntity,
            local,
            remote,
            ConflictStatus::Pending,
            Some(format!("同一 id 的类型不一致：本地 {} / 对端 {}", entity.kind, op.kind)),
        ));
        out.reject =
            Some(Rejection::KindMismatch { existing: entity.kind.clone(), incoming: op.kind.clone() });
        return out;
    }

    entity.schema_ver = entity.schema_ver.max(op.schema_ver);

    match &op.op {
        OpKind::DeleteEntity { reason } => {
            apply_delete(entity, op, reason.as_deref(), ctx, &mut out);
        }
        OpKind::RestoreEntity => apply_restore(entity, op, ctx, &mut out),
        OpKind::Create { fields } => {
            if deleted_gate(entity, op, ctx, &mut out) {
                return out;
            }
            let fields = fields.clone();
            for (field, value) in fields {
                seed_field(entity, &field, value, op, ctx, &mut out);
            }
        }
        _ => {
            if deleted_gate(entity, op, ctx, &mut out) {
                return out;
            }
            apply_field_op(entity, op, ctx, &mut out);
        }
    }

    // 待裁决的字段标出来（已自动裁决的不标，避免界面上出现「已解决却仍报冲突」）
    let pending: Vec<(String, String)> = out
        .conflicts
        .iter()
        .filter(|c| c.status.is_pending())
        .map(|c| (c.entity_id.clone(), c.field.clone()))
        .collect();
    for (_, field) in pending {
        if !field.is_empty() {
            entity.conflicted.insert(field);
        }
    }

    out
}

/// 实体已删除时的「闸门」：返回 `true` 表示这条操作不应写进实体。
///
/// 处理的就是「一方更新、一方删除」（场景 5）与「并发恢复删除」（场景 30）。
fn deleted_gate(
    entity: &mut Entity,
    op: &Operation,
    ctx: &MergeCtx,
    out: &mut MergeOutcome,
) -> bool {
    let Some(tomb) = entity.deleted.clone() else {
        return false;
    };
    // 写入者见过这次删除 ⇒ 顺序上的「删了又改」
    let saw_delete = op.base.contains(&tomb.origin.device, tomb.origin.seq);
    let local =
        ConflictSide::new(Some(field_snapshot(&tomb)), tomb.hlc.clone(), tomb.origin.clone());
    let remote = ConflictSide::new(Some(op_value(op)), op.hlc.clone(), op.stamp());

    if saw_delete {
        // 已删除的记录被顺序改写：默认不复活（记录进队列，数据不丢）
        out.conflicts.push(ctx.conflict(
            entity,
            &op.field,
            ConflictReason::DeleteVsUpdate,
            local,
            remote,
            ConflictStatus::Pending,
            Some("记录已删除，改写在默认策略下不会复活它".to_string()),
        ));
        out.reject = Some(Rejection::Deleted { field: op.field.clone() });
        return true;
    }

    // 并发：写入者没看到删除
    match ctx.schema.delete_policy {
        DeletePolicy::DeleteWins if !ctx.schema.resurrect_on_write => {
            out.conflicts.push(ctx.conflict(
                entity,
                &op.field,
                ConflictReason::DeleteVsUpdate,
                local,
                remote,
                ConflictStatus::Resolved,
                Some("删除优先：并发的更新未生效，原值已留档".to_string()),
            ));
            out.reject = Some(Rejection::Deleted { field: op.field.clone() });
            true
        }
        DeletePolicy::UpdateWins | DeletePolicy::DeleteWins => {
            // 更新优先（或开了「写即复活」）：取消墓碑并继续应用这条写入
            entity.deleted = None;
            out.touched();
            out.conflicts.push(ctx.conflict(
                entity,
                &op.field,
                ConflictReason::DeleteVsUpdate,
                local,
                remote,
                ConflictStatus::Resolved,
                Some("更新优先：并发的写入使记录复活".to_string()),
            ));
            false
        }
        DeletePolicy::Manual => {
            out.conflicts.push(ctx.conflict(
                entity,
                &op.field,
                ConflictReason::DeleteVsUpdate,
                local,
                remote,
                ConflictStatus::Pending,
                Some("删除与更新并发，等待人工裁决".to_string()),
            ));
            out.reject = Some(Rejection::Deleted { field: op.field.clone() });
            true
        }
    }
}

/// 删除实体（落墓碑）。
fn apply_delete(
    entity: &mut Entity,
    op: &Operation,
    reason: Option<&str>,
    ctx: &MergeCtx,
    out: &mut MergeOutcome,
) {
    // 删除者没看到本地全部状态 ⇒ 与本地更新并发
    let concurrent = !op.base.covers(&entity.version);

    if let Some(existing) = &entity.deleted {
        // 已有墓碑：谁的时间更晚用谁的（幂等：同一个墓碑重复到达不改动）
        if existing.hlc >= op.hlc {
            return;
        }
    }

    let local = ConflictSide::new(
        Some(Value::Object(
            entity
                .fields
                .iter()
                .map(|(k, v)| (k.clone(), v.display_value(SetPolicy::AddWins)))
                .collect(),
        )),
        entity.updated.clone(),
        Stamp::new(&entity.id, 0),
    );
    let remote = ConflictSide::new(Some(op_value(op)), op.hlc.clone(), op.stamp());

    // 更新优先 + 并发：这次删除不生效，记录留档（数据与状态都不动）
    if concurrent && matches!(ctx.schema.delete_policy, DeletePolicy::UpdateWins) {
        out.conflicts.push(ctx.conflict(
            entity,
            "",
            ConflictReason::DeleteVsUpdate,
            local,
            remote,
            ConflictStatus::Resolved,
            Some("更新优先：本地更新未被这次并发删除覆盖（可从冲突记录里改回删除）".to_string()),
        ));
        return;
    }

    entity.deleted = Some(Tombstone {
        hlc: op.hlc.clone(),
        origin: op.stamp(),
        base: op.base.clone(),
        reason: reason.map(|r| r.to_string()),
        cascade_from: None,
    });
    out.touched();
    if !concurrent {
        // 删除者看到了两边状态：这条删除是权威的，实体上遗留的待裁决冲突随之关闭
        let fields: Vec<String> = entity.conflicted.iter().cloned().collect();
        for field in fields {
            out.settle(&field);
        }
    }

    if concurrent {
        let (status, note) = match ctx.schema.delete_policy {
            DeletePolicy::DeleteWins => (
                ConflictStatus::Pending,
                "删除优先：并发的本地更新未生效，原值已留档待确认",
            ),
            // 更新优先的情形已经在上面提前返回，这里只是把策略与说明配上
            DeletePolicy::UpdateWins => {
                (ConflictStatus::Resolved, "更新优先：本地更新未被删除覆盖")
            }
            DeletePolicy::Manual => (ConflictStatus::Pending, "删除与本地更新并发，等待人工裁决"),
        };
        out.conflicts.push(ctx.conflict(
            entity,
            "",
            ConflictReason::DeleteVsUpdate,
            local,
            remote,
            status,
            Some(note.to_string()),
        ));
    }
}

/// 取消墓碑（显式恢复）。
fn apply_restore(entity: &mut Entity, op: &Operation, ctx: &MergeCtx, out: &mut MergeOutcome) {
    let Some(tomb) = entity.deleted.clone() else {
        return; // 本来就没删：幂等
    };
    let saw_delete = op.base.contains(&tomb.origin.device, tomb.origin.seq);
    let local = ConflictSide::new(Some(field_snapshot(&tomb)), tomb.hlc.clone(), tomb.origin.clone());
    let remote = ConflictSide::new(None, op.hlc.clone(), op.stamp());

    if saw_delete {
        entity.deleted = None;
        out.touched();
        // 恢复是明确的实体级操作：实体上的待裁决冲突一并了结
        let fields: Vec<String> = entity.conflicted.iter().cloned().collect();
        for field in fields {
            out.settle(&field);
        }
        return;
    }

    match ctx.schema.delete_policy {
        DeletePolicy::UpdateWins => {
            entity.deleted = None;
            out.touched();
            out.conflicts.push(ctx.conflict(
                entity,
                "",
                ConflictReason::DeleteVsUpdate,
                local,
                remote,
                ConflictStatus::Resolved,
                Some("恢复优先：并发的恢复操作生效".to_string()),
            ));
        }
        DeletePolicy::DeleteWins => {
            out.conflicts.push(ctx.conflict(
                entity,
                "",
                ConflictReason::DeleteVsUpdate,
                local,
                remote,
                ConflictStatus::Pending,
                Some("删除优先：并发的恢复未生效，等待确认".to_string()),
            ));
        }
        DeletePolicy::Manual => {
            out.conflicts.push(ctx.conflict(
                entity,
                "",
                ConflictReason::DeleteVsUpdate,
                local,
                remote,
                ConflictStatus::Pending,
                Some("删除与恢复并发，等待人工裁决".to_string()),
            ));
        }
    }
}

/// 字段级操作分发（按 schema 声明的字段策略）。
fn apply_field_op(entity: &mut Entity, op: &Operation, ctx: &MergeCtx, out: &mut MergeOutcome) {
    match ctx.schema.field_kind(&op.field) {
        MergeKind::Lww => apply_lww(entity, op, op_value(op), ctx, out, false),
        MergeKind::LwwSilent => apply_lww(entity, op, op_value(op), ctx, out, true),
        MergeKind::MultiValue => apply_multi(entity, op, op_value(op), ctx, out),
        MergeKind::Frozen => apply_frozen(entity, op, op_value(op), ctx, out),
        MergeKind::Counter => apply_counter_op(entity, op, ctx, out),
        MergeKind::Set { policy } => apply_set_op(entity, op, policy, ctx, out),
        MergeKind::List => apply_list_op(entity, op, ctx, out),
    }
}

/// 创建实体时的字段种子：按字段策略决定「一个 JSON 值」怎么变成字段状态。
fn seed_field(
    entity: &mut Entity,
    field: &str,
    value: Value,
    op: &Operation,
    ctx: &MergeCtx,
    out: &mut MergeOutcome,
) {
    // 唯一键约束：创建时同样要查（场景 8 双方新增同业务唯一键）
    if ctx.schema.unique_fields.iter().any(|f| f == field) {
        if let Some(owner) = unique_owner(ctx, field, &value, &entity.id) {
            out.conflicts.push(ctx.conflict(
                entity,
                field,
                ConflictReason::UniqueKey,
                ConflictSide::new(None, op.hlc.clone(), op.stamp()),
                ConflictSide::new(Some(value.clone()), op.hlc.clone(), op.stamp()),
                ConflictStatus::Pending,
                Some(format!("唯一键 {field} 已被实体 {owner} 占用，两边都保留")),
            ));
            out.reject = Some(Rejection::UniqueKey { field: field.to_string(), owner });
            return;
        }
    }

    match ctx.schema.field_kind(field) {
        MergeKind::Lww => write_lww(entity, field, value, op, ctx, out, false),
        MergeKind::LwwSilent => write_lww(entity, field, value, op, ctx, out, true),
        MergeKind::Frozen => write_frozen(entity, field, value, op, ctx, out),
        MergeKind::MultiValue => push_multi(entity, field, value, op, ctx, out),
        MergeKind::Counter => {
            let FieldState::Counter { total, parts, hlc } = entity
                .fields
                .entry(field.to_string())
                .or_insert_with(|| FieldState::Counter {
                    total: 0,
                    parts: BTreeMap::new(),
                    hlc: Hlc::default(),
                })
            else {
                // 该字段历史上不是计数器（schema 改过）：按 LWW 覆盖
                write_lww(entity, field, value, op, ctx, out, false);
                return;
            };
            if op.hlc > *hlc {
                if let Some(n) = value.as_i64() {
                    *total = n;
                    parts.clear();
                    parts.insert(op.origin.clone(), n);
                    *hlc = op.hlc.clone();
                    out.touched();
                }
            }
        }
        MergeKind::Set { .. } => {
            // 数组 → 逐个加入；非数组按 LWW 单值处理（schema 不匹配时保守降级）
            if let Some(items) = value.as_array() {
                for item in items {
                    add_set_element(entity, field, element_key(item), op, out);
                }
            } else if !value.is_null() {
                write_lww(entity, field, value, op, ctx, out, false);
            }
        }
        MergeKind::List => {
            if let Some(items) = value.as_array() {
                let existing: Vec<String> = list_positions(entity, field);
                let mut last = existing.last().cloned();
                for item in items {
                    let key = element_key(item);
                    let position = match order::key_between(last.as_deref(), None) {
                        Some(position) => position,
                        None => continue,
                    };
                    last = Some(position.clone());
                    insert_list_item(entity, field, key, item.clone(), position, op, out);
                }
            } else if !value.is_null() {
                write_lww(entity, field, value, op, ctx, out, false);
            }
        }
    }
}

/// LWW 字段（含 MV / Counter 字段收到 `Set` 时的降级处理）。
///
/// `silent` 只影响**并发写入要不要记一条冲突**（见 [`MergeKind::LwwSilent`]）：
/// 值语义（HLC 较晚者胜出）与冲突关闭行为完全一致。
fn apply_lww(
    entity: &mut Entity,
    op: &Operation,
    value: Value,
    ctx: &MergeCtx,
    out: &mut MergeOutcome,
    silent: bool,
) {
    match &op.op {
        OpKind::Set { .. } | OpKind::Unset => {
            if let Some(owner) = unique_owner(ctx, &op.field, &value, &entity.id) {
                // 唯一键撞车是**真**冲突（两条记录抢同一个业务主键），静默策略也不例外
                out.conflicts.push(ctx.conflict(
                    entity,
                    &op.field,
                    ConflictReason::UniqueKey,
                    ConflictSide::new(
                        entity.fields.get(&op.field).map(|f| f.display_value(SetPolicy::AddWins)),
                        op.hlc.clone(),
                        op.stamp(),
                    ),
                    ConflictSide::new(Some(value.clone()), op.hlc.clone(), op.stamp()),
                    ConflictStatus::Pending,
                    Some(format!("唯一键 {} 已被实体 {owner} 占用，两边都保留", op.field)),
                ));
                out.reject = Some(Rejection::UniqueKey { field: op.field.clone(), owner });
                return;
            }
            write_lww(entity, &op.field, value, op, ctx, out, silent);
        }
        // 集合 / 计数器操作落在标量字段上：策略不匹配，拒绝并记一条（不静默）
        _ => {
            out.reject = Some(Rejection::FieldKind {
                field: op.field.clone(),
                expected: "lww",
            });
        }
    }
}

/// 写入 LWW 字段（唯一键检查已在外层完成）。
fn write_lww(
    entity: &mut Entity,
    field: &str,
    value: Value,
    op: &Operation,
    ctx: &MergeCtx,
    out: &mut MergeOutcome,
    silent: bool,
) {
    let incoming = FieldState::Value {
        value: value.clone(),
        hlc: op.hlc.clone(),
        origin: op.stamp(),
    };
    match entity.fields.get(field).cloned() {
        None => {
            entity.fields.insert(field.to_string(), incoming);
            out.touched();
        }
        Some(FieldState::Value { value: current, hlc: current_hlc, origin: current_origin }) => {
            let concurrent = is_concurrent_write(op, &current_origin);
            if concurrent && current != value && !silent {
                out.conflicts.push(ctx.conflict(
                    entity,
                    field,
                    ConflictReason::ConcurrentWrite,
                    ConflictSide::new(Some(current.clone()), current_hlc.clone(), current_origin.clone()),
                    ConflictSide::new(Some(value.clone()), op.hlc.clone(), op.stamp()),
                    ConflictStatus::Pending,
                    Some(
                        "同一字段并发写入：已按 HLC 保留较晚的一次，另一方留档待确认".to_string(),
                    ),
                ));
            }
            if op.hlc > current_hlc {
                entity.fields.insert(field.to_string(), incoming);
                // 明确看到两边状态后的新写入 = 争议已了结
                if !concurrent {
                    entity.conflicted.remove(field);
                    out.settle(field);
                }
                out.touched();
            }
        }
        Some(other) => {
            // 字段状态与当前 schema 不一致（schema 改过 / 旧数据）：换成本次的写法，
            // 旧值完整留在冲突记录里（场景 17）
            let previous = other.display_value(SetPolicy::AddWins);
            out.conflicts.push(ctx.conflict(
                entity,
                field,
                ConflictReason::ConcurrentWrite,
                ConflictSide::new(Some(previous), op.hlc.clone(), op.stamp()),
                ConflictSide::new(Some(value.clone()), op.hlc.clone(), op.stamp()),
                ConflictStatus::Resolved,
                Some("字段类型已变更，旧值留档".to_string()),
            ));
            entity.fields.insert(field.to_string(), incoming);
            out.touched();
        }
    }
}

/// MV-Register：保留并发多值。
fn apply_multi(
    entity: &mut Entity,
    op: &Operation,
    value: Value,
    ctx: &MergeCtx,
    out: &mut MergeOutcome,
) {
    match &op.op {
        OpKind::Set { .. } | OpKind::Unset => {
            if let Some(owner) = unique_owner(ctx, &op.field, &value, &entity.id) {
                out.conflicts.push(ctx.conflict(
                    entity,
                    &op.field,
                    ConflictReason::UniqueKey,
                    ConflictSide::new(None, op.hlc.clone(), op.stamp()),
                    ConflictSide::new(Some(value.clone()), op.hlc.clone(), op.stamp()),
                    ConflictStatus::Pending,
                    Some(format!("唯一键 {} 已被实体 {owner} 占用", op.field)),
                ));
                out.reject = Some(Rejection::UniqueKey { field: op.field.clone(), owner });
                return;
            }
            push_multi(entity, &op.field, value, op, ctx, out);
        }
        _ => {
            out.reject =
                Some(Rejection::FieldKind { field: op.field.clone(), expected: "multi_value" });
        }
    }
}

fn push_multi(
    entity: &mut Entity,
    field: &str,
    value: Value,
    op: &Operation,
    ctx: &MergeCtx,
    out: &mut MergeOutcome,
) {
    let stamp = op.stamp();
    let FieldState::Multi { values } = entity
        .fields
        .entry(field.to_string())
        .or_insert_with(|| FieldState::Multi { values: Vec::new() })
    else {
        write_lww(entity, field, value, op, ctx, out, false);
        return;
    };

    // 写入者见过的旧值被这次写入取代（同一分支而已，不算并发）
    values.retain(|v| !op.base.contains(&v.origin.device, v.origin.seq));
    if !values.iter().any(|v| v.origin == stamp) {
        values.push(StampedValue {
            value: value.clone(),
            hlc: op.hlc.clone(),
            origin: stamp.clone(),
            base: op.base.clone(),
        });
    }
    values.sort_by(|a, b| a.hlc.cmp(&b.hlc).then(a.origin.cmp(&b.origin)));
    out.touched();

    if values.len() > 1 {
        // 并发多值：全部保留，等人裁决
        let local = values
            .iter()
            .rev()
            .find(|v| v.origin != stamp)
            .map(|v| ConflictSide::new(Some(v.value.clone()), v.hlc.clone(), v.origin.clone()))
            .unwrap_or_else(|| ConflictSide::new(None, op.hlc.clone(), stamp.clone()));
        out.conflicts.push(ctx.conflict(
            entity,
            field,
            ConflictReason::MultiValue,
            local,
            ConflictSide::new(Some(value), op.hlc.clone(), stamp),
            ConflictStatus::Pending,
            Some("并发写入了不同的值，全部保留等待裁决".to_string()),
        ));
    } else {
        entity.conflicted.remove(field);
        out.settle(field);
    }
}

/// 不可变字段：首次写入生效。
fn apply_frozen(
    entity: &mut Entity,
    op: &Operation,
    value: Value,
    ctx: &MergeCtx,
    out: &mut MergeOutcome,
) {
    write_frozen(entity, &op.field, value, op, ctx, out);
}

/// 不可变字段的实际写入（创建时的种子与后续 `Set` 共用）。
fn write_frozen(
    entity: &mut Entity,
    field: &str,
    value: Value,
    op: &Operation,
    ctx: &MergeCtx,
    out: &mut MergeOutcome,
) {
    match entity.fields.get(field).cloned() {
        None => {
            entity.fields.insert(
                field.to_string(),
                FieldState::Frozen { value, hlc: op.hlc.clone(), origin: op.stamp() },
            );
            out.touched();
        }
        Some(FieldState::Frozen { value: current, hlc: current_hlc, origin: current_origin }) => {
            if current == value {
                return; // 幂等：写的是同一个值
            }
            out.conflicts.push(ctx.conflict(
                entity,
                field,
                ConflictReason::FrozenWrite,
                ConflictSide::new(Some(current), current_hlc, current_origin),
                ConflictSide::new(Some(value), op.hlc.clone(), op.stamp()),
                ConflictStatus::Pending,
                Some("不可变字段被改写，保留首次写入的值".to_string()),
            ));
            out.reject = Some(Rejection::Immutable { field: field.to_string() });
        }
        // 该字段历史上不是不可变字段（schema 改过）：按 LWW 覆盖并留档
        Some(_) => write_lww(entity, field, value, op, ctx, out, false),
    }
}

/// 计数器：增量相加、整体赋值按 HLC 裁决。
fn apply_counter_op(entity: &mut Entity, op: &Operation, ctx: &MergeCtx, out: &mut MergeOutcome) {
    match &op.op {
        OpKind::Increment { delta } => {
            let FieldState::Counter { total, parts, .. } = entity
                .fields
                .entry(op.field.clone())
                .or_insert_with(|| FieldState::Counter {
                    total: 0,
                    parts: BTreeMap::new(),
                    hlc: Hlc::default(),
                })
            else {
                out.reject =
                    Some(Rejection::FieldKind { field: op.field.clone(), expected: "counter" });
                return;
            };
            // 幂等由引擎的操作去重保证（同一条 op 不会应用两次）
            *total += delta;
            *parts.entry(op.origin.clone()).or_insert(0) += delta;
            out.touched();
        }
        OpKind::Set { .. } | OpKind::Unset => {
            let Some(n) = (match &op.op {
                OpKind::Set { value } => value.as_i64(),
                _ => Some(0),
            }) else {
                out.reject =
                    Some(Rejection::FieldKind { field: op.field.clone(), expected: "counter" });
                return;
            };
            let FieldState::Counter { total, parts, hlc } = entity
                .fields
                .entry(op.field.clone())
                .or_insert_with(|| FieldState::Counter {
                    total: 0,
                    parts: BTreeMap::new(),
                    hlc: Hlc::default(),
                })
            else {
                write_lww(entity, &op.field, op_value(op), op, ctx, out, false);
                return;
            };
            if op.hlc > *hlc {
                *total = n;
                parts.clear();
                parts.insert(op.origin.clone(), n);
                *hlc = op.hlc.clone();
                out.touched();
            }
        }
        _ => {
            out.reject = Some(Rejection::FieldKind { field: op.field.clone(), expected: "counter" });
        }
    }
}

/// 集合（OR-Set）：加入 / 移除。
fn apply_set_op(
    entity: &mut Entity,
    op: &Operation,
    _policy: SetPolicy,
    _ctx: &MergeCtx,
    out: &mut MergeOutcome,
) {
    match &op.op {
        OpKind::Add { element, .. } => add_set_element(entity, &op.field, element.clone(), op, out),
        OpKind::Remove { element } => {
            let entry = entity
                .fields
                .entry(op.field.clone())
                .or_insert_with(|| FieldState::Set { elements: BTreeMap::new() });
            let FieldState::Set { elements } = entry else {
                out.reject =
                    Some(Rejection::FieldKind { field: op.field.clone(), expected: "set" });
                return;
            };
            let element_state = elements.entry(element.clone()).or_default();
            // 删除水位 = 删除者见过的状态 ∪ 删除操作自身（与到达顺序无关）
            let mut watermark = op.base.clone();
            watermark.observe(&op.origin, op.seq);
            let before = element_state.removals.clone();
            element_state.removals.merge(&watermark);
            if element_state.removals != before {
                out.touched();
            }
            element_state.last_hlc = element_state.last_hlc.clone().max(op.hlc.clone());
        }
        OpKind::Set { value } => {
            if let Some(items) = value.as_array() {
                for item in items.clone() {
                    add_set_element(entity, &op.field, element_key(&item), op, out);
                }
            } else {
                out.reject =
                    Some(Rejection::FieldKind { field: op.field.clone(), expected: "set" });
            }
        }
        _ => {
            out.reject = Some(Rejection::FieldKind { field: op.field.clone(), expected: "set" });
        }
    }
}

fn add_set_element(
    entity: &mut Entity,
    field: &str,
    element: String,
    op: &Operation,
    out: &mut MergeOutcome,
) {
    let entry = entity
        .fields
        .entry(field.to_string())
        .or_insert_with(|| FieldState::Set { elements: BTreeMap::new() });
    let FieldState::Set { elements } = entry else {
        out.reject = Some(Rejection::FieldKind { field: field.to_string(), expected: "set" });
        return;
    };
    let element_state = elements.entry(element).or_default();
    element_state
        .adds
        .insert(op.stamp().tag(), AddTag { hlc: op.hlc.clone(), base: op.base.clone() });
    element_state.last_hlc = element_state.last_hlc.clone().max(op.hlc.clone());
    out.touched();
}

/// 有序列表：加入 / 移除 / 移动。
fn apply_list_op(entity: &mut Entity, op: &Operation, ctx: &MergeCtx, out: &mut MergeOutcome) {
    match &op.op {
        OpKind::Add { element, position } => {
            let position = position
                .clone()
                .filter(|p| order::is_valid_key(p))
                .unwrap_or_else(|| order::key_after_all(list_positions(entity, &op.field).iter().map(|s| s.as_str())));
            insert_list_item(entity, &op.field, element.clone(), Value::String(element.clone()), position, op, out);
        }
        OpKind::Remove { element } => {
            let entry = entity
                .fields
                .entry(op.field.clone())
                .or_insert_with(|| FieldState::List { items: BTreeMap::new() });
            let FieldState::List { items } = entry else {
                out.reject =
                    Some(Rejection::FieldKind { field: op.field.clone(), expected: "list" });
                return;
            };
            let default_position =
                order::key_after_all(items.values().map(|i| i.position.as_str()));
            let item = items.entry(element.clone()).or_insert_with(|| ListItem {
                position: default_position,
                value: Value::String(element.clone()),
                hlc: op.hlc.clone(),
                origin: op.stamp(),
                removed: None,
            });
            if item.removed.is_none() {
                item.removed = Some(op.stamp());
                item.hlc = item.hlc.clone().max(op.hlc.clone());
                out.touched();
            }
        }
        OpKind::Move { element, position } => {
            let FieldState::List { items } =
                entity.fields.entry(op.field.clone()).or_insert_with(|| FieldState::List {
                    items: BTreeMap::new(),
                })
            else {
                out.reject =
                    Some(Rejection::FieldKind { field: op.field.clone(), expected: "list" });
                return;
            };
            let Some(item) = items.get_mut(element) else {
                return; // 移动一个本地没有的元素：等它的加入操作到达（因果缓冲会兜住）
            };
            if item.removed.is_some() {
                return;
            }
            let concurrent = is_concurrent_write(op, &item.origin);
            let changed_position = item.position != *position;
            if op.hlc > item.hlc {
                item.position = position.clone();
                item.hlc = op.hlc.clone();
                item.origin = op.stamp();
                out.touched();
            }
            if concurrent && changed_position {
                out.conflicts.push(ctx.conflict(
                    entity,
                    &op.field,
                    ConflictReason::ListMove,
                    ConflictSide::new(
                        Some(Value::String(element.clone())),
                        op.hlc.clone(),
                        op.stamp(),
                    ),
                    ConflictSide::new(
                        Some(Value::String(position.clone())),
                        op.hlc.clone(),
                        op.stamp(),
                    ),
                    ConflictStatus::Resolved,
                    Some("同一元素被并发移动到不同位置，按 HLC 保留一次，两个位置键都留档".to_string()),
                ));
            }
        }
        _ => {
            out.reject = Some(Rejection::FieldKind { field: op.field.clone(), expected: "list" });
        }
    }
}

fn insert_list_item(
    entity: &mut Entity,
    field: &str,
    element: String,
    value: Value,
    position: String,
    op: &Operation,
    out: &mut MergeOutcome,
) {
    let entry = entity
        .fields
        .entry(field.to_string())
        .or_insert_with(|| FieldState::List { items: BTreeMap::new() });
    let FieldState::List { items } = entry else {
        out.reject = Some(Rejection::FieldKind { field: field.to_string(), expected: "list" });
        return;
    };
    match items.get_mut(&element) {
        None => {
            items.insert(
                element,
                ListItem { position, value, hlc: op.hlc.clone(), origin: op.stamp(), removed: None },
            );
            out.touched();
        }
        Some(item) => {
            // 已有墓碑：只有「见过这次删除」的加入才算明确重新添加（否则删除优先）
            if let Some(removal) = item.removed.clone() {
                if op.base.contains(&removal.device, removal.seq) {
                    item.removed = None;
                    item.position = position;
                    item.value = value;
                    item.hlc = op.hlc.clone();
                    item.origin = op.stamp();
                    out.touched();
                }
                return;
            }
            if op.hlc > item.hlc {
                item.position = position;
                item.value = value;
                item.hlc = op.hlc.clone();
                item.origin = op.stamp();
                out.touched();
            }
        }
    }
}

/// 集合 / 列表元素的键：字符串直接用，其它类型用其 JSON 文本。
pub fn element_key(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// 某列表字段里所有元素的位置键（含已删除的元素：位置占用也要算进去）。
fn list_positions(entity: &Entity, field: &str) -> Vec<String> {
    match entity.fields.get(field) {
        Some(FieldState::List { items }) => {
            let mut positions: Vec<String> =
                items.values().map(|i| i.position.clone()).collect();
            positions.sort();
            positions
        }
        _ => Vec::new(),
    }
}

/// 这条写入是否与字段上已有的一次写入并发。
///
/// 因果就绪的前提（见模块注释）保证了：对方没见过我这次写入 ⟺ 两次写入并发。
fn is_concurrent_write(op: &Operation, current: &Stamp) -> bool {
    current != &op.stamp() && !op.base.contains(&current.device, current.seq)
}

/// 唯一键查询（未接入时返回 `None`）。
fn unique_owner(ctx: &MergeCtx, field: &str, value: &Value, self_id: &str) -> Option<EntityId> {
    if !ctx.schema.unique_fields.iter().any(|f| f == field) {
        return None;
    }
    if value.is_null() {
        return None;
    }
    ctx.unique_lookup.and_then(|lookup| lookup(field, value, self_id))
}

/// op 携带的值（实体级操作为 `Null`）。
fn op_value(op: &Operation) -> Value {
    match &op.op {
        OpKind::Set { value } => value.clone(),
        OpKind::Increment { delta } => Value::from(*delta),
        OpKind::Add { element, position } => serde_json::json!({
            "element": element,
            "position": position,
        }),
        OpKind::Remove { element } => Value::String(element.clone()),
        OpKind::Move { element, position } => {
            serde_json::json!({ "element": element, "position": position })
        }
        OpKind::Create { fields } => Value::Object(fields.clone().into_iter().collect()),
        OpKind::Unset | OpKind::DeleteEntity { .. } | OpKind::RestoreEntity => Value::Null,
    }
}

/// 墓碑的 JSON 快照（冲突记录里的「本地一方」）。
fn field_snapshot(tomb: &Tombstone) -> Value {
    serde_json::json!({
        "deleted_at": tomb.hlc.to_string(),
        "reason": tomb.reason,
        "cascade_from": tomb.cascade_from,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{CascadeRule, DeletePolicy, Schema};
    use crate::version::VersionVector;

    /// 造一条操作（测试助手）。
    struct OpBuilder {
        device: String,
        seq: u64,
        wall: u64,
        /// `None` = 用实体当前版本（顺序写入）；`Some` = 指定基线（模拟离线 / 并发）
        base: Option<VersionVector>,
    }

    impl OpBuilder {
        fn device(device: &str) -> OpBuilder {
            OpBuilder { device: device.to_string(), seq: 0, wall: 1_000, base: None }
        }

        fn wall(mut self, wall: u64) -> OpBuilder {
            self.wall = wall;
            self
        }

        /// 模拟「这台设备没看到本地最新状态」（离线并发）。
        fn offline(mut self) -> OpBuilder {
            self.base = Some(VersionVector::new());
            self
        }

        /// 指定写入时看到的版本。
        fn base(mut self, base: VersionVector) -> OpBuilder {
            self.base = Some(base);
            self
        }

        /// 指定该设备此前已产生的操作数（同一台设备的后续操作要接着编号）。
        fn seq(mut self, seq: u64) -> OpBuilder {
            self.seq = seq;
            self
        }

        fn op(
            &mut self,
            entity: &Entity,
            kind_field: (&str, &str),
            op: OpKind,
        ) -> Operation {
            self.seq += 1;
            Operation {
                op_id: new_id(),
                origin: self.device.clone(),
                seq: self.seq,
                hlc: Hlc::new(self.wall, self.seq as u32, self.device.clone()),
                entity_id: entity.id.clone(),
                kind: entity.kind.clone(),
                field: kind_field.1.to_string(),
                op,
                base: self.base.clone().unwrap_or_else(|| entity.version.clone()),
                schema_ver: 1,
                at_ms: self.wall,
            }
        }
    }

    /// 「本地应用一条操作」：合并 + 记录版本（与引擎行为一致）。
    fn apply_op(entity: &mut Entity, op: &Operation, schema: &Schema) -> MergeOutcome {
        let ctx = MergeCtx::new(schema, "local", 1_700_000_000_000);
        let out = apply(entity, op, &ctx);
        entity.version.observe(&op.origin, op.seq);
        entity.updated = entity.updated.clone().max(op.hlc.clone());
        out
    }

    fn book_entity() -> Entity {
        Entity::new("book-1", "book", Hlc::new(1, 0, "A"), 1)
    }

    fn set(value: &str) -> OpKind {
        OpKind::Set { value: Value::String(value.to_string()) }
    }

    fn set_num(value: i64) -> OpKind {
        OpKind::Set { value: Value::from(value) }
    }

    fn schema_book() -> Schema {
        Schema::new("book")
            .field("title", MergeKind::Lww)
            .field("tags", MergeKind::set())
            .field("order", MergeKind::List)
            .field("pages", MergeKind::Counter)
            .field("isbn", MergeKind::Frozen)
            .unique("isbn")
    }

    #[test]
    fn different_fields_merge_without_conflict() {
        // 场景 2：甲改书名、乙改简介 → 字段级合并
        let schema = schema_book();
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A");
        let mut b = OpBuilder::device("B");

        let op1 = a.op(&entity, ("book", "title"), set("三体"));
        apply_op(&mut entity, &op1, &schema);
        let op2 = b.op(&entity, ("book", "intro"), set("科幻"));
        let out = apply_op(&mut entity, &op2, &schema);

        assert_eq!(entity.field("title"), Some(Value::String("三体".into())));
        assert_eq!(entity.field("intro"), Some(Value::String("科幻".into())));
        assert!(out.conflicts.is_empty(), "不同字段不应产生冲突");
    }

    #[test]
    fn same_value_concurrent_write_is_idempotent() {
        // 场景 3：两边改成同一个值 → 不冲突
        let schema = schema_book();
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A");
        let mut b = OpBuilder::device("B");
        let op_a = a.op(&entity, ("book", "title"), set("三体"));
        apply_op(&mut entity, &op_a, &schema);
        // B 没看到 A 的写入（并发），但值一样
        let op_b = b.op(&entity, ("book", "title"), set("三体"));
        let out = apply_op(&mut entity, &op_b, &schema);
        assert!(out.conflicts.is_empty());
        assert_eq!(entity.field("title"), Some(Value::String("三体".into())));
    }

    #[test]
    fn same_field_concurrent_write_records_conflict_and_lww_winner() {
        // 场景 4：同一字段并发改成不同值 → LWW 选边 + 冲突留档
        let schema = schema_book();
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A").wall(1_000);
        let mut b = OpBuilder::device("B").wall(2_000).offline();

        let op_a = a.op(&entity, ("book", "title"), set("张三"));
        apply_op(&mut entity, &op_a, &schema);
        let op_b = b.op(&entity, ("book", "title"), set("李四"));
        let out = apply_op(&mut entity, &op_b, &schema);

        assert_eq!(out.conflicts.len(), 1);
        assert_eq!(out.conflicts[0].reason, ConflictReason::ConcurrentWrite);
        assert_eq!(out.conflicts[0].local.value, Some(Value::String("张三".into())));
        assert_eq!(out.conflicts[0].remote.value, Some(Value::String("李四".into())));
        // HLC 更晚的 B 胜出（时钟快也一样：HLC 全序）
        assert_eq!(entity.field("title"), Some(Value::String("李四".into())));
        // 败方数据没丢
        assert_eq!(out.conflicts[0].local.value, Some(Value::String("张三".into())));
    }

    #[test]
    fn silent_lww_picks_winner_without_recording_a_conflict() {
        // 场景 4 的静默变体：值语义一样（HLC 较晚者胜），但不进冲突队列。
        // 用在阅读进度这类「位置」字段上：败方只是过时的位置，不值得人裁决。
        let schema = Schema::new("reading_location")
            .field("char_offset", MergeKind::LwwSilent)
            .field("chapter_cid", MergeKind::LwwSilent);
        let mut entity = Entity::new("book-1", "reading_location", Hlc::default(), 1);
        let mut a = OpBuilder::device("A").wall(1_000);
        let mut b = OpBuilder::device("B").wall(2_000).offline();

        let op_a = a.op(&entity, ("reading_location", "char_offset"), set_num(120));
        apply_op(&mut entity, &op_a, &schema);
        let op_b = b.op(&entity, ("reading_location", "char_offset"), set_num(900));
        let out = apply_op(&mut entity, &op_b, &schema);

        assert!(out.conflicts.is_empty(), "静默 LWW 不应产生冲突：{:?}", out.conflicts);
        assert_eq!(entity.field("char_offset"), Some(Value::from(900)), "仍按 HLC 选较晚的一次");
        assert!(entity.conflicted.is_empty(), "静默字段不该被标记为待裁决");
    }

    #[test]
    fn silent_lww_still_reports_unique_key_conflicts() {
        // 静默只针对「同一字段并发写成不同值」；两条记录抢同一个唯一键是真冲突，
        // 必须留档并拒绝写入（否则书架里会出现两条同键记录，谁也发现不了）
        let schema = Schema::new("book").unique("isbn").field("isbn", MergeKind::LwwSilent);
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A");
        let op = a.op(&entity, ("book", "isbn"), set("978-7"));
        let lookup = |_field: &str, _value: &Value, _self_id: &str| Some("book-2".to_string());
        let ctx = MergeCtx::new(&schema, "local", 0).with_unique_lookup(&lookup);

        let out = apply(&mut entity, &op, &ctx);
        assert!(matches!(out.reject, Some(Rejection::UniqueKey { .. })));
        assert!(entity.field("isbn").is_none(), "唯一键冲突时两边都不写");
        assert!(out.has_pending(), "唯一键冲突必须进冲突队列");
    }

    #[test]
    fn later_write_after_seeing_both_values_has_no_conflict() {
        // 因果顺序：B 看到 A 的写入后再改 → 不是冲突
        let schema = schema_book();
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A").wall(1_000);
        let mut b = OpBuilder::device("B").wall(1_000);

        let op_a = a.op(&entity, ("book", "title"), set("张三"));
        apply_op(&mut entity, &op_a, &schema);
        let op_b = b.op(&entity, ("book", "title"), set("李四")); // base 含 A:1
        let out = apply_op(&mut entity, &op_b, &schema);

        assert!(out.conflicts.is_empty(), "顺序写入不是冲突");
        assert_eq!(entity.field("title"), Some(Value::String("李四".into())));
    }

    #[test]
    fn immutable_field_keeps_first_write() {
        let schema = schema_book();
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A");
        let mut b = OpBuilder::device("B");
        let op_a = a.op(&entity, ("book", "isbn"), set("978-7-5366-9293-0"));
        apply_op(&mut entity, &op_a, &schema);
        let op_b = b.op(&entity, ("book", "isbn"), set("另一个 ISBN"));
        let out = apply_op(&mut entity, &op_b, &schema);

        assert_eq!(entity.field("isbn"), Some(Value::String("978-7-5366-9293-0".into())));
        assert!(out.conflicts.iter().any(|c| c.reason == ConflictReason::FrozenWrite));
        assert!(matches!(out.reject, Some(Rejection::Immutable { .. })));
    }

    #[test]
    fn counter_increments_add_up() {
        // 场景 13：甲 +1、乙 +2 → +3
        let schema = schema_book();
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A");
        let mut b = OpBuilder::device("B");
        let op_a = a.op(&entity, ("book", "pages"), OpKind::Increment { delta: 1 });
        apply_op(&mut entity, &op_a, &schema);
        let op_b = b.op(&entity, ("book", "pages"), OpKind::Increment { delta: 2 });
        let out = apply_op(&mut entity, &op_b, &schema);
        assert_eq!(entity.field("pages"), Some(Value::from(3)));
        assert!(out.conflicts.is_empty());
    }

    #[test]
    fn set_add_wins_and_remove_wins() {
        // 场景 11：甲加标签 X、乙删标签 X（并发）
        let add_wins = Schema::new("book").field("tags", MergeKind::set());
        let remove_wins =
            Schema::new("book").field("tags", MergeKind::Set { policy: SetPolicy::RemoveWins });

        for (schema, expected_present) in [(&add_wins, true), (&remove_wins, false)] {
            let mut entity = book_entity();
            let mut a = OpBuilder::device("A").wall(1_000);

            // A 先加 X
            let op_a = a.op(&entity, ("book", "tags"), OpKind::Add {
                element: "科幻".into(),
                position: None,
            });
            apply_op(&mut entity, &op_a, schema);
            let seen_by_a = entity.version.clone();

            // B 看到 A 的加入后删掉 X
            let mut b = OpBuilder::device("B").wall(2_000).base(seen_by_a.clone());
            let op_b = b.op(&entity, ("book", "tags"), OpKind::Remove { element: "科幻".into() });
            apply_op(&mut entity, &op_b, schema);

            // A 没见过这次删除，又加了一次（并发加入 vs 删除）
            let mut a2 = OpBuilder::device("A").wall(3_000).seq(1).base(seen_by_a);
            let op_a2 = a2.op(&entity, ("book", "tags"), OpKind::Add {
                element: "科幻".into(),
                position: None,
            });
            apply_op(&mut entity, &op_a2, schema);

            let policy = schema.field_kind("tags").set_policy().unwrap();
            let present = matches!(
                entity.fields.get("tags"),
                Some(FieldState::Set { elements }) if elements.get("科幻")
                    .map(|e| e.is_present(policy))
                    .unwrap_or(false)
            );
            assert_eq!(present, expected_present, "策略 {policy:?} 下元素存在性不符");
        }
    }

    #[test]
    fn set_remove_then_readd_after_seeing_removal_works() {
        // remove-wins 下也必须能重新添加：B 删了 X，A 看到删除后再加 X
        let schema =
            Schema::new("book").field("tags", MergeKind::Set { policy: SetPolicy::RemoveWins });
        let mut entity = App::new_entity();
        let mut a = OpBuilder::device("A").wall(1_000);
        let mut b = OpBuilder::device("B").wall(2_000);

        let op_a = a.op(&entity, ("book", "tags"), OpKind::Add { element: "x".into(), position: None });
        apply_op(&mut entity, &op_a, &schema);
        let op_b = b.op(&entity, ("book", "tags"), OpKind::Remove { element: "x".into() });
        apply_op(&mut entity, &op_b, &schema);
        // A 的第二次加入：base 已包含 B 的删除（顺序）
        let op_a2 = a.op(&entity, ("book", "tags"), OpKind::Add { element: "x".into(), position: None });
        apply_op(&mut entity, &op_a2, &schema);

        let policy = SetPolicy::RemoveWins;
        let present = matches!(
            entity.fields.get("tags"),
            Some(FieldState::Set { elements }) if elements.get("x").map(|e| e.is_present(policy)).unwrap_or(false)
        );
        assert!(present, "见过删除后的重新添加必须生效");
    }

    #[test]
    fn list_concurrent_inserts_keep_both_and_stay_ordered() {
        // 场景 12：两边同时往同一处插入 → 两个元素都保留，顺序确定
        let schema = Schema::new("shelf").field("order", MergeKind::List);
        let mut entity = Entity::new("shelf-1", "shelf", Hlc::new(1, 0, "A"), 1);
        let mut a = OpBuilder::device("A");
        let mut b = OpBuilder::device("B");

        let seed = a.op(&entity, ("shelf", "order"), OpKind::Add {
            element: "book-1".into(),
            position: Some("V".into()),
        });
        apply_op(&mut entity, &seed, &schema);

        // 两边并发插入到 "V" 之前，各自算出同一个位置键
        let op_a = a.op(&entity, ("shelf", "order"), OpKind::Add {
            element: "book-A".into(),
            position: Some(order::key_between(None, Some("V")).unwrap()),
        });
        apply_op(&mut entity, &op_a, &schema);
        let op_b = b.op(&entity, ("shelf", "order"), OpKind::Add {
            element: "book-B".into(),
            position: Some(order::key_between(None, Some("V")).unwrap()),
        });
        apply_op(&mut entity, &op_b, &schema);

        let value = entity.field("order").unwrap();
        let items: Vec<String> = value
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(items.len(), 3, "并发插入的两个元素都应保留：{items:?}");
        assert_eq!(items[2], "book-1");
        assert!(items.contains(&"book-A".to_string()) && items.contains(&"book-B".to_string()));
    }

    #[test]
    fn list_remove_wins_over_concurrent_add() {
        let schema = Schema::new("shelf").field("order", MergeKind::List);
        let mut entity = Entity::new("shelf-1", "shelf", Hlc::new(1, 0, "A"), 1);
        let mut a = OpBuilder::device("A");
        let mut b = OpBuilder::device("B").offline();
        let add = a.op(&entity, ("shelf", "order"), OpKind::Add {
            element: "book-1".into(),
            position: Some("V".into()),
        });
        apply_op(&mut entity, &add, &schema);
        // B 并发删除（base 里没有 A 的加入）
        let remove = b.op(&entity, ("shelf", "order"), OpKind::Remove { element: "book-1".into() });
        apply_op(&mut entity, &remove, &schema);
        assert_eq!(entity.field("order"), Some(Value::Array(vec![])));
    }

    #[test]
    fn delete_wins_over_concurrent_update() {
        // 场景 5：甲改用户、乙删用户 → 默认删除优先，更新进冲突队列
        let schema = Schema::new("book").field("title", MergeKind::Lww);
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A").wall(2_000);
        let mut b = OpBuilder::device("B").wall(1_000).offline();

        let op_a = a.op(&entity, ("book", "title"), set("新名字"));
        apply_op(&mut entity, &op_a, &schema);
        let op_b = b.op(&entity, ("book", ""), OpKind::DeleteEntity { reason: None });
        let out = apply_op(&mut entity, &op_b, &schema);

        assert!(entity.is_deleted(), "默认策略下删除优先");
        let conflict = out
            .conflicts
            .iter()
            .find(|c| c.reason == ConflictReason::DeleteVsUpdate)
            .expect("应记录删除 / 更新冲突");
        // 被覆盖掉的本地值必须留档（删除把本地更新「盖住」了，值放在冲突记录里）
        assert!(conflict.local.value.as_ref().unwrap()["title"] == Value::String("新名字".into()));
        assert!(out.changed, "墓碑本身要落下去（删除是显式操作）");
    }

    #[test]
    fn update_wins_policy_resurrects_on_concurrent_update() {
        let schema = Schema::new("book")
            .field("title", MergeKind::Lww)
            .delete_policy(DeletePolicy::UpdateWins);
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A").wall(2_000);
        let mut b = OpBuilder::device("B").wall(1_000).offline();

        let op_a = a.op(&entity, ("book", "title"), set("新名字"));
        apply_op(&mut entity, &op_a, &schema);
        let op_b = b.op(&entity, ("book", ""), OpKind::DeleteEntity { reason: None });
        apply_op(&mut entity, &op_b, &schema);

        assert!(!entity.is_deleted(), "更新优先策略下记录应活着");
        assert_eq!(entity.field("title"), Some(Value::String("新名字".into())));
    }

    #[test]
    fn delete_after_seeing_update_is_sequential() {
        // 顺序删除：B 见过 A 的更新再删 → 不产生冲突
        let schema = Schema::new("book").field("title", MergeKind::Lww);
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A");
        let mut b = OpBuilder::device("B");
        let op_a = a.op(&entity, ("book", "title"), set("新名字"));
        apply_op(&mut entity, &op_a, &schema);
        let op_b = b.op(&entity, ("book", ""), OpKind::DeleteEntity { reason: None });
        let out = apply_op(&mut entity, &op_b, &schema);
        assert!(entity.is_deleted());
        assert!(out.conflicts.is_empty(), "顺序删除不该报冲突");
    }

    #[test]
    fn restore_after_seeing_delete_revives() {
        // 场景 30：甲删、乙（看到删除后）恢复
        let schema = Schema::new("book").field("title", MergeKind::Lww);
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A");
        let mut b = OpBuilder::device("B");
        let del = a.op(&entity, ("book", ""), OpKind::DeleteEntity { reason: None });
        apply_op(&mut entity, &del, &schema);
        let restore = b.op(&entity, ("book", ""), OpKind::RestoreEntity);
        let out = apply_op(&mut entity, &restore, &schema);
        assert!(!entity.is_deleted());
        assert!(out.conflicts.is_empty());
    }

    #[test]
    fn concurrent_restore_loses_by_default() {
        let schema = Schema::new("book").field("title", MergeKind::Lww);
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A").wall(1_000);
        let mut b = OpBuilder::device("B").wall(2_000).offline();
        // A 删
        let del = a.op(&entity, ("book", ""), OpKind::DeleteEntity { reason: None });
        apply_op(&mut entity, &del, &schema);
        // B 没见过删除，但发起了恢复
        let restore = b.op(&entity, ("book", ""), OpKind::RestoreEntity);
        let out = apply_op(&mut entity, &restore, &schema);
        assert!(entity.is_deleted(), "默认删除优先");
        assert_eq!(out.conflicts.len(), 1);
        assert_eq!(
            out.conflicts[0].status,
            ConflictStatus::Pending,
            "并发的恢复被删除盖住，应进待裁决队列"
        );
    }

    #[test]
    fn both_sides_delete_is_idempotent() {
        // 场景 6：双方都删 → 合并为删除
        let schema = Schema::new("book").field("title", MergeKind::Lww);
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A").wall(1_000);
        let mut b = OpBuilder::device("B").wall(2_000);
        let del_a = a.op(&entity, ("book", ""), OpKind::DeleteEntity { reason: None });
        apply_op(&mut entity, &del_a, &schema);
        let before = entity.deleted.clone();
        let del_b = b.op(&entity, ("book", ""), OpKind::DeleteEntity { reason: None });
        let out = apply_op(&mut entity, &del_b, &schema);
        // 后到的删除时间更晚 → 采用它；若更早则保持原墓碑
        assert!(entity.is_deleted());
        if before.as_ref().unwrap().hlc >= del_b.hlc {
            assert!(!out.changed);
        }
    }

    #[test]
    fn multi_value_field_keeps_conflicting_values() {
        let schema = Schema::new("book_source").field("json", MergeKind::MultiValue);
        let mut entity = Entity::new("src-1", "book_source", Hlc::new(1, 0, "A"), 1);
        let mut a = OpBuilder::device("A").wall(1_000);
        let mut b = OpBuilder::device("B").wall(2_000).offline();
        let op_a = a.op(&entity, ("book_source", "json"), set("{\"a\":1}"));
        apply_op(&mut entity, &op_a, &schema);
        let op_b = b.op(&entity, ("book_source", "json"), set("{\"a\":2}"));
        let out = apply_op(&mut entity, &op_b, &schema);
        assert_eq!(entity.field("json").unwrap().as_array().unwrap().len(), 2);
        assert!(out.conflicts.iter().any(|c| c.reason == ConflictReason::MultiValue));
        assert!(entity.conflicted.contains("json"));
    }

    #[test]
    fn schema_change_records_old_value() {
        // 场景 17：字段策略从集合变成单值，旧值不丢
        let mut entity = book_entity();
        let set_schema = Schema::new("book").field("tags", MergeKind::set());
        let lww_schema = Schema::new("book").field("tags", MergeKind::Lww);
        let mut a = OpBuilder::device("A");
        let add = a.op(&entity, ("book", "tags"), OpKind::Add { element: "x".into(), position: None });
        apply_op(&mut entity, &add, &set_schema);
        let op = a.op(&entity, ("book", "tags"), set("新语义"));
        let out = apply_op(&mut entity, &op, &lww_schema);
        assert_eq!(entity.field("tags"), Some(Value::String("新语义".into())));
        assert_eq!(out.conflicts.len(), 1);
        assert_eq!(out.conflicts[0].local.value, Some(Value::Array(vec![Value::String("x".into())])));
    }

    #[test]
    fn unique_key_conflict_keeps_both_entities() {
        // 场景 8：双方新增同一唯一键
        let schema = Schema::new("book").field("isbn", MergeKind::Lww).unique("isbn");
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A");
        let op = a.op(&entity, ("book", "isbn"), set("978-7"));
        let lookup = |_field: &str, _value: &Value, _self_id: &str| Some("book-2".to_string());
        let ctx = MergeCtx::new(&schema, "local", 0).with_unique_lookup(&lookup);
        let out = apply(&mut entity, &op, &ctx);
        assert!(matches!(out.reject, Some(Rejection::UniqueKey { .. })));
        assert!(entity.field("isbn").is_none(), "唯一键冲突时两边都不写");
        assert!(out.has_pending());
    }

    #[test]
    fn kind_mismatch_is_rejected() {
        let schema = Schema::new("book");
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A");
        let mut op = a.op(&entity, ("book", "title"), set("x"));
        op.kind = "bookmark".into();
        let out = apply(&mut entity, &op, &MergeCtx::new(&schema, "local", 0));
        assert!(matches!(out.reject, Some(Rejection::KindMismatch { .. })));
        assert!(entity.fields.is_empty());
    }

    #[test]
    fn wrong_op_kind_for_field_is_rejected() {
        let schema = Schema::new("book").field("pages", MergeKind::Counter);
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A");
        let op = a.op(&entity, ("book", "pages"), OpKind::Add { element: "x".into(), position: None });
        let out = apply(&mut entity, &op, &MergeCtx::new(&schema, "local", 0));
        assert!(matches!(out.reject, Some(Rejection::FieldKind { .. })));
    }

    #[test]
    fn cascade_rules_exist_in_schema() {
        // 级联规则由引擎执行；这里只确认 schema 能带上它（行为测试在 engine）
        let schema = Schema::new("group").cascade(CascadeRule::orphan("book", "group_id"));
        assert_eq!(schema.cascade.len(), 1);
    }

    #[test]
    fn create_seeds_each_field_by_its_kind() {
        let schema = schema_book();
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A");
        let op = a.op(
            &entity,
            ("book", ""),
            OpKind::Create {
                fields: BTreeMap::from([
                    ("title".to_string(), Value::String("三体".into())),
                    ("tags".to_string(), serde_json::json!(["科幻", "中国"])),
                    ("pages".to_string(), Value::from(42)),
                    ("isbn".to_string(), Value::String("978-7".into())),
                ]),
            },
        );
        apply_op(&mut entity, &op, &schema);
        assert_eq!(entity.field("title"), Some(Value::String("三体".into())));
        assert_eq!(entity.field("pages"), Some(Value::from(42)));
        assert_eq!(entity.field("isbn"), Some(Value::String("978-7".into())));
        let tags = entity.field("tags").unwrap();
        assert_eq!(tags.as_array().unwrap().len(), 2);
    }

    /// 测试助手：统一造实体的入口（避免各用例重复写 id / kind）。
    struct App;

    impl App {
        fn new_entity() -> Entity {
            book_entity()
        }
    }

    #[test]
    fn version_observation_is_recorded_by_caller() {
        let schema = schema_book();
        let mut entity = book_entity();
        let mut a = OpBuilder::device("A");
        let op = a.op(&entity, ("book", "title"), set("x"));
        apply_op(&mut entity, &op, &schema);
        assert_eq!(entity.version.get("A"), 1);
        assert_eq!(entity.version, VersionVector::from_pairs([("A", 1)]));
    }
}

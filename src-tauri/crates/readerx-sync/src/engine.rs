//! 同步引擎门面：本地写入、应用远端操作、冲突队列、级联删除。
//!
//! 一次修改的完整路径（本地写入）：
//!
//! ```text
//! set_field()
//!   → 生成 Operation（op_id / hlc / seq / base = 实体当前版本）
//!   → 先写 oplog.jsonl（fsync，崩了也不丢）
//!   → 用同一套 merge 逻辑并进内存实体（本地写入天然不与自己冲突）
//! ```
//!
//! 收到远端操作的路径（[`SyncEngine::apply_remote`]）：
//!
//! ```text
//! 去重（op_id 见过就跳过）
//!   → schema 版本太新？缓冲（不合并）
//!   → 因果就绪？base 没被本地版本覆盖 → 缓冲（等前序操作）
//!   → merge（字段策略裁决 + 冲突留档）
//!   → 记进实体版本向量、推进本地 HLC、追加日志
//! ```
//!
//! **因果就绪**（`entity.version ⊇ op.base`）是 merge 的前提，也是「两次写入是否并发」
//! 能只看 `op.base` 的原因（见 [`crate::merge`] 的模块说明）。局域网同步里操作乱序
//! 到达很常见（场景 20），所以缓冲不是异常路径，而是常规路径。

use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

use crate::error::{Result, SyncError};
use crate::hlc::{HlcClock, HlcState};
use crate::id::{new_id, now_ms, DeviceId, EntityId, OpId};
use crate::merge::{self, MergeCtx, MergeOutcome, Rejection};
use crate::model::{
    Conflict, ConflictReason, ConflictStatus, Entity, FieldState, OpKind, Operation, Resolution,
    SetPolicy,
};
use crate::order;
use crate::schema::{CascadeAction, SchemaRegistry};
use crate::store::{LockGuard, PeerState, SyncStore};
use crate::version::VersionVector;
use crate::{SCHEMA_VERSION, PROTOCOL_VERSION};

/// 「记下来也连不上」的对端地址：**未指定地址**（`0.0.0.0` / `::`）。
///
/// 那是绑定用的通配地址，不是目的地；界面还会把它当「本机地址」展示，用户照着填必然
/// 失败（同步服务绑在 `0.0.0.0:47821`，见 `sync/lan.rs`）。历史版本会把这种「来源 IP
/// 是通配地址」的连接记成对端地址，启动时扫一遍清掉。
///
/// **回环地址算可用**：同一台机器上的两个实例（模拟器 / 本机自测）本来就要用回环连，
/// 把它当坏地址清掉会让这种场景再也连不上。
///
/// 解析不出来的字符串（旧格式 / 手改文件）不算在内：宁可留着让用户看见，
/// 也不要静默抹掉一条可能有用的记录。
pub(crate) fn unusable_peer_addr(addr: &str) -> bool {
    // `SocketAddr` 直接解析最稳（`ip:port` 是唯一写入格式）
    if let Ok(socket) = addr.parse::<std::net::SocketAddr>() {
        return socket.ip().is_unspecified();
    }
    // 旧数据可能是裸 `ip`（没有端口）：也认，解析不出就当它可用
    match addr.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_unspecified(),
        Err(_) => false,
    }
}

/// 打开引擎时的选项。
#[derive(Clone, Debug)]
pub struct EngineOptions {
    /// 设备展示名（「手机」「客厅台式机」）；空串表示沿用已保存的名字
    pub device_name: String,
    /// 各实体类型的字段合并策略
    pub schemas: SchemaRegistry,
    /// 本程序支持的 schema 版本（收到更高的操作会先缓冲）
    pub schema_version: u32,
    /// 只读打开：不加目录锁、不允许任何写入。
    ///
    /// 用于「同步服务正在跑，但我想看看现在有什么数据」这类场景：
    /// 读快照 + 重放日志尾部就能得到一致的最新视图，而不会被写者拒绝。
    pub read_only: bool,
    /// 强行接管残留的目录锁（确认没有别的实例在跑时用；见 [`crate::store::LockGuard`]）
    pub force_unlock: bool,
}

impl EngineOptions {
    /// 默认选项：设备名 + ReaderX 的默认 schema 表。
    pub fn new(device_name: impl Into<String>) -> EngineOptions {
        EngineOptions {
            device_name: device_name.into(),
            schemas: SchemaRegistry::readerx_defaults(),
            schema_version: SCHEMA_VERSION,
            read_only: false,
            force_unlock: false,
        }
    }

    /// 强行接管残留目录锁（进程被强杀后可能留下；确认没有别的实例在跑再用）。
    pub fn force_unlock(mut self) -> EngineOptions {
        self.force_unlock = true;
        self
    }

    /// 以只读方式打开（见 [`EngineOptions::read_only`]）。
    pub fn read_only(mut self) -> EngineOptions {
        self.read_only = true;
        self
    }

    pub fn with_schemas(mut self, schemas: SchemaRegistry) -> EngineOptions {
        self.schemas = schemas;
        self
    }

    pub fn with_schema_version(mut self, version: u32) -> EngineOptions {
        self.schema_version = version;
        self
    }
}

/// 引擎状态快照（状态页 / CLI `status`）。
#[derive(Clone, Debug)]
pub struct EngineStatus {
    pub device_id: String,
    pub device_name: String,
    pub group_id: String,
    pub data_dir: PathBuf,
    pub protocol: String,
    pub entities: usize,
    pub live_entities: usize,
    pub deleted_entities: usize,
    pub ops: usize,
    pub conflicts: usize,
    pub pending_conflicts: usize,
    pub deferred_ops: usize,
    pub peers: usize,
    pub knowledge: VersionVector,
}

/// 单条远端操作的处理结果。
#[derive(Clone, Debug, PartialEq)]
pub enum ApplyResult {
    /// 已合并（`changed` 表示实体真的变了）
    Applied { changed: bool, conflicts: usize },
    /// 之前就见过（幂等去重）
    Duplicate,
    /// 进了因果缓冲，等前序操作
    Deferred { reason: String },
    /// 被拒绝（数据未进实体），原因见 `code`（[`Rejection::code`]）
    Rejected { code: String },
}

/// 批量应用的结果统计。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BatchOutcome {
    pub applied: usize,
    pub changed: usize,
    pub duplicates: usize,
    pub deferred: usize,
    pub rejected: usize,
    pub conflicts: usize,
    /// 被拒操作的 `(op_id, 原因码, 说明)`（回给对端，便于它知道哪条没进去）
    pub rejects: Vec<(String, String, String)>,
}

/// 同步引擎：一个数据目录对应一台设备的一份数据。
pub struct SyncEngine {
    store: SyncStore,
    /// 数据目录独占锁（Drop 时释放）：防止两个进程同时写同一份数据
    _lock: Option<LockGuard>,
    /// 只读打开：写路径直接报错，避免读到一半的数据被改
    read_only: bool,
    clock: HlcClock,
    schemas: SchemaRegistry,
    schema_version: u32,
    entities: BTreeMap<EntityId, Entity>,
    ops: Vec<Operation>,
    /// op_id → 在 `ops` 里的下标（幂等去重）
    op_index: HashMap<OpId, usize>,
    /// `(来源设备, 序号)` → 在 `ops` 里的下标（增量同步求差用）
    origin_index: BTreeMap<(String, u64), usize>,
    conflicts: Vec<Conflict>,
    deferred: Vec<Operation>,
    peers: BTreeMap<String, PeerState>,
    /// 本机同步服务的监听端口（0 = 没在监听）。运行期状态，不落盘：
    /// 握手时告诉对端，对端据此记住「怎么主动连回来」。
    listen_port: u16,
    /// 本设备下一条操作的序号
    next_seq: u64,
    /// 内存状态是否有未落盘的改动（操作日志是即时落盘的）
    dirty: bool,
    knowledge_cache: Option<VersionVector>,
}

impl SyncEngine {
    /// 打开（必要时初始化）一个数据目录。
    pub fn open(root: impl Into<PathBuf>, options: EngineOptions) -> Result<SyncEngine> {
        let store = SyncStore::open(root, &options.device_name)?;
        let device_id = store.device_id().to_string();
        let device_name = store.device().device_name.clone();
        let clock = store.load_clock()?.restore(&device_id);

        let ops = store.read_oplog()?;
        let snapshot = store.load_entities()?;
        let mut entities: BTreeMap<EntityId, Entity> = BTreeMap::new();
        let mut op_index: HashMap<OpId, usize> = HashMap::new();
        let mut origin_index: BTreeMap<(String, u64), usize> = BTreeMap::new();
        for (index, op) in ops.iter().enumerate() {
            op_index.insert(op.op_id.clone(), index);
            origin_index.insert((op.origin.clone(), op.seq), index);
        }

        // 快照里的实体版本已经包含快照之前的操作；日志里超出的部分是「还没进快照」的尾部
        for entity in snapshot.entities {
            entities.insert(entity.id.clone(), entity);
        }
        let next_seq = ops
            .iter()
            .filter(|op| op.origin == device_id)
            .map(|op| op.seq)
            .max()
            .unwrap_or(0)
            + 1;

        let conflicts = store.load_conflicts()?;
        let deferred = store.load_deferred()?;
        let peers = store.load_peers()?;

        // 只读打开不抢锁：写者（同步服务）可以继续持有目录锁
        let lock = if options.read_only {
            None
        } else if options.force_unlock {
            log::warn!("按 --force-unlock 接管目录锁 dir={}", store.root().display());
            Some(LockGuard::steal(store.root(), store.device_id())?)
        } else {
            Some(LockGuard::acquire(store.root(), store.device_id())?)
        };
        let mut engine = SyncEngine {
            store,
            _lock: lock,
            read_only: options.read_only,
            clock,
            schemas: options.schemas,
            schema_version: options.schema_version,
            entities,
            ops,
            op_index,
            origin_index,
            conflicts,
            deferred,
            peers,
            listen_port: 0,
            next_seq,
            dirty: false,
            knowledge_cache: None,
        };

        // 所有操作的 HLC 都要「见过」：否则重启后本地时间可能落后于历史
        let ops_snapshot: Vec<Operation> = engine.ops.clone();
        for op in &ops_snapshot {
            engine.clock.advance_to(&op.hlc);
        }

        // 重放快照之后的尾部（快照没来得及写也不会丢修改）
        let applied = snapshot.applied_ops.min(engine.ops.len());
        for index in applied..engine.ops.len() {
            let op = engine.ops[index].clone();
            let outcome = engine.merge_into_model(&op, None);
            let settled = outcome.settled.clone();
            engine.absorb_conflicts(outcome);
            engine.settle_conflicts(&op.entity_id, &settled);
        }

        engine.retry_deferred();

        log::info!(
            "同步引擎已就绪 device={} name={} group={} 实体={} 操作={} 待处理冲突={}",
            crate::version::short_device(&device_id),
            device_name,
            crate::version::short_device(engine.store.group_id()),
            engine.entities.len(),
            engine.ops.len(),
            engine.pending_conflict_count()
        );
        Ok(engine)
    }

    /// 用配对码加入已有群组（保留本设备 id 与本地数据，换群组密钥）。
    ///
    /// 加入后本地已有数据在新群组里是「本设备新建的记录」，会在下一次同步时发出去。
    pub fn join_group(&mut self, code: &str) -> Result<()> {
        let store = SyncStore::join(self.store.root(), code, &self.store.device().device_name)?;
        self.store = store;
        self.dirty = true;
        self.flush()
    }

    /// 改设备展示名（对端在发现应答与握手里看到的名字）。
    ///
    /// 只改身份里的名字，设备 id、群组、密钥与全部数据都不动 —— 改名不能让这台设备
    /// 在群组里变成「另一台设备」。
    pub fn rename_device(&mut self, name: &str) -> Result<()> {
        if self.store.device().device_name == name {
            return Ok(());
        }
        self.store = SyncStore::open(self.store.root(), name)?;
        log::info!("同步设备名已更新: {name}");
        self.dirty = true;
        self.flush()
    }

    /// 配对码（把它给另一台设备即可加入同一同步群组）。
    pub fn pairing_code(&self) -> String {
        self.store.device().pairing_code()
    }

    pub fn device_id(&self) -> &str {
        self.store.device_id()
    }

    pub fn device_name(&self) -> &str {
        &self.store.device().device_name
    }

    pub fn group_id(&self) -> &str {
        self.store.group_id()
    }

    pub fn data_dir(&self) -> &std::path::Path {
        self.store.root()
    }

    pub fn schemas(&self) -> &SchemaRegistry {
        &self.schemas
    }

    /// 群组密钥字节（传输层握手用）。
    pub fn secret_bytes(&self) -> Result<Vec<u8>> {
        self.store.device().secret_bytes()
    }

    pub fn status(&self) -> EngineStatus {
        let live = self.entities.values().filter(|e| !e.is_deleted()).count();
        EngineStatus {
            device_id: self.store.device_id().to_string(),
            device_name: self.store.device().device_name.clone(),
            group_id: self.store.group_id().to_string(),
            data_dir: self.store.root().to_path_buf(),
            protocol: PROTOCOL_VERSION.to_string(),
            entities: self.entities.len(),
            live_entities: live,
            deleted_entities: self.entities.len() - live,
            ops: self.ops.len(),
            conflicts: self.conflicts.len(),
            pending_conflicts: self.pending_conflict_count(),
            deferred_ops: self.deferred.len(),
            peers: self.peers.len(),
            knowledge: self.knowledge(),
        }
    }

    /// 已并入的操作向量（增量同步的游标：告诉对端「我有哪些」）。
    pub fn knowledge(&self) -> VersionVector {
        match &self.knowledge_cache {
            Some(v) => v.clone(),
            None => {
                let mut vector = VersionVector::new();
                for op in &self.ops {
                    vector.observe(&op.origin, op.seq);
                }
                vector
            }
        }
    }

    // ---------------------------------------------------------------- 查询

    pub fn entity(&self, id: &str) -> Option<&Entity> {
        self.entities.get(id)
    }

    /// 某类型的实体（默认不含已删除）。
    pub fn entities_of_kind(&self, kind: &str, include_deleted: bool) -> Vec<&Entity> {
        self.entities
            .values()
            .filter(|e| e.kind == kind)
            .filter(|e| include_deleted || !self.is_effectively_deleted(e))
            .collect()
    }

    pub fn all_entities(&self, include_deleted: bool) -> Vec<&Entity> {
        self.entities
            .values()
            .filter(|e| include_deleted || !self.is_effectively_deleted(e))
            .collect()
    }

    /// 读取某字段的当前值（多值字段返回数组）。
    pub fn field(&self, id: &str, field: &str) -> Option<Value> {
        self.entities.get(id).and_then(|e| e.field(field))
    }

    /// 该实体是否**实际**处于删除态：自己没墓碑，但父实体已删且级联规则是 `Cascade`。
    ///
    /// 并发场景（甲删父、乙加子）无法靠某一次写入的级联覆盖：子记录的操作可能比
    /// 父删除更晚到达，谁都不知道该由谁来级联。所以级联在**读取时**再按规则派生一次，
    /// 保证各副本显示一致（写入端的级联见 [`SyncEngine::delete_entity`]）。
    pub fn is_effectively_deleted(&self, entity: &Entity) -> bool {
        if entity.is_deleted() {
            return true;
        }
        let schema = self.schemas.get(&entity.kind);
        for rule in &schema.cascade {
            if rule.on_delete != CascadeAction::Cascade {
                continue;
            }
            let Some(parent_id) = entity.field(&rule.parent_field).and_then(|v| v.as_str().map(str::to_string))
            else {
                continue;
            };
            if let Some(parent) = self.entities.get(&parent_id) {
                if parent.is_deleted() {
                    return true;
                }
            }
        }
        false
    }

    /// 子实体（按某字段引用本实体）。
    pub fn children_of(&self, parent_id: &str, child_kind: &str, parent_field: &str) -> Vec<&Entity> {
        self.entities
            .values()
            .filter(|e| e.kind == child_kind && !self.is_effectively_deleted(e))
            .filter(|e| e.field(parent_field).and_then(|v| v.as_str().map(str::to_string)).as_deref() == Some(parent_id))
            .collect()
    }

    pub fn conflicts(&self, status: Option<ConflictStatus>) -> Vec<&Conflict> {
        self.conflicts
            .iter()
            .filter(|c| status.map(|s| c.status == s).unwrap_or(true))
            .collect()
    }

    pub fn pending_conflict_count(&self) -> usize {
        self.conflicts.iter().filter(|c| c.status.is_pending()).count()
    }

    pub fn deferred_ops(&self) -> &[Operation] {
        &self.deferred
    }

    pub fn peers(&self) -> &BTreeMap<String, PeerState> {
        &self.peers
    }

    pub fn op_count(&self) -> usize {
        self.ops.len()
    }

    /// 全部操作（按写入顺序；CLI `ops` / 排错用）。
    pub fn ops(&self) -> &[Operation] {
        &self.ops
    }

    // ------------------------------------------------------------ 本地写入

    /// 新建实体；`id` 为空则新生成 ULID。返回实体 id。
    pub fn create_entity<I, K>(
        &mut self,
        kind: &str,
        id: Option<String>,
        fields: I,
    ) -> Result<EntityId>
    where
        I: IntoIterator<Item = (K, Value)>,
        K: Into<String>,
    {
        let id = id.unwrap_or_else(new_id);
        if self.entities.contains_key(&id) {
            return Err(SyncError::Invalid(format!("实体 {id} 已存在")));
        }
        let fields: BTreeMap<String, Value> =
            fields.into_iter().map(|(k, v)| (k.into(), v)).collect();
        self.record_entity_op(&id, kind, OpKind::Create { fields })?;
        Ok(id)
    }

    /// 写一个字段（策略由 schema 决定：LWW / MV / Frozen）。
    pub fn set_field(&mut self, id: &str, field: &str, value: Value) -> Result<()> {
        let kind = self.kind_of(id)?;
        self.record_field_op(id, &kind, field, OpKind::Set { value })
    }

    /// 清空字段。
    pub fn unset_field(&mut self, id: &str, field: &str) -> Result<()> {
        let kind = self.kind_of(id)?;
        self.record_field_op(id, &kind, field, OpKind::Unset)
    }

    /// 计数器增减。
    pub fn increment(&mut self, id: &str, field: &str, delta: i64) -> Result<()> {
        let kind = self.kind_of(id)?;
        self.record_field_op(id, &kind, field, OpKind::Increment { delta })
    }

    /// 集合 / 列表加入元素。列表未给位置时追加到末尾。
    pub fn add_element(
        &mut self,
        id: &str,
        field: &str,
        element: &str,
        position: Option<String>,
    ) -> Result<String> {
        let kind = self.kind_of(id)?;
        let schema = self.schemas.get(&kind);
        let is_list = matches!(schema.field_kind(field), crate::schema::MergeKind::List);
        let position = if is_list {
            Some(match position {
                Some(p) if order::is_valid_key(&p) => p,
                _ => {
                    let keys = self.list_positions(id, field);
                    order::key_after_all(keys.iter().map(|s| s.as_str()))
                }
            })
        } else {
            None
        };
        self.record_field_op(
            id,
            &kind,
            field,
            OpKind::Add { element: element.to_string(), position: position.clone() },
        )?;
        Ok(position.unwrap_or_default())
    }

    /// 集合 / 列表移除元素。
    pub fn remove_element(&mut self, id: &str, field: &str, element: &str) -> Result<()> {
        let kind = self.kind_of(id)?;
        self.record_field_op(id, &kind, field, OpKind::Remove { element: element.to_string() })
    }

    /// 列表元素移动到新位置键。`before` / `after` 给出相邻元素 id 时自动算位置键。
    pub fn move_element(&mut self, id: &str, field: &str, element: &str, position: &str) -> Result<()> {
        let kind = self.kind_of(id)?;
        if !order::is_valid_key(position) {
            return Err(SyncError::Invalid(format!("非法的位置键：{position}")));
        }
        self.record_field_op(
            id,
            &kind,
            field,
            OpKind::Move { element: element.to_string(), position: position.to_string() },
        )
    }

    /// 计算「插到 `prev` 与 `next` 之间」的位置键；相邻无法插入时退化为追加到末尾。
    ///
    /// 退化只会让顺序与期望略有出入（位置由写入方决定并随操作同步，各副本一致），
    /// 不会丢数据，因此这里记 debug 日志即可。
    pub fn position_between(
        &self,
        id: &str,
        field: &str,
        prev: Option<&str>,
        next: Option<&str>,
    ) -> String {
        match order::key_between(prev, next) {
            Some(key) => key,
            None => {
                log::debug!("位置键相邻无法插入，退化为追加到末尾 entity={id} field={field}");
                let keys = self.list_positions(id, field);
                order::key_after_all(keys.iter().map(|s| s.as_str()))
            }
        }
    }

    /// 删除实体（写墓碑）。级联规则按 schema 执行：级联 / 阻止 / 留下孤儿。
    pub fn delete_entity(&mut self, id: &str, reason: Option<String>) -> Result<usize> {
        let kind = self.kind_of(id)?;
        let schema = self.schemas.get(&kind);

        // 先检查「阻止删除」类规则：子记录还在就删不掉（场景 9）
        for rule in &schema.cascade {
            if rule.on_delete != CascadeAction::Block {
                continue;
            }
            let children = self.children_of(id, &rule.child_kind, &rule.parent_field);
            if !children.is_empty() {
                let ids: Vec<String> = children.iter().map(|c| c.id.clone()).collect();
                self.push_conflict(Conflict {
                    id: new_id(),
                    entity_id: id.to_string(),
                    kind: kind.clone(),
                    field: rule.parent_field.clone(),
                    reason: ConflictReason::CascadeBlocked,
                    local: crate::model::ConflictSide::new(
                        Some(serde_json::json!(ids)),
                        self.clock.last().clone(),
                        crate::model::Stamp::new(self.device_id(), 0),
                    ),
                    remote: crate::model::ConflictSide::new(
                        None,
                        self.clock.last().clone(),
                        crate::model::Stamp::new(self.device_id(), 0),
                    ),
                    status: ConflictStatus::Pending,
                    detected_at_ms: now_ms(),
                    peer_device: None,
                    note: Some(format!("还有 {} 条 {} 引用它，删除已阻止", ids.len(), rule.child_kind)),
                    resolved_by_op: None,
                });
                return Err(SyncError::Schema(format!(
                    "还有 {} 条 {} 引用该记录，删除被阻止",
                    ids.len(),
                    rule.child_kind
                )));
            }
        }

        // 级联 / 孤儿处理：先生成子记录的操作，再删自己
        let mut cascaded = 0usize;
        for rule in schema.cascade.clone() {
            let child_ids: Vec<String> = self
                .children_of(id, &rule.child_kind, &rule.parent_field)
                .into_iter()
                .map(|child| child.id.clone())
                .collect();
            for child_id in child_ids {
                match rule.on_delete {
                    CascadeAction::Cascade => {
                        self.delete_entity(&child_id, Some(format!("级联自 {id}")))?;
                        cascaded += 1;
                    }
                    CascadeAction::Orphan => {
                        self.record_field_op(
                            &child_id,
                            &rule.child_kind,
                            &rule.parent_field,
                            OpKind::Set { value: Value::Null },
                        )?;
                        cascaded += 1;
                    }
                    CascadeAction::Block => {}
                }
            }
        }

        self.record_entity_op(id, &kind, OpKind::DeleteEntity { reason })?;
        Ok(cascaded)
    }

    /// 取消墓碑（从回收站还原）。
    pub fn restore_entity(&mut self, id: &str) -> Result<()> {
        let kind = self.kind_of(id)?;
        self.record_entity_op(id, &kind, OpKind::RestoreEntity)
    }

    /// 解决一条冲突（裁决结果会作为**新的本地操作**写下去，因此也会同步给对端）。
    pub fn resolve_conflict(&mut self, conflict_id: &str, resolution: Resolution) -> Result<()> {
        let conflict = self
            .conflicts
            .iter()
            .find(|c| c.id == conflict_id)
            .cloned()
            .ok_or_else(|| SyncError::NotFound(format!("冲突 {conflict_id}")))?;

        let value = match &resolution {
            Resolution::KeepLocal => conflict.local.value.clone(),
            Resolution::KeepRemote => conflict.remote.value.clone(),
            Resolution::Value { value } => Some(value.clone()),
            Resolution::Dismiss => None,
        };
        let status = match &resolution {
            Resolution::KeepLocal => ConflictStatus::KeptLocal,
            Resolution::KeepRemote => ConflictStatus::KeptRemote,
            Resolution::Value { .. } => ConflictStatus::Resolved,
            Resolution::Dismiss => ConflictStatus::Dismissed,
        };

        let mut resolved_by_op = None;
        if let Some(value) = value {
            if conflict.field.is_empty() {
                // 实体级冲突（删除 vs 更新）：只改状态，数据改动走 delete / restore
                log::debug!("实体级冲突只能标记状态，数据改动请调用 delete_entity / restore_entity");
            } else {
                self.set_field(&conflict.entity_id, &conflict.field, value)?;
                resolved_by_op = self.ops.last().map(|op| op.op_id.clone());
                if let Some(entity) = self.entities.get_mut(&conflict.entity_id) {
                    entity.conflicted.remove(&conflict.field);
                }
            }
        }

        if let Some(target) = self.conflicts.iter_mut().find(|c| c.id == conflict_id) {
            target.status = status;
            target.resolved_by_op = resolved_by_op;
        }
        self.dirty = true;
        Ok(())
    }

    // ------------------------------------------------------------ 远端应用

    /// 应用一条远端操作（幂等、可乱序）。
    pub fn apply_remote(&mut self, op: &Operation, peer_device: Option<&str>) -> Result<ApplyResult> {
        if self.op_index.contains_key(&op.op_id) {
            return Ok(ApplyResult::Duplicate);
        }
        if op.schema_ver > self.schema_version {
            self.defer(op.clone());
            return Ok(ApplyResult::Deferred {
                reason: format!("对端 schema 版本 {} 高于本机 {}", op.schema_ver, self.schema_version),
            });
        }
        if !self.causally_ready(op) {
            self.defer(op.clone());
            return Ok(ApplyResult::Deferred { reason: "前序操作尚未到达".to_string() });
        }

        let outcome = self.apply_ready(op, peer_device)?;
        let conflicts = outcome.conflicts.len();
        let rejected = outcome.reject.as_ref().map(|r| r.code().to_string());
        let settled = outcome.settled.clone();
        self.absorb_conflicts(outcome);
        self.settle_conflicts(&op.entity_id, &settled);
        // 这条操作可能正好补上了别人缺的前序：顺手再试一次缓冲里的操作
        self.retry_deferred();
        match rejected {
            Some(code) => Ok(ApplyResult::Rejected { code }),
            None => Ok(ApplyResult::Applied { changed: true, conflicts }),
        }
    }

    /// 批量应用（自动按 HLC 排序，尽量满足因果顺序）。
    pub fn apply_many(&mut self, ops: &[Operation], peer_device: Option<&str>) -> Result<BatchOutcome> {
        let mut batch = BatchOutcome::default();
        let mut sorted: Vec<Operation> = ops.to_vec();
        sorted.sort_by(|a, b| a.hlc.cmp(&b.hlc).then(a.op_id.cmp(&b.op_id)));
        for op in &sorted {
            let before = self.ops.len();
            match self.apply_remote(op, peer_device)? {
                ApplyResult::Applied { conflicts, .. } => {
                    batch.applied += 1;
                    batch.changed += usize::from(self.ops.len() > before);
                    batch.conflicts += conflicts;
                }
                ApplyResult::Duplicate => batch.duplicates += 1,
                ApplyResult::Deferred { reason } => {
                    batch.deferred += 1;
                    batch.rejects.push((
                        op.op_id.clone(),
                        "deferred".to_string(),
                        reason,
                    ));
                }
                ApplyResult::Rejected { code } => {
                    batch.rejected += 1;
                    batch.rejects.push((op.op_id.clone(), code.clone(), "操作未通过合并".to_string()));
                }
            }
        }
        let _ = self.retry_deferred();
        Ok(batch)
    }

    /// 重试因果缓冲里的操作（新操作到达后可能有能应用的了）。
    pub fn retry_deferred(&mut self) -> usize {
        if self.deferred.is_empty() {
            return 0;
        }
        let mut applied_total = 0usize;
        for _round in 0..16 {
            let mut remaining: Vec<Operation> = Vec::new();
            let mut progressed = false;
            let pending = std::mem::take(&mut self.deferred);
            for op in pending {
                if self.op_index.contains_key(&op.op_id) {
                    progressed = true; // 已经被别的路径合并过
                    continue;
                }
                if op.schema_ver <= self.schema_version && self.causally_ready(&op) {
                    match self.apply_ready(&op, None) {
                        Ok(outcome) => {
                            let settled = outcome.settled.clone();
                            self.absorb_conflicts(outcome);
                            self.settle_conflicts(&op.entity_id, &settled);
                            applied_total += 1;
                            progressed = true;
                        }
                        Err(e) => {
                            log::warn!("缓冲操作合并失败，继续留档: {}", e);
                            remaining.push(op);
                        }
                    }
                } else {
                    remaining.push(op);
                }
            }
            self.deferred = remaining;
            if !progressed || self.deferred.is_empty() {
                break;
            }
        }
        if applied_total > 0 {
            log::debug!("因果缓冲重试成功 {applied_total} 条");
        }
        applied_total
    }

    /// 对端缺少的操作（增量同步：`peer_knowledge` 之外的部分）。
    ///
    /// 返回的批次按 HLC 排序，`has_more` 表示还有剩余，调用方继续拉。
    pub fn ops_for_peer(&self, peer_knowledge: &VersionVector, limit: usize) -> (Vec<Operation>, bool) {
        let limit = limit.max(1);
        let mut picked: Vec<Operation> = Vec::new();
        for (device, from_seq) in self.knowledge().ahead_of(peer_knowledge) {
            let start = (device.clone(), from_seq + 1);
            for ((origin, _seq), index) in self.origin_index.range(start..) {
                if origin != &device {
                    break;
                }
                picked.push(self.ops[*index].clone());
                if picked.len() > limit {
                    picked.sort_by(|a, b| a.hlc.cmp(&b.hlc).then(a.op_id.cmp(&b.op_id)));
                    picked.truncate(limit);
                    return (picked, true);
                }
            }
        }
        picked.sort_by(|a, b| a.hlc.cmp(&b.hlc).then(a.op_id.cmp(&b.op_id)));
        (picked, false)
    }

    // ------------------------------------------------------------ 持久化

    /// 把快照 / 冲突 / 缓冲 / 对端状态刷到磁盘。
    ///
    /// 操作日志是每次写入即时落盘的；这里刷的是可以由日志重建的派生数据，
    /// 所以调用频率不敏感（一次同步结束、一次批量写入结束调用即可）。
    pub fn flush(&mut self) -> Result<()> {
        if self.read_only {
            // 只读视图不能覆盖写者维护的快照
            return Ok(());
        }
        let entities: Vec<Entity> = self.entities.values().cloned().collect();
        self.store.save_entities(&entities, self.ops.len())?;
        self.store.save_conflicts(&self.conflicts)?;
        self.store.save_deferred(&self.deferred)?;
        self.store.save_peers(&self.peers)?;
        self.store.save_device()?;
        self.store.save_clock(&HlcState::from_clock(&self.clock))?;
        self.dirty = false;
        Ok(())
    }

    /// 记录一次与对端的同步（地址、对方已知版本、结果）。
    ///
    /// **被移除的设备在这里被忽略**：删除只有在用户显式「重新接受」时（[`SyncEngine::accept_peer`]，
    /// 界面上是在「查找局域网设备」里点「重新接受」）才撤销。否则「设备正在同步时点了删除」
    /// 这种时序会让会话结束时的记录把删除悄悄抹掉 —— 删除必须是稳定的。
    pub fn record_peer_sync(
        &mut self,
        peer_device: &str,
        peer_name: &str,
        addr: Option<String>,
        peer_knowledge: VersionVector,
        error: Option<String>,
    ) {
        if self.store.is_device_removed(peer_device) {
            log::debug!(
                "设备已被移除，忽略本次同步记录 peer={}",
                crate::version::short_device(peer_device)
            );
            return;
        }
        let entry = self.peers.entry(peer_device.to_string()).or_insert_with(|| PeerState {
            device_id: peer_device.to_string(),
            ..PeerState::default()
        });
        entry.name = peer_name.to_string();
        if let Some(addr) = addr {
            entry.addr = Some(addr);
        }
        entry.knowledge = peer_knowledge;
        entry.last_seen_ms = now_ms();
        entry.last_error = error.clone();
        if error.is_none() {
            entry.last_sync_ms = now_ms();
            entry.sync_count += 1;
        }
        self.dirty = true;
    }

    /// 本机是否拒绝该设备接入（同步界面「删除设备」的结果）。
    pub fn is_device_removed(&self, device: &str) -> bool {
        self.store.is_device_removed(device)
    }

    /// 本机拒绝接入的设备 id 名单。
    pub fn removed_devices(&self) -> &[DeviceId] {
        self.store.removed_devices()
    }

    /// 移除一台已配对设备：**本机不再与它同步，并拒绝它接进来**。
    ///
    /// 做三件事：
    /// 1. 从 `peers` 里删掉它（含地址与「对方已知版本」）—— 自动同步与「立即同步」
    ///    都不会再找它，界面上的设备列表也不再显示；
    /// 2. 记进拒绝名单（`device.json`），它的连接会在握手的群组校验之后被拒；
    /// 3. 丢掉它那批「基线还没齐」的缓冲操作 —— 它已被拒绝，那批操作永远等不到前序，
    ///    留着只会让缓冲一直不收敛。
    ///
    /// **不会**删掉已经合并进来的数据（那是两台设备共同的历史），也**不会**通知对端：
    /// 无中心的局域网里没有「踢人」这回事，对端仍然持有它那份数据和群组密钥。
    pub fn remove_peer(&mut self, peer_device: &str) -> Result<()> {
        self.ensure_writable()?;
        if peer_device.is_empty() || peer_device == self.device_id() {
            return Err(SyncError::Invalid("不能移除本机".to_string()));
        }
        let was_known = self.peers.remove(peer_device).is_some();
        let added = self.store.set_device_removed(peer_device, true);
        let deferred_before = self.deferred.len();
        self.deferred.retain(|op| op.origin != peer_device);
        let dropped = deferred_before - self.deferred.len();
        if !was_known && !added && dropped == 0 {
            // 既没同步过、也不在名单里：没有再可做的，但也不必报错（幂等）
            return Ok(());
        }
        self.dirty = true;
        log::info!(
            "已移除设备 peer={}（不再同步并拒绝其接入） 丢弃缓冲操作={dropped}",
            crate::version::short_device(peer_device)
        );
        self.flush()
    }

    /// 解除对某台设备的拒绝（**显式重新接受**）。返回它之前是否真的在拒绝名单里。
    ///
    /// 这是撤销「删除设备」的唯一途径：只解除拒绝，不建立对端记录 ——
    /// 之后与它同步一次（`session::sync_with_addr`）才会回到设备列表。
    /// 自动同步 / 手动同步都**不能**把删除撤销掉（见 [`SyncEngine::record_peer_sync`]）。
    pub fn accept_peer(&mut self, peer_device: &str) -> Result<bool> {
        self.ensure_writable()?;
        if !self.store.set_device_removed(peer_device, false) {
            return Ok(false);
        }
        self.dirty = true;
        log::info!("已重新接受设备 peer={}", crate::version::short_device(peer_device));
        self.flush()?;
        Ok(true)
    }

    /// 设置本机同步服务的监听端口（`0` = 停止监听）。
    ///
    /// 由持有 [`crate::net::PeerServer`] 的一方（App / CLI `serve`）在启停时同步进来，
    /// 下一次握手就会告诉对端。
    pub fn set_listen_port(&mut self, port: u16) {
        self.listen_port = port;
    }

    /// 本机同步服务的监听端口（0 = 没在监听）。
    pub fn listen_port(&self) -> u16 {
        self.listen_port
    }

    /// 忘掉某台对端的地址（对端告诉我们它没在监听 / 地址已失效时用）。
    ///
    /// 只清地址，保留这台设备本身（版本向量与同步计数还在，下次连上接着用）。
    pub fn forget_peer_addr(&mut self, peer_device: &str) {
        if let Some(entry) = self.peers.get_mut(peer_device) {
            if entry.addr.take().is_some() {
                log::info!(
                    "已清掉对端地址（对端未在监听） peer={}",
                    crate::version::short_device(peer_device)
                );
                self.dirty = true;
            }
        }
    }

    /// 清掉历史数据里「根本连不上」的对端地址（未指定 / 回环地址）。
    ///
    /// 曾经的版本会把 `0.0.0.0:47821` 这类地址记成对端地址（来源 IP 是通配地址时），
    /// 界面把它当「本机地址」展示、自动同步却永远连不上。启动时扫一遍清掉，
    /// 之后地址由下次握手或 UDP 发现重新写入。
    ///
    /// 返回清掉的条数（>0 时调用方值得刷一次盘）。
    pub fn forget_unusable_peer_addrs(&mut self) -> usize {
        let stale: Vec<String> = self
            .peers
            .iter()
            .filter(|(_, peer)| peer.addr.as_deref().is_some_and(unusable_peer_addr))
            .map(|(device, _)| device.clone())
            .collect();
        for device in &stale {
            let _ = self.forget_peer_addr(device);
        }
        stale.len()
    }

    /// 刷新某台**已知对端**的地址（局域网里 DHCP 换 IP / 换网卡后用）。
    ///
    /// 只改地址，不动同步计数与对方已知版本 —— 它不是一次同步，只是「记下新门牌号」。
    /// 不认识的设备 id 一律忽略（配对是显式动作，发现只服务于已配对的连接）。
    pub fn update_peer_addr(&mut self, peer_device: &str, addr: &str) {
        let Some(entry) = self.peers.get_mut(peer_device) else {
            return;
        };
        if entry.addr.as_deref() == Some(addr) {
            return;
        }
        log::info!(
            "对端地址已更新 peer={} addr={addr}",
            crate::version::short_device(peer_device)
        );
        entry.addr = Some(addr.to_string());
        self.dirty = true;
    }

    // ------------------------------------------------------------ 内部实现

    /// 只读打开时拒绝一切写操作（明确报错，而不是悄悄改坏别人正在用的数据）。
    fn ensure_writable(&self) -> Result<()> {
        if self.read_only {
            return Err(SyncError::Invalid(format!(
                "数据目录以只读方式打开：{}（如需写入请先退出正在使用它的进程）",
                self.store.root().display()
            )));
        }
        Ok(())
    }

    /// 是否只读打开。
    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    fn kind_of(&self, id: &str) -> Result<String> {
        self.entities
            .get(id)
            .map(|e| e.kind.clone())
            .ok_or_else(|| SyncError::NotFound(format!("实体 {id}")))
    }

    /// 因果就绪：实体版本已覆盖操作基线（或实体还没出现但基线为空）。
    fn causally_ready(&self, op: &Operation) -> bool {
        match self.entities.get(&op.entity_id) {
            Some(entity) => entity.version.covers(&op.base),
            None => op.base.is_empty(),
        }
    }

    fn defer(&mut self, op: Operation) {
        if self.deferred.iter().any(|d| d.op_id == op.op_id) {
            return;
        }
        log::debug!(
            "操作进入因果缓冲 op={} entity={} base={}",
            op.op_id,
            op.entity_id,
            op.base.to_short_string()
        );
        self.deferred.push(op);
        self.dirty = true;
    }

    /// 生成并应用一条本地操作。
    fn record_field_op(&mut self, id: &str, kind: &str, field: &str, op: OpKind) -> Result<()> {
        let entity = self
            .entities
            .get(id)
            .ok_or_else(|| SyncError::NotFound(format!("实体 {id}")))?;
        if entity.is_deleted() {
            let schema = self.schemas.get(kind);
            if !schema.resurrect_on_write {
                return Err(SyncError::Schema(format!("实体 {id} 已删除")));
            }
        }
        let base = entity.version.clone();
        let hlc = self.clock.now();
        let op = Operation {
            op_id: new_id(),
            origin: self.device_id().to_string(),
            seq: self.next_seq,
            hlc,
            entity_id: id.to_string(),
            kind: kind.to_string(),
            field: field.to_string(),
            op,
            base,
            schema_ver: self.schema_version,
            at_ms: now_ms(),
        };
        self.next_seq += 1;
        self.commit_local(op)
    }

    fn record_entity_op(&mut self, id: &str, kind: &str, op: OpKind) -> Result<()> {
        let base = self.entities.get(id).map(|e| e.version.clone()).unwrap_or_default();
        let hlc = self.clock.now();
        let op = Operation {
            op_id: new_id(),
            origin: self.device_id().to_string(),
            seq: self.next_seq,
            hlc,
            entity_id: id.to_string(),
            kind: kind.to_string(),
            field: String::new(),
            op,
            base,
            schema_ver: self.schema_version,
            at_ms: now_ms(),
        };
        self.next_seq += 1;
        self.commit_local(op)
    }

    /// 本地操作提交：先落盘（fsync），再并进内存。
    ///
    /// 顺序很重要：日志是真相，实体是派生。先写日志意味着「ACK 给用户之前
    /// 修改已经在磁盘上」，即使随后进程被杀，重启重放也能得到同样的实体。
    fn commit_local(&mut self, op: Operation) -> Result<()> {
        self.ensure_writable()?;
        self.store.append_op(&op)?;
        let index = self.ops.len();
        self.op_index.insert(op.op_id.clone(), index);
        self.origin_index.insert((op.origin.clone(), op.seq), index);
        let outcome = self.merge_into_model(&op, None);
        self.ops.push(op);
        self.absorb_conflicts(outcome);
        self.knowledge_cache = None;
        self.dirty = true;
        Ok(())
    }

    /// 把操作并进内存实体（不改日志、不改索引）。
    fn merge_into_model(&mut self, op: &Operation, peer_device: Option<&str>) -> MergeOutcome {
        let schema = self.schemas.get(&op.kind);
        let candidates = self.unique_candidates(op);
        let device_id = self.device_id().to_string();
        let lookup = |field: &str, value: &Value, _self_id: &str| -> Option<EntityId> {
            candidates
                .iter()
                .find(|(f, v, _)| f == field && v == value)
                .map(|(_, _, owner)| owner.clone())
        };
        let mut ctx = MergeCtx::new(&schema, &device_id, now_ms()).with_peer(peer_device);
        if !candidates.is_empty() {
            ctx = ctx.with_unique_lookup(&lookup);
        }

        let entity = self.entities.entry(op.entity_id.clone()).or_insert_with(|| {
            Entity::new(&op.entity_id, &op.kind, op.hlc.clone(), op.schema_ver)
        });
        let outcome = merge::apply(entity, op, &ctx);
        entity.version.observe(&op.origin, op.seq);
        entity.updated = entity.updated.clone().max(op.hlc.clone());
        self.clock.observe(&op.hlc);
        outcome
    }

    /// 应用一条已确认「因果就绪」的操作（远端路径）。
    fn apply_ready(&mut self, op: &Operation, peer_device: Option<&str>) -> Result<MergeOutcome> {
        self.ensure_writable()?;
        let outcome = self.merge_into_model(op, peer_device);
        self.store.append_op(op)?;
        let index = self.ops.len();
        self.op_index.insert(op.op_id.clone(), index);
        self.origin_index.insert((op.origin.clone(), op.seq), index);
        self.ops.push(op.clone());
        self.knowledge_cache = None;
        self.dirty = true;

        // 唯一键冲突：占用者也要标成「待裁决」，否则用户只看到一边
        if let Some(Rejection::UniqueKey { field, owner }) = &outcome.reject {
            if let Some(entity) = self.entities.get_mut(owner) {
                entity.conflicted.insert(field.clone());
            }
        }
        Ok(outcome)
    }

    /// 找出这条操作会写到的唯一键当前被谁占用（用于冲突提示）。
    fn unique_candidates(&self, op: &Operation) -> Vec<(String, Value, EntityId)> {
        let schema = self.schemas.get(&op.kind);
        if schema.unique_fields.is_empty() {
            return Vec::new();
        }
        let mut checks: Vec<(String, Value)> = Vec::new();
        match &op.op {
            OpKind::Set { value } => checks.push((op.field.clone(), value.clone())),
            OpKind::Create { fields } => {
                checks.extend(fields.iter().map(|(k, v)| (k.clone(), v.clone())))
            }
            _ => {}
        }
        let mut out = Vec::new();
        for (field, value) in checks {
            if !schema.unique_fields.iter().any(|f| f == &field) || value.is_null() {
                continue;
            }
            if let Some(owner) = self.find_unique_owner(&op.kind, &field, &value, &op.entity_id) {
                out.push((field, value, owner));
            }
        }
        out
    }

    fn find_unique_owner(
        &self,
        kind: &str,
        field: &str,
        value: &Value,
        self_id: &str,
    ) -> Option<EntityId> {
        self.entities
            .values()
            .filter(|e| e.kind == kind && e.id != self_id && !e.is_deleted())
            .find(|e| e.field(field).as_ref() == Some(value))
            .map(|e| e.id.clone())
    }

    /// 收下合并产生的冲突（同一条待裁决冲突只留一条）。
    fn absorb_conflicts(&mut self, outcome: MergeOutcome) {
        for conflict in outcome.conflicts {
            self.push_conflict(conflict);
        }
    }

    /// 关闭「已被后续写入了结」的待裁决冲突。
    ///
    /// 场景：甲、乙并发改同一字段 → 两边都进了冲突队列；甲裁决后同步给乙，
    /// 乙应用这条新写入（它看到了两边状态）时，队列里的旧冲突就该自己消失，
    /// 否则用户会一直看到一条已经解决了的「冲突」。
    fn settle_conflicts(&mut self, entity_id: &str, settled: &[String]) {
        if settled.is_empty() {
            return;
        }
        let mut closed = 0usize;
        for conflict in self.conflicts.iter_mut() {
            if conflict.status.is_pending()
                && conflict.entity_id == entity_id
                && settled.iter().any(|field| field == &conflict.field)
            {
                conflict.status = ConflictStatus::Resolved;
                conflict.note = Some(match conflict.note.take() {
                    Some(note) => format!("{note}（已被后续写入统一）"),
                    None => "已被后续写入统一".to_string(),
                });
                closed += 1;
            }
        }
        if closed > 0 {
            if let Some(entity) = self.entities.get_mut(entity_id) {
                for field in settled {
                    entity.conflicted.remove(field);
                }
            }
            self.dirty = true;
            log::debug!("冲突已随后续写入关闭 entity={entity_id} 数量={closed}");
        }
    }

    fn push_conflict(&mut self, conflict: Conflict) {
        let duplicate = self.conflicts.iter().any(|c| {
            c.status.is_pending()
                && conflict.status.is_pending()
                && c.entity_id == conflict.entity_id
                && c.field == conflict.field
                && c.reason == conflict.reason
        });
        if duplicate {
            return;
        }
        log::info!(
            "同步冲突 entity={} field={} reason={:?} status={:?}",
            conflict.entity_id,
            if conflict.field.is_empty() { "-" } else { &conflict.field },
            conflict.reason,
            conflict.status
        );
        self.conflicts.push(conflict);
        self.dirty = true;
    }

    /// 某列表字段当前所有位置键。
    fn list_positions(&self, id: &str, field: &str) -> Vec<String> {
        match self.entities.get(id).and_then(|e| e.fields.get(field)) {
            Some(FieldState::List { items }) => {
                let mut positions: Vec<String> = items.values().map(|i| i.position.clone()).collect();
                positions.sort();
                positions
            }
            _ => Vec::new(),
        }
    }

    /// 只读统计：各类实体数量（CLI `status` / 界面展示用）。
    pub fn kind_counts(&self, include_deleted: bool) -> BTreeMap<String, usize> {
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for entity in self.all_entities(include_deleted) {
            *counts.entry(entity.kind.clone()).or_insert(0) += 1;
        }
        counts
    }

    /// 冲突涉及的字段名集合（展示用）。
    pub fn conflicted_fields(&self, entity_id: &str) -> HashSet<String> {
        self.entities
            .get(entity_id)
            .map(|e| e.conflicted.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// 集合字段当前的元素（按策略判定存在性）。
    pub fn set_elements(&self, id: &str, field: &str) -> Vec<String> {
        let policy = self
            .entity(id)
            .map(|e| self.schemas.get(&e.kind).field_kind(field).set_policy())
            .unwrap_or(Some(SetPolicy::AddWins));
        match self.entities.get(id).and_then(|e| e.fields.get(field)) {
            Some(FieldState::Set { elements }) => elements
                .iter()
                .filter(|(_, state)| policy.map(|p| state.is_present(p)).unwrap_or(false))
                .map(|(key, _)| key.clone())
                .collect(),
            _ => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ConflictReason;
    use crate::schema::{CascadeRule, DeletePolicy, MergeKind, Schema};
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("readerx-sync-engine-{tag}-{}", new_id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    /// 书 + 标签 + 列表 + 进度的一套 schema（贴近真实用法）。
    fn schemas() -> SchemaRegistry {
        let mut registry = SchemaRegistry::new();
        registry.register(
            Schema::new("book")
                .field("title", MergeKind::Lww)
                .field("author", MergeKind::Lww)
                .field("tags", MergeKind::set())
                .field("order", MergeKind::List)
                .field("format", MergeKind::Frozen)
                .cascade(CascadeRule::cascade("bookmark", "book_id")),
        );
        registry.register(
            Schema::new("bookmark")
                .field("book_id", MergeKind::Frozen)
                .field("note", MergeKind::Lww),
        );
        registry.register(Schema::new("setting").unique("key").field("key", MergeKind::Frozen));
        registry
    }

    fn engine(tag: &str) -> SyncEngine {
        let dir = temp_dir(tag);
        SyncEngine::open(dir, EngineOptions::new(tag).with_schemas(schemas())).unwrap()
    }

    #[test]
    fn local_writes_are_persisted_and_reloadable() {
        let dir = temp_dir("persist");
        let mut engine =
            SyncEngine::open(&dir, EngineOptions::new("A").with_schemas(schemas())).unwrap();
        let id = engine
            .create_entity("book", None, [("title", serde_json::json!("三体"))])
            .unwrap();
        engine.set_field(&id, "title", serde_json::json!("三体（重制版）")).unwrap();
        engine.add_element(&id, "tags", "科幻", None).unwrap();
        engine.flush().unwrap();
        let device_id = engine.device_id().to_string();
        drop(engine);

        let reopened =
            SyncEngine::open(&dir, EngineOptions::new("A").with_schemas(schemas())).unwrap();
        assert_eq!(reopened.device_id(), device_id);
        assert_eq!(reopened.field(&id, "title"), Some(serde_json::json!("三体（重制版）")));
        assert_eq!(reopened.set_elements(&id, "tags"), vec!["科幻".to_string()]);
        assert_eq!(reopened.op_count(), 3);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn snapshot_tail_is_replayed_after_crash() {
        let dir = temp_dir("tail");
        {
            let mut engine =
                SyncEngine::open(&dir, EngineOptions::new("A").with_schemas(schemas())).unwrap();
            engine
                .create_entity("book", Some("book-1".into()), [("title", serde_json::json!("一"))])
                .unwrap();
            engine.flush().unwrap();
            // 之后又改了两次，但「没来得及 flush」就退出（模拟被杀进程）
            engine.set_field("book-1", "title", serde_json::json!("二")).unwrap();
            engine.set_field("book-1", "title", serde_json::json!("三")).unwrap();
        }
        let reopened =
            SyncEngine::open(&dir, EngineOptions::new("A").with_schemas(schemas())).unwrap();
        assert_eq!(
            reopened.field("book-1", "title"),
            Some(serde_json::json!("三")),
            "快照之后的日志尾部必须被重放"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn duplicate_ops_are_ignored() {
        let mut a = engine("dup-a");
        let mut b = engine("dup-b");
        let id = a.create_entity("book", None, [("title", serde_json::json!("一"))]).unwrap();
        a.flush().unwrap();
        let op = a.ops().last().unwrap().clone();

        assert!(matches!(b.apply_remote(&op, Some(a.device_id())).unwrap(), ApplyResult::Applied { .. }));
        assert_eq!(b.apply_remote(&op, Some(a.device_id())).unwrap(), ApplyResult::Duplicate);
        assert_eq!(b.op_count(), 1, "重复操作不应重复计数");
        assert_eq!(a.field(&id, "title"), b.field(&id, "title"));
    }

    #[test]
    fn out_of_order_ops_go_to_causal_buffer_then_apply() {
        let mut a = engine("causal-a");
        let mut b = engine("causal-b");
        let id = a.create_entity("book", None, [("title", serde_json::json!("一"))]).unwrap();
        a.set_field(&id, "title", serde_json::json!("二")).unwrap();
        a.flush().unwrap();
        let ops: Vec<Operation> = a.ops().to_vec();

        // 先送第二条（基线含第一条）→ 应进缓冲
        let result = b.apply_remote(&ops[1], Some(a.device_id())).unwrap();
        assert!(matches!(result, ApplyResult::Deferred { .. }), "乱序到达应先缓冲：{result:?}");
        assert_eq!(b.entity(&id), None);
        assert_eq!(b.deferred_ops().len(), 1);

        // 再送第一条 → 第二条会被自动重试并应用
        let result = b.apply_remote(&ops[0], Some(a.device_id())).unwrap();
        assert!(matches!(result, ApplyResult::Applied { .. }));
        assert_eq!(b.deferred_ops().len(), 0, "前序到达后缓冲应被清空");
        assert_eq!(b.field(&id, "title"), Some(serde_json::json!("二")));
    }

    /// 「删除设备」：本机忘掉它 + 进拒绝名单，重启后仍然拒绝；
    /// 同步记录**不能**撤销删除，只有显式接受（`accept_peer`）才行。
    #[test]
    fn removed_peer_is_rejected_until_it_is_accepted_explicitly() {
        let dir = temp_dir("remove-peer");
        let mut engine =
            SyncEngine::open(&dir, EngineOptions::new("A").with_schemas(schemas())).unwrap();
        // 先「同步过」一台设备：peers.json 里就记下了它
        engine.record_peer_sync(
            "peer-1",
            "旧手机",
            Some("192.168.0.9:47821".to_string()),
            VersionVector::from_pairs([("peer-1", 3)]),
            None,
        );
        engine.flush().unwrap();
        assert!(engine.peers().contains_key("peer-1"));

        engine.remove_peer("peer-1").unwrap();
        assert!(!engine.peers().contains_key("peer-1"), "移除后不该再出现在设备列表里");
        assert!(engine.is_device_removed("peer-1"), "移除的设备进拒绝名单");
        assert!(engine.remove_peer(&engine.device_id().to_string()).is_err(), "不能移除本机");

        // 并发时序：删除时还有一次同步在跑，它结束时会记录这一次同步 —— 不能把删除撤销
        engine.record_peer_sync("peer-1", "旧手机", None, VersionVector::default(), None);
        assert!(engine.is_device_removed("peer-1"), "同步记录不能撤销删除");
        assert!(!engine.peers().contains_key("peer-1"), "被移除的设备不能被记回列表");
        drop(engine);

        let mut reopened =
            SyncEngine::open(&dir, EngineOptions::new("A").with_schemas(schemas())).unwrap();
        assert!(reopened.is_device_removed("peer-1"), "重启后仍应拒绝该设备");
        assert!(!reopened.peers().contains_key("peer-1"));

        // 显式重新接受（界面上就是「查找局域网设备」里的「重新接受」）
        assert!(reopened.accept_peer("peer-1").unwrap(), "接受应报告状态变化");
        assert!(!reopened.is_device_removed("peer-1"), "接受后不再拒绝");
        // 再同步一次才会回到设备列表
        reopened.record_peer_sync("peer-1", "旧手机", None, VersionVector::default(), None);
        assert!(reopened.peers().contains_key("peer-1"));
        reopened.flush().unwrap();
        drop(reopened);

        let again =
            SyncEngine::open(&dir, EngineOptions::new("A").with_schemas(schemas())).unwrap();
        assert!(!again.is_device_removed("peer-1"), "重新接受要落盘");
        assert!(again.peers().contains_key("peer-1"));
    }

    /// 移除设备时，它那批「等不到前序」的缓冲操作一并丢掉：它已被拒绝，
    /// 那些操作永远不会再有基线，留着只会让缓冲一直不收敛。
    #[test]
    fn removing_peer_drops_its_pending_ops() {
        let dir = temp_dir("remove-deferred");
        let mut a = engine("causal-remove-a");
        let mut b =
            SyncEngine::open(&dir, EngineOptions::new("B").with_schemas(schemas())).unwrap();
        let id = a.create_entity("book", None, [("title", serde_json::json!("一"))]).unwrap();
        a.set_field(&id, "title", serde_json::json!("二")).unwrap();
        a.flush().unwrap();
        let ops: Vec<Operation> = a.ops().to_vec();

        // 只送第二条（基线含第一条）→ 进缓冲，来源是设备 A
        b.apply_remote(&ops[1], Some(a.device_id())).unwrap();
        assert_eq!(b.deferred_ops().len(), 1);

        b.remove_peer(a.device_id()).unwrap();
        assert_eq!(b.deferred_ops().len(), 0, "被移除设备的缓冲操作应清掉");
        drop(b);

        let reopened =
            SyncEngine::open(&dir, EngineOptions::new("B").with_schemas(schemas())).unwrap();
        assert_eq!(reopened.deferred_ops().len(), 0, "清空要落盘");
    }

    #[test]
    fn concurrent_field_edit_creates_conflict_and_can_be_resolved() {
        let mut a = engine("conflict-a");
        let mut b = engine("conflict-b");
        let id = a.create_entity("book", Some("book-1".into()), [("title", serde_json::json!("原名"))]).unwrap();
        a.flush().unwrap();
        // B 先同步到同一起点
        b.apply_many(a.ops(), Some(a.device_id())).unwrap();

        // 之后各自离线改标题
        a.set_field(&id, "title", serde_json::json!("甲的名字")).unwrap();
        b.set_field(&id, "title", serde_json::json!("乙的名字")).unwrap();
        a.flush().unwrap();
        b.flush().unwrap();
        let a_ops: Vec<Operation> = a.ops().to_vec();
        let b_ops: Vec<Operation> = b.ops().to_vec();

        b.apply_many(&a_ops, Some(a.device_id())).unwrap();
        a.apply_many(&b_ops, Some(b.device_id())).unwrap();

        // 两边收敛到同一个值
        assert_eq!(a.field(&id, "title"), b.field(&id, "title"));
        // 冲突都留了档（败方数据在记录里）
        let conflict = b
            .conflicts(None)
            .into_iter()
            .find(|c| c.reason == ConflictReason::ConcurrentWrite)
            .cloned()
            .expect("应有并发写冲突");
        assert_eq!(conflict.local.value, Some(serde_json::json!("乙的名字")));
        assert_eq!(conflict.remote.value, Some(serde_json::json!("甲的名字")));

        // 裁决：保留本地 → 写一条新操作
        b.resolve_conflict(&conflict.id, Resolution::KeepLocal).unwrap();
        assert_eq!(b.field(&id, "title"), Some(serde_json::json!("乙的名字")));
        assert_eq!(b.pending_conflict_count(), 0);
        b.flush().unwrap();

        // 裁决结果也能同步出去
        let new_ops: Vec<Operation> = b.ops()[a_ops.len()..].to_vec();
        a.apply_many(&new_ops, Some(b.device_id())).unwrap();
        assert_eq!(a.field(&id, "title"), Some(serde_json::json!("乙的名字")));
    }

    #[test]
    fn resolving_a_conflict_closes_it_on_the_other_side() {
        // 甲、乙并发改同一字段 → 两边都进队列；甲裁决后同步过去 → 乙的队列自动关闭
        let mut a = engine("settle-a");
        let mut b = engine("settle-b");
        let id = a
            .create_entity("book", Some("b1".into()), [("title", serde_json::json!("原名"))])
            .unwrap();
        a.flush().unwrap();
        b.apply_many(a.ops(), Some(a.device_id())).unwrap();

        a.set_field(&id, "title", serde_json::json!("甲")).unwrap();
        b.set_field(&id, "title", serde_json::json!("乙")).unwrap();
        let a_ops: Vec<Operation> = a.ops().to_vec();
        let b_ops: Vec<Operation> = b.ops().to_vec();
        a.apply_many(&b_ops, Some(b.device_id())).unwrap();
        b.apply_many(&a_ops, Some(a.device_id())).unwrap();
        assert_eq!(a.pending_conflict_count(), 1);
        assert_eq!(b.pending_conflict_count(), 1);

        // 甲裁决：保留本地（写一条新操作，对端能看到这次决定）
        let conflict = a.conflicts(Some(ConflictStatus::Pending))[0].clone();
        a.resolve_conflict(&conflict.id, Resolution::KeepLocal).unwrap();
        a.flush().unwrap();

        // 同步给乙：乙的旧冲突应被这次写入「了结」
        let new_ops: Vec<Operation> = a.ops()[a_ops.len()..].to_vec();
        b.apply_many(&new_ops, Some(a.device_id())).unwrap();
        assert_eq!(b.field(&id, "title"), Some(serde_json::json!("甲")));
        assert_eq!(b.pending_conflict_count(), 0, "对端裁决后本地队列应自动关闭");
        assert!(b.conflicts(None).iter().any(|c| !c.status.is_pending()), "记录仍保留可追溯");
    }

    #[test]
    fn two_engines_converge_after_bidirectional_sync() {
        let mut a = engine("conv-a");
        let mut b = engine("conv-b");
        let id = a
            .create_entity(
                "book",
                Some("book-1".into()),
                [("title", serde_json::json!("三体")), ("author", serde_json::json!("刘慈欣"))],
            )
            .unwrap();
        a.flush().unwrap();
        b.apply_many(a.ops(), Some(a.device_id())).unwrap();

        // 甲改标题、乙改作者（不同字段）：不该有冲突
        a.set_field(&id, "title", serde_json::json!("三体 II")).unwrap();
        b.set_field(&id, "author", serde_json::json!("刘慈欣 ")).unwrap();
        let a_ops: Vec<Operation> = a.ops().to_vec();
        let b_ops: Vec<Operation> = b.ops().to_vec();
        b.apply_many(&a_ops, Some(a.device_id())).unwrap();
        a.apply_many(&b_ops, Some(b.device_id())).unwrap();

        assert_eq!(a.field(&id, "title"), b.field(&id, "title"));
        assert_eq!(a.field(&id, "author"), b.field(&id, "author"));
        assert_eq!(a.pending_conflict_count(), 0, "不同字段不应产生冲突");
        assert_eq!(b.pending_conflict_count(), 0);
    }

    #[test]
    fn delete_then_concurrent_update_keeps_data_in_conflict() {
        let mut a = engine("del-a");
        let mut b = engine("del-b");
        let id = a
            .create_entity("book", Some("book-1".into()), [("title", serde_json::json!("三体"))])
            .unwrap();
        a.flush().unwrap();
        b.apply_many(a.ops(), Some(a.device_id())).unwrap();

        // 乙离线改标题，甲删书
        b.set_field(&id, "title", serde_json::json!("改过的名字")).unwrap();
        a.delete_entity(&id, None).unwrap();
        let a_ops: Vec<Operation> = a.ops().to_vec();
        let b_ops: Vec<Operation> = b.ops().to_vec();
        a.apply_many(&b_ops, Some(b.device_id())).unwrap();
        b.apply_many(&a_ops, Some(a.device_id())).unwrap();

        assert!(a.entity(&id).unwrap().is_deleted());
        assert!(b.entity(&id).unwrap().is_deleted(), "默认删除优先：两边都应删除");
        let conflict = b
            .conflicts(None)
            .into_iter()
            .find(|c| c.reason == ConflictReason::DeleteVsUpdate)
            .cloned()
            .expect("应记录删除 / 更新冲突");
        let snapshot = conflict.local.value.unwrap();
        assert_eq!(snapshot["title"], serde_json::json!("改过的名字"), "被删掉的值必须留档");
    }

    #[test]
    fn update_wins_schema_resurrects() {
        let mut registry = schemas();
        registry.register(
            Schema::new("note")
                .field("text", MergeKind::Lww)
                .delete_policy(DeletePolicy::UpdateWins),
        );
        let dir_a = temp_dir("uw-a");
        let dir_b = temp_dir("uw-b");
        let mut a = SyncEngine::open(&dir_a, EngineOptions::new("A").with_schemas(registry.clone()))
            .unwrap();
        let mut b = SyncEngine::open(&dir_b, EngineOptions::new("B").with_schemas(registry)).unwrap();
        let id = a.create_entity("note", Some("n1".into()), [("text", serde_json::json!("v1"))]).unwrap();
        a.flush().unwrap();
        b.apply_many(a.ops(), Some(a.device_id())).unwrap();

        b.set_field(&id, "text", serde_json::json!("v2")).unwrap();
        a.delete_entity(&id, None).unwrap();
        let a_ops: Vec<Operation> = a.ops().to_vec();
        let b_ops: Vec<Operation> = b.ops().to_vec();
        a.apply_many(&b_ops, Some(b.device_id())).unwrap();
        b.apply_many(&a_ops, Some(a.device_id())).unwrap();

        assert!(!a.entity(&id).unwrap().is_deleted(), "更新优先：记录应活着");
        assert_eq!(a.field(&id, "text"), Some(serde_json::json!("v2")));
        fs::remove_dir_all(&dir_a).ok();
        fs::remove_dir_all(&dir_b).ok();
    }

    #[test]
    fn cascade_delete_and_orphan_rules() {
        let mut registry = schemas();
        registry.register(
            Schema::new("group")
                .field("name", MergeKind::Lww)
                .cascade(CascadeRule::orphan("book", "group_id"))
                .cascade(CascadeRule::block("bookmark", "group_id")),
        );
        let dir = temp_dir("cascade");
        let mut engine =
            SyncEngine::open(&dir, EngineOptions::new("A").with_schemas(registry)).unwrap();
        let group = engine
            .create_entity("group", Some("g1".into()), [("name", serde_json::json!("科幻"))])
            .unwrap();
        let book = engine
            .create_entity(
                "book",
                Some("b1".into()),
                [("title", serde_json::json!("三体")), ("group_id", serde_json::json!(group))],
            )
            .unwrap();
        let bookmark = engine
            .create_entity("bookmark", Some("m1".into()), [("group_id", serde_json::json!(group))])
            .unwrap();

        // 有书签引用 → 阻止删除
        let err = engine.delete_entity(&group, None).unwrap_err();
        assert!(matches!(err, SyncError::Schema(_)), "级联阻止应报 schema 错误：{err}");
        assert!(engine
            .conflicts(Some(ConflictStatus::Pending))
            .iter()
            .any(|c| c.reason == ConflictReason::CascadeBlocked));

        // 删掉书签后可以删分组：书变成孤儿（group_id 被清空）
        engine.delete_entity(&bookmark, None).unwrap();
        engine.delete_entity(&group, None).unwrap();
        assert!(engine.entity(&group).unwrap().is_deleted());
        assert_eq!(engine.field(&book, "group_id"), Some(serde_json::Value::Null));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cascade_derived_delete_hides_children() {
        let dir = temp_dir("derived");
        let mut engine =
            SyncEngine::open(&dir, EngineOptions::new("A").with_schemas(schemas())).unwrap();
        let book = engine
            .create_entity("book", Some("b1".into()), [("title", serde_json::json!("三体"))])
            .unwrap();
        // 书签挂在书上（schema 里 book 的 cascade 规则是 cascade bookmark）
        engine
            .create_entity("bookmark", Some("m1".into()), [("book_id", serde_json::json!(book))])
            .unwrap();
        assert_eq!(engine.entities_of_kind("bookmark", false).len(), 1);

        engine.delete_entity(&book, None).unwrap();
        assert_eq!(
            engine.entities_of_kind("bookmark", false).len(),
            0,
            "父记录删除后，子记录在读取时应一并视为已删除"
        );
        assert_eq!(engine.entities_of_kind("bookmark", true).len(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unique_key_conflict_is_visible_on_both_entities() {
        let dir = temp_dir("unique");
        let mut engine =
            SyncEngine::open(&dir, EngineOptions::new("A").with_schemas(schemas())).unwrap();
        engine
            .create_entity("setting", Some("s1".into()), [("key", serde_json::json!("theme"))])
            .unwrap();
        // 本地再建一条同 key 的设置：唯一键冲突，两边都保留
        engine
            .create_entity("setting", Some("s2".into()), [("key", serde_json::json!("theme"))])
            .unwrap();
        assert!(engine.pending_conflict_count() >= 1);
        assert!(engine.conflicted_fields("s2").contains("key"));
        assert_eq!(engine.entities_of_kind("setting", false).len(), 2);
        fs::remove_dir_all(&dir).ok();
    }

    /// 未指定地址是「绑定用的通配地址」，不是能连的对端地址。
    ///
    /// 回归：曾经把 `0.0.0.0:47821` 记成对端地址，界面上当成「本机地址」显示，
    /// 用户照着同步必然失败；而回环地址在「本机两实例」场景下是正经地址，不能一起清掉。
    #[test]
    fn unspecified_peer_addresses_are_unusable_but_loopback_is_kept() {
        assert!(unusable_peer_addr("0.0.0.0:47821"));
        assert!(unusable_peer_addr("[::]:47821"));
        assert!(!unusable_peer_addr("127.0.0.1:47821"));
        assert!(!unusable_peer_addr("192.168.0.101:47821"));
        assert!(!unusable_peer_addr("fd00::1:47821"));
        // 看不懂的历史值不静默抹掉
        assert!(!unusable_peer_addr("nas.local:47821"));
    }

    #[test]
    fn startup_cleanup_drops_only_the_unconnectable_addresses() {
        let dir = temp_dir("stale-addr");
        let mut engine =
            SyncEngine::open(&dir, EngineOptions::new("A").with_schemas(schemas())).unwrap();
        engine.record_peer_sync("peer-bad", "手机", Some("0.0.0.0:47821".into()), VersionVector::new(), None);
        engine.record_peer_sync("peer-good", "台式机", Some("192.168.0.101:47821".into()), VersionVector::new(), None);
        engine.flush().unwrap();

        assert_eq!(engine.forget_unusable_peer_addrs(), 1);
        assert!(engine.peers().get("peer-bad").unwrap().addr.is_none(), "坏地址要被清掉");
        assert_eq!(
            engine.peers().get("peer-good").unwrap().addr.as_deref(),
            Some("192.168.0.101:47821"),
            "好地址不受影响"
        );
        // 清干净后重复调用不再有动作
        assert_eq!(engine.forget_unusable_peer_addrs(), 0);
        // 设备本身留着（同步计数与对方已知版本还在）
        assert!(engine.peers().contains_key("peer-bad"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ops_for_peer_only_sends_the_difference() {
        let mut a = engine("diff-a");
        let mut b = engine("diff-b");
        let id = a.create_entity("book", None, [("title", serde_json::json!("一"))]).unwrap();
        a.set_field(&id, "title", serde_json::json!("二")).unwrap();
        a.flush().unwrap();

        // B 什么都没有 → 全量
        let (batch, more) = a.ops_for_peer(&VersionVector::new(), 100);
        assert_eq!(batch.len(), 2);
        assert!(!more);
        b.apply_many(&batch, Some(a.device_id())).unwrap();

        // B 同步后，A 再改一次 → 只发一条
        a.set_field(&id, "title", serde_json::json!("三")).unwrap();
        let (batch, _) = a.ops_for_peer(&b.knowledge(), 100);
        assert_eq!(batch.len(), 1, "增量同步只应发差集");
        assert_eq!(batch[0].seq, 3);

        // 分页
        let (page1, more) = a.ops_for_peer(&VersionVector::new(), 1);
        assert_eq!(page1.len(), 1);
        assert!(more);
    }

    #[test]
    fn knowledge_reflects_authored_ops_and_relay() {
        let mut a = engine("relay-a");
        let mut b = engine("relay-b");
        let mut c = engine("relay-c");
        let id = a.create_entity("book", None, [("title", serde_json::json!("一"))]).unwrap();
        a.set_field(&id, "title", serde_json::json!("二")).unwrap();
        b.apply_many(a.ops(), Some(a.device_id())).unwrap();
        b.set_field(&id, "title", serde_json::json!("三")).unwrap();

        // C 只跟 B 同步，也应该拿到 A 的操作（中继）
        let (batch, _) = b.ops_for_peer(&c.knowledge(), 100);
        c.apply_many(&batch, Some(b.device_id())).unwrap();
        assert_eq!(c.field(&id, "title"), Some(serde_json::json!("三")));
        assert_eq!(c.knowledge().get(a.device_id()), 2, "中继后 C 应知道 A 的两条操作");
        assert_eq!(c.knowledge().get(b.device_id()), 1);
    }

    #[test]
    fn list_ordering_converges() {
        let mut a = engine("list-a");
        let mut b = engine("list-b");
        let id = a
            .create_entity("book", Some("shelf".into()), Vec::<(String, Value)>::new())
            .unwrap();
        a.add_element(&id, "order", "book-1", None).unwrap();
        a.flush().unwrap();
        b.apply_many(a.ops(), Some(a.device_id())).unwrap();

        // 两边并发往同一处插入
        let key = "V";
        a.add_element(&id, "order", "book-A", Some(key.into())).unwrap();
        b.add_element(&id, "order", "book-B", Some(key.into())).unwrap();
        let a_ops: Vec<Operation> = a.ops().to_vec();
        let b_ops: Vec<Operation> = b.ops().to_vec();
        a.apply_many(&b_ops, Some(b.device_id())).unwrap();
        b.apply_many(&a_ops, Some(a.device_id())).unwrap();

        let order_a = a.field(&id, "order").unwrap();
        let order_b = b.field(&id, "order").unwrap();
        assert_eq!(order_a, order_b, "并发插入后顺序必须一致");
        assert_eq!(order_a.as_array().unwrap().len(), 3, "两个新元素都要保留");
    }

    #[test]
    fn format_migration_rejects_future_files() {
        let dir = temp_dir("future");
        let engine = SyncEngine::open(&dir, EngineOptions::new("A")).unwrap();
        drop(engine);
        let device_path = dir.join("device.json");
        let mut value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&device_path).unwrap()).unwrap();
        value["format"] = serde_json::json!(99);
        fs::write(&device_path, serde_json::to_vec(&value).unwrap()).unwrap();
        let err = match SyncEngine::open(&dir, EngineOptions::new("A")) {
            Ok(_) => panic!("未来版本应拒绝加载"),
            Err(e) => e,
        };
        assert!(matches!(err, SyncError::Unsupported(_)), "未来版本应拒绝加载：{err}");
        fs::remove_dir_all(&dir).ok();
    }
}

//! 数据模型：操作（op log 的最小单位）、实体（物化视图）、冲突记录。
//!
//! 三层的关系：
//!
//! ```text
//! Operation   —— 追加型日志，同步与重放的唯一真相（一次修改 = 一条 op）
//! Entity      —— 由 op 重放出来的物化视图（字段值 + 每字段版本 + 已并入的操作向量）
//! Conflict    —— 无法自动裁决时留下的记录（数据不丢，等人 / 业务规则处理）
//! ```
//!
//! 为什么以「操作」而不是「最终值」为同步单位：两台设备都改过同一条记录时，
//! 最终值里已经看不出「谁在什么基础上改的」——判断并发需要每条修改携带
//! 作者写入时看到的版本（[`Operation::base`]），而版本只有操作自己知道。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

use crate::hlc::Hlc;
use crate::id::{DeviceId, EntityId, OpId};
use crate::version::VersionVector;

/// 操作在某个设备内的序号对 `(设备, 序号)`——判断「对方是否见过这条操作」用。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Stamp {
    pub device: DeviceId,
    pub seq: u64,
}

impl Stamp {
    pub fn new(device: impl Into<DeviceId>, seq: u64) -> Stamp {
        Stamp { device: device.into(), seq }
    }

    /// OR-Set 的 tag 形式：`设备:序号`。
    pub fn tag(&self) -> String {
        format!("{}:{}", self.device, self.seq)
    }

    /// 由 tag 反解（解析失败返回 `None`）。
    pub fn from_tag(tag: &str) -> Option<Stamp> {
        let (device, seq) = tag.rsplit_once(':')?;
        Some(Stamp { device: device.to_string(), seq: seq.parse().ok()? })
    }
}

/// 混合逻辑时钟的默认值（反序列化老数据时用：视为「最旧」）。
impl Default for Hlc {
    fn default() -> Self {
        Hlc::new(0, 0, String::new())
    }
}

/// 带版本的值（MV-Register 的一项）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StampedValue {
    pub value: Value,
    pub hlc: Hlc,
    pub origin: Stamp,
    /// 写入者当时的因果基线：比它旧的并发值可以据此清掉
    pub base: VersionVector,
}

/// 集合元素的「加入」记录。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AddTag {
    pub hlc: Hlc,
    /// 加入时的因果基线（remove-wins 策略下判断「是否见过删除」用）
    pub base: VersionVector,
}

/// OR-Set 的一个元素。
///
/// 用「加入 tag 集合 + 删除水位」表达增删，而不是一个布尔值：
/// 甲加、乙删同一个元素时，布尔值无法表达「乙删的是不是甲加的那个」，
/// 也无法在乱序到达时得到一致结果（场景 11 / 20）。
///
/// `removals` 记的是「删除发生时删除者见过的状态」（删除者的版本向量 ∪ 删除操作自身）：
/// 某个加入 tag 的序号 ≤ 该水位 ⇒ 这次加入已被删除覆盖。这样**与操作到达顺序无关**：
/// 先到删除后到加入、或反过来，判出来的结果都一样。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SetElement {
    /// tag（`设备:序号`）→ 加入信息
    pub adds: BTreeMap<String, AddTag>,
    /// 删除水位：被删除覆盖到的状态
    #[serde(default, skip_serializing_if = "VersionVector::is_empty")]
    pub removals: VersionVector,
    /// 最近一次变更时间（展示、排序用）
    pub last_hlc: Hlc,
}

impl SetElement {
    /// 该元素当前是否在集合里（按字段声明的策略判定）。
    pub fn is_present(&self, policy: SetPolicy) -> bool {
        match policy {
            // 添加优先：只要有一个「删除没见过」的加入，元素就在
            SetPolicy::AddWins => self
                .adds
                .iter()
                .any(|(tag, _)| match Stamp::from_tag(tag) {
                    Some(stamp) => !self.removals.contains(&stamp.device, stamp.seq),
                    // tag 不合法（外部改坏的数据）时保守当作「未被删除」
                    None => true,
                }),
            // 删除优先：加入还必须发生在删除之后（基线覆盖删除水位 = 明确重新添加）
            SetPolicy::RemoveWins => self.adds.iter().any(|(tag, add)| {
                match Stamp::from_tag(tag) {
                    Some(stamp) => {
                        // 加入者见过这次删除（基线覆盖删除水位）⇒ 明确重新添加
                        !self.removals.contains(&stamp.device, stamp.seq)
                            && add.base.covers(&self.removals)
                    }
                    None => false,
                }
            }),
        }
    }

    /// 该元素的加入总数（诊断用）。
    pub fn add_count(&self) -> usize {
        self.adds.len()
    }
}

/// 集合字段的并发策略。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetPolicy {
    /// 甲加 X、乙删 X（并发）→ X 保留（默认，OR-Set 语义）
    AddWins,
    /// 甲加 X、乙删 X（并发）→ X 删除；只有「见过删除」的再次添加才生效
    RemoveWins,
}

/// 有序列表里的一个元素（位置键 + 载荷 + 元素级墓碑）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ListItem {
    /// 分数索引位置键：与相邻元素之间总能再插一个（见 [`crate::order`]）
    pub position: String,
    /// 元素载荷（通常是被排序对象的 id；也允许内联对象）
    pub value: Value,
    /// 最近一次位置 / 载荷变更
    pub hlc: Hlc,
    pub origin: Stamp,
    /// 元素级墓碑（谁在什么基础上删的）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<Stamp>,
}

impl ListItem {
    pub fn is_present(&self) -> bool {
        self.removed.is_none()
    }
}

/// 字段的物化状态：类型不同，合并语义不同（见 [`crate::merge`]）。
///
/// 用带 tag 的枚举直接序列化，磁盘上一眼能看出这个字段是什么类型，
/// 也便于以后加新类型时旧版本「不认识就报错」而不是静默按错误语义合并。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FieldState {
    /// 单值字段：最后写入者胜出（按 HLC 全序）
    Value { value: Value, hlc: Hlc, origin: Stamp },
    /// MV-Register：并发写入的值全部保留，等人工 / 业务规则裁决
    Multi { values: Vec<StampedValue> },
    /// 不可变字段：只在创建时写入一次（如 book_id、created_at）
    Frozen { value: Value, hlc: Hlc, origin: Stamp },
    /// PN-Counter：可加可减、并发增量自动相加
    Counter {
        total: i64,
        parts: BTreeMap<DeviceId, i64>,
        /// 最近一次「整体赋值」（Create / Set）的时间；增量不加时间戳
        #[serde(default = "Hlc::default")]
        hlc: Hlc,
    },
    /// OR-Set：集合元素的增删
    Set { elements: BTreeMap<String, SetElement> },
    /// 有序列表
    List { items: BTreeMap<String, ListItem> },
}

impl FieldState {
    /// 字段当前值的 JSON 形态（多值字段返回数组；集合返回数组；列表按位置排序返回数组）。
    pub fn display_value(&self, policy: SetPolicy) -> Value {
        match self {
            FieldState::Value { value, .. } | FieldState::Frozen { value, .. } => value.clone(),
            FieldState::Multi { values } => {
                Value::Array(values.iter().map(|v| v.value.clone()).collect())
            }
            FieldState::Counter { total, .. } => Value::from(*total),
            FieldState::Set { elements } => Value::Array(
                elements
                    .iter()
                    .filter(|(_, e)| e.is_present(policy))
                    .map(|(key, _)| Value::String(key.clone()))
                    .collect(),
            ),
            FieldState::List { items } => {
                let mut live: Vec<&ListItem> = items.values().filter(|i| i.is_present()).collect();
                live.sort_by(|a, b| a.position.cmp(&b.position));
                Value::Array(live.into_iter().map(|i| i.value.clone()).collect())
            }
        }
    }

    /// 该字段是否为「有值」状态（未清空的单值字段才算有值）。
    pub fn is_resolved(&self) -> bool {
        match self {
            FieldState::Multi { values } => values.len() <= 1,
            _ => true,
        }
    }
}

/// 实体墓碑：删除不是物理删除，而是一次「删除操作」的记录。
///
/// 直接删掉记录会让「删除」与「并发更新」无法比较（场景 5），
/// 也会让离线设备同步时把已删记录当新记录加回来（场景 29 全量同步）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tombstone {
    pub hlc: Hlc,
    pub origin: Stamp,
    /// 删除者写入时看到的实体版本（并发判定用）
    pub base: VersionVector,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// 级联删除：由哪个父实体触发（展示用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cascade_from: Option<EntityId>,
}

/// 实体：由操作重放出来的当前状态。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entity {
    pub id: EntityId,
    /// 业务类型（book / reading_progress / bookmark / …），决定字段合并策略
    pub kind: String,
    pub fields: BTreeMap<String, FieldState>,
    /// 已并入本实体的操作（origin → 最大序号）
    pub version: VersionVector,
    /// 创建时间（第一条 op 的 HLC）
    pub created: Hlc,
    /// 最近一次变更时间
    pub updated: Hlc,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<Tombstone>,
    /// 待裁决的字段（并发多值 / 唯一键冲突等）
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub conflicted: BTreeSet<String>,
    /// 该实体使用的 schema 版本（写入时的；用于识别旧客户端不认识的字段语义）
    #[serde(default)]
    pub schema_ver: u32,
}

impl Entity {
    /// 新建一个空实体（由 [`crate::merge`] 在收到第一条操作时调用）。
    pub fn new(id: impl Into<EntityId>, kind: impl Into<String>, created: Hlc, schema_ver: u32) -> Entity {
        Entity {
            id: id.into(),
            kind: kind.into(),
            fields: BTreeMap::new(),
            version: VersionVector::new(),
            updated: created.clone(),
            created,
            deleted: None,
            conflicted: BTreeSet::new(),
            schema_ver,
        }
    }

    pub fn is_deleted(&self) -> bool {
        self.deleted.is_some()
    }

    /// 字段的当前值（JSON 形态）。
    pub fn field(&self, field: &str) -> Option<Value> {
        self.fields.get(field).map(|f| f.display_value(SetPolicy::AddWins))
    }
}

/// 冲突原因（决定「怎么裁决」以及界面上怎么解释）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictReason {
    /// 并发改了同一字段的不同值（LWW 已选边，败方保留在记录里）
    ConcurrentWrite,
    /// MV-Register 字段并存多个值，无人能自动裁决
    MultiValue,
    /// 不可变字段被并发改写
    FrozenWrite,
    /// 一方删除、一方更新（按 schema 的删除策略处理，败方进队列）
    DeleteVsUpdate,
    /// 唯一键被两条记录同时占用
    UniqueKey,
    /// 列表元素被并发移动到不同位置
    ListMove,
    /// 并发新增了同一业务唯一键 / 同一 id
    DuplicateEntity,
    /// 级联删除被阻止（子记录仍在）
    CascadeBlocked,
}

/// 冲突的一方（本地值 / 远端值）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConflictSide {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    pub hlc: Hlc,
    pub origin: Stamp,
}

impl ConflictSide {
    pub fn new(value: Option<Value>, hlc: Hlc, origin: Stamp) -> ConflictSide {
        ConflictSide { value, hlc, origin }
    }
}

/// 冲突的处理状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictStatus {
    /// 待处理
    Pending,
    /// 已按「保留本地」解决
    KeptLocal,
    /// 已按「保留远端」解决
    KeptRemote,
    /// 已手工指定值
    Resolved,
    /// 用户明确忽略（数据仍在冲突记录里）
    Dismissed,
}

impl ConflictStatus {
    pub fn is_pending(self) -> bool {
        matches!(self, ConflictStatus::Pending)
    }
}

/// 冲突记录：**不静默丢数据**的兜底。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Conflict {
    pub id: String,
    pub entity_id: EntityId,
    pub kind: String,
    /// 冲突字段（实体级冲突为空串）
    pub field: String,
    pub reason: ConflictReason,
    pub local: ConflictSide,
    pub remote: ConflictSide,
    pub status: ConflictStatus,
    pub detected_at_ms: u64,
    /// 检测到冲突的对端设备（本地自身冲突为空）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_device: Option<DeviceId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// 裁决时写入的新操作 id（解决冲突 = 记一条新 op，让裁决结果也能同步出去）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_by_op: Option<OpId>,
}

/// 冲突的解决方式。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "choice", rename_all = "snake_case")]
pub enum Resolution {
    /// 保留本地值（写一条本地 op 把值钉住）
    KeepLocal,
    /// 采用冲突记录里远端那一方的值
    KeepRemote,
    /// 手工指定值
    Value { value: Value },
    /// 忽略（只改状态，不再改动数据）
    Dismiss,
}

/// 一次修改的意图（op 的载荷）。
///
/// 注意 `Increment` / `Add` / `Remove` 记的是**增量与意图**，不是最终值：
/// 计数器必须能相加、集合必须能表达「加过又删过」，只同步最终值这些语义就丢了。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpKind {
    /// 创建实体并写入若干字段（首次出现该实体时用）
    Create { fields: BTreeMap<String, Value> },
    /// 写一个字段的值（按字段策略：LWW / MV / Frozen）
    Set { value: Value },
    /// 清空字段（等价于写 null 的语义化写法）
    Unset,
    /// 计数器增量
    Increment { delta: i64 },
    /// 集合 / 列表加入元素（列表用 `position` 指定位置键）
    Add { element: String, position: Option<String> },
    /// 集合 / 列表移除元素
    Remove { element: String },
    /// 列表元素移动到新位置键
    Move { element: String, position: String },
    /// 删除实体（写墓碑）
    DeleteEntity { reason: Option<String> },
    /// 取消墓碑（显式恢复，例如「从回收站还原」）
    RestoreEntity,
}

impl OpKind {
    /// 是否是实体级操作（不针对具体字段）。
    pub fn is_entity_level(&self) -> bool {
        matches!(self, OpKind::DeleteEntity { .. } | OpKind::RestoreEntity)
    }

    /// 简短标签（日志 / CLI 展示）。
    pub fn label(&self) -> &'static str {
        match self {
            OpKind::Create { .. } => "create",
            OpKind::Set { .. } => "set",
            OpKind::Unset => "unset",
            OpKind::Increment { .. } => "increment",
            OpKind::Add { .. } => "add",
            OpKind::Remove { .. } => "remove",
            OpKind::Move { .. } => "move",
            OpKind::DeleteEntity { .. } => "delete",
            OpKind::RestoreEntity => "restore",
        }
    }
}

/// 一条操作：op log 的基本单位，也是同步的传输单位。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Operation {
    /// 全局唯一操作 id（幂等去重的依据，见 [`crate::engine`]）
    pub op_id: OpId,
    /// 产生该操作的设备（中继传播时保持原值，这样版本向量才有意义）
    pub origin: DeviceId,
    /// 该设备内的单调序号（从 1 开始）
    pub seq: u64,
    /// 混合逻辑时钟（排序 / LWW 裁决）
    pub hlc: Hlc,
    pub entity_id: EntityId,
    /// 实体类型（收到未见过的实体时据此选合并策略）
    pub kind: String,
    /// 目标字段（实体级操作为空串）
    #[serde(default)]
    pub field: String,
    pub op: OpKind,
    /// 作者写入时看到的实体版本：与自己当前版本比较即可判断是否并发
    pub base: VersionVector,
    /// 作者写入时该实体类型的 schema 版本
    #[serde(default)]
    pub schema_ver: u32,
    /// 作者本地墙钟（只用于展示诊断，不参与裁决——裁决只看 hlc）
    #[serde(default)]
    pub at_ms: u64,
}

impl Operation {
    /// 该操作的来源标记。
    pub fn stamp(&self) -> Stamp {
        Stamp::new(self.origin.clone(), self.seq)
    }

    /// 作者写入时的实体版本 + 这条操作自身（用于写入实体版本向量）。
    pub fn resulting_version(&self) -> VersionVector {
        let mut v = self.base.clone();
        v.observe(&self.origin, self.seq);
        v
    }

    /// 人类可读的一行（日志、CLI `ops` 输出）。
    pub fn summary(&self) -> String {
        format!(
            "{} {} {} {}.{} {}",
            self.op_id,
            crate::version::short_device(&self.origin),
            self.seq,
            self.kind,
            if self.field.is_empty() { "-" } else { &self.field },
            self.op.label()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hlc(ms: u64, counter: u32, device: &str) -> Hlc {
        Hlc::new(ms, counter, device)
    }

    #[test]
    fn stamp_tag_roundtrip() {
        let stamp = Stamp::new("01ABC", 7);
        assert_eq!(stamp.tag(), "01ABC:7");
        assert_eq!(Stamp::from_tag("01ABC:7"), Some(stamp));
        assert_eq!(Stamp::from_tag("nonsense"), None);
        // 设备 id 里不含冒号，rsplit 仍能兜住异常输入
        assert_eq!(Stamp::from_tag("a:b:3"), Some(Stamp::new("a:b", 3)));
    }

    #[test]
    fn set_element_add_wins() {
        let mut e = SetElement::default();
        e.adds.insert(
            "A:1".to_string(),
            AddTag { hlc: hlc(10, 0, "A"), base: VersionVector::new() },
        );
        assert!(e.is_present(SetPolicy::AddWins));
        // 删除水位盖过 A:1（= 删除者见过这次加入）
        e.removals = VersionVector::from_pairs([("A", 1)]);
        assert!(!e.is_present(SetPolicy::AddWins));
        // 并发加入（删除的水位没盖到 B:1）→ 元素仍在（add-wins）
        e.adds.insert(
            "B:1".to_string(),
            AddTag { hlc: hlc(11, 0, "B"), base: VersionVector::new() },
        );
        assert!(e.is_present(SetPolicy::AddWins));
        // remove-wins：B:1 没有见过删除 → 元素不在
        assert!(!e.is_present(SetPolicy::RemoveWins));
        // 见过删除后再加（基线覆盖删除水位）→ 重新添加生效
        e.adds.insert(
            "B:2".to_string(),
            AddTag { hlc: hlc(12, 0, "B"), base: VersionVector::from_pairs([("A", 1), ("B", 1)]) },
        );
        assert!(e.is_present(SetPolicy::RemoveWins));
    }

    #[test]
    fn set_element_judgement_is_order_independent() {
        // 「删除先到、加入后到」与「加入先到、删除后到」必须同判
        let add = AddTag { hlc: hlc(10, 0, "A"), base: VersionVector::new() };
        let removal_watermark = VersionVector::from_pairs([("A", 1), ("B", 4)]);

        let mut late_add =
            SetElement { removals: removal_watermark.clone(), ..SetElement::default() };
        late_add.adds.insert("A:1".to_string(), add.clone());
        assert!(!late_add.is_present(SetPolicy::AddWins));

        let mut early_add = SetElement::default();
        early_add.adds.insert("A:1".to_string(), add);
        early_add.removals = removal_watermark;

        assert!(!early_add.is_present(SetPolicy::AddWins));
    }

    #[test]
    fn display_value_shapes() {
        let value = FieldState::Value {
            value: Value::String("张三".into()),
            hlc: hlc(1, 0, "A"),
            origin: Stamp::new("A", 1),
        };
        assert_eq!(value.display_value(SetPolicy::AddWins), Value::String("张三".into()));

        let counter = FieldState::Counter { total: 5, parts: BTreeMap::new(), hlc: hlc(1, 0, "A") };
        assert_eq!(counter.display_value(SetPolicy::AddWins), Value::from(5));

        let mut set = FieldState::Set { elements: BTreeMap::new() };
        if let FieldState::Set { elements } = &mut set {
            let mut e = SetElement::default();
            e.adds.insert("A:1".into(), AddTag { hlc: hlc(1, 0, "A"), base: VersionVector::new() });
            elements.insert("tag-x".into(), e);
        }
        assert_eq!(set.display_value(SetPolicy::AddWins), serde_json::json!(["tag-x"]));

        let list = FieldState::List {
            items: BTreeMap::from([
                (
                    "b".to_string(),
                    ListItem {
                        position: "2".into(),
                        value: Value::String("b".into()),
                        hlc: hlc(1, 0, "A"),
                        origin: Stamp::new("A", 1),
                        removed: None,
                    },
                ),
                (
                    "a".to_string(),
                    ListItem {
                        position: "1".into(),
                        value: Value::String("a".into()),
                        hlc: hlc(1, 0, "A"),
                        origin: Stamp::new("A", 2),
                        removed: None,
                    },
                ),
            ]),
        };
        assert_eq!(list.display_value(SetPolicy::AddWins), serde_json::json!(["a", "b"]));
    }

    #[test]
    fn operation_json_roundtrip() {
        let op = Operation {
            op_id: "op-1".into(),
            origin: "A".into(),
            seq: 3,
            hlc: hlc(100, 1, "A"),
            entity_id: "book-1".into(),
            kind: "book".into(),
            field: "title".into(),
            op: OpKind::Set { value: Value::String("三体".into()) },
            base: VersionVector::from_pairs([("A", 2)]),
            schema_ver: 1,
            at_ms: 100,
        };
        let json = serde_json::to_string(&op).unwrap();
        let back: Operation = serde_json::from_str(&json).unwrap();
        assert_eq!(op, back);
        assert_eq!(op.stamp(), Stamp::new("A", 3));
        assert_eq!(op.resulting_version().get("A"), 3);
    }

    #[test]
    fn entity_new_starts_empty() {
        let e = Entity::new("x", "book", hlc(1, 0, "A"), 1);
        assert!(!e.is_deleted());
        assert!(e.field("title").is_none());
    }
}

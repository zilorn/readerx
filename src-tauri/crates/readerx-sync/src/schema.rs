//! Schema：每种实体类型的「字段用哪种合并策略 + 删除语义 + 约束」。
//!
//! 同一个同步引擎要同时服务几种完全不同的数据：书架的标签是集合、阅读进度是
//! 「最后读到的位置」、书籍元信息是普通字段、书源配置是多人可改的 JSON。
//! 它们的冲突语义不一样，所以策略**按实体类型声明**，引擎不去猜。
//!
//! 未声明的字段一律按 [`MergeKind::Lww`] 处理（宁可 LWW + 冲突队列，
//! 也不要因为「没声明」而拒绝同步：老客户端写的新字段同样要能落库，见场景 17）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::model::SetPolicy;

/// 字段的合并策略。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MergeKind {
    /// 单值：按 HLC 最后写入者胜出；并发且值不同时记一条冲突
    Lww,
    /// 单值：按 HLC 最后写入者胜出，**并发时不记冲突**。
    ///
    /// 用于「位置」这类数据：阅读进度、播放位置、最后打开的章节。两台设备各读到
    /// 不同位置时，落后的一方只是**过时的位置**，不是需要人裁决的内容——进冲突队列
    /// 只会让用户面对一堆「保留哪个进度」的无意义选择，而真正的数据冲突被淹没。
    /// 取舍是明确的：这里放弃了「败方留档」，代价可接受（位置本身没有信息量），
    /// 因此只给这类字段用，不要拿它当「省事的 LWW」。
    LwwSilent,
    /// 多值：并发值全部保留，进入冲突队列等裁决
    MultiValue,
    /// 不可变：只有创建时能写（改动会被记为冲突并保留原值）
    Frozen,
    /// PN-Counter：并发增量相加
    Counter,
    /// 集合：OR-Set
    Set { policy: SetPolicy },
    /// 有序列表：元素带分数索引位置键
    List,
}

impl MergeKind {
    pub fn lww() -> MergeKind {
        MergeKind::Lww
    }

    /// 静默 LWW（并发不记冲突，见 [`MergeKind::LwwSilent`]）。
    pub fn lww_silent() -> MergeKind {
        MergeKind::LwwSilent
    }

    /// 是否为「单值 LWW」家族（含静默变体）：值语义相同，只差要不要记冲突。
    pub fn is_lww(&self) -> bool {
        matches!(self, MergeKind::Lww | MergeKind::LwwSilent)
    }

    pub fn set() -> MergeKind {
        MergeKind::Set { policy: SetPolicy::AddWins }
    }

    /// 集合策略（非集合字段返回 `None`）。
    pub fn set_policy(&self) -> Option<SetPolicy> {
        match self {
            MergeKind::Set { policy } => Some(*policy),
            _ => None,
        }
    }
}

/// 删除与更新的裁决策略。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeletePolicy {
    /// 删除优先（并发更新进冲突队列）——默认
    DeleteWins,
    /// 更新优先：并发更新把记录「救回来」，删除进冲突队列
    UpdateWins,
    /// 删除照落（保证各副本一致），冲突挂起等人工决定是否恢复
    Manual,
}

/// 父实体被删除时，子实体的处理方式。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CascadeAction {
    /// 一起删除（订单删除 → 明细删除）
    Cascade,
    /// 阻止删除（子记录还在就删不掉，记一条冲突）
    Block,
    /// 留下子记录但清空指向父实体的字段（孤儿修复）
    Orphan,
}

/// 级联规则：`child_kind` 里引用 `parent_field` 的记录如何处理。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CascadeRule {
    pub child_kind: String,
    pub parent_field: String,
    pub on_delete: CascadeAction,
}

impl CascadeRule {
    pub fn cascade(child_kind: impl Into<String>, parent_field: impl Into<String>) -> CascadeRule {
        CascadeRule {
            child_kind: child_kind.into(),
            parent_field: parent_field.into(),
            on_delete: CascadeAction::Cascade,
        }
    }

    pub fn block(child_kind: impl Into<String>, parent_field: impl Into<String>) -> CascadeRule {
        CascadeRule { on_delete: CascadeAction::Block, ..CascadeRule::cascade(child_kind, parent_field) }
    }

    pub fn orphan(child_kind: impl Into<String>, parent_field: impl Into<String>) -> CascadeRule {
        CascadeRule { on_delete: CascadeAction::Orphan, ..CascadeRule::cascade(child_kind, parent_field) }
    }
}

/// 一种实体类型的同步语义。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Schema {
    pub kind: String,
    /// schema 版本：op 里带上写入时的版本，用于识别「旧客户端不认识新字段」
    #[serde(default = "default_version")]
    pub version: u32,
    /// 字段名 → 合并策略
    #[serde(default)]
    pub fields: BTreeMap<String, MergeKind>,
    /// 未声明字段的兜底策略
    #[serde(default = "MergeKind::lww")]
    pub default_kind: MergeKind,
    /// 业务唯一键（并发占用同一值时进冲突队列，见场景 8）
    #[serde(default)]
    pub unique_fields: Vec<String>,
    /// 删除 vs 更新的裁决
    #[serde(default = "default_delete_policy")]
    pub delete_policy: DeletePolicy,
    /// 墓碑之上是否允许「写即复活」：直接 Set 一个已删除实体时是否视为恢复
    #[serde(default)]
    pub resurrect_on_write: bool,
    /// 父实体删除时对子实体的处理
    #[serde(default)]
    pub cascade: Vec<CascadeRule>,
    /// 删除时是否保留正文之外的大字段（如封面 / 文件路径），仅作语义提示
    #[serde(default)]
    pub note: Option<String>,
}

fn default_version() -> u32 {
    1
}

fn default_delete_policy() -> DeletePolicy {
    DeletePolicy::DeleteWins
}

impl Schema {
    /// 新建一个 schema（未声明字段走 LWW）。
    pub fn new(kind: impl Into<String>) -> Schema {
        Schema {
            kind: kind.into(),
            version: 1,
            fields: BTreeMap::new(),
            default_kind: MergeKind::Lww,
            unique_fields: Vec::new(),
            delete_policy: DeletePolicy::DeleteWins,
            resurrect_on_write: false,
            cascade: Vec::new(),
            note: None,
        }
    }

    /// 声明字段策略（链式书写）。
    pub fn field(mut self, name: &str, kind: MergeKind) -> Schema {
        self.fields.insert(name.to_string(), kind);
        self
    }

    /// 声明唯一键。
    pub fn unique(mut self, name: &str) -> Schema {
        self.unique_fields.push(name.to_string());
        self
    }

    /// 声明删除策略。
    pub fn delete_policy(mut self, policy: DeletePolicy) -> Schema {
        self.delete_policy = policy;
        self
    }

    /// 允许「写即复活」。
    pub fn resurrect_on_write(mut self) -> Schema {
        self.resurrect_on_write = true;
        self
    }

    /// 追加一条级联规则。
    pub fn cascade(mut self, rule: CascadeRule) -> Schema {
        self.cascade.push(rule);
        self
    }

    /// 某字段的合并策略（未声明则用兜底策略）。
    pub fn field_kind(&self, field: &str) -> MergeKind {
        self.fields.get(field).copied().unwrap_or(self.default_kind)
    }

    /// 该字段当前是否处于「已删除」的语义范围（删除时忽略正文类字段）。
    pub fn is_immutable(&self, field: &str) -> bool {
        matches!(self.field_kind(field), MergeKind::Frozen)
    }
}

/// schema 注册表：按实体类型查策略，未知类型走通用兜底。
#[derive(Clone, Debug, Default)]
pub struct SchemaRegistry {
    schemas: BTreeMap<String, Schema>,
    /// 未注册类型的兜底 schema
    fallback: Option<Schema>,
}

impl SchemaRegistry {
    pub fn new() -> SchemaRegistry {
        SchemaRegistry { schemas: BTreeMap::new(), fallback: None }
    }

    /// 注册（覆盖同名）一个 schema。
    pub fn register(&mut self, schema: Schema) -> &mut Self {
        self.schemas.insert(schema.kind.clone(), schema);
        self
    }

    /// 设置未知类型的兜底 schema（`kind` 字段会被忽略）。
    pub fn set_fallback(&mut self, schema: Schema) -> &mut Self {
        self.fallback = Some(schema);
        self
    }

    /// 查询某类型的 schema；未注册时返回兜底（再没有就是纯 LWW + 删除优先）。
    pub fn get(&self, kind: &str) -> Schema {
        if let Some(schema) = self.schemas.get(kind) {
            return schema.clone();
        }
        let mut fallback = self.fallback.clone().unwrap_or_else(|| Schema::new(kind));
        fallback.kind = kind.to_string();
        fallback
    }

    /// 是否显式注册过该类型。
    pub fn contains(&self, kind: &str) -> bool {
        self.schemas.contains_key(kind)
    }

    /// 已注册的类型。
    pub fn kinds(&self) -> Vec<&str> {
        self.schemas.keys().map(|k| k.as_str()).collect()
    }

    /// ReaderX 的默认同步语义。
    ///
    /// 这些类型对应 App 现有的本地数据（书架元信息 / 阅读进度 / 书签 / 分组 /
    /// 书源），字段名与 App 桥接层（`src-tauri/src/sync/bridge.rs`）写入的一致。
    /// 改这里的字段名或策略时，桥接层要一起改（`tests/sync_bridge.rs` 会挡住不一致）。
    pub fn readerx_defaults() -> SchemaRegistry {
        let mut registry = SchemaRegistry::new();

        // 书籍元信息：普通字段 LWW；标签是集合；文件本身（正文 / 封面）不同步，
        // 只同步「哪本书、元信息是什么」，避免局域网里搬几百兆文件。
        // 删书连带删掉它的进度与书签：留着只会变成指不到书的孤儿记录。
        registry.register(
            Schema::new("book")
                .field("title", MergeKind::Lww)
                .field("author", MergeKind::Lww)
                .field("intro", MergeKind::Lww)
                .field("cover", MergeKind::Lww)
                .field("tags", MergeKind::set())
                .field("group", MergeKind::Lww)
                .field("format", MergeKind::Frozen)
                .field("file_name", MergeKind::Frozen)
                .cascade(CascadeRule::cascade("reading_progress", "book_id"))
                .cascade(CascadeRule::cascade("bookmark", "book_id"))
                // 只对某本书生效的文本替换规则跟随书一起删（全局规则没有 book_id，不受影响）
                .cascade(CascadeRule::cascade("text_replace", "book_id")),
        );

        // 阅读进度（App 的精确进度：章节序号 + 章节 cid + 章内字符偏移 + 上下文快照）。
        // 这里用**静默 LWW**：两台设备各读到不同位置时，落后的一方只是过时的位置，
        // 不该变成一条要人裁决的冲突（否则第一次同步就会堆一屏「保留哪个进度」）。
        registry.register(
            Schema::new("reading_progress")
                .field("book_id", MergeKind::Frozen)
                .field("chapter", MergeKind::LwwSilent)
                .field("chapter_cid", MergeKind::LwwSilent)
                .field("char_offset", MergeKind::LwwSilent)
                .field("context", MergeKind::LwwSilent)
                .field("updated_at", MergeKind::LwwSilent),
        );

        // 书签：一条书签一旦存在就是「用户标记」，正文位置不可变；
        // 备注可以改（并发改备注走 LWW，败方进冲突队列）
        registry.register(
            Schema::new("bookmark")
                .field("book_id", MergeKind::Frozen)
                .field("chapter_index", MergeKind::Frozen)
                .field("offset", MergeKind::Frozen)
                .field("text", MergeKind::Frozen)
                .field("note", MergeKind::Lww),
        );

        // 分组：名字 LWW，组内顺序用列表
        registry.register(
            Schema::new("group")
                .field("name", MergeKind::Lww)
                .field("order", MergeKind::List),
        );

        // 书架顺序：一个单例实体上的有序列表（元素 = 书籍 id）
        registry.register(Schema::new("shelf").field("order", MergeKind::List));

        // 设置项：key 唯一，值默认 LWW；某些项（如自定义 CSS）按多值保留
        registry.register(
            Schema::new("setting")
                .unique("key")
                .field("key", MergeKind::Frozen)
                .field("value", MergeKind::Lww),
        );

        // 文本替换规则（App 的「阅读时显示级替换」）：实体 id 由规则内容派生
        // （作用域 + 书 + 查找 + 替换 + 是否正则），因此字段本身不可变 ——
        // 改一条规则等于删掉旧实体、新建一条，两台设备各自编辑也不会写出半新半旧的值。
        // `book_id` 是**书实体 id**（uid），与进度 / 书签同一口径；书被删时规则一起删。
        registry.register(
            Schema::new("text_replace")
                .field("scope", MergeKind::Frozen)
                .field("book_id", MergeKind::Frozen)
                .field("find", MergeKind::Frozen)
                .field("replace", MergeKind::Frozen)
                .field("regex", MergeKind::Frozen)
                .field("created_at", MergeKind::LwwSilent),
        );

        // 分章规则（用户自定义的章节标题正则）：名称 + 正则即身份。
        // 与文本替换同理：规则内容就是它的身份，字段不可变。
        registry.register(
            Schema::new("chapter_rule")
                .field("name", MergeKind::Frozen)
                .field("pattern", MergeKind::Frozen)
                .field("created_at", MergeKind::LwwSilent),
        );

        // 书源：整份 JSON 都可能被两边同时改，保留多值让人选。
        // 不声明唯一键：实体 id 由书源地址派生（换设备也认得同一份源），
        // 而「同名不同源」在现实里很常见，拿名字当唯一键会把合法的第二份源拒之门外。
        registry.register(
            Schema::new("book_source")
                .field("name", MergeKind::Lww)
                .field("url", MergeKind::Frozen)
                .field("json", MergeKind::MultiValue),
        );

        // 账号 / 登录态这类凭据不进同步（见 docs/sync.md 的「不做什么」），
        // 因此这里不注册 source_session。
        registry
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_kind_falls_back_to_lww() {
        let registry = SchemaRegistry::new();
        let schema = registry.get("whatever");
        assert_eq!(schema.kind, "whatever");
        assert_eq!(schema.field_kind("title"), MergeKind::Lww);
        assert_eq!(schema.delete_policy, DeletePolicy::DeleteWins);
    }

    #[test]
    fn declared_fields_win_over_fallback() {
        let mut registry = SchemaRegistry::new();
        registry.register(Schema::new("book").field("tags", MergeKind::set()).unique("title"));
        let schema = registry.get("book");
        assert_eq!(schema.field_kind("tags"), MergeKind::set());
        assert_eq!(schema.field_kind("title"), MergeKind::Lww);
        assert_eq!(schema.unique_fields, vec!["title".to_string()]);
        assert!(registry.contains("book"));
        assert_eq!(registry.kinds(), vec!["book"]);
    }

    #[test]
    fn readerx_defaults_cover_app_types() {
        let registry = SchemaRegistry::readerx_defaults();
        for kind in [
            "book",
            "reading_progress",
            "bookmark",
            "group",
            "shelf",
            "setting",
            "book_source",
            "text_replace",
            "chapter_rule",
        ] {
            assert!(registry.contains(kind), "{kind} 应有默认 schema");
        }
        let book = registry.get("book");
        assert_eq!(book.field_kind("tags").set_policy(), Some(SetPolicy::AddWins));
        // 只对某本书生效的替换规则要跟着书一起删（否则会留下指不到书的孤儿规则）
        assert!(
            book.cascade
                .iter()
                .any(|rule| rule.child_kind == "text_replace" && rule.on_delete == CascadeAction::Cascade),
            "书籍删除应级联删除该书的文本替换规则"
        );
        // 规则类数据：实体 id 由内容派生，字段一律不可变（改规则 = 删旧建新）
        assert_eq!(
            registry.get("text_replace").field_kind("replace"),
            MergeKind::Frozen
        );
        assert_eq!(
            registry.get("chapter_rule").field_kind("pattern"),
            MergeKind::Frozen
        );
        let source = registry.get("book_source");
        assert_eq!(source.field_kind("json"), MergeKind::MultiValue);
        assert!(source.unique_fields.is_empty(), "书源不按名字做唯一键");
        // 位置类字段一律静默 LWW：并发读到不同位置不是「数据冲突」
        assert_eq!(
            registry.get("reading_progress").field_kind("char_offset"),
            MergeKind::LwwSilent
        );
        assert_eq!(
            registry.get("reading_progress").field_kind("updated_at"),
            MergeKind::LwwSilent
        );
        assert_eq!(registry.get("shelf").field_kind("order"), MergeKind::List);
    }

    #[test]
    fn cascade_builders() {
        let rule = CascadeRule::block("bookmark", "book_id");
        assert_eq!(rule.on_delete, CascadeAction::Block);
        let rule = CascadeRule::orphan("book", "group_id");
        assert_eq!(rule.on_delete, CascadeAction::Orphan);
        let rule = CascadeRule::cascade("chapter_run", "book_id");
        assert_eq!(rule.on_delete, CascadeAction::Cascade);
    }

    #[test]
    fn schema_json_roundtrip() {
        let schema = Schema::new("book").field("tags", MergeKind::set()).unique("title");
        let json = serde_json::to_string(&schema).unwrap();
        let back: Schema = serde_json::from_str(&json).unwrap();
        assert_eq!(schema, back);
    }
}

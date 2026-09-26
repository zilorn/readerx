//! 版本向量：判断两次更新是否**并发**。
//!
//! 每个设备给「自己产生的操作」编号（`origin → 该设备已产生的最大序号`），
//! 一个版本向量因此描述了「我见过哪些操作」。两个向量的关系有四种：
//!
//! - `Equal`：见过的东西完全一样；
//! - `Before` / `After`：一方是另一方的祖先（**不并发**，后者覆盖前者是安全的）；
//! - `Concurrent`：双方各有对方没见过的操作 ← **只有这种情况才需要冲突处理**。
//!
//! 这份判断是整个同步框架的地基：字段级合并、墓碑裁决、唯一键仲裁都先看它。
//! 它同时也是**增量同步的游标**——「你有哪些我没有」直接由两个向量相减得到，
//! 不需要额外的「已发送」表（见 [`crate::session`]）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::id::DeviceId;

/// 两个版本向量的因果关系。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Relation {
    Equal,
    /// self 是 other 的祖先（self 见过的东西 other 都见过）
    Before,
    /// self 是 other 的后代
    After,
    /// 并发：互有未见
    Concurrent,
}

impl Relation {
    /// 是否并发（唯一需要冲突处理的情形）。
    pub fn is_concurrent(self) -> bool {
        matches!(self, Relation::Concurrent)
    }

    /// self 是否不早于 other（`Equal` 或 `After`）。
    pub fn is_current_or_newer(self) -> bool {
        matches!(self, Relation::Equal | Relation::After)
    }
}

/// 版本向量：`设备 id → 该设备已产生并被本副本见过的最大序号`。
///
/// 用 `BTreeMap` 而不是 `HashMap`：序列化结果稳定（便于比对文件差异、写测试断言），
/// 遍历顺序也确定（差集计算不会因为哈希顺序而变）。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct VersionVector(BTreeMap<DeviceId, u64>);

impl VersionVector {
    /// 空向量（什么都没见过）。
    pub fn new() -> VersionVector {
        VersionVector(BTreeMap::new())
    }

    /// 由 `(设备, 序号)` 列表构造（后面的重复项取最大）。
    pub fn from_pairs<I, S>(pairs: I) -> VersionVector
    where
        I: IntoIterator<Item = (S, u64)>,
        S: Into<String>,
    {
        let mut v = VersionVector::new();
        for (device, seq) in pairs {
            v.observe(&device.into(), seq);
        }
        v
    }

    pub fn is_empty(&self) -> bool {
        self.0.values().all(|seq| *seq == 0)
    }

    /// 某设备已被见到的最大序号（未见过的设备为 0）。
    pub fn get(&self, device: &str) -> u64 {
        self.0.get(device).copied().unwrap_or(0)
    }

    /// 是否见过 `(device, seq)` 这条操作。
    pub fn contains(&self, device: &str, seq: u64) -> bool {
        self.get(device) >= seq
    }

    /// 记下「见过来自 `device` 的第 `seq` 条操作」，返回是否推进了进度。
    ///
    /// 乱序到达（先看到 seq=5 再看到 seq=3）不会回退：向量只存最大值。
    pub fn observe(&mut self, device: &str, seq: u64) -> bool {
        let entry = self.0.entry(device.to_string()).or_insert(0);
        if seq > *entry {
            *entry = seq;
            true
        } else {
            false
        }
    }

    /// 取并集（合并两个副本的见识）。
    pub fn merge(&mut self, other: &VersionVector) {
        for (device, seq) in other.iter() {
            self.observe(device, *seq);
        }
    }

    /// 合并后的新向量。
    pub fn joined(&self, other: &VersionVector) -> VersionVector {
        let mut v = self.clone();
        v.merge(other);
        v
    }

    /// 与另一向量的因果关系。
    pub fn relation(&self, other: &VersionVector) -> Relation {
        let mut self_ahead = false;
        let mut other_ahead = false;
        for (device, seq) in self.iter() {
            match other.get(device).cmp(seq) {
                std::cmp::Ordering::Less => self_ahead = true,
                std::cmp::Ordering::Greater => other_ahead = true,
                std::cmp::Ordering::Equal => {}
            }
            if self_ahead && other_ahead {
                return Relation::Concurrent;
            }
        }
        // self 里没有的设备：可能 other 独有
        for (device, seq) in other.iter() {
            if *seq > self.get(device) {
                other_ahead = true;
                break;
            }
        }
        match (self_ahead, other_ahead) {
            (false, false) => Relation::Equal,
            (true, false) => Relation::After,
            (false, true) => Relation::Before,
            (true, true) => Relation::Concurrent,
        }
    }

    /// 是否并发（便捷方法）。
    pub fn concurrent_with(&self, other: &VersionVector) -> bool {
        self.relation(other).is_concurrent()
    }

    /// 自己是 `other` 的后代或相等（即 `other` 见过的东西自己都见过）。
    pub fn covers(&self, other: &VersionVector) -> bool {
        self.relation(other).is_current_or_newer()
    }

    /// 自己相对 `other` **领先**的部分：`(设备, 起始序号)`，
    /// 表示「该设备从 `起始序号 + 1` 到 `self[设备]` 的操作对方没有」。
    pub fn ahead_of(&self, other: &VersionVector) -> Vec<(DeviceId, u64)> {
        let mut out = Vec::new();
        for (device, seq) in self.iter() {
            let known = other.get(device);
            if *seq > known {
                out.push((device.clone(), known));
            }
        }
        out
    }

    /// 自己**缺少** `other` 的部分（[`VersionVector::ahead_of`] 的反方向）。
    pub fn missing_from(&self, other: &VersionVector) -> Vec<(DeviceId, u64)> {
        other.ahead_of(self)
    }

    /// 所有已知设备（含序号为 0 的）。
    pub fn iter(&self) -> impl Iterator<Item = (&DeviceId, &u64)> {
        self.0.iter()
    }

    /// 已知设备数量。
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// 见过的操作总数（各设备最大序号之和，仅用于展示「规模」）。
    pub fn total(&self) -> u64 {
        self.0.values().sum()
    }

    /// 紧凑的展示形式：`A:3,B:5`（日志与 CLI 输出用，不参与持久化契约）。
    pub fn to_short_string(&self) -> String {
        if self.0.is_empty() {
            return "-".to_string();
        }
        self.0
            .iter()
            .map(|(device, seq)| format!("{}:{}", short_device(device), seq))
            .collect::<Vec<_>>()
            .join(",")
    }
}

/// 设备 id 在日志里的短形式（ULID 只取后 6 位，够区分且不刷屏）。
pub fn short_device(device: &str) -> String {
    if device.len() > 6 {
        device[device.len() - 6..].to_string()
    } else {
        device.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_vectors_are_equal() {
        let a = VersionVector::new();
        let b = VersionVector::new();
        assert_eq!(a.relation(&b), Relation::Equal);
        assert!(!a.concurrent_with(&b));
    }

    #[test]
    fn ancestor_is_before_and_not_concurrent() {
        let a = VersionVector::from_pairs([("A", 3)]);
        let b = VersionVector::from_pairs([("A", 3), ("B", 5)]);
        assert_eq!(a.relation(&b), Relation::Before);
        assert_eq!(b.relation(&a), Relation::After);
        assert!(!a.concurrent_with(&b));
    }

    #[test]
    fn divergent_histories_are_concurrent() {
        // 甲改到 A:3，乙改到 B:2 —— 互有未见（场景 4 的前提）
        let jia = VersionVector::from_pairs([("A", 3), ("B", 2)]);
        let yi = VersionVector::from_pairs([("A", 2), ("B", 3)]);
        assert_eq!(jia.relation(&yi), Relation::Concurrent);
        assert!(jia.concurrent_with(&yi));
    }

    #[test]
    fn equal_different_device_sets() {
        let a = VersionVector::from_pairs([("A", 1), ("B", 0)]);
        let b = VersionVector::from_pairs([("A", 1)]);
        // B:0 等价于「没见过 B 的任何操作」
        assert_eq!(a.relation(&b), Relation::Equal);
    }

    #[test]
    fn observe_never_rewinds() {
        let mut v = VersionVector::new();
        assert!(v.observe("A", 5));
        assert!(!v.observe("A", 3), "乱序到达的旧序号不应回退进度");
        assert_eq!(v.get("A"), 5);
        assert!(v.contains("A", 5));
        assert!(!v.contains("A", 6));
    }

    #[test]
    fn ahead_of_is_the_sync_diff() {
        // 本地有 A:1..3 与 B:1..2，对端只有 A:1
        let local = VersionVector::from_pairs([("A", 3), ("B", 2)]);
        let peer = VersionVector::from_pairs([("A", 1)]);
        let mut diff = local.ahead_of(&peer);
        diff.sort();
        assert_eq!(diff, vec![("A".to_string(), 1), ("B".to_string(), 0)]);
        // 反方向：自己缺对端什么（缺 A:2..3 与 B:1..2）
        let mut missing = peer.missing_from(&local);
        missing.sort();
        assert_eq!(missing, vec![("A".to_string(), 1), ("B".to_string(), 0)]);
    }

    #[test]
    fn merge_is_join() {
        let mut a = VersionVector::from_pairs([("A", 3)]);
        let b = VersionVector::from_pairs([("A", 1), ("B", 7)]);
        a.merge(&b);
        assert_eq!(a.get("A"), 3);
        assert_eq!(a.get("B"), 7);
        assert!(a.covers(&b));
    }

    #[test]
    fn json_roundtrip_is_stable() {
        let v = VersionVector::from_pairs([("B", 2), ("A", 1)]);
        let json = serde_json::to_string(&v).unwrap();
        assert_eq!(json, r#"{"A":1,"B":2}"#);
        let back: VersionVector = serde_json::from_str(&json).unwrap();
        assert_eq!(v, back);
    }

    #[test]
    fn covers_and_total() {
        let v = VersionVector::from_pairs([("A", 2), ("B", 3)]);
        assert!(v.covers(&VersionVector::from_pairs([("A", 2)])));
        assert!(!v.covers(&VersionVector::from_pairs([("A", 3)])));
        assert_eq!(v.total(), 5);
        assert_eq!(v.to_short_string(), format!("{}:2,{}:3", short_device("A"), short_device("B")));
    }
}

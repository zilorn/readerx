//! 混合逻辑时钟（HLC）：`(wall_ms, counter, device)`。
//!
//! 直接用本地墙钟做 LWW 会在两种情况下出错：
//!
//! 1. **设备时钟不准**（手机比桌面快一小时）——晚发生的写判定成更早；
//! 2. **时钟回拨**（NTP 校时、用户改时间）——新写的版本号比旧写还小，更新被丢弃。
//!
//! HLC 把「物理时间」与「逻辑计数」拼在一起：
//!
//! - 本地事件：`wall = max(上次 wall, 物理时间)`；`wall` 前进则 `counter = 0`，
//!   否则 `counter += 1`。物理钟回拨也不会让 `wall` 变小。
//! - 收到远端事件：`wall = max(上次 wall, 远端 wall, 物理时间)`，`counter` 按情况 +1。
//!
//! 于是 HLC 满足：**因果顺序蕴含 HLC 顺序**（a 先于 b ⇒ hlc(a) < hlc(b)），
//! 而比较又是全序（同 `wall`/`counter` 时用 device 打平），可直接当 LWW 的裁决键。
//! 注意反向不成立：HLC 小不等于因果在前——「是否并发」要看版本向量（见 [`crate::version`]）。

use crate::error::{Result, SyncError};
use crate::id::{now_ms, DeviceId};
use serde::{Deserialize, Serialize};

/// 一次事件（一个本地写入 / 一个收到的远端操作）的混合逻辑时间戳。
///
/// 字段顺序即比较顺序：先比物理毫秒，再比计数器，最后用设备 id 打平，
/// 因此任意两个 HLC 都能判大小（LWW 需要的是全序，不是偏序）。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Hlc {
    /// 逻辑墙钟毫秒（只增不减，可能领先真实时间）
    pub wall_ms: u64,
    /// 同一毫秒内的事件序号
    pub counter: u32,
    /// 产生该事件的设备（打平用，保证全序）
    pub device: DeviceId,
}

impl Hlc {
    /// 由三个分量构造。
    pub fn new(wall_ms: u64, counter: u32, device: impl Into<DeviceId>) -> Hlc {
        Hlc { wall_ms, counter, device: device.into() }
    }

    /// 零点（尚未发生任何事件）。
    pub fn zero(device: impl Into<DeviceId>) -> Hlc {
        Hlc::new(0, 0, device)
    }

    /// 该事件是否来自 `device` 自己。
    pub fn is_local(&self, device: &str) -> bool {
        self.device == device
    }
}

impl std::fmt::Display for Hlc {
    /// `{毫秒}-{计数}-{设备}`，只用于日志与冲突展示。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:013}-{:05}-{}", self.wall_ms, self.counter, self.device)
    }
}

/// 本地 HLC 时钟：记住「本设备见过的最大时间」。
///
/// 状态需要持久化（见 [`HlcClock::state`] / [`HlcClock::restore`]）：进程重启后若从 0
/// 重新计数，物理钟回拨过的设备会生成比历史更小的 HLC，导致自己的新写入被判为旧值。
#[derive(Clone, Debug)]
pub struct HlcClock {
    device: DeviceId,
    last: Hlc,
}

impl HlcClock {
    /// 新建（进度为 `(0,0)`；首次 [`HlcClock::now`] 会取物理时间）。
    pub fn new(device: impl Into<DeviceId>) -> HlcClock {
        let device = device.into();
        HlcClock { last: Hlc::zero(device.clone()), device }
    }

    /// 从持久化状态恢复。
    pub fn restore(device: impl Into<DeviceId>, wall_ms: u64, counter: u32) -> HlcClock {
        let device = device.into();
        HlcClock { last: Hlc::new(wall_ms, counter, device.clone()), device }
    }

    /// 本设备 id。
    pub fn device(&self) -> &str {
        &self.device
    }

    /// 当前进度 `(wall_ms, counter)`，用于持久化。
    pub fn state(&self) -> (u64, u32) {
        (self.last.wall_ms, self.last.counter)
    }

    /// 上一次发出的时间戳。
    pub fn last(&self) -> &Hlc {
        &self.last
    }

    /// 产生一个本地事件（用真实物理时间）。
    pub fn now(&mut self) -> Hlc {
        self.now_at(now_ms())
    }

    /// 产生一个本地事件（指定物理时间，测试用）。
    pub fn now_at(&mut self, physical_ms: u64) -> Hlc {
        let wall = self.last.wall_ms.max(physical_ms);
        let counter = if wall == self.last.wall_ms { self.last.counter.saturating_add(1) } else { 0 };
        self.last = Hlc::new(wall, counter, self.device.clone());
        self.last.clone()
    }

    /// 观察到远端事件（收到操作时调用），返回本地推进后的时间戳。
    pub fn observe(&mut self, remote: &Hlc) -> Hlc {
        self.observe_at(remote, now_ms())
    }

    /// 观察到远端事件（指定物理时间，测试用）。
    pub fn observe_at(&mut self, remote: &Hlc, physical_ms: u64) -> Hlc {
        let wall = self.last.wall_ms.max(remote.wall_ms).max(physical_ms);
        let counter = if wall == self.last.wall_ms && wall == remote.wall_ms {
            self.last.counter.max(remote.counter).saturating_add(1)
        } else if wall == self.last.wall_ms {
            self.last.counter.saturating_add(1)
        } else if wall == remote.wall_ms {
            remote.counter.saturating_add(1)
        } else {
            0
        };
        self.last = Hlc::new(wall, counter, self.device.clone());
        self.last.clone()
    }

    /// 校验并推进到至少 `remote`（用于从磁盘恢复时把见过的最大 HLC 吃进来）。
    pub fn advance_to(&mut self, remote: &Hlc) {
        if *remote > self.last {
            self.last = remote.clone();
        }
    }
}

/// HLC 的 JSON 形态（持久化用的紧凑形式）。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HlcState {
    pub wall_ms: u64,
    pub counter: u32,
}

impl HlcState {
    pub fn from_clock(clock: &HlcClock) -> HlcState {
        let (wall_ms, counter) = clock.state();
        HlcState { wall_ms, counter }
    }

    /// 恢复时钟；`device` 与状态文件里的设备 id 必须一致（由调用方保证）。
    pub fn restore(&self, device: impl Into<DeviceId>) -> HlcClock {
        HlcClock::restore(device, self.wall_ms, self.counter)
    }

    pub fn validate(&self) -> Result<()> {
        if self.wall_ms == 0 && self.counter > 0 {
            return Err(SyncError::Json("HLC 状态非法：counter 非零但 wall_ms 为 0".to_string()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_events_are_strictly_increasing() {
        let mut clock = HlcClock::new("A");
        let a = clock.now_at(1_000);
        let b = clock.now_at(1_000);
        let c = clock.now_at(1_000);
        assert!(a < b && b < c);
        assert_eq!(a.counter, 0);
        assert_eq!(b.counter, 1);
        assert_eq!(c.counter, 2);
    }

    #[test]
    fn physical_clock_rollback_does_not_go_back() {
        let mut clock = HlcClock::new("A");
        let a = clock.now_at(5_000);
        // 用户改时间 / NTP 回拨
        let b = clock.now_at(1_000);
        assert!(b > a, "回拨后产生的 HLC 仍必须大于此前的事件");
        assert_eq!(b.wall_ms, 5_000);
        assert_eq!(b.counter, 1);
    }

    #[test]
    fn observing_remote_advances_past_it() {
        let mut a = HlcClock::new("A");
        let mut b = HlcClock::new("B");
        let ea = a.now_at(1_000);
        // B 的物理钟快一小时
        let eb = b.now_at(1_000 + 3_600_000);
        let after = a.observe_at(&eb, 1_001);
        assert!(after > eb, "观察远端后本地时间必须严格大于远端");
        assert_eq!(after.wall_ms, eb.wall_ms);
        assert_eq!(after.counter, eb.counter + 1);
        // 之后再产生本地事件仍递增
        let next = a.now_at(1_002);
        assert!(next > after);
        assert!(ea < eb);
    }

    #[test]
    fn observe_with_slow_local_clock_increases_counter() {
        let mut a = HlcClock::new("A");
        let mut b = HlcClock::new("B");
        let eb = b.now_at(10_000);
        let after = a.observe_at(&eb, 1_000); // 本地物理钟慢
        assert_eq!(after.wall_ms, 10_000);
        assert_eq!(after.counter, eb.counter + 1);
    }

    #[test]
    fn causality_implies_hlc_order_across_devices() {
        // A 写 → B 观察后写：因果链上的 HLC 必须递增
        let mut a = HlcClock::new("A");
        let e1 = a.now_at(1_000);
        let mut b = HlcClock::new("B");
        let e2 = b.observe_at(&e1, 900); // B 的钟比 A 慢
        let e3 = b.now_at(900);
        assert!(e1 < e2 && e2 < e3);
    }

    #[test]
    fn state_roundtrip() {
        let mut clock = HlcClock::new("dev-1");
        clock.now_at(4_242);
        clock.now_at(4_242);
        let state = HlcState::from_clock(&clock);
        assert_eq!((state.wall_ms, state.counter), (4_242, 1));
        let restored = state.restore("dev-1");
        assert_eq!(restored.state(), (4_242, 1));
        // 恢复后继续产生事件必须大于恢复点
        let mut restored = restored;
        assert!(restored.now_at(1) > clock.last().clone());
    }

    #[test]
    fn display_is_stable() {
        let h = Hlc::new(1_730_000_000_123, 7, "01ABC");
        assert_eq!(h.to_string(), "1730000000123-00007-01ABC");
    }

    #[test]
    fn ordering_is_total_even_with_equal_time() {
        let a = Hlc::new(100, 0, "A");
        let b = Hlc::new(100, 0, "B");
        assert_ne!(a.cmp(&b), std::cmp::Ordering::Equal);
        assert!(a < b);
    }
}

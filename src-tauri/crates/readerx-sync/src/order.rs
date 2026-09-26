//! 有序列表的位置键（分数索引 / fractional index）。
//!
//! 有序列表最麻烦的是「两边同时往同一处插入」：如果用「第 n 位」这种整数下标，
//! 一次插入要让后面所有元素 +1，并发时就必然打架（场景 12）。
//!
//! 这里用**位置键**代替下标：每个元素带一个字符串键，按字典序排序即为列表顺序；
//! 往两个相邻元素之间插入时，生成一个字典序严格位于两者之间的新键——
//! 只改被插入元素自己的键，别的元素完全不动。两个设备并发插入同一处时，
//! 各自生成的键都会保留，按 `(位置键, 元素 id)` 排出确定顺序（不会互相覆盖）。
//!
//! ## 关键约定
//!
//! - 字母表**不含 `0`**：`0` 是字典序最小位，一旦出现在键里，「往它前面插」
//!   就再也无位可用；去掉它以后头尾都留有余量。
//! - **末尾追加**（最常见的操作：往书架加书）走「整数 +1」：`V` → `W` → … → `z`
//!   → `zV` → `zW`…，平均 60 次追加才长一位，键不会失控。
//! - **插到最前**走「取中点」：`V` → `F` → `7` → …，约 5～6 次后逼近最小的 `1`，
//!   此后 [`key_before_all`] 返回 `None`（**首位下限已被用尽**）。
//! - 两个键**相邻**（中间不存在合法字符串）时，[`key_between`] 返回 `None`。
//!   调用方（引擎）此时退化为「追加到末尾」并记 debug 日志——顺序略有出入，
//!   但不会丢数据、也不会让各副本不一致（位置由写入方决定，随操作一起同步）。
//!
//! 这是 RGA / LSEQ 的**轻量替代**：不保证并发插入的语义级合并（那需要真正的位置
//! 标识 CRDT），但对书架排序、分组顺序这类场景足够，实现与排查成本低得多。
//! 需要富文本协同编辑时请用 Yjs 这类成熟 CRDT。

/// 位置键字母表：**不含 `0`**，且**按 ASCII 递增**（数字 < 大写 < 小写）。
const ALPHABET: &[u8] = b"123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/// 最小位（`1`）
const MIN: u32 = 0;
/// 最大位（`z`）
const MAX: u32 = 60;
/// 中间位（`V`），用于「两边都没有约束」时取一个留有余量的键
const MID: u32 = 30;
/// 键长上限（防御被外部改坏的输入）
const MAX_LEN: usize = 512;

fn digit_of(b: u8) -> Option<u32> {
    ALPHABET.iter().position(|c| *c == b).map(|p| p as u32)
}

fn ch(digit: u32) -> char {
    ALPHABET[digit.min(MAX) as usize] as char
}

fn encode(digits: &[u32]) -> String {
    digits.iter().map(|d| ch(*d)).collect()
}

fn digits(key: &str) -> Option<Vec<u32>> {
    if key.is_empty() || key.len() > MAX_LEN {
        return None;
    }
    key.bytes().map(digit_of).collect()
}

/// 位置键是否合法（非空、只含字母表字符、长度合理）。
pub fn is_valid_key(key: &str) -> bool {
    digits(key).is_some()
}

/// 生成一个严格介于 `prev` 与 `next` 之间的位置键；无法插入时返回 `None`。
///
/// - `prev = None` 表示插到最前面，`next = None` 表示插到最后面；
/// - 两者都给时必须 `prev < next`，否则返回 `None`。
pub fn key_between(prev: Option<&str>, next: Option<&str>) -> Option<String> {
    match (prev, next) {
        (None, None) => Some(ch(MID).to_string()),
        // 末尾追加：整数式 +1（最高频路径，键长增长最慢）
        (Some(p), None) => increment(p),
        // 开头插入：取一个比 next 首位更小的位（或去掉末位）
        (None, Some(n)) => prepend_before(n),
        (Some(p), Some(n)) => midpoint(p, n),
    }
}

/// 生成一个排在所有给定键之后的键（追加到列表末尾）。
pub fn key_after_all<'a, I>(keys: I) -> String
where
    I: IntoIterator<Item = &'a str>,
{
    match keys.into_iter().max() {
        Some(max) => increment(max).unwrap_or_else(|| format!("{max}{}", ch(MID))),
        None => ch(MID).to_string(),
    }
}

/// 生成一个排在所有给定键之前的键（插到列表开头）；首位下限用尽时返回 `None`。
pub fn key_before_all<'a, I>(keys: I) -> Option<String>
where
    I: IntoIterator<Item = &'a str>,
{
    match keys.into_iter().min() {
        Some(min) => prepend_before(min),
        None => Some(ch(MID).to_string()),
    }
}

/// `prev` 之后的下一个键：末位 +1，满位则进位；整串都是最大位时延长一位。
fn increment(prev: &str) -> Option<String> {
    let mut ds = digits(prev)?;
    for i in (0..ds.len()).rev() {
        if ds[i] < MAX {
            ds[i] += 1;
            return Some(encode(&ds));
        }
        ds[i] = MIN; // 进位
    }
    // 全是最大位：延长一位（任何延长都比原键大）
    Some(format!("{prev}{}", ch(MID)))
}

/// 一个严格小于 `next` 的键。
fn prepend_before(next: &str) -> Option<String> {
    let ds = digits(next)?;
    for i in 0..ds.len() {
        if ds[i] > MIN {
            // 取中点而不是 next[i]-1：给「再往前插」留出空间
            let mid = MIN + (ds[i] - MIN) / 2;
            let mut out = ds[..i].to_vec();
            out.push(mid);
            return Some(encode(&out));
        }
    }
    // 每一位都是最小位：去掉末位（真前缀一定小于原键）
    if ds.len() > 1 {
        Some(encode(&ds[..ds.len() - 1]))
    } else {
        None
    }
}

/// 两个已有键之间的中点。
fn midpoint(prev: &str, next: &str) -> Option<String> {
    if prev >= next {
        return None;
    }
    let p = digits(prev)?;
    let n = digits(next)?;
    let mut out: Vec<u32> = Vec::new();
    // out 是否已经确定小于 next（某一位取到了比 next 小的值）
    let mut less = false;
    let mut i = 0usize;
    while out.len() <= MAX_LEN {
        let lo = p.get(i).copied();
        let hi = n.get(i).copied();
        if less {
            // 上界已无约束，只需保证 > prev，并留出上方空间
            match lo {
                Some(l) if l < MAX => {
                    out.push(((l + MAX) / 2).max(l + 1));
                    return Some(encode(&out));
                }
                Some(_) => {
                    out.push(MAX);
                    i += 1;
                    continue;
                }
                None => {
                    // prev 到此结束：任何位都 > prev 的前缀，取中间位留余量
                    out.push(MID);
                    return Some(encode(&out));
                }
            }
        }
        match (lo, hi) {
            // 同位：抄下来继续看下一位
            (Some(l), Some(h)) if h == l => {
                out.push(l);
                i += 1;
            }
            // next 的位只比 prev 大 1：抄 prev 的位，此后上界再无约束
            (Some(l), Some(h)) if h == l + 1 => {
                out.push(l);
                less = true;
                i += 1;
            }
            // 中间有空间：取中点收工
            (Some(l), Some(h)) if h > l + 1 => {
                out.push((l + h) / 2);
                return Some(encode(&out));
            }
            // prev 的位反而更大（非法输入：prev > next）
            (Some(_), Some(_)) => return None,
            // prev 以 next 为前缀 ⇒ prev > next，非法
            (Some(_), None) => return None,
            // prev 已结束、out 与 next 同前缀：需要一位严格小于 next 的位
            (None, Some(h)) => {
                if h > MIN {
                    out.push(h - 1);
                    return Some(encode(&out));
                }
                return None; // 相邻，插不进去
            }
            (None, None) => {
                out.push(MID);
                return Some(encode(&out));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn between(prev: Option<&str>, next: Option<&str>) -> String {
        key_between(prev, next).unwrap_or_else(|| panic!("应能插入：{prev:?} < ? < {next:?}"))
    }

    #[test]
    fn between_respects_bounds() {
        let cases: Vec<(Option<&str>, Option<&str>)> = vec![
            (None, None),
            (None, Some("V")),
            (Some("V"), None),
            (Some("1"), Some("2")),
            (Some("1"), Some("12")),
            (Some("a"), Some("b")),
            (Some("zz"), Some("zzV")),
        ];
        for (prev, next) in cases {
            let key = between(prev, next);
            assert!(is_valid_key(&key), "生成的位置键必须合法：{key}");
            if let Some(p) = prev {
                assert!(p < key.as_str(), "{p} 应小于 {key}");
            }
            if let Some(n) = next {
                assert!(key.as_str() < n, "{key} 应小于 {n}");
            }
        }
    }

    #[test]
    fn adjacent_keys_report_none_instead_of_wrong_order() {
        // "1" 是字母表的最小键，前面放不下东西
        assert_eq!(key_between(None, Some("1")), None);
        // 非法输入（prev >= next）也要如实返回 None，而不是给出越界的键
        assert_eq!(key_between(Some("V"), Some("V")), None);
        assert_eq!(key_between(Some("W"), Some("V")), None);
        assert_eq!(key_between(Some("VV"), Some("V")), None);
        assert_eq!(key_between(Some(""), Some("V")), None);
    }

    #[test]
    fn repeated_tail_insertions_are_cheap_and_ordered() {
        let mut list = vec![key_between(None, None).unwrap()];
        for _ in 0..500 {
            list.push(key_after_all(list.iter().map(|s| s.as_str())));
        }
        let mut sorted = list.clone();
        sorted.sort();
        assert_eq!(list, sorted, "反复往尾部追加后顺序必须保持");
        let longest = list.iter().map(|k| k.len()).max().unwrap();
        // 每长一位约能追加 30 次（中位起步），500 次追加后仍在 20 位以内
        assert!(longest <= 20, "末尾追加的键长增长过快：{longest}");
        assert!(list.iter().all(|k| is_valid_key(k)));
    }

    #[test]
    fn repeated_head_insertions_stay_ordered_until_exhausted() {
        let mut list = vec![key_between(None, None).unwrap()];
        let mut inserted = 0;
        // 首位空间有限（几次取中点后逼近最小位），用尽后 key_between 返回 None
        while let Some(key) = key_between(None, Some(&list[0])) {
            assert!(key < list[0], "{key} 应小于当前首位 {}", list[0]);
            list.insert(0, key);
            inserted += 1;
            assert!(inserted <= 100, "应当最终返回 None，而不是无限插入");
        }
        assert!(inserted >= 3, "至少应能插入几次（实际 {inserted}）");
        let mut sorted = list.clone();
        sorted.sort();
        assert_eq!(list, sorted);
    }

    #[test]
    fn middle_insertions_stay_ordered() {
        let mut list = vec!["1".to_string(), "2".to_string()];
        for _ in 0..100 {
            if let Some(key) = key_between(Some(&list[0]), Some(&list[1])) {
                list.insert(1, key);
            } else {
                break;
            }
        }
        let mut sorted = list.clone();
        sorted.sort();
        assert_eq!(list, sorted);
        assert!(list.len() > 5, "两个键之间应该能插入多次");
    }

    #[test]
    fn concurrent_insert_at_same_spot_keeps_both() {
        // 甲乙都以 "1" 为前驱、"2" 为后继插入：生成的键相同，靠元素 id 打平顺序
        let jia = between(Some("1"), Some("2"));
        let yi = between(Some("1"), Some("2"));
        assert_eq!(jia, yi, "同样的相邻元素必须算出同一个键（否则顺序会飘）");
        let mut items = vec![("1".to_string(), "a"), ("2".to_string(), "b")];
        items.push((jia, "x"));
        items.push((yi, "y"));
        items.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(b.1)));
        let order: Vec<&str> = items.iter().map(|(_, v)| *v).collect();
        assert_eq!(order, vec!["a", "x", "y", "b"]);
    }

    #[test]
    fn before_and_after_all() {
        let keys = ["5".to_string(), "F".to_string(), "V".to_string()];
        let head = key_before_all(keys.iter().map(|s| s.as_str())).unwrap();
        let tail = key_after_all(keys.iter().map(|s| s.as_str()));
        assert!(head.as_str() < "5");
        assert!(tail.as_str() > "V");
        assert_eq!(key_after_all(std::iter::empty()), "V");
        assert!(key_before_all(std::iter::empty()).is_some());
    }

    #[test]
    fn invalid_keys_are_rejected() {
        assert!(!is_valid_key(""));
        assert!(!is_valid_key("a-b"));
        assert!(!is_valid_key("0V"), "0 不在字母表里（会让「往前插」无位可用）");
        assert!(is_valid_key("1Vk"));
    }

    #[test]
    fn increment_walks_the_whole_alphabet_before_growing() {
        let mut key = "1".to_string();
        let mut seen = 0;
        while key.len() == 1 {
            let next = increment(&key).unwrap();
            assert!(next > key);
            key = next;
            seen += 1;
            assert!(seen < 200);
        }
        // 单位长度能用满整个字母表（61 个位）
        assert_eq!(seen, 61);
        assert_eq!(key.len(), 2);
    }
}

//! 命令行参数解析（手写，零依赖：与 `readerx-source` 的 CLI 保持一致的做法）。
//!
//! 规则简单明确：
//!
//! - `--key value` 与 `--key=value` 等价；
//! - 布尔开关写 `--key`（如 `--all`、`--json`、`--verbose`）；
//! - 其余 token 是位置参数（第一个位置参数是子命令）；
//! - 全局参数（`--data-dir` / `--name` / `--timeout` …）写在子命令前后都行。

use std::collections::BTreeMap;

/// 用法说明。
pub const USAGE_TEXT: &str = r#"readerx-sync —— ReaderX 局域网同步（独立运行器，与 App 共用同一份数据目录）

用法：
  readerx-sync [全局参数] <命令> [命令参数]

全局参数：
  --data-dir <目录>        同步数据目录；默认 $READERX_SYNC_HOME 或 ~/.local/share/readerx-sync
  --name <名称>            本机设备名（首次初始化时写入，之后可改名）
  --timeout <秒>           网络操作超时（默认 20）
  --discovery-port <端口>  发现广播端口（默认 47822）
  --verbose                日志打到标准错误（debug 级）
  --force-unlock           接管残留的目录锁（进程被强杀后可能留下；确认没有别的实例在跑再用）
  -h, --help               显示本说明

命令：
  init                     初始化数据目录（新群组）；加 --join <配对码> 加入已有群组
  pairing                  打印配对码（给另一台设备用）
  status                   设备 / 群组 / 数据量 / 待处理冲突
  create <类型> [--id <id>] [--set k=v ...]   新建实体（值按 JSON 解析，失败当字符串）
  set <实体> <字段> <值>    写字段
  unset <实体> <字段>       清空字段
  incr <实体> <字段> <增量> 计数器增减
  add <实体> <字段> <元素> [--pos <位置键>]   集合 / 列表加入元素
  rm <实体> <字段> <元素>   集合 / 列表移除元素
  move <实体> <字段> <元素> <位置键>          列表元素移动
  delete <实体> [--reason <原因>]             删除（写墓碑）
  restore <实体>           取消墓碑
  ls [--kind <类型>] [--all]                  列出实体（--all 含已删除）
  show <实体>              打印实体 JSON
  ops [--limit <n>]        最近的操作日志
  conflicts [--all]        冲突队列（默认只看待处理）
  resolve <冲突id> --keep local|remote | --value <json> | --dismiss
  serve [--port <端口>] [--no-discovery]      启动同步服务（前台运行）
  discover                 广播发现局域网内的对端
  sync <地址|auto>         与对端同步一次（auto = 先发现再逐个同步）

示例：
  readerx-sync --data-dir /tmp/a init --name 手机
  readerx-sync --data-dir /tmp/a create book --set 'title=三体' --set 'tags=["科幻"]'
  readerx-sync --data-dir /tmp/b init --name 台式机 --join 01J...ab12
  readerx-sync --data-dir /tmp/b serve
  readerx-sync --data-dir /tmp/a sync 192.168.1.9:47821
"#;

/// 解析出来的开关集合。
#[derive(Clone, Debug, Default)]
pub struct Flags(BTreeMap<String, Vec<String>>);

impl Flags {
    /// 取最后一个值（同名参数重复时以最后一个为准，与 shell 习惯一致）。
    pub fn get(&self, key: &str) -> Option<String> {
        self.0.get(key).and_then(|values| values.last().cloned())
    }

    /// 取全部值（`--set` 可以给多次）。
    pub fn all(&self, key: &str) -> Vec<String> {
        self.0.get(key).cloned().unwrap_or_default()
    }

    pub fn get_u64(&self, key: &str) -> Option<u64> {
        self.get(key).and_then(|v| v.parse().ok())
    }

    pub fn has(&self, key: &str) -> bool {
        self.0.contains_key(key)
    }

    /// 是否给了某个布尔开关。
    pub fn is_set(&self, key: &str) -> bool {
        match self.get(key) {
            None => false,
            Some(value) => !matches!(value.as_str(), "false" | "0" | "no"),
        }
    }
}

/// 不需要参数值的布尔开关。
const BOOLEAN_FLAGS: &[&str] = &[
    "all",
    "json",
    "verbose",
    "no-discovery",
    "raw",
    "force-unlock",
    "help",
    "h",
];

/// 拆分位置参数与开关。
pub fn split(args: &[String]) -> std::result::Result<(Vec<String>, Flags), String> {
    let mut positional = Vec::new();
    let mut flags = Flags::default();
    let mut index = 0usize;
    while index < args.len() {
        let token = &args[index];
        if token == "--" {
            positional.extend(args[index + 1..].iter().cloned());
            break;
        }
        if let Some(name) = token.strip_prefix("--") {
            let (key, value) = match name.split_once('=') {
                Some((key, value)) => (key.to_string(), Some(value.to_string())),
                None => (name.to_string(), None),
            };
            index += 1;
            let value = match value {
                Some(value) => Some(value),
                None if BOOLEAN_FLAGS.contains(&key.as_str()) => Some("true".to_string()),
                None => {
                    // 下一个 token 是值；缺值时报错而不是静默当成 true
                    let next = args.get(index).cloned();
                    match next {
                        Some(next) if !next.starts_with("--") => {
                            index += 1;
                            Some(next)
                        }
                        _ => return Err(format!("参数 --{key} 缺少取值")),
                    }
                }
            };
            flags.0.entry(key).or_default().push(value.unwrap_or_default());
        } else if token == "-h" {
            flags.0.entry("h".to_string()).or_default().push("true".to_string());
            index += 1;
        } else {
            positional.push(token.clone());
            index += 1;
        }
    }
    Ok((positional, flags))
}

/// 便捷：`--set k=v` 解析成 `(k, JSON 值)`。
pub fn parse_kv(text: &str) -> std::result::Result<(String, serde_json::Value), String> {
    let (key, value) = text
        .split_once('=')
        .ok_or_else(|| format!("--set 需要 k=v 形式：{text}"))?;
    Ok((key.to_string(), parse_value(value, false)?))
}

/// 把命令行里的值解析成 JSON：能解析成 JSON 就用 JSON，否则当字符串。
///
/// 这样 `set b1 title 三体` 与 `set b1 title '"三体"'` 都能用，而
/// `set b1 tags '["科幻"]'` 给的是数组。
pub fn parse_value(text: &str, raw: bool) -> std::result::Result<serde_json::Value, String> {
    if raw {
        return Ok(serde_json::Value::String(text.to_string()));
    }
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(value) => Ok(value),
        Err(_) => Ok(serde_json::Value::String(text.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn splits_positional_and_flags() {
        let (positional, flags) =
            split(&args(&["--data-dir", "/tmp/a", "sync", "1.2.3.4:1", "--timeout=5", "--json"]))
                .unwrap();
        assert_eq!(positional, vec!["sync", "1.2.3.4:1"]);
        assert_eq!(flags.get("data-dir").unwrap(), "/tmp/a");
        assert_eq!(flags.get_u64("timeout"), Some(5));
        assert!(flags.is_set("json"));
        assert!(!flags.is_set("all"));
    }

    #[test]
    fn repeated_flags_keep_all_values() {
        let (_, flags) = split(&args(&["create", "book", "--set", "a=1", "--set", "b=2"])).unwrap();
        assert_eq!(flags.all("set"), vec!["a=1", "b=2"]);
        assert_eq!(flags.get("set").unwrap(), "b=2");
    }

    #[test]
    fn missing_flag_value_is_an_error() {
        let err = split(&args(&["sync", "--timeout"])).unwrap_err();
        assert!(err.contains("缺少取值"), "{err}");
        // 布尔开关不需要取值
        let (positional, flags) = split(&args(&["ls", "--all"])).unwrap();
        assert_eq!(positional, vec!["ls"]);
        assert!(flags.is_set("all"));
    }

    #[test]
    fn double_dash_stops_flag_parsing() {
        let (positional, _) = split(&args(&["set", "e1", "title", "--", "--weird-value"])).unwrap();
        assert_eq!(positional, vec!["set", "e1", "title", "--weird-value"]);
    }

    #[test]
    fn value_parsing_prefers_json_then_string() {
        assert_eq!(parse_value("42", false).unwrap(), serde_json::json!(42));
        assert_eq!(parse_value("true", false).unwrap(), serde_json::json!(true));
        assert_eq!(parse_value(r#"["a"]"#, false).unwrap(), serde_json::json!(["a"]));
        assert_eq!(parse_value("三体", false).unwrap(), serde_json::json!("三体"));
        // --raw 强制字符串（比如书名就叫 42）
        assert_eq!(parse_value("42", true).unwrap(), serde_json::json!("42"));
    }

    #[test]
    fn kv_parsing() {
        let (key, value) = parse_kv("title=三体").unwrap();
        assert_eq!(key, "title");
        assert_eq!(value, serde_json::json!("三体"));
        assert!(parse_kv("没有等号").is_err());
    }
}

//! 终端输出：人类可读的树状摘要与 `--json` 的机器输出。
//!
//! 约定：人类可读输出面向排查（书源返回的列表逐条展开、正文只给预览），
//! `--json` 输出**完整原始值**，便于后续用 `jq` 或脚本断言。

use serde_json::Value;

/// 单行 JSON（`--json` 统一出口：stdout 只有这一行 JSON，进度都在 stderr）
pub fn print_json(value: &Value) {
    match serde_json::to_string(value) {
        Ok(text) => println!("{text}"),
        Err(err) => eprintln!("readerx-source: JSON 序列化失败：{err}"),
    }
}

/// 打印一次入口函数的返回值（数组展开条目、对象按键、正文给预览）
pub fn print_value(value: &Value) {
    match value {
        Value::Array(items) => {
            println!("返回 {} 项：", items.len());
            for (index, item) in items.iter().enumerate() {
                print_item(index + 1, item);
            }
        }
        Value::Null => println!("（返回 null）"),
        other => print_item(1, other),
    }
}

fn print_item(index: usize, value: &Value) {
    match value {
        Value::Object(map) => {
            let name = text_field(map, &["bookName", "chapterName", "name", "title"])
                .unwrap_or_else(|| "(无标题)".to_string());
            let mut extras: Vec<String> = Vec::new();
            for key in [
                "author",
                "chapterUrl",
                "bookUrl",
                "url",
                "latest",
                "updateTime",
            ] {
                if let Some(field) = map.get(key).and_then(|v| v.as_str()) {
                    if !field.trim().is_empty() {
                        extras.push(format!("{key}={}", truncate(field, 80)));
                    }
                }
            }
            // 正文（bookContent）给字数与预览，避免把整章打印到终端
            if let Some(content) = map.get("text").and_then(|v| v.as_str()) {
                extras.push(format!("正文 {} 字", content.chars().count()));
                extras.push(format!("预览：{}", truncate(&content.replace('\n', " "), 120)));
            }
            println!(
                "  {index}. {name}{}",
                if extras.is_empty() {
                    String::new()
                } else {
                    format!("\n      {}", extras.join("\n      "))
                }
            );
        }
        Value::String(text) => println!("  {index}. {}", truncate(text, 200)),
        other => println!("  {index}. {}", truncate(&other.to_string(), 200)),
    }
}

fn text_field(map: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = map.get(*key).and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

/// 截断超长文本（按字符，不切断 UTF-8）
pub fn truncate(text: &str, limit: usize) -> String {
    let mut out: String = text.chars().take(limit).collect();
    if text.chars().count() > limit {
        out.push('…');
    }
    out
}

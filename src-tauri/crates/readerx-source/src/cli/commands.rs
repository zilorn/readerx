//! CLI 子命令：`sources` / `call` / `run` / `test`。
//!
//! `auth` / `login` 在 [`crate::cli::auth_cmd`]；共用的装载与调用流水线在
//! [`crate::cli::source`]。

use crate::cli::args::{Cli, ENTRY_FUNCTIONS};
use crate::cli::render as out;
use crate::cli::source::{call_and_print, compact, load_source, prepare_and_call};
use crate::engine;
use crate::models::{BookItem, ChapterItem};
use crate::store;
use serde_json::{json, Value};
use std::time::Instant;

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

pub fn cmd_sources(cli: &Cli) -> Result<(), String> {
    let (sources, warnings) = store::list_sources_with_warnings()?;
    if cli.json {
        let list: Vec<Value> = sources
            .iter()
            .map(|s| {
                json!({
                    "id": s.id,
                    "name": s.name,
                    "enabled": s.enabled,
                    "autoAuth": s.auto_auth,
                    "capabilities": s.capabilities,
                    "jsLength": s.js.chars().count(),
                    "userAgent": s.user_agent,
                })
            })
            .collect();
        out::print_json(&json!({
            "dataDir": store::data_root().display().to_string(),
            "sources": list,
            "warnings": warnings.iter().map(|(file, err)| json!({"file": file, "error": err})).collect::<Vec<_>>(),
        }));
        return Ok(());
    }
    println!("数据目录：{}", store::data_root().display());
    if sources.is_empty() {
        println!("（没有已安装书源：用 --source <文件.json> 直接跑单个书源文件）");
    }
    for source in &sources {
        let cookies = store::read_login_cookie(&source.id)
            .ok()
            .flatten()
            .map(|c| c.split(';').filter(|p| !p.trim().is_empty()).count())
            .unwrap_or(0);
        println!(
            "{} {} [{}]  JS {} 字{}{}",
            if source.enabled { "●" } else { "○" },
            source.name,
            source.id,
            source.js.chars().count(),
            if cookies > 0 {
                format!("  登录态 {cookies} 条")
            } else {
                String::new()
            },
            if source.auto_auth { "" } else { "  自动认证关闭" }
        );
    }
    for (file, err) in warnings {
        eprintln!("readerx-source: 跳过无法解析的书源文件 {file}：{err}");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// call
// ---------------------------------------------------------------------------

pub fn cmd_call(cli: &Cli) -> Result<(), String> {
    let fn_name = cli
        .positionals
        .first()
        .cloned()
        .ok_or_else(|| format!("用法：call <函数> [参数JSON]\n可选函数：{}", ENTRY_FUNCTIONS.join(" / ")))?;
    let args = match cli.positionals.get(1) {
        Some(text) => serde_json::from_str::<Value>(text)
            .map_err(|e| format!("参数 JSON 解析失败: {e}"))?,
        None => default_args(&fn_name)?,
    };
    call_and_print(cli, &fn_name, &args)
}

/// 各入口函数的示例参数（与编辑页「测试」面板一致）
pub fn default_args(fn_name: &str) -> Result<Value, String> {
    let value = match fn_name {
        "searchBook" => json!(["搜索关键词"]),
        "discoverBooks" => json!([{ "name": "", "url": "" }]),
        "discoverCategories" => json!([]),
        "bookDetail" | "bookToc" => json!([{ "bookName": "书名", "bookUrl": "https://" }]),
        "bookContent" => json!([
            { "chapterName": "第一章", "chapterUrl": "https://" },
            { "bookName": "书名", "bookUrl": "https://" }
        ]),
        other => {
            return Err(format!(
                "`{other}` 不是入口函数（可选：{}），请显式给出参数 JSON",
                ENTRY_FUNCTIONS.join(" / ")
            ))
        }
    };
    Ok(value)
}


// ---------------------------------------------------------------------------
// run：搜索 → 目录 → 正文
// ---------------------------------------------------------------------------

pub fn cmd_run(cli: &Cli) -> Result<(), String> {
    let keyword = cli
        .positionals
        .first()
        .cloned()
        .ok_or_else(|| "用法：run <关键词> [--chapters N]".to_string())?;
    let source = load_source(cli)?;
    let mut steps: Vec<Value> = Vec::new();

    if !cli.json {
        println!("书源：{} [{}]", source.name, source.id);
        println!("关键词：{keyword}");
    }

    // 1) 搜索
    let search = prepare_and_call(cli, &source, "searchBook", &json!([keyword]))?;
    if !search.ok {
        return Err(format!(
            "searchBook 失败：{}",
            search.error.clone().unwrap_or_else(|| "未知原因".into())
        ));
    }
    let books: Vec<BookItem> = match search.value.as_ref() {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| serde_json::from_value(item.clone()).ok())
            .collect(),
        _ => Vec::new(),
    };
    if !cli.json {
        println!("\n== 搜索（{} ms，{} 本）==", search.elapsed_ms, books.len());
        if books.is_empty() {
            println!(
                "  （没有解析到书籍：先看 --verbose 的书源 console 日志与返回值，确认搜索结果页结构）"
            );
        }
        for (index, book) in books.iter().enumerate().take(20) {
            println!(
                "  {}. {}{}{}",
                index + 1,
                book.book_name,
                book.author
                    .as_deref()
                    .filter(|a| !a.is_empty())
                    .map(|a| format!(" — {a}"))
                    .unwrap_or_default(),
                if book.book_url.is_empty() { "  ⚠ 无 bookUrl" } else { "" }
            );
        }
        if books.len() > 20 {
            println!("  … 其余 {} 本省略", books.len() - 20);
        }
    }
    steps.push(json!({
        "step": "searchBook",
        "ok": search.ok,
        "elapsedMs": search.elapsed_ms,
        "count": books.len(),
        "value": search.value,
        "logs": search.logs,
    }));

    let Some(book) = books.first().cloned() else {
        if cli.json {
            out::print_json(&json!({"source": source.id, "keyword": keyword, "steps": steps}));
        } else {
            println!("\n没有搜索结果（不再继续跑目录）：换个关键词，或用 --verbose 看规则里的日志");
        }
        // 搜索本身成功但零结果不算失败（与 App 的发现页一致），只有规则报错才非零退出
        return Ok(());
    };
    if !cli.json {
        println!("\n用第一本继续：{}", book.book_name);
    }

    // 2) 目录
    let toc = prepare_and_call(cli, &source, "bookToc", &json!([book]))?;
    let chapters: Vec<ChapterItem> = match toc.value.as_ref() {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| serde_json::from_value(item.clone()).ok())
            .collect(),
        _ => Vec::new(),
    };
    if !cli.json {
        println!("== 目录（{} ms，{} 章）==", toc.elapsed_ms, chapters.len());
        for (index, chapter) in chapters.iter().enumerate().take(10) {
            println!("  {}. {}", index + 1, chapter.chapter_name);
        }
        if chapters.len() > 10 {
            println!("  … 其余 {} 章省略", chapters.len() - 10);
        }
        if !toc.ok {
            if let Some(error) = &toc.error {
                eprintln!("readerx-source: bookToc 失败：{error}");
            }
        }
    }
    steps.push(json!({
        "step": "bookToc",
        "ok": toc.ok,
        "elapsedMs": toc.elapsed_ms,
        "count": chapters.len(),
        "value": toc.value,
        "logs": toc.logs,
    }));

    // 3) 正文（前 N 章，并发与 App 的「书源并发」一致）
    if cli.chapters > 0 && !chapters.is_empty() {
        let picked: Vec<ChapterItem> = chapters.iter().take(cli.chapters).cloned().collect();
        let started = Instant::now();
        let contents = engine::fetch_chapter_contents(
            &source.id,
            &source.js,
            &book,
            &picked,
            cli.concurrency,
            cli.timeout_ms.unwrap_or(engine::DEFAULT_CHAPTER_BUDGET_MS),
        )?;
        let ok_count = contents.iter().filter(|c| c.ok).count();
        if !cli.json {
            println!(
                "== 正文（{} ms，{}/{} 章成功）==",
                started.elapsed().as_millis(),
                ok_count,
                contents.len()
            );
            for item in &contents {
                let preview: String = item.text.chars().take(80).collect();
                if item.ok {
                    println!(
                        "  ✓ {}（{} 字）{}",
                        item.chapter_name,
                        item.text.chars().count(),
                        preview.replace('\n', " ")
                    );
                } else {
                    println!("  ✗ {} —— {}", item.chapter_name, item.error);
                }
            }
        }
        steps.push(json!({
            "step": "bookContent",
            "ok": ok_count == contents.len(),
            "elapsedMs": started.elapsed().as_millis() as u64,
            "count": contents.len(),
            "okCount": ok_count,
            "value": contents,
        }));
    }

    if cli.json {
        out::print_json(&json!({
            "source": {"id": source.id, "name": source.name},
            "keyword": keyword,
            "steps": steps,
        }));
    } else if steps.iter().any(|step| step["ok"] == json!(false)) {
        return Err("EXIT_FAILURE".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// test：离线冒烟
// ---------------------------------------------------------------------------

pub fn cmd_test(cli: &Cli) -> Result<(), String> {
    let source = load_source(cli)?;
    let mut checks: Vec<Value> = Vec::new();
    let mut failed = 0;

    // 1) 结构：id / 名称 / JS 非空
    let structure_ok = !source.js.trim().is_empty();
    if !structure_ok {
        failed += 1;
    }
    checks.push(json!({
        "name": "书源结构",
        "ok": structure_ok,
        "detail": if structure_ok {
            format!("id={} name={} JS {} 字", source.id, source.name, source.js.chars().count())
        } else {
            "js 为空".to_string()
        },
    }));

    // 2) 能力开关
    let caps = &source.capabilities;
    checks.push(json!({
        "name": "能力开关",
        "ok": true,
        "detail": format!(
            "搜索={} 发现={} 详情={} 目录={} 正文={}",
            caps.search, caps.discover, caps.detail, caps.toc, caps.content
        ),
    }));

    // 3) JS 语法 + 入口函数定义（在引擎里编译一次，快且不联网）
    let syntax = engine::inspect(&source.js);
    if !syntax.ok {
        failed += 1;
    }
    let defined = syntax.defined.join(" ");
    checks.push(json!({
        "name": "JS 语法",
        "ok": syntax.ok,
        "detail": syntax.error.clone().unwrap_or_else(|| "编译通过".to_string()),
    }));
    // 语法没过就不报「入口函数」结论：文本匹配在编译失败时没有意义
    let has_entries = syntax.ok && !syntax.defined.is_empty();
    checks.push(json!({
        "name": "入口函数",
        "ok": has_entries,
        "detail": if !syntax.ok {
            "语法未通过，无法确认入口函数".to_string()
        } else if syntax.defined.is_empty() {
            "未发现任何入口函数定义".to_string()
        } else {
            defined
        },
    }));
    if syntax.ok && syntax.defined.is_empty() {
        failed += 1;
    }

    // 4) 参数构造（与编辑页「测试」面板一致）
    for fn_name in ENTRY_FUNCTIONS {
        let args = default_args(fn_name);
        let ok = args.is_ok();
        if !ok {
            failed += 1;
        }
        checks.push(json!({
            "name": format!("参数 {fn_name}"),
            "ok": ok,
            "detail": args.map(|a| compact(&a)).unwrap_or_else(|e| e),
        }));
    }

    if cli.json {
        out::print_json(&json!({
            "source": {"id": source.id, "name": source.name},
            "dataDir": store::data_root().display().to_string(),
            "ok": failed == 0,
            "checks": checks,
        }));
    } else {
        println!("书源：{} [{}]", source.name, source.id);
        println!("数据目录：{}", store::data_root().display());
        for check in &checks {
            println!(
                "  {} {}：{}",
                if check["ok"] == json!(true) { "✓" } else { "✗" },
                check["name"].as_str().unwrap_or(""),
                check["detail"].as_str().unwrap_or("")
            );
        }
        println!(
            "\n{}",
            if failed == 0 {
                "离线检查通过（联网行为请用 call / run）"
            } else {
                "存在问题，见上方 ✗"
            }
        );
    }
    if failed > 0 {
        return Err("EXIT_FAILURE".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------

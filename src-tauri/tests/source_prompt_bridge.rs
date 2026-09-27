//! 书源输入表单（`input.prompt`）桥接的端到端回归：**真实引擎 + 真实注册表**，只把界面换成 mock。
//!
//! 覆盖的是单元测试替身绕过的那一层：引擎线程真的阻塞在 `prompt::ask` 上、
//! 表单真的经事件 / `readerx_source_prompt_pending` 交给界面、界面回传的值真的
//! 走了命令校验再送回引擎线程。前端弹层本身的渲染不在这里（见 `src/lib/sourcePrompt.ts`）。
//!
//! **串行执行**：表单后端与「本次运行内记住的值」都是进程级全局，数据根更是一次性初始化，
//! 所以用例之间必须错开（与 tests/sync_bridge.rs 同一约定）。

use readerx_lib::source_prompt;
use readerx_source::prompt::{self, PromptRequest};
use serde_json::{json, Map, Value};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

/// 用例串行锁（见文件头说明）
static SERIAL: Mutex<()> = Mutex::new(());

/// mock 应用（整个测试进程共用一份，活到进程结束）
fn mock_app() -> &'static tauri::AppHandle<tauri::test::MockRuntime> {
    static APP: OnceLock<tauri::AppHandle<tauri::test::MockRuntime>> = OnceLock::new();
    APP.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("readerx-prompt-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // Tauri 的 app_data_dir = $XDG_DATA_HOME/<identifier>；只设一次（并发改环境变量是 UB）
        std::env::set_var("XDG_DATA_HOME", &root);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock 应用应能构建");
        let handle = app.handle().clone();
        readerx_source::store::init_data_root(handle.path().app_data_dir().unwrap());
        // mock 应用要活到进程结束（否则句柄失效）
        std::mem::forget(app);
        source_prompt::install(handle.clone());
        handle
    })
}

/// 造一个书源：界面抬头要有可读的显示名（读不到就回落成 id）
fn seed_source(id: &str, name: &str) {
    let source = readerx_source::BookSource {
        schema_version: 1,
        id: id.to_string(),
        name: name.to_string(),
        book_source_url: "https://example.com".to_string(),
        author: String::new(),
        version: String::new(),
        comment: String::new(),
        enabled: true,
        capabilities: Default::default(),
        auto_auth: true,
        group_id: None,
        user_agent: String::new(),
        headers: Default::default(),
        update_time: 0,
        js: "function searchBook() { return []; }".to_string(),
    };
    readerx_source::store::put_source(&source).expect("书源应能落盘");
}

/// 等界面侧「看到」表单（引擎线程会一直阻塞到界面回传为止）
fn wait_for_form(app: &tauri::AppHandle<tauri::test::MockRuntime>, source_id: &str) -> source_prompt::SourcePromptEvent {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        let pending = source_prompt::pending(app);
        if let Some(event) = pending.into_iter().find(|item| item.source_id == source_id) {
            return event;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("等了 10 秒也没等到表单交给界面");
}

fn request(source_id: &str, opts: &str) -> PromptRequest {
    prompt::parse_request(source_id, opts).expect("选项应能解析")
}

/// 正常链路：书源弹表单 → 界面拿到字段 → 回传值 → 引擎拿到规范化后的结果。
///
/// 顺带验证三件容易出错的事：界面上写的错值会被打回（表单留在原地）、
/// 同一张表单第二次不再弹（本次运行记住的值）、作废的 id 交不上去。
#[test]
fn form_reaches_the_frontend_and_returns_values() {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let app = mock_app();
    let source_id = "prompt-bridge-source";
    seed_source(source_id, "桥接演示源");
    let opts = r#"{"title":"站点口令","message":"桥接测试","fields":[
        {"key":"pwd","label":"口令","type":"password","required":true},
        {"key":"rps","label":"并发","type":"number","defaultValue":"2","min":1,"max":5}
    ]}"#;

    // 引擎线程：真的阻塞在这里等界面
    let worker = {
        let request = request(source_id, opts);
        std::thread::spawn(move || prompt::ask(&request))
    };

    let event = wait_for_form(app, source_id);
    assert_eq!(event.source_name, "桥接演示源");
    assert_eq!(event.title, "站点口令");
    assert_eq!(event.message, "桥接测试");
    assert_eq!(event.fields.len(), 2);
    assert_eq!(event.fields[0].label, "口令");
    assert!(event.fields[0].required);

    // 界面上必填留空的兜底校验：命令拒绝，但表单还在等着，用户改完可以再交
    let mut missing = Map::new();
    missing.insert("rps".to_string(), Value::String("9".to_string()));
    assert!(
        source_prompt::readerx_source_prompt_submit(event.id, Some(missing), false).is_err(),
        "越界 / 必填留空的值应被打回"
    );
    assert!(
        source_prompt::pending(app)
            .iter()
            .any(|item| item.id == event.id),
        "打回后表单应仍在等待"
    );

    let mut values = Map::new();
    values.insert("pwd".to_string(), Value::String("s3cret".to_string()));
    values.insert("rps".to_string(), Value::String("3".to_string()));
    source_prompt::readerx_source_prompt_submit(event.id, Some(values), false)
        .expect("合法值应被接受");

    let outcome = worker.join().expect("引擎线程应正常结束").expect("ask 不应报错");
    assert!(outcome.ok, "{}", outcome.message);
    assert_eq!(outcome.values["pwd"], json!("s3cret"));
    // 数字字段一律规范化成 JSON 数字，书源里可以直接参与运算
    assert_eq!(outcome.values["rps"], json!(3));
    assert!(source_prompt::pending(app).is_empty());

    // 同一张表单再来一次：本次运行已记住，不再推给界面
    let again = prompt::ask(&request(source_id, opts)).expect("第二次应命中记忆");
    assert_eq!(again.values, outcome.values);
    assert!(
        source_prompt::pending(app).is_empty(),
        "命中记忆时不该再弹表单"
    );

    // 作废的 id（超时 / 已提交过）不能再交
    assert!(source_prompt::readerx_source_prompt_submit(event.id, None, true).is_err());
}

/// 用户取消：书源拿到 `ok:false` + 原因（不抛错，规则自行降级），表单从队列里消失。
#[test]
fn cancel_returns_ok_false_to_the_rule() {
    let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let app = mock_app();
    let source_id = "prompt-bridge-cancel";
    seed_source(source_id, "取消演示源");
    let opts = r#"{"title":"会被取消的表单","fields":[{"key":"code","label":"访问码"}]}"#;

    let worker = {
        let request = request(source_id, opts);
        std::thread::spawn(move || prompt::ask(&request))
    };
    let event = wait_for_form(app, source_id);
    source_prompt::readerx_source_prompt_submit(event.id, None, true).expect("取消应被接受");

    let outcome = worker
        .join()
        .expect("引擎线程应正常结束")
        .expect("取消不该让 ask 报错");
    assert!(!outcome.ok);
    assert!(outcome.message.contains("取消"), "{}", outcome.message);
    assert!(outcome.values.is_empty());
    assert!(source_prompt::pending(app).is_empty());

    // 没被记住：再次调用会重新问用户（这里是判断「注册表里又出现了一张表单」）
    let worker = {
        let request = request(source_id, opts);
        std::thread::spawn(move || prompt::ask(&request))
    };
    let again = wait_for_form(app, source_id);
    source_prompt::readerx_source_prompt_submit(again.id, None, true).expect("取消应被接受");
    let outcome = worker.join().unwrap().unwrap();
    assert!(!outcome.ok);
    assert!(outcome.message.contains("取消"), "{}", outcome.message);
}

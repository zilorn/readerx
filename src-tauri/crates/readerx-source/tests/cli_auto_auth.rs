#![cfg(feature = "cli")]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_CASE: AtomicUsize = AtomicUsize::new(0);

/// 每例启动独立 CLI 进程，隔离后端单例和自动认证冷却；挑战与 CDP 均只用本机端口。
fn check_challenge(command: &str, backend: &str, auto_auth: bool, expected: &str) {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", server.local_addr().unwrap());
    let response_thread = std::thread::spawn(move || {
        let (mut stream, _) = server.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        let mut request = [0; 4096];
        stream.read(&mut request).unwrap();
        stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\ncf-mitigated: challenge\r\nContent-Length: 9\r\nConnection: close\r\n\r\nchallenge").unwrap();
    });
    // 保留端口但不处理 CDP 请求，让连接超时，不启动真实浏览器或误连其它服务。
    let cdp_port = TcpListener::bind("127.0.0.1:0").unwrap();
    let cdp_url = format!("http://{}", cdp_port.local_addr().unwrap());
    let root = std::env::temp_dir().join(format!(
        "readerx-cli-auto-auth-{}-{}",
        std::process::id(),
        NEXT_CASE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).unwrap();
    let source_file = root.join("source.json");
    let source = serde_json::json!({
        "id": "cli-auth-test", "name": "CLI auth test", "bookSourceUrl": url,
        "autoAuth": auto_auth,
        "js": format!(
            "function searchBook() {{ const r = http.get({url:?}); if (!r.cf || r.cf.auto !== {expected:?}) throw new Error('cf.auto=' + JSON.stringify(r.cf)); return []; }}"
        )
    });
    let source_text = serde_json::to_string(&source).unwrap();
    std::fs::write(&source_file, &source_text).unwrap();
    let mut cli = Command::new(env!("CARGO_BIN_EXE_readerx-source"));
    cli.args(["--source"])
        .arg(&source_file)
        .arg("--data-dir")
        .arg(root.join("data"))
        .args(["--cdp", &cdp_url, "--auth", backend, "--json", command])
        .arg(if command == "call" {
            "searchBook"
        } else {
            "keyword"
        })
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .env_remove("READERX_CHROME")
        .env("NO_PROXY", "127.0.0.1");
    let output = cli.output().unwrap();
    response_thread.join().unwrap();
    // CLI 的临时开关不能写回书源文件。
    assert_eq!(std::fs::read_to_string(&source_file).unwrap(), source_text);
    std::fs::remove_dir_all(&root).unwrap();
    assert!(
        output.status.success(),
        "{command}/{backend}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    if command == "call" {
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["value"], serde_json::json!([]));
    } else {
        assert_eq!(result["steps"][0]["ok"], true, "{result}");
        assert_eq!(result["steps"][0]["value"], serde_json::json!([]));
    }
    if expected == "cancelled" {
        assert!(String::from_utf8_lossy(&output.stderr).contains("网页认证开始"));
    }
}

#[test]
fn call_and_run_register_auth_and_respect_switches() {
    for command in ["call", "run"] {
        check_challenge(command, "cdp", true, "cancelled");
        check_challenge(command, "auto", true, "cancelled");
        check_challenge(command, "none", true, "disabled");
        check_challenge(command, "webkit", true, "unsupported");
        check_challenge(command, "cdp", false, "disabled");
    }
}

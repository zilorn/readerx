//! 终端交互式输入后端：`input.prompt` 在独立二进制里的实现。
//!
//! 书源在 CLI 里要用户输入时（站点口令 / 访问码 / 翻页参数…），逐项在**标准错误**上提问、
//! 读标准输入：
//! - 提问走 stderr、结果照旧走 stdout：CLI 的 stdout 是给脚本消费的数据，不能被提问污染；
//! - 密码字段在真终端上关闭回显（termios），并在读完后恢复；
//! - 标准输入不是终端（管道 / 重定向 / CI）时 `supported()` 为 false，书源拿到 `ok:false`
//!   自行降级，而不是把整条命令挂在那儿等一个永远不会来的输入。

use crate::prompt::{PromptOutcome, PromptField, PromptFieldKind, PromptProvider, PromptRequest};
use serde_json::{Map, Value};
use std::io::{BufRead, IsTerminal, Write};

/// 一张表单最多重问几轮（必填留空 / 数字越界时让用户改，而不是直接失败）
const MAX_ATTEMPTS: usize = 3;

/// 终端后端（无状态：每次调用直接读标准输入）
pub struct TerminalPrompt;

impl TerminalPrompt {
    pub fn new() -> Self {
        Self
    }
}

impl PromptProvider for TerminalPrompt {
    fn supported(&self) -> bool {
        // 两边都要是终端：stdin 拿输入、stderr 显示提问（stdout 留给命令结果）
        std::io::stdin().is_terminal() && std::io::stderr().is_terminal()
    }

    fn prompt(&self, request: &PromptRequest) -> Result<PromptOutcome, String> {
        let mut last_error = String::new();
        for attempt in 1..=MAX_ATTEMPTS {
            if attempt > 1 {
                eprintln!("── 重新填写（{last_error}）");
            }
            print_header(request);
            let mut raw = Map::new();
            for field in &request.fields {
                match read_field(field)? {
                    Some(text) => {
                        raw.insert(field.key.clone(), Value::String(text));
                    }
                    // EOF / 读失败：用户（或管道）不再提供输入，按取消处理
                    None => return Ok(PromptOutcome::cancelled()),
                }
            }
            match request.normalize_values(&raw) {
                Ok(values) => return Ok(PromptOutcome::success(values)),
                Err(reason) => last_error = reason,
            }
        }
        Ok(PromptOutcome::failure(format!(
            "输入未完成：{last_error}"
        )))
    }
}

/// 表单抬头：标题 + 说明（书源没写标题时用书源 id 代替，用户至少知道是谁在问）
fn print_header(request: &PromptRequest) {
    let title = if request.title.trim().is_empty() {
        request.source_id.as_str()
    } else {
        request.title.trim()
    };
    eprintln!("── {title}");
    if !request.message.trim().is_empty() {
        eprintln!("   {}", request.message.trim());
    }
}

/// 读一个字段；返回 None 表示输入结束（EOF）
fn read_field(field: &PromptField) -> Result<Option<String>, String> {
    let prompt = format!("{}{}: ", field.label, field_hint(field));
    match field.kind {
        PromptFieldKind::Password => read_line_no_echo(&prompt),
        PromptFieldKind::Text | PromptFieldKind::Number => read_line(&prompt),
    }
}

/// 字段提示（必填 / 取值范围 / 长度上限）
fn field_hint(field: &PromptField) -> String {
    let mut notes: Vec<String> = Vec::new();
    if field.required {
        notes.push("必填".to_string());
    }
    if field.kind == PromptFieldKind::Number {
        match (field.min, field.max) {
            (Some(min), Some(max)) => notes.push(format!("{min}–{max}")),
            (Some(min), None) => notes.push(format!("≥ {min}")),
            (None, Some(max)) => notes.push(format!("≤ {max}")),
            (None, None) => {}
        }
    }
    if !field.placeholder.trim().is_empty() {
        notes.push(field.placeholder.trim().to_string());
    }
    if notes.is_empty() {
        String::new()
    } else {
        format!("（{}）", notes.join("，"))
    }
}

/// 提示 + 读一行（去掉行尾换行；EOF 返回 None）
fn read_line(prompt: &str) -> Result<Option<String>, String> {
    eprint!("{prompt}");
    let _ = std::io::stderr().flush();
    read_stdin_line()
}

/// 关掉回显读一行（密码字段）。
///
/// 拿不到终端属性（非 tty / 平台不支持）时退回普通读取——此时 `supported()` 本来就是 false，
/// 走到这里只可能是终端属性读取失败，宁可回显也不要卡住用户。
fn read_line_no_echo(prompt: &str) -> Result<Option<String>, String> {
    eprint!("{prompt}");
    let _ = std::io::stderr().flush();
    let guard = EchoGuard::suppress();
    let line = read_stdin_line();
    // 用户按下的回车没有回显，补一个换行，后续输出才不会与这一行连在一起
    if guard.is_some() {
        eprintln!();
    }
    line
}

fn read_stdin_line() -> Result<Option<String>, String> {
    let mut line = String::new();
    let read = std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|err| format!("读取输入失败: {err}"))?;
    if read == 0 {
        return Ok(None);
    }
    while line.ends_with('\n') || line.ends_with('\r') {
        line.pop();
    }
    Ok(Some(line))
}

/// 关闭终端回显并在离开作用域时恢复（Drop 保证异常路径也会恢复）。
#[cfg(unix)]
struct EchoGuard(libc::termios);

#[cfg(unix)]
impl EchoGuard {
    fn suppress() -> Option<Self> {
        use std::os::fd::AsRawFd;
        let fd = std::io::stdin().as_raw_fd();
        let mut original = std::mem::MaybeUninit::<libc::termios>::uninit();
        // SAFETY: fd 由标准输入持有且在整个调用期间有效；tcgetattr 成功时结构体已完整写入
        if unsafe { libc::tcgetattr(fd, original.as_mut_ptr()) } != 0 {
            return None;
        }
        let original = unsafe { original.assume_init() };
        let mut quiet = original;
        quiet.c_lflag &= !libc::ECHO;
        // SAFETY: quiet 是刚读出来的 termios，fd 同上
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &quiet) } != 0 {
            return None;
        }
        Some(Self(original))
    }
}

#[cfg(unix)]
impl Drop for EchoGuard {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        let fd = std::io::stdin().as_raw_fd();
        // SAFETY: 恢复的是进入时读到的原始 termios（本类型只能由 suppress() 构造）
        unsafe { libc::tcsetattr(fd, libc::TCSANOW, &self.0) };
    }
}

/// 非 unix（CLI 主要面向 Linux，但代码要能编译）：不做回显控制
#[cfg(not(unix))]
struct EchoGuard;

#[cfg(not(unix))]
impl EchoGuard {
    fn suppress() -> Option<Self> {
        None
    }
}

//! 统一异常兜底：把「panic」收敛成可读错误文本。
//!
//! 书源 JS 由用户自编 / 导入，运行在 Boa 引擎里；HTML 解析走 `scraper`、网络走 `reqwest`，
//! 这些第三方代码内部仍可能存在 unwind 点。配合 release 的 `panic = "unwind"`（见 Cargo.toml），
//! 这里用 `catch_unwind` 保证：出现意外 panic 时只让**当前这次调用**失败并向前端返回
//! 可读原因（同时 panic hook 会把位置打到日志），而不是整个应用无提示闪退。

use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};

/// 从 panic 载荷里取出可读文本（普通字符串之外的载荷给兜底文案）。
pub(crate) fn panic_text(payload: &(dyn Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        return (*text).to_string();
    }
    if let Some(text) = payload.downcast_ref::<String>() {
        return text.clone();
    }
    "未知内部错误".to_string()
}

/// 执行 `task`：正常返回其值；发生 panic 时返回 `Err("<what>内部异常: …")`。
pub(crate) fn catch<T, F>(what: &str, task: F) -> Result<T, String>
where
    F: FnOnce() -> T,
{
    match catch_unwind(AssertUnwindSafe(task)) {
        Ok(value) => Ok(value),
        Err(payload) => Err(format!("{what}内部异常: {}", panic_text(&*payload))),
    }
}

/// `task` 本身返回 `Result` 时的便捷版本：panic 与业务错误统一为可读错误文本。
pub(crate) fn catch_result<T, F>(what: &str, task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    catch(what, task).and_then(|inner| inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_becomes_readable_error() {
        let result = catch_result("书源执行", || -> Result<(), String> {
            panic!("引擎内部断言失败")
        });
        let message = result.expect_err("panic 必须转成 Err");
        assert!(message.contains("书源执行"), "{message}");
        assert!(message.contains("引擎内部断言失败"), "{message}");

        // 非字符串载荷也要有兜底文案
        let payload = catch("测试", || -> u8 { std::panic::panic_any(42u32) });
        assert!(payload.expect_err("panic 必须转成 Err").contains("未知内部错误"));

        // 正常路径原样透传（Ok 与业务 Err 都不受影响）
        assert_eq!(catch_result("测试", || Ok(1u8)).unwrap(), 1);
        assert_eq!(
            catch_result("测试", || Err::<u8, String>("业务错误".into())).unwrap_err(),
            "业务错误"
        );
    }
}

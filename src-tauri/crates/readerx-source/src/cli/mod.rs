//! 独立二进制（CLI）的子系统：参数解析、命令实现、终端输出。
//!
//! 只在 `cli` feature 下编译；库使用方（包括 App）不会引入这些代码。

pub mod args;
pub mod auth_cmd;
pub mod commands;
pub mod render;
pub mod source;

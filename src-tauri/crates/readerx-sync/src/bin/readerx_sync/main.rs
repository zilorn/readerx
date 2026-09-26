//! 独立二进制 `readerx-sync`：局域网同步的命令行运行器（见 `crate::cli`）。
//!
//! 与 App 共用同一份库代码（`readerx-sync` crate），因此这里跑通的同步与冲突语义
//! 就是 App 接入后的语义；区别只是没有界面。

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = readerx_sync::cli::main(&args);
    std::process::exit(code);
}

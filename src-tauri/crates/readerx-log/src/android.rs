//! Android logcat 输出目标。
//!
//! Android 上 Rust 的 stdout / stderr 不会自动进 logcat，真机排障最方便的一条路
//! （`adb logcat -s readerx`）因此需要显式调用 liblog。这里直接声明系统符号，
//! 不引 `android_logger` / `ndk-sys`：只有「写一行」一个需求，几行 FFI 足够，
//! 也避免把日志设施绑到 NDK 版本上。其他平台上整个模块是空实现。

#[cfg(target_os = "android")]
pub(crate) fn write(level: log::Level, tag: &str, text: &str) {
    use std::os::raw::{c_char, c_int};

    // `#[link(name = "log")]` 不能省：Android NDK 不会自动链上 liblog，
    // 少了它 release 构建会以「undefined symbol: __android_log_write」在链接期失败
    // （android_log-sys / ndk-sys 用的也是这一行）。
    #[link(name = "log")]
    extern "C" {
        fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
    }

    // ANDROID_LOG_* 优先级（android/log.h）
    let priority: c_int = match level {
        log::Level::Error => 6,
        log::Level::Warn => 5,
        log::Level::Info => 4,
        log::Level::Debug => 3,
        log::Level::Trace => 2,
    };
    let tag = c_string(tag);
    let text = c_string(text);
    // 返回值只是写入的字节数；logcat 不可用（权限 / 缓冲区满）时也没有可做的补救
    unsafe {
        let _ = __android_log_write(
            priority,
            tag.as_ptr() as *const c_char,
            text.as_ptr() as *const c_char,
        );
    }
}

/// logcat 的 tag 有长度限制，超长会被截断；同时 C 字符串不能含内层 NUL
#[cfg(target_os = "android")]
fn c_string(value: &str) -> Vec<u8> {
    let mut bytes: Vec<u8> = value.bytes().filter(|b| *b != 0).take(31).collect();
    bytes.push(0);
    bytes
}

#[cfg(not(target_os = "android"))]
pub(crate) fn write(_level: log::Level, _tag: &str, _text: &str) {}

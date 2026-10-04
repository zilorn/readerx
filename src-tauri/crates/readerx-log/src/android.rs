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
    let tag = tag_c_string(tag);
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

/// 正文不套用 tag 的长度限制；过滤内层 NUL，避免 C 接口提前结束消息。
#[cfg(any(target_os = "android", test))]
fn c_string(value: &str) -> Vec<u8> {
    let mut bytes: Vec<u8> = value.bytes().filter(|b| *b != 0).collect();
    bytes.push(0);
    bytes
}

/// 保留 tag 的 31 字节兼容限制，截断时不拆开 UTF-8 字符。
#[cfg(any(target_os = "android", test))]
fn tag_c_string(value: &str) -> Vec<u8> {
    let tag = value.replace('\0', "");
    let mut end = tag.len().min(31);
    while !tag.is_char_boundary(end) {
        end -= 1;
    }
    c_string(&tag[..end])
}

#[cfg(not(target_os = "android"))]
pub(crate) fn write(_level: log::Level, _tag: &str, _text: &str) {}

#[cfg(test)]
mod tests {
    use super::{c_string, tag_c_string};
    use std::ffi::CStr;

    #[test]
    fn message_preserves_long_utf8_text_and_tail() {
        let message = format!("{}\n中文错误详情：连接失败", "message ".repeat(100));
        let bytes = c_string(&message);
        assert_eq!(
            CStr::from_bytes_with_nul(&bytes).unwrap().to_str().unwrap(),
            message
        );
    }

    #[test]
    fn c_strings_remove_interior_nuls() {
        assert_eq!(c_string("before\0after\0"), b"beforeafter\0");
        assert_eq!(tag_c_string("read\0erx"), b"readerx\0");
        assert_eq!(c_string(""), b"\0");
    }

    #[test]
    fn tag_limit_preserves_utf8_boundary() {
        assert_eq!(
            tag_c_string(&"a".repeat(40)),
            format!("{}\0", "a".repeat(31)).as_bytes()
        );
        let tag = format!("{}中文", "a".repeat(30));
        let bytes = tag_c_string(&tag);
        assert_eq!(
            CStr::from_bytes_with_nul(&bytes).unwrap().to_str().unwrap(),
            "a".repeat(30)
        );
    }
}

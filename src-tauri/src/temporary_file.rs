//! 原子写入的失败清理与 App 启动回收。启动回收必须早于迁移、UI 和同步线程。

use std::fs;
use std::path::{Path, PathBuf};

/// 声明在文件句柄之前，使失败退出时先关闭文件，再清理临时文件。
pub(crate) struct TemporaryFile(pub PathBuf);

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        remove(&self.0);
    }
}

fn remove(path: &Path) {
    if let Err(error) = fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!("清理存储临时文件失败：{error}");
        }
    }
}

/// 仅扫描 App 管理的存储目录；不递归到任意子树，也不跟随目录符号链接。
/// sync 的引擎文件由引擎持锁清理，书源和登录态由独立 crate 管理。
pub(crate) fn cleanup(root: &Path) -> std::io::Result<()> {
    for (name, depth) in [("state", 0), ("books", 1), ("images", 0)] {
        scan(&root.join(name), depth)?;
    }
    let sync = root.join("sync");
    if fs::symlink_metadata(&sync).is_ok_and(|meta| meta.is_dir()) {
        remove(&sync.join("settings.json.tmp"));
    }
    Ok(())
}

fn scan(dir: &Path, depth: usize) -> std::io::Result<()> {
    match fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() && depth > 0 {
            scan(&entry.path(), depth - 1)?;
        } else if kind.is_file()
            && entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(".tmp"))
        {
            remove(&entry.path());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_removes_owned_temporary_files_and_preserves_data() {
        let root =
            std::env::temp_dir().join(format!("readerx-temp-{}", readerx_sync::id::new_id()));
        for name in [
            "state",
            "books/book-1",
            "images",
            "sync/content/book-1",
            "source_sessions",
        ] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        let stale = [
            "state/readerx.reading-time.tmp",
            "books/book-1/content.json.tmp",
            "books/legacy.id-migration.tmp",
            "images/image.png.sync.tmp",
            "images/.image.png.123.1.tmp",
            "sync/settings.json.tmp",
        ];
        let retained = [
            "books/book-1/content.json",
            "images/image.png",
            "sync/content/book-1/body.json.tmp",
            "source_sessions/session.json.tmp",
        ];
        for name in stale.iter().chain(retained.iter()) {
            fs::write(root.join(name), b"original").unwrap();
        }
        fs::create_dir(root.join("images/keep.tmp")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("source_sessions"), root.join("books/linked"))
            .unwrap();
        cleanup(&root).unwrap();
        cleanup(&root).unwrap();
        for name in stale {
            assert!(!root.join(name).exists(), "{name}");
        }
        for name in retained {
            assert_eq!(fs::read(root.join(name)).unwrap(), b"original", "{name}");
        }
        assert!(root.join("images/keep.tmp").is_dir());
        fs::remove_dir_all(root).unwrap();
    }
}

//! 跨设备身份（uid）：让「同一本书」在两台设备上算出同一个实体 id。
//!
//! 同步框架按实体 id 对齐两边的数据，而 App 里的书籍 id 是**每台设备各自生成**的
//! （`local-<时间>-<随机>`），同一个 epub 在手机上导入和在桌面上导入拿到的是两个 id，
//! 照搬本地 id 会让「进度 / 书签 / 分组」永远对不上。
//!
//! 因此同步用的实体 id 由**内容特征**派生：
//!
//! | 对象 | 身份依据 | 为什么 |
//! | --- | --- | --- |
//! | 在线书 | 书源地址 + 书籍详情页地址 | 同一本书源的同一本书，两台设备指向同一份内容 |
//! | 导入书 | 文件名（大小写归一）+ 字节数 | 同一个文件在两台设备上的稳定特征，且不需要读文件内容 |
//! | 分组 | 分组名 | 分组是用户自己起的名字，名字就是它的身份 |
//! | 书源 | 书源地址 | 书源 id 每台设备各自生成，地址才是它真正的主键 |
//!
//! **已知取舍**：导入书用「文件名 + 字节数」而不是内容哈希 —— 算内容哈希要把整本书
//! 读一遍（几百 MB，导入路径上不可接受），而文件名相同、字节数也相同的两个**不同**文件
//! 在实践中不存在。代价是改名 / 换一份同名不同内容的文件会被当成新书，这不影响正确性：
//! 两边各自收敛，只是不会互相同步而已。

use sha2::{Digest, Sha256};

/// 书籍身份的来源特征。
#[derive(Clone, Debug, Default)]
pub struct BookKey<'a> {
    /// 书源地址（在线书才有）
    pub source_url: Option<&'a str>,
    /// 书籍详情页地址（在线书才有）
    pub book_url: Option<&'a str>,
    /// 导入文件名
    pub file_name: &'a str,
    /// 文件字节数
    pub size: u64,
}

/// 派生书籍实体 id（`b-<16 位十六进制>`）。
pub fn book_uid(key: &BookKey<'_>) -> String {
    let book_url = key.book_url.unwrap_or("").trim();
    let seed = if book_url.is_empty() {
        // 导入书：文件名（大小写归一）+ 字节数
        format!("file\n{}\n{}", key.file_name.trim().to_lowercase(), key.size)
    } else {
        // 在线书：书源地址 + 书籍详情页地址。
        // 书源被删（拿不到地址）时退化成只用书籍地址 —— 这仍然能对上另一台设备的
        // 同一个书源记录（只要地址没变），比退回文件特征准得多。
        format!(
            "url\n{}\n{}",
            key.source_url.map(normalize_url).unwrap_or_default(),
            normalize_url(book_url)
        )
    };
    format!("b-{}", short_hash(&seed))
}

/// 分组实体 id（`g-<16 位十六进制>`）：分组名即身份。
pub fn group_uid(name: &str) -> String {
    format!("g-{}", short_hash(&format!("group\n{}", name.trim())))
}

/// 书源实体 id（`s-<16 位十六进制>`）：书源地址即身份。
pub fn source_uid(url: &str) -> String {
    format!("s-{}", short_hash(&format!("source\n{}", normalize_url(url))))
}

/// 阅读进度实体 id：一本书一条，跟随书身份。
pub fn progress_uid(book_uid: &str) -> String {
    format!("rp-{book_uid}")
}

/// URL 归一化：只做「同一条地址的不同写法」这一层，不猜重定向。
/// 两台设备上同一个书源的地址写法应当一致，这里只兜掉大小写与末尾斜杠的差别。
fn normalize_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_lowercase()
}

/// 取 sha256 前 16 位十六进制：够用的碰撞空间（64 bit），且短到在日志 / CLI 里能看。
fn short_hash(seed: &str) -> String {
    let digest = Sha256::digest(seed.as_bytes());
    let mut out = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_key(name: &str, size: u64) -> BookKey<'_> {
        BookKey { file_name: name, size, ..BookKey::default() }
    }

    #[test]
    fn same_file_features_give_same_uid() {
        // 两台设备导入同一个文件 → 同一个 uid（大小写与首尾空格不影响）
        let a = book_uid(&file_key("三体.epub", 1024));
        let b = book_uid(&file_key(" 三体.EPUB ", 1024));
        assert_eq!(a, b);
        assert!(a.starts_with("b-"));
        assert_eq!(a.len(), 18);
    }

    #[test]
    fn different_size_means_different_uid() {
        assert_ne!(book_uid(&file_key("三体.epub", 1024)), book_uid(&file_key("三体.epub", 1025)));
    }

    #[test]
    fn online_books_key_on_source_and_url() {
        let key = BookKey {
            source_url: Some("https://a.example.com"),
            book_url: Some("https://a.example.com/book/1"),
            file_name: "在线书",
            size: 0,
        };
        let same = BookKey {
            source_url: Some("https://a.example.com/"),
            book_url: Some("https://A.example.com/book/1"),
            ..key.clone()
        };
        assert_eq!(book_uid(&key), book_uid(&same), "地址写法差异不应改变身份");
        let other = BookKey { book_url: Some("https://a.example.com/book/2"), ..key.clone() };
        assert_ne!(book_uid(&key), book_uid(&other));
        // 书源被删（拿不到书源地址）：仍按书籍地址对齐，不与导入书混淆
        let no_source = BookKey { source_url: None, ..key.clone() };
        assert_ne!(book_uid(&key), book_uid(&no_source));
        assert_ne!(book_uid(&no_source), book_uid(&file_key("在线书", 0)));
    }

    #[test]
    fn group_and_source_uids_are_stable_and_trimmed() {
        assert_eq!(group_uid("科幻"), group_uid(" 科幻 "));
        assert_ne!(group_uid("科幻"), group_uid("奇幻"));
        assert_eq!(source_uid("https://x.example.com/"), source_uid("https://x.example.com"));
        assert!(source_uid("https://x.example.com").starts_with("s-"));
    }

    #[test]
    fn progress_uid_is_derived_from_book() {
        let book = book_uid(&file_key("a.epub", 1));
        assert_eq!(progress_uid(&book), format!("rp-{book}"));
    }
}

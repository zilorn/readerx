//! 本机**可被对端连上**的地址（同步界面「本机地址」那几行）。
//!
//! 同步服务端按 `0.0.0.0:47821` 绑定（监听全部网卡），而 `0.0.0.0` 只是「所有网卡」这个
//! 绑定意图，**不是能连的地址** —— 直接把它显示给用户，对方照着填只会失败（历史问题：
//! 界面一度把 bind 地址当本机地址展示）。这里枚举本机网卡的真实地址，只留下对端可能
//! 连上的那些：跳过回环、未指定地址与 IPv6 链路本地（`fe80::` 需要 scope id，裸地址连不上）。
//!
//! 端口由调用方带（同步服务的监听端口），因为「对外地址」要连的是对端的同步端口，
//! 不是发现端口。

/// 本机对外地址（`host` 不含端口，IPv6 形如 `fd00::1`，需要方括号由展示层补）。
///
/// 顺序按「最可能是用户在找的那个」排：先家庭 / 办公室局域网（`192.168.*`、`10.*`、
/// 其余私有段），再虚拟网卡（Tailscale 的 `100.64/10`、Docker 网桥的 `172.*`），
/// 最后 IPv6。地址少的时候用户一眼就是正确的那个，多的时候也能逐个试。
pub fn local_addresses() -> Vec<String> {
    let mut found = platform::addresses();
    found.sort_by_key(|addr| address_rank(addr));
    found.dedup();
    found
}

/// 地址的展示优先级（越小越靠前）；解析不出来的排最后
fn address_rank(addr: &str) -> (u8, u8, String) {
    let Ok(ip) = addr.parse::<std::net::IpAddr>() else {
        return (9, 9, addr.to_string());
    };
    let family = u8::from(ip.is_ipv6());
    let kind = match ip {
        std::net::IpAddr::V4(v4) => {
            let octets = v4.octets();
            match octets {
                [192, 168, ..] => 0,
                [10, ..] => 1,
                // Tailscale / CGNAT：能用但不是「局域网地址」的样子
                [100, b, ..] if (64..=127).contains(&b) => 3,
                // Docker 等虚拟网桥常见段
                [172, b, ..] if (16..=31).contains(&b) => 4,
                [127, ..] => 8,
                _ => 2,
            }
        }
        // 全局 / 唯一本地 IPv6 排在 IPv4 之后
        std::net::IpAddr::V6(_) => 5,
    };
    (family, kind, addr.to_string())
}

/// 回环 / 未指定地址：它们不是「对端能连」的地址
fn is_usable_ip(ip: std::net::IpAddr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() {
        return false;
    }
    match ip {
        // IPv6 链路本地必须带 scope id（`fe80::1%eth0`）才能连通，裸地址没法用
        std::net::IpAddr::V6(v6) => !(v6.segments()[0] & 0xffc0 == 0xfe80),
        std::net::IpAddr::V4(_) => true,
    }
}

/// 网卡「已启用」标志（`IFF_UP`）。
///
/// 各系统的取值都是 `0x1`（Linux / macOS / \*BSD / Android 的 `<net/if.h>`），
/// 这里写常量而不是 `libc::IFF_UP`：该常量不是所有目标平台都有导出，
/// 而过滤「没插网线的 Docker 网桥」这类地址只需要这一个位。
const IFF_UP: u32 = 0x1;

/// 把一条 `ip/前缀` 记录收进结果（`ip addr` 输出解析用）
#[cfg(target_os = "android")]
fn push_cidr(found: &mut Vec<String>, cidr: &str) {
    let host = cidr.split('/').next().unwrap_or("").trim();
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        if is_usable_ip(ip) {
            found.push(ip.to_string());
        }
    }
}

#[cfg(all(unix, not(target_os = "android")))]
mod platform {
    use super::{is_usable_ip, IFF_UP};

    /// `getifaddrs(3)` 枚举网卡地址（Linux / macOS / Windows 之外的桌面 Unix）
    pub fn addresses() -> Vec<String> {
        let mut found = Vec::new();
        let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
        // SAFETY: 由 libc 分配链表，成功时用 freeifaddrs 释放（见下）
        if unsafe { libc::getifaddrs(&mut head) } != 0 {
            log::debug!("枚举网卡地址失败：{}", std::io::Error::last_os_error());
            return found;
        }
        let mut cursor = head;
        while !cursor.is_null() {
            // SAFETY: cursor 来自 getifaddrs 的链表，逐个 next 前进
            let entry = unsafe { &*cursor };
            // 只列已启用的网卡：`NO-CARRIER` 的 Docker 网桥（172.17.x.x）等未启用地址
            // 对用户没有意义，列出来只会让人挑错地址
            let is_up = entry.ifa_flags & IFF_UP != 0;
            if is_up && !entry.ifa_addr.is_null() {
                // SAFETY: ifa_addr 指向该网卡的 sockaddr
                let family = unsafe { (*entry.ifa_addr).sa_family as i32 };
                let ip = match family {
                    libc::AF_INET => {
                        // SAFETY: family 已确认是 AF_INET，可当作 sockaddr_in 读
                        let addr = unsafe { &*(entry.ifa_addr as *const libc::sockaddr_in) };
                        Some(std::net::IpAddr::V4(std::net::Ipv4Addr::from(u32::from_be(
                            addr.sin_addr.s_addr,
                        ))))
                    }
                    libc::AF_INET6 => {
                        // SAFETY: family 已确认是 AF_INET6，可当作 sockaddr_in6 读
                        let addr = unsafe { &*(entry.ifa_addr as *const libc::sockaddr_in6) };
                        Some(std::net::IpAddr::V6(std::net::Ipv6Addr::from(addr.sin6_addr.s6_addr)))
                    }
                    _ => None,
                };
                if let Some(ip) = ip {
                    if is_usable_ip(ip) {
                        found.push(ip.to_string());
                    }
                }
            }
            // 链表节点：`ifa_next` 是普通字段读取，空值由循环条件兜住
            cursor = entry.ifa_next;
        }
        // SAFETY: head 由 getifaddrs 成功分配
        unsafe { libc::freeifaddrs(head) };
        found
    }
}

/// Android 没有可用的 `getifaddrs`（bionic 的符号藏在私有 libc 里，不导出给应用），
/// 改用系统自带 `ip addr` 的输出来枚举。解析失败只说明「拿不到」，不影响同步本身。
#[cfg(target_os = "android")]
mod platform {
    use super::push_cidr;

    pub fn addresses() -> Vec<String> {
        let mut found = Vec::new();
        let output = match std::process::Command::new("ip").arg("addr").output() {
            Ok(output) => output,
            Err(error) => {
                log::debug!("执行 ip addr 失败，无法列出本机地址：{error}");
                return found;
            }
        };
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let line = line.trim();
            // 形如 `inet 192.168.0.101/24 brd ...` / `inet6 fe80::1/64 scope link`
            let Some(rest) = line
                .strip_prefix("inet ")
                .or_else(|| line.strip_prefix("inet6 "))
            else {
                continue;
            };
            let cidr = rest.split_whitespace().next().unwrap_or("");
            push_cidr(&mut found, cidr);
        }
        found
    }
}

/// 其它平台（Windows 等）暂不枚举：界面按「拿不到地址」处理，同步本身不受影响。
#[cfg(not(any(unix, target_os = "android")))]
mod platform {
    pub fn addresses() -> Vec<String> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_and_unspecified_are_not_addresses_to_share() {
        assert!(!is_usable_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_usable_ip("0.0.0.0".parse().unwrap()));
        assert!(!is_usable_ip("::".parse().unwrap()));
        assert!(!is_usable_ip("::1".parse().unwrap()));
        // IPv6 链路本地要 scope id 才能连，裸地址不可用
        assert!(!is_usable_ip("fe80::1".parse().unwrap()));
        assert!(is_usable_ip("192.168.0.101".parse().unwrap()));
        assert!(is_usable_ip("fd00::1".parse().unwrap()));
    }

    #[test]
    fn addresses_never_contain_a_bind_address() {
        for addr in local_addresses() {
            assert_ne!(addr, "0.0.0.0", "通配地址不能当本机地址展示");
            assert_ne!(addr, "::", "通配地址不能当本机地址展示");
        }
    }

    /// 排序把「像局域网地址」的排前面：用户最可能就是要抄那一个
    #[test]
    fn lan_addresses_come_before_virtual_ones() {
        let mut list = vec![
            "172.17.0.1".to_string(),
            "100.115.206.79".to_string(),
            "fd00::1".to_string(),
            "10.0.0.5".to_string(),
            "192.168.0.107".to_string(),
        ];
        list.sort_by_key(|addr| address_rank(addr));
        assert_eq!(
            list,
            vec!["192.168.0.107", "10.0.0.5", "100.115.206.79", "172.17.0.1", "fd00::1"]
        );
    }
}

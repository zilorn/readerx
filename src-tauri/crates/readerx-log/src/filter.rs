//! 日志级别过滤：`READERX_LOG` 风格的一行规格 → 全局级别 + 按 target 前缀的覆盖。
//!
//! 规格语法（逗号分隔，越靠后的同名规则优先，最长前缀命中优先）：
//!
//! ```text
//! info                              全局 info
//! debug                             全局 debug
//! off                               全关
//! readerx_source=debug              该 target（含子模块）debug
//! readerx_source::host=trace,info   指定模块 trace，其余 info
//! readerx_source                    target 不带级别 = 该 target trace
//! ```
//!
//! 只做「前缀匹配 + 全局兜底」这一件事：比起引入 `env_logger` 的正则过滤器，
//! 这点语法足够定位问题，也不会让日志开销随规则条数增长。

use log::{Level, LevelFilter};

/// 一条 `target=level` 覆盖规则
#[derive(Debug, Clone)]
struct Directive {
    /// target 前缀（不含 `::` 边界，匹配时按 `::` 分段比较）
    target: String,
    level: LevelFilter,
}

/// 解析后的过滤器
#[derive(Debug, Clone)]
pub struct Filter {
    global: LevelFilter,
    directives: Vec<Directive>,
    /// 传给 `log::set_max_level` 的上限：只放行「可能被任何规则接受」的记录，
    /// 比全局级别低的记录在门面层就被丢掉，不必进到格式化。
    max: LevelFilter,
}

impl Default for Filter {
    fn default() -> Self {
        Self::parse("info").unwrap_or(Self {
            global: LevelFilter::Info,
            directives: Vec::new(),
            max: LevelFilter::Info,
        })
    }
}

impl Filter {
    /// 解析一行规格；非法级别名报错（调用方决定是退回默认还是提示用户）
    pub fn parse(spec: &str) -> Result<Self, String> {
        let spec = spec.trim();
        let mut filter = Self {
            global: LevelFilter::Info,
            directives: Vec::new(),
            max: LevelFilter::Info,
        };
        if spec.is_empty() {
            filter.recompute_max();
            return Ok(filter);
        }
        for raw in spec.split(',') {
            let part = raw.trim();
            if part.is_empty() {
                continue;
            }
            match part.split_once('=') {
                Some((target, level)) => {
                    let target = normalize_target(target)?;
                    let level = parse_level(level)?;
                    filter.push_directive(target, level);
                }
                // 不带 `=`：能解析成级别就是全局级别，否则按「该 target 全开」处理
                None => match parse_level(part) {
                    Ok(level) => filter.global = level,
                    Err(_) => {
                        let target = normalize_target(part)?;
                        filter.push_directive(target, LevelFilter::Trace);
                    }
                },
            }
        }
        filter.recompute_max();
        Ok(filter)
    }

    /// 规格回显（前端展示当前生效的级别）
    pub fn spec(&self) -> String {
        if self.directives.is_empty() {
            return level_name(self.global).to_string();
        }
        let mut parts = vec![level_name(self.global).to_string()];
        for d in &self.directives {
            parts.push(format!("{}={}", d.target, level_name(d.level)));
        }
        parts.join(",")
    }

    /// 全局级别（不含覆盖规则）
    pub fn global(&self) -> LevelFilter {
        self.global
    }

    /// 传给 `log::set_max_level` 的上限
    pub fn max_level(&self) -> LevelFilter {
        self.max
    }

    /// 是否放行这条记录
    pub fn enabled(&self, level: Level, target: &str) -> bool {
        if level == Level::Error && self.global == LevelFilter::Off && self.directives.is_empty() {
            return false;
        }
        self.level_for(target) >= level.to_level_filter()
    }

    /// 该 target 实际生效的最低级别：最长前缀命中 > 全局兜底
    fn level_for(&self, target: &str) -> LevelFilter {
        let mut best: Option<&Directive> = None;
        for directive in &self.directives {
            if target_matches(&directive.target, target) {
                let longer = best
                    .map(|current| directive.target.len() > current.target.len())
                    .unwrap_or(true);
                if longer {
                    best = Some(directive);
                }
            }
        }
        best.map(|d| d.level).unwrap_or(self.global)
    }

    fn push_directive(&mut self, target: String, level: LevelFilter) {
        // 同一 target 后写的覆盖先写的
        if let Some(existing) = self.directives.iter_mut().find(|d| d.target == target) {
            existing.level = level;
            return;
        }
        self.directives.push(Directive { target, level });
    }

    fn recompute_max(&mut self) {
        let mut max = self.global;
        for directive in &self.directives {
            if directive.level > max {
                max = directive.level;
            }
        }
        self.max = max;
    }
}

/// target 按 `::` 分段匹配：`readerx_source` 命中 `readerx_source::host`，
/// 但 `readerx_sourc` 不算命中（避免前缀误伤）。
fn target_matches(prefix: &str, target: &str) -> bool {
    if prefix == target {
        return true;
    }
    target
        .strip_prefix(prefix)
        .map(|rest| rest.starts_with("::"))
        .unwrap_or(false)
}

fn normalize_target(raw: &str) -> Result<String, String> {
    let target = raw.trim();
    if target.is_empty() {
        return Err("日志过滤规则的 target 为空".to_string());
    }
    Ok(target.to_string())
}

fn parse_level(raw: &str) -> Result<LevelFilter, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "off" | "none" | "0" => Ok(LevelFilter::Off),
        "error" | "1" => Ok(LevelFilter::Error),
        "warn" | "warning" | "2" => Ok(LevelFilter::Warn),
        "info" | "3" => Ok(LevelFilter::Info),
        "debug" | "4" => Ok(LevelFilter::Debug),
        "trace" | "5" => Ok(LevelFilter::Trace),
        other => Err(format!("无法识别的日志级别: {other}")),
    }
}

/// 级别的规范名称（写进规格与界面）
pub fn level_name(level: LevelFilter) -> &'static str {
    match level {
        LevelFilter::Off => "off",
        LevelFilter::Error => "error",
        LevelFilter::Warn => "warn",
        LevelFilter::Info => "info",
        LevelFilter::Debug => "debug",
        LevelFilter::Trace => "trace",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level_of(spec: &str, target: &str) -> LevelFilter {
        Filter::parse(spec).unwrap().level_for(target)
    }

    #[test]
    fn global_level_applies_as_fallback() {
        assert_eq!(level_of("warn", "readerx::storage"), LevelFilter::Warn);
        assert_eq!(level_of("debug", "anything"), LevelFilter::Debug);
        assert_eq!(level_of("off", "anything"), LevelFilter::Off);
    }

    #[test]
    fn target_prefix_beats_global_and_needs_segment_boundary() {
        assert_eq!(
            level_of("info,readerx_source=debug", "readerx_source::host"),
            LevelFilter::Debug
        );
        assert_eq!(
            level_of("info,readerx_source=debug", "readerx_source"),
            LevelFilter::Debug
        );
        // 只是字符串前缀、不是模块段，不算命中
        assert_eq!(
            level_of("info,readerx_source=debug", "readerx_source_extra"),
            LevelFilter::Info
        );
        // 更长的前缀优先
        assert_eq!(
            level_of("warn,readerx=info,readerx::host=debug", "readerx::host::x"),
            LevelFilter::Debug
        );
    }

    #[test]
    fn bare_target_means_trace_and_duplicates_take_last() {
        assert_eq!(level_of("readerx_source", "readerx_source::engine"), LevelFilter::Trace);
        assert_eq!(
            level_of("readerx_source=debug,readerx_source=error", "readerx_source::engine"),
            LevelFilter::Error
        );
    }

    #[test]
    fn max_level_covers_overrides_above_global() {
        let filter = Filter::parse("error,readerx_source=debug").unwrap();
        assert_eq!(filter.max_level(), LevelFilter::Debug);
        assert!(filter.enabled(Level::Debug, "readerx_source::host"));
        assert!(!filter.enabled(Level::Debug, "readerx::storage"));
        assert!(filter.enabled(Level::Error, "readerx::storage"));
    }

    #[test]
    fn invalid_level_is_rejected_with_readable_message() {
        let error = Filter::parse("info,readerx=chatty").unwrap_err();
        assert!(error.contains("chatty"), "{error}");
    }

    #[test]
    fn empty_spec_falls_back_to_info() {
        let filter = Filter::parse("   ").unwrap();
        assert_eq!(filter.global(), LevelFilter::Info);
        assert_eq!(filter.spec(), "info");
    }
}

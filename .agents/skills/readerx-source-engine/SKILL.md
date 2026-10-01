---
name: readerx-source-engine
description: 修改 ReaderX 书源引擎、Boa 宿主 API、浏览器认证后端、登录态持久化或独立 CLI，维护 App/CLI 共用边界与数据兼容；普通书架样式和本地书籍解析不触发。
---

# ReaderX 书源引擎开发

先读取 [AGENTS.md](../../../AGENTS.md) 的书源、储存、平台与日志章节。链接以本技能目录为起点；Rust 命令在 src-tauri 执行。

## 定位与参考

- 核心引擎和持久化位于 src-tauri/crates/readerx-source，不依赖 Tauri/GUI；App 与 CLI 共用，不在主 crate 重写引擎或存储。
- 修改字段、规则或宿主 API 时按范围读取 [规范](../../../docs/book-source-spec.md)、[API](../../../docs/book-source-api.md) 或 [使用指南](../../../docs/book-source-guide.md)，不默认加载全部文档。
- CLI 与认证任务读 [CLI 文档](../../../docs/book-source-cli.md)；Cloudflare 任务再读 [Cloudflare 文档](../../../docs/cloudflare.md)。
- 日志任务读 [日志文档](../../../docs/logging.md)。使用 log 门面；URL 通过 readerx_log::redact::url，错误地址通过 redact::urls_in_text 脱敏。不输出 Cookie、token、请求头值、存储快照、正文。循环仅 debug，用户可见失败走 reportFailure，不重复记错。

## 跨宿主契约

- 真实浏览器能力通过 auth::AuthProvider 注册。App 使用 tauri-plugin-webview-login，CLI 使用可选 CDP/WebKit 后端；核心不加平台认证分支。
- AuthRequest 携带脚本、会话 UA 与四段 ProbeScript。窗口 UA 与请求 UA 一致，后端原样执行探针；格式改动同时检查 Android、桌面、CDP、CLI WebKit 四个宿主。
- 桌面登录看 plugins/tauri-plugin-webview-login；Linux 用 WebKitGTK CookieManager，不用宿主 eval 读隔离的页面 localStorage。
- 数据根目录由宿主 store::init_data_root 指定。修改格式前检查 store.rs 布局和旧数据，保持 App/CLI 共用数据兼容，明确迁移方式。
- 新 App command 同步 src-tauri/src/lib.rs 注册与 capability；书源变动同步相应 docs/。

## 验证与交付

- 在 src-tauri 运行 `cargo test -p readerx-source`；CLI 改动追加 `cargo build -p readerx-source --features cli`，CLI WebKit 改动追加 `cargo build -p readerx-source --features "cli webkit"`。需要系统库时告诉用户；缓存写入被沙箱阻拦时提权，不换缓存目录。
- 按改动验证宿主契约、错误路径或旧数据迁移；前端桥接改动同时检查类型与 i18n，提交前运行 pnpm build。
- 仅提交任务代码与文档，使用中文提交信息，报告检查结果和未验证的平台。

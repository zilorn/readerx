---
name: readerx-source-engine
description: 修改 ReaderX 书源引擎、Boa 宿主 API、浏览器认证后端、登录态持久化或独立 CLI，维护 App/CLI 共用边界与数据兼容；普通书架样式和本地书籍解析不触发。
---

# ReaderX 书源引擎开发

按以下边界定位实现与验证范围。链接以本技能目录为起点；Rust 命令在 src-tauri 执行。

## 定位与参考

- 核心引擎和持久化位于 src-tauri/crates/readerx-source，不依赖 Tauri/GUI；App 与 CLI 共用，不在主 crate 重写引擎或存储。
- 修改字段、规则或宿主 API 时按范围读取 [规范](../../../docs/book-source-spec.md)、[API](../../../docs/book-source-api.md) 或 [使用指南](../../../docs/book-source-guide.md)，不默认加载全部文档。
- CLI 与认证任务读 [CLI 文档](../../../docs/book-source-cli.md)；Cloudflare 任务再读 [Cloudflare 文档](../../../docs/cloudflare.md)。
- 含图正文读 [图片文档](../../../docs/book-source-image.md)，前端转换查看 src/lib/sourceContent.ts、src/lib/booksTypes.ts 与 src/lib/chapterImages.ts；段内图片使用字符锚点，保留远端身份与本地文件引用，图片失败不应让已取回正文失效。
- 日志任务读 [日志文档](../../../docs/logging.md)。使用 log 门面；URL 通过 readerx_log::redact::url，错误地址通过 redact::urls_in_text 脱敏。不输出 Cookie、token、请求头值、存储快照、正文。循环仅 debug，用户可见失败走 reportFailure，不重复记错。

## 跨宿主契约

- 真实浏览器能力通过 auth::AuthProvider 注册。App 使用 tauri-plugin-webview-login，CLI 使用可选 CDP/WebKit 后端；核心不加平台认证分支。CLI 在命令分发前统一注册后端，覆盖 call/run 的自动认证与 webview.login；`--auth none` 仅在本次装载书源时关闭 autoAuth，不写回书源。
- CDP 认证在连接或启动浏览器前验证 URL 为带 host 的 HTTP(S) 地址；Cookie 域名或目标 host 缺失时拒绝匹配，不得退回全站 Cookie。
- AuthRequest 携带脚本、会话 UA 与四段 ProbeScript。窗口 UA 与请求 UA 一致，后端原样执行探针；格式改动同时检查 Android、桌面、CDP、CLI WebKit 四个宿主。
- 桌面登录看 src-tauri/plugins/tauri-plugin-webview-login；Linux 用 WebKitGTK CookieManager 读取含 httpOnly 的 Cookie；页面存储能力以 src/desktop.rs 的实测表为准，不用宿主 eval 读隔离的页面 localStorage。探针生成逻辑在引擎 storage.rs，后端不解析其内部结构。桌面正常收尾与 Android 一样不要求 Cookie 非空，仍采集并透传存储探针；等待标记按求值字符串解码后的完整值比较，不匹配快照子串。
- 数据根目录由宿主 store::init_data_root 指定。修改格式前检查 store.rs 布局和旧数据，保持 App/CLI 共用数据兼容，明确迁移方式。
- 书源稳定 ID 与迁移查看 src-tauri/crates/readerx-source/src/id_migration.rs；涉及在线书引用、分组或同步身份时同时读 [数据技能](../readerx-data/SKILL.md)，检查 src-tauri/src/sync/data_ids.rs 与 src/lib/dataIds.ts，不因编辑书源地址重建已有稳定 ID。
- App 保存书源通过 sync/data_ids.rs 的 save_source；文件仍由共享书源 crate 写入，数据库中的 bookSourceId 引用与迁移映射由 App 维护。旧元信息损坏时保留映射并延后引用迁移。
- 新 App command 同步 src-tauri/src/lib.rs 注册与 capability；书源变动同步相应 docs/。

## 验证与交付

按 [技能维护规则](../../skills.md#技能维护) 同步本次改变的宿主契约、入口与验证方法。

- 在 src-tauri 运行 `cargo test -p readerx-source`；CLI 改动追加 `cargo build -p readerx-source --features cli`；CDP 改动追加 `cargo test -p readerx-source --features cli` 以覆盖可选后端，CLI WebKit 改动追加 `cargo build -p readerx-source --features "cli webkit"`。需要系统库时告诉用户；缓存写入被沙箱阻拦时提权，不换缓存目录。
- 桌面登录插件改动追加 `cargo test -p tauri-plugin-webview-login`，覆盖无 Cookie 的存储采集收尾与探针等待标记判断；真实 WebView 的平台能力另行实测。
- 按改动验证宿主契约、错误路径或旧数据迁移；前端桥接改动同时检查类型与 i18n，提交前运行 pnpm build。
- 仅提交任务代码与文档，使用中文提交信息，报告检查结果和未验证的平台。

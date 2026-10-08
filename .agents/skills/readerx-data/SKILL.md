---
name: readerx-data
description: 修改 ReaderX 本地书库存储、稳定身份与旧数据迁移、数据备份恢复、局域网同步引擎及 App 接线、阅读时长统计；纯界面样式、书源规则执行或版本发布不触发。
---

# ReaderX 数据维护

先确定涉及的存储、身份与数据通道，只读相应参考。代码路径以仓库根目录为起点，Rust 命令在 src-tauri 执行；前端改动同时使用 [前端技能](../readerx-frontend/SKILL.md)。

## 定位与参考

| 功能 | 实现入口 | 按需资料 |
| --- | --- | --- |
| 本地书库存储、迁移、稳定 ID | src-tauri/src/book_store.rs、book_store/sqlite.rs、book_store/backup.rs、storage.rs、models.rs、sync/identity.rs、sync/book_ids.rs、sync/data_ids.rs；src/lib/books.ts、booksTypes.ts、dataIds.ts | [存储与身份约束](references/contracts.md#书库与稳定身份) |
| 备份与恢复 | src-tauri/src/data_transfer/；src/lib/backup.ts、src/pages/DataBackup.tsx | [备份约束](references/contracts.md#备份与恢复)、[备份文档](../../../docs/backup.md) |
| 同步协议、合并与传输 | src-tauri/crates/readerx-sync/ | [同步约束](references/contracts.md#局域网同步)、[同步文档](../../../docs/sync.md) 对应章节 |
| 同步 App 接线与落库 | src-tauri/src/sync/；src/lib/sync.ts、src/components/SyncProgress.tsx | 同步文档 App 接线、实时落库与停止部分 |
| 阅读时长 | src/lib/readingTime.ts、src/pages/ReadingTime.tsx；src-tauri/src/reading_time.rs、sync/reading_time.rs | [计时约束](references/contracts.md#阅读时长)、[阅读时长文档](../../../docs/reading-time.md) |

持久化由 Rust 承担；readerx-sync 保持独立于 Tauri/GUI，宿主书库读写与界面事件留在 App 接线层。修改书源存储或登录态时同时使用 [书源引擎技能](../readerx-source-engine/SKILL.md)。日志沿用 [日志文档](../../../docs/logging.md)。

## 验证与交付

- 本地书库与身份迁移：`cargo test -p readerx --lib book_store`，迁移变动再运行 `cargo test -p readerx --lib sync::book_ids` 或 `cargo test -p readerx --lib sync::data_ids`；确认筛选命中了相关测试。
- 备份：`cargo test -p readerx --lib data_transfer`，检查合并/覆盖、凭据过滤和真实归档往返；与同步钩子交叉时追加 `cargo test -p readerx --test sync_bridge`。
- 同步核心：`cargo test -p readerx-sync`；CLI 改动追加 `cargo build -p readerx-sync --features cli`。App 接线改动运行 `cargo test -p readerx --test sync_bridge`，按需追加 `cargo test -p readerx --lib sync`。
- 阅读时长：`cargo test -p readerx --lib reading_time`，同步逻辑变动追加 sync_bridge；计时前端验证可见/聚焦、离页、挂起和跨日场景。
- 前端桥接同时运行类型、i18n 与构建检查。纯技能/文档变动仅核对链接、代码入口和格式；无法验证的 Android 文件选择、真实双设备网络或原生生命周期如实报告，不以单测代替平台实测。
- 按 [技能维护规则](../../skills.md#技能维护) 同步受影响的契约和 docs；仅提交任务文件，中文提交信息，报告提交与验证范围。

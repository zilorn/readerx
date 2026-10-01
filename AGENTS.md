# AGENTS.md

未经用户明确要求，不修改本文件。CLAUDE.md 为指向本文件的软链。

## 项目与技能入口

ReaderX 是 Tauri 2 + SolidJS 电子书阅读器，支持本地书库、在线书源及 Android / Linux / Windows。Android 为首要目标；手机与桌面共用页面、路由和业务逻辑，外壳按窗口宽度切换。

专项约定只维护在下列 skill 中；执行对应任务前读取相关 SKILL.md。技能索引见 [.agents/skills.md](.agents/skills.md)。

| 任务 | 技能 |
| --- | --- |
| 页面、外壳、状态、主题、i18n、构建资源 | [readerx-frontend](.agents/skills/readerx-frontend/SKILL.md) |
| 书源引擎、宿主 API、浏览器认证、登录态、CLI | [readerx-source-engine](.agents/skills/readerx-source-engine/SKILL.md) |
| `wt: XXX` 或明确要求 worktree | [readerx-worktree](.agents/skills/readerx-worktree/SKILL.md) |
| 指定版本更新或发布 | [readerx-release](.agents/skills/readerx-release/SKILL.md) |

## 通用开发约定

- 使用 pnpm，新增依赖用 `pnpm add`。开发服务器为 `http://localhost:1420`；启动前确认端口，复用已有服务。
- 后端逻辑优先放 Rust，持久化由 Rust 操作；修改数据格式时考虑旧数据迁移。
- 新增 App Rust command 同步 `src-tauri/src/lib.rs` 的 `invoke_handler`，按需配置 `src-tauri/capabilities`。
- 不随意删除已有功能，不增加无意义页面或说明性提示；职责过多的文件应按业务拆分。
- 普通开发不修改版本或 CHANGELOG.md；版本与发布按对应 skill 执行。
- 不手写或提交生成的简繁词典，不提交 dist/、node_modules/ 等构建产物。

## 日志与失败

所有业务代码遵循 [docs/logging.md](docs/logging.md)：

- Rust 用 `log` 门面，前端用 `src/lib/logger.ts` 的 `createLogger(scope)`；不直接写 `println!` / `console.*`，CLI 结果输出除外。
- `error` 记录异常，`warn` 记录可恢复失败或降级，`info` 记录完整用户动作；逐章、逐请求等循环细节只用 `debug`。
- 不记录凭据、请求头值、存储快照或正文；只记数量或长度。URL 用 `readerx_log::redact::url()`，错误文本中的地址用 `redact::urls_in_text()` 脱敏。
- 前端用户可见失败走 `reportFailure(...)`，不再重复记录 `log.error`。

## 验证与环境

- 修改前端后运行 `pnpm exec tsc --noEmit`、`pnpm run i18n:check`；提交前保证 `pnpm build` 通过。纯文档/技能修改检查链接、内容与技能格式即可。
- Rust 检查在 `src-tauri` 执行，选择涉及的 crate / feature；专项检查见对应 skill。
- 沙箱阻拦正常操作或 cargo / pnpm 缓存写入时申请提权，不通过临时缓存目录绕过。需要安装系统库时告诉用户。

## Git 交付

- 完成任务后提交，仅暂存本次任务文件；不操作用户的无关修改。任务较大时按完整改动分批提交。
- 提交信息用中文，格式为 `feat/fix/docs: 内容`。最终用表格报告提交哈希与提交信息，并简述改动、验证结果及未验证范围。
- worktree 的创建、整合与清理，以及发布的 tag / 推送，按对应 skill 和用户授权执行。

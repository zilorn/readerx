# 项目技能

技能放在 `.agents/skills/`，随仓库版本管理；`.claude/skills` 是指向 `../.agents/skills` 的软链，共用同一份内容。全局协作约定已由 agent 加载；worktree、PR 与发布流程完整维护在对应技能中。

| 技能 | 适用任务 | 调用示例 |
| --- | --- | --- |
| [readerx-worktree](skills/readerx-worktree/SKILL.md) | worktree 开发、整合、清理 | `$readerx-worktree wt: reader-theme，调整阅读主题` |
| [readerx-pr](skills/readerx-pr/SKILL.md) | 从 issue 或需求到 Pull Request 的完整交付 | `$readerx-pr pr: #12` |
| [readerx-release](skills/readerx-release/SKILL.md) | 指定版本更新与发布 | `$readerx-release 更新v0.3.1` |
| [readerx-frontend](skills/readerx-frontend/SKILL.md) | 页面、外壳、状态、样式、i18n | `$readerx-frontend 修复桌面抽屉宽度` |
| [readerx-source-engine](skills/readerx-source-engine/SKILL.md) | 书源、认证、持久化、CLI | `$readerx-source-engine 修复CLI登录态复用` |
| [readerx-data](skills/readerx-data/SKILL.md) | 本地书库存储、稳定身份迁移、备份、局域网同步、阅读时长 | `$readerx-data 修复备份恢复后重复计时` |

Codex 支持从仓库 `.agents/skills/` 发现技能，并根据 description 自动选择；未出现新技能时可重启。参见 [官方技能文档](https://learn.chatgpt.com/docs/build-skills)。其他 agent 可读取对应 SKILL.md，自动发现与调用语法以其自身支持为准。

技能中的相对链接以 SKILL.md 所在目录为起点，代码与命令路径以仓库根目录为起点（Rust 检查在 src-tauri）。worktree、PR 与发布流程只维护在对应 SKILL.md；前端与引擎技能按需引用 docs/ 中的专项资料。

发布时 bump 参数不带 v，tag 带 v。worktree 技能在确认提交已整合后清理，保留未提交文件与未整合成果；PR 交付由 PR 合并完成整合，合并前保留 worktree 与任务分支。

## 技能维护

- 实现入口、数据契约、平台差异或验证方法发生变化时，在同一任务中更新受影响的项目 skill 与引用资料，随代码一起提交；纯样式或局部修复没有改变这些信息时无需改写 skill。
- 新增值得复用的功能知识时，先归入职责对应的现有 skill。SKILL.md 保留定位、关键约束、按需阅读入口和验证方法；较长的实现说明放 references/，用户操作与完整协议说明继续维护在 docs/，不要复制两份完整文档。
- 内容以当前代码与验证结果为依据。文档和代码不一致时核实实际行为，修正本次涉及的过时说明；尚未验证的平台或计划中的功能不能写成已实现的保证。
- 移动、重命名或删除实现时，同时修正入口链接和旧说明；改变触发范围或新增 skill 时更新本索引及 description。AGENTS.md 仅在用户明确要求修改该文件时调整。
- 文档任务检查相对链接、代码路径和技能格式即可；代码任务仍执行对应开发检查。不要为了“保持更新”记录每次提交、临时排查过程或重复通用开发规范。

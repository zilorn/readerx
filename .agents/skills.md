# 项目技能

技能放在 `.agents/skills/`，随仓库版本管理；`.claude/skills` 是指向 `../.agents/skills` 的软链，共用同一份内容。全局协作约定已由 agent 加载；worktree 与发布流程完整维护在对应技能中。

| 技能 | 适用任务 | 调用示例 |
| --- | --- | --- |
| [readerx-worktree](skills/readerx-worktree/SKILL.md) | worktree 开发、整合、清理 | `$readerx-worktree wt: reader-theme，调整阅读主题` |
| [readerx-release](skills/readerx-release/SKILL.md) | 指定版本更新与发布 | `$readerx-release 更新v0.3.1` |
| [readerx-frontend](skills/readerx-frontend/SKILL.md) | 页面、外壳、状态、样式、i18n | `$readerx-frontend 修复桌面抽屉宽度` |
| [readerx-source-engine](skills/readerx-source-engine/SKILL.md) | 书源、认证、持久化、CLI | `$readerx-source-engine 修复CLI登录态复用` |

Codex 支持从仓库 `.agents/skills/` 发现技能，并根据 description 自动选择；未出现新技能时可重启。参见 [官方技能文档](https://learn.chatgpt.com/docs/build-skills)。其他 agent 可读取对应 SKILL.md，自动发现与调用语法以其自身支持为准。

技能中的相对链接以 SKILL.md 所在目录为起点，代码与命令路径以仓库根目录为起点（Rust 检查在 src-tauri）。worktree 与发布流程只维护在对应 SKILL.md；前端与引擎技能按需引用 docs/ 中的专项资料。

发布时 bump 参数不带 v，tag 带 v。worktree 技能在确认提交已整合后清理，保留未提交文件与未整合成果。

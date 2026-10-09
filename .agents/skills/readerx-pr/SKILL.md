---
name: readerx-pr
description: 按 pr: 请求把 issue 或需求做成 Pull Request：读取需求、创建 worktree 完成开发与验证、推送分支并按模板创建 PR；普通本地开发、版本发布与未要求 PR 的任务不触发。
---

# ReaderX PR 交付

本技能包含从需求到 Pull Request 的完整流程；worktree 的建立与清理沿用 [worktree 技能](../readerx-worktree/SKILL.md)，命令在仓库根目录执行，链接以本技能目录为起点。

## 读取需求

- 从 `pr:` 后的内容取得任务：issue 链接、编号或需求描述。拿到链接或编号后先提取编号，用 `gh issue view <n> --comments` 读取标题、正文与评论。
- 明确要达成的行为、涉及范围与验收条件；信息不足且会导致实现范围不同时先向用户确认，不自行扩大需求。
- 用户当次说明与 issue 不一致时以用户为准，并在 PR 中说明差异；需求已实现或已有 PR 覆盖时说明现状并停止，不重复开工。
- 开工前检查 `git status --short`、`git worktree list`、当前分支与远程状态，保留无关修改。

## 建立 worktree 并开发

- 按 worktree 技能创建 `.worktree/<name>` 与分支 `codex/<name>`，名称取任务关键词；已存在同名目录或分支时先确认，不覆盖已有工作。
- 默认从最新 main 起分支；用户指定其他目标分支时尊重该选择，并在 PR 中使用对应 base。
- 在 worktree 内完成改动，运行适用检查：`pnpm exec tsc --noEmit`、`pnpm run i18n:check`、`pnpm build`；涉及 Rust 时在 src-tauri 运行对应 crate 的检查。
- PR 自动检查、手动签名 arm64 APK、签名 Secrets 与产物验收见 [CI 与构建](../../../docs/ci.md)；CI 文件变动检查 Actions 语法，产物收集脚本变动运行 `node --test scripts/collect-artifacts.test.mjs`。
- 同步更新受影响的文档、中英文文案与项目 skill；只提交本次任务文件，提交信息用中文 `feat/fix/docs: 内容`，改动较大时按完整改动分批提交。

## 推送与创建 PR

- 推送前用 `gh pr list --head codex/<name>` 与 `gh pr view <n>` 确认没有重复 PR。
- 推送任务分支：`git push -u origin codex/<name>`。`pr:` 请求包含本次分支推送与创建 PR 的授权；不推送 main，不强推，不批量推送其他分支与 tag。
- 正文写入被忽略的临时文件（如主仓库 `.worktree/<name>-pr-body.md`），用 `gh pr create --base main --head codex/<name> --title <中文概述> --body-file <路径>` 创建，创建后删除临时文件。
- 正文按 [PR 模板](../../../.github/pull_request_template.md) 填写问题、改动后的行为、实际执行与未验证的检查、数据与兼容性；用 `Fixes #<n>` 关联 issue，未执行的检查不标为通过。

## 收尾

- PR 创建后保留 worktree 与分支，便于按审查反馈在同一分支追加提交并推送，不另开 PR；PR 合并或用户要求清理时再按 worktree 技能移除。
- 用表格报告提交哈希、中文提交信息、issue 与 PR 链接、推送分支与目标分支、实际执行的检查及未验证范围。

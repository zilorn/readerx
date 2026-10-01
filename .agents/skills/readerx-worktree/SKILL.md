---
name: readerx-worktree
description: "在 ReaderX 中按用户指定的 wt 名称创建隔离 worktree、完成开发并整合回 main；用于 wt: XXX 或明确要求 worktree 的任务，普通当前目录开发不触发。"
---

# ReaderX worktree 开发

本技能包含完整 worktree 开发、整合与清理流程。链接以本技能目录为起点，命令在仓库根目录执行。

## 建立工作区

- 查看 `git status --short`、`git worktree list` 和当前分支，确认 main 与任务起点，保留已有修改。
- 使用用户指定的 XXX 创建 `.worktree/XXX`，分支默认 `codex/XXX`；先检查同名路径与分支，不覆盖已有工作。默认从 main 开始，用户明确指定起点时尊重该选择。
- 在 worktree 中完成任务并运行对应检查；不要另起占用 1420 端口的开发服务器。
- 仅提交任务文件，使用中文 `feat/fix/docs: 内容` 提交信息。

## 整合与清理

- 通常先将任务分支 rebase 到 main，再快进 main；工作量大、改动文件多时选择 merge。解决任务冲突并检查最终结果。
- main 工作区有可能受影响的未提交修改时，不自动 stash、reset 或覆盖；保留任务提交并说明整合阻碍。
- 先确认提交已被 main 包含，再移除干净的任务 worktree、删除已整合分支，避免丢失成果。不强制移除带未提交文件的 worktree。
- 用表格报告最终提交哈希、中文提交信息及整合状态；此流程本身不要求远程推送。

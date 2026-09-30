# worktree 相关

此文件将指导你通过worktree更新功能

你需要：

- 在 `[项目根目录]/.worktree/XXX` 创建worktree。
- 完成工作。
- remove worktree.
- 合并（merge）或变基（rebase）到main分支。
- 如有冲突，解决冲突。
- 删除创建分支。

## 关于merge和rebase的选择：

你应优先选择rebase，但如果工作量大，改动文件较多，你应选择merge。

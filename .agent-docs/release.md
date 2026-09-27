# 关于版本发布

## 思维链

- 使用git查找最新发布tag指向的git记录
- 查阅git的diff
- 将更新内容写入至`CHANGELOG.md`的[Unreleased]中
- 运行`pnpm run bump [版本号]`，例如：`pnpm run bump v0.2.0`
- 提交git,信息为`docs: 更新v[版本号]`，例如：`docs: 更新v0.2.0`
- 添加对应tag,例如：`git tag -a v[版本号] -m [提交信息]`
- 将git的commit和tag推送至远程仓库

## 语言风格

你需要简介的说明功能的改动，无需描述详细的实现方案，你只需要简洁的描述即可。

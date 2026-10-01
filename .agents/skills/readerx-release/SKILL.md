---
name: readerx-release
description: 按 ReaderX 发布流程更新指定版本、整理 CHANGELOG、提交并创建发布 tag，在授权范围内推送；用于“更新v0.2.0”等明确版本或发布请求，普通开发不改版本和 CHANGELOG。
---

# ReaderX 版本发布

先读取 [AGENTS.md](../../../AGENTS.md)、[发布流程](../../../.agent-docs/release.md) 与 [版本同步脚本](../../../scripts/bump-version.mjs)。链接以本技能目录为起点，命令在仓库根目录执行。

## 准备发布内容

1. 从请求取得目标版本，不自行升级。检查工作区、当前分支、远程与已有 tag，保留无关修改。
2. 找到最新发布 tag 及其提交，阅读该提交至当前发布内容的 diff；没有 tag 时根据可用历史整理，不虚构基线。
3. 将用户可感知的功能与修复简洁写入 CHANGELOG.md 的 `[Unreleased]`，保留已有条目，不罗列详细实现方案。
4. 执行 `pnpm run bump 0.2.0`，替换为目标版本。**脚本参数不带 v**；原发布文档的 `pnpm run bump v0.2.0` 示例与实现不一致，不能直接照抄。tag 仍使用 `v0.2.0`。
5. 核对 package.json、src-tauri/tauri.conf.json、src-tauri/Cargo.toml、src-tauri/Cargo.lock 的版本一致。正式版脚本归档 `[Unreleased]`，预发布版不归档；目标等于当前版本时脚本跳过，检查状态后决定剩余动作，不伪造变更。

## 验证和发布

- 运行 `pnpm exec tsc --noEmit`、`pnpm run i18n:check`、`pnpm build`；包含 Rust 改动时，在 src-tauri 内运行相关检查。
- 仅暂存发布相关文件，提交信息使用 `docs: 更新v0.2.0`；创建带注释的 `v0.2.0` tag，注释使用同一提交信息。已有 tag 不覆盖、不移动。
- 原流程包含推送 commit 与 tag。已经授权完整发布或推送时核对远程并推送对应分支与本次 tag；仅要求本地版本变更时完成本地结果，远程动作须在授权范围内。不强推，不批量推送其他 tag。
- 验证失败先修复；无法继续时保留成果，报告阻碍与剩余动作。用表格报告提交哈希和中文提交信息，说明版本、tag、推送状态。

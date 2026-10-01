# 参与贡献 / Contributing

欢迎提交问题反馈、功能建议、文档修正和代码改进。仓库的完整协作约定见
[AGENTS.md](./AGENTS.md)；请在开始修改前阅读，且不要修改该文件。
English contributions are welcome. Issue and PR templates include English prompts;
repository conventions are documented in AGENTS.md in Chinese.

## 反馈问题与建议

先搜索 [现有 Issue](https://github.com/zilorn/readerx/issues)，避免重复反馈。
[新建 Issue](https://github.com/zilorn/readerx/issues/new/choose) 时选择问题反馈、功能建议或使用求助模板。
故障反馈请提供 ReaderX 版本、系统版本、复现步骤、预期与实际行为；界面问题可附截图。

日志可从「设置 → 调试 → 应用日志」获取，操作说明见 [日志文档](./docs/logging.md)。
只分享相关片段，并检查是否含有 Cookie、token、密码、私人地址、登录态或书籍正文。
导入问题优先提供有权公开分享的最小样本及格式说明。

较大功能或架构调整建议先开 Issue 讨论使用场景与范围。书源问题请说明涉及的能力、
是否能在站点正常访问，以及使用 App 还是独立 CLI；仅分享有权公开的规则和样本。

## 开发环境

使用 pnpm 管理依赖，新增依赖用 `pnpm add`，保留锁文件。运行原生应用还需要 Rust
工具链及对应平台的 Tauri 开发依赖；Android 开发还需要 Android SDK / NDK。
环境与平台说明可参考 [README](./README.md#开发) 和现有构建工作流。

```bash
git clone https://github.com/zilorn/readerx.git
cd readerx
pnpm install
pnpm dev
```

开发服务器固定使用 `http://localhost:1420`。如果已由 `pnpm tauri android dev`
启动，不要重复启动。浏览器模式用于调界面，原生后端功能应在 Tauri 应用中验证：

```bash
pnpm tauri dev
pnpm tauri android dev
```

## 修改约定

- Android 为首要目标，Linux / Windows 与手机共用页面、路由及本地书库；外壳差异放在 `src/shell/`。
- 页面使用 SolidJS，页面组件默认导出并按现有路由约定懒加载；跨页面状态放在 `src/lib/store.ts`。
- 样式使用 Tailwind CSS v4 和主题变量；图标使用内联 SVG，不用表情或文本符号代替图标。
- 用户可见文案通过 `t()` 翻译，中英文词典同步修改，参见 [i18n 文档](./docs/i18n.md)。
- 后端与持久化优先放在 Rust；修改数据格式时考虑旧数据迁移和兼容性。
- 书源引擎位于 `src-tauri/crates/readerx-source`，保持独立于 Tauri / GUI，相关改动同步更新 `docs/`。
- 日志使用项目统一出口，凭据与书籍正文不进入日志，详见 [日志约定](./docs/logging.md)。
- 不随意删除功能，不修改版本或 `CHANGELOG.md`，除非任务明确要求。
- 不提交 `dist/`、`node_modules/`、构建生成的简繁词典及与本次任务无关的文件。

## 验证改动

代码改动后运行以下检查，提交前保证适用的检查通过：

```bash
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
```

Rust 改动应在 `src-tauri` 目录运行相关 crate 的测试；书源引擎测试为：

```bash
cd src-tauri
cargo test -p readerx-source
```

界面改动应验证手机宽度和桌面宽度，以及涉及的主题与语言；原生集成改动应在对应平台验证。
持久化改动需验证旧数据读取与迁移。仅修改文档或模板时，检查内容、相对链接和模板格式即可。
在 PR 中记录实际执行的检查和未验证的部分，不要将未执行的检查标为通过。

## 提交 Pull Request

1. 从目标分支创建工作分支，一次 PR 聚焦一个明确问题。
2. 完成修改与验证，更新相关文档。
3. 提交信息使用中文，格式为 `feat: 内容`、`fix: 内容` 或 `docs: 内容`。
4. 使用 PR 模板说明问题、最终行为、验证结果，以及迁移或兼容性风险；关联相关 Issue。
5. 根据审查反馈调整，提交时只包含本次任务相关文件。

贡献遵循仓库现有的 [GPL-3.0-only 许可证](./LICENSE)。

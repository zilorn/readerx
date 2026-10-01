---
name: readerx-frontend
description: 开发或修改 ReaderX 的 SolidJS 页面、路由、共享状态、主题、界面文案和手机/桌面外壳，遵循前端与 i18n 约定；纯 Rust 引擎或版本发布不触发。
---

# ReaderX 前端开发

先读取 [AGENTS.md](../../../AGENTS.md) 的对应章节，检查相邻组件。链接以本技能目录为起点，命令在仓库根目录执行。

## 定位职责

- 页面和路由：查看 src/App.tsx、src/shell/routes.ts。页面 default export，App.tsx 用 lazy 引入。保活页只登记 KEPT_PAGES，不写 Route；新主 Tab 同时修改 routes.ts。保活页 Portal 弹层用 closeOnRouteChange 收起。
- 外壳和导航：修改 src/shell/，手机与桌面共用页面。AppShell 只承接外壳选择、Suspense、Toast 与跨页面分组抽屉。跳转用 useNavigate 或 Solid 的 A 组件。
- 状态：跨页面偏好放 src/lib/store.ts 的模块级 signal，修改走 action；组件 signal 仅存局部 UI 状态，不用 createEffect 驱动渲染树。持久化交给 Rust，考虑旧数据迁移。
- 样式：沿用 Tailwind v4、主题 token 和 src/index.css 变量，颜色不写死。body 浮层用 `max-w-[var(--app-column)]`；阅读字号修改保留既有行高、字距和缩进。SVG 图标放 src/components/icons.tsx，不引图标库。
- 平台：窗口宽度决定外壳，不复制桌面页面；桌面文件导入用 readerx_pick_book_file。新增 Rust command 同步 invoke_handler 与所需 capability。

## 按需参考

- 文案与词典：读 [i18n 文档](../../../docs/i18n.md)。界面用 t()，中英 key/占位符同步；模块顶层只存 key，渲染时翻译。持久化兜底值参考 src/lib/bookDisplay.ts。
- 抽屉交互：读 [抽屉文档](../../../docs/drawers.md)。不为说明功能增加无意义页面或提示。
- 日志与失败：读 [日志文档](../../../docs/logging.md)。使用 createLogger，失败走 reportFailure，避免重复记错或输出正文、凭据。
- 简繁词典：同时核对 scripts/han-dict.mjs 与 src/lib/hanDict.ts 的分区定义。生成资源不入库，大块数据不改成 JS 模块。

## 完成检查

运行 `pnpm exec tsc --noEmit`、`pnpm run i18n:check`、`pnpm build`。检查涉及交互的手机与 ≥900px 桌面布局；保活页检查切换后的状态、滚动和弹层，无法实测如实说明。仅提交任务文件，使用中文提交信息；不修改版本、CHANGELOG 或 AGENTS.md。

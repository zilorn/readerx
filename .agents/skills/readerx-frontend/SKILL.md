---
name: readerx-frontend
description: 开发或修改 ReaderX 的 SolidJS 页面、路由、共享状态、主题、界面文案和手机/桌面外壳，遵循前端与 i18n 约定；纯 Rust 引擎或版本发布不触发。
---

# ReaderX 前端开发

检查相邻组件，按以下职责定位改动。链接以本技能目录为起点，命令在仓库根目录执行。

## 定位职责

- 页面和路由：查看 src/App.tsx、src/shell/routes.ts。页面 default export，App.tsx 用 lazy 引入。保活页只登记 KEPT_PAGES，不写 Route；新主 Tab 同时修改 routes.ts。保活页 Portal 弹层用 closeOnRouteChange 收起。
- 外壳和导航：修改 src/shell/，手机与桌面共用页面。AppShell 承接外壳选择、Toast、书源输入弹窗、跨页面分组抽屉与同步导航接线；页面栈、滚动、导航及 Suspense 留在外壳。跳转用 useNavigate 或 Solid 的 A 组件。
- 状态：共享状态沿用 src/lib/ 下对应业务模块的模块级 signal（偏好在 store.ts，书库在 books.ts，分组在 groups.ts），不要全部堆进 store.ts；读取 getter，修改走导出的 setter/action，跨页面偏好不重复保存，不引入 Redux/MobX；组件 signal 仅存局部 UI 状态，不用 createEffect 驱动渲染树。持久化交给 Rust，考虑旧数据迁移。
- 样式：沿用 Tailwind v4、主题 token 和 src/index.css 变量，颜色不写死，浅色/深色/sepia 由 html[data-theme] 切换；手机列宽由 --app-column 控制，桌面由外壳分栏，页面沿用相邻页面的滚动结构。body 浮层用 `max-w-[var(--app-column)]`；阅读字号修改保留既有行高、字距和缩进。SVG 图标放 src/components/icons.tsx，不引图标库，不用表情或文本符号代替按钮图标。复杂样式优先用 @utility 等 Tailwind 机制，注意低版本 Android WebView 兼容性，必要时提供 fallback。
- 平台：窗口宽度决定外壳，不复制桌面页面；桌面文件导入用 readerx_pick_book_file。新增 Rust command 同步 invoke_handler 与所需 capability。

## 按需参考

- 阅读、听书、在线缓存或本地导入：读 [功能实现与约束](references/features.md) 中对应部分；涉及 Rust 书库存储、备份、同步或身份迁移时同时使用 [数据技能](../readerx-data/SKILL.md)。
- 应用更新：读 [更新文档](../../../docs/app-updates.md)，入口为 src/lib/appUpdates.ts 与 src-tauri/src/app_updates.rs；安装包匹配需同步核对 scripts/collect-artifacts.mjs，下载沿用系统浏览器。
- 文案与词典：读 [i18n 文档](../../../docs/i18n.md)。界面用 t()，中英 key/占位符同步；模块顶层只存 key，渲染时翻译。持久化兜底值参考 src/lib/bookDisplay.ts。日志、注释、匹配与持久化字符串不进词典，保持既有中文约定。
- 抽屉交互：读 [抽屉文档](../../../docs/drawers.md)。不为说明功能增加无意义页面或提示。
- 日志与失败：读 [日志文档](../../../docs/logging.md)。使用 createLogger，失败走 reportFailure，避免重复记错或输出正文、凭据。
- 简繁词典：同时修改 scripts/han-dict.mjs 的 HAN_DICT_SECTIONS 与 src/lib/hanDict.ts 的 SECTIONS，保持 readerx-han-dict/1 格式契约。src/generated/han-dict-<方向>.bin 由 Vite 的 hanDict 插件在 dev/build 自动生成，数据来自 opencc-js，不手写或入库。大块数据使用构建期压缩资源、运行时按需加载，不改成 JS 模块。

## 完成检查

按 [技能维护规则](../../skills.md#技能维护) 同步本次改变的实现入口与约束。

运行 `pnpm exec tsc --noEmit`、`pnpm run i18n:check`、`pnpm build`。检查涉及交互的手机与 ≥900px 桌面布局；保活页检查切换后的状态、滚动和弹层，无法实测如实说明。仅提交任务文件，使用中文提交信息；普通前端任务不修改版本、CHANGELOG 或 AGENTS.md；用户明确要求时按任务范围执行。组件 props 显式声明类型，非页面组件具名导出。

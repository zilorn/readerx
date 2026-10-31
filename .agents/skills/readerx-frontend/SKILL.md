---
name: readerx-frontend
description: 开发或修改 ReaderX 的 SolidJS 页面、路由、共享状态、主题、界面文案和手机/桌面外壳，遵循前端与 i18n 约定；纯 Rust 引擎或版本发布不触发。
---

# ReaderX 前端开发

检查相邻组件，按以下职责定位改动。链接以本技能目录为起点，命令在仓库根目录执行。

## 定位职责

- 页面和路由：查看 src/App.tsx、src/shell/routes.ts。页面 default export，App.tsx 用 lazy 引入。保活页只登记 KEPT_PAGES，不写 Route；新主 Tab 同时修改 routes.ts。保活页 Portal 弹层用 closeOnRouteChange 收起。
- 外壳和导航：修改 src/shell/，手机与桌面共用页面。AppShell 承接外壳选择、Toast、书源输入弹窗、跨页面分组抽屉与同步导航接线；页面栈、滚动、导航及 Suspense 留在外壳。跳转用 useNavigate 或 Solid 的 A 组件。
- 桌面页头：PageHeader 通过 src/shell/pageTitle.ts 向 DesktopTitleBar 注册响应式标题、返回与右侧操作；保活页由 PageBody 提供固定路径，不能在异步加载完成时把当前路由当作所属页。合并仅在 usesWindowPageTitle() 为真时生效；全屏保留页面工具栏兜底。阅读器布局和回归入口见 [桌面标题栏](../../../docs/desktop-chrome.md)。
- 状态：共享状态沿用 src/lib/ 下对应业务模块的模块级 signal（偏好在 store.ts，书库在 books.ts，分组在 groups.ts），不要全部堆进 store.ts；读取 getter，修改走导出的 setter/action，跨页面偏好不重复保存，不引入 Redux/MobX；组件 signal 仅存局部 UI 状态，不用 createEffect 驱动渲染树。Tauri 宿主持久化交给 Rust，考虑旧数据迁移；HarmonyOS / 浏览器由 src/lib/webStore.ts 用 IndexedDB 承担同一组后端函数（backend.ts 分流），不要再往 WebView 里塞第三方存储库。
- 样式：沿用 Tailwind v4、主题 token 和 src/index.css 变量，颜色不写死，浅色/深色/sepia 由 html[data-theme] 切换；手机列宽由 --app-column 控制，桌面由外壳分栏，页面沿用相邻页面的滚动结构。body 浮层用 `max-w-[var(--app-column)]`；阅读字号修改保留既有行高、字距和缩进。SVG 图标放 src/components/icons.tsx，不引图标库，不用表情或文本符号代替按钮图标。复杂样式优先用 @utility 等 Tailwind 机制，注意低版本 Android WebView 兼容性，必要时提供 fallback。
- 平台：窗口宽度决定外壳，不复制桌面页面；桌面文件导入用 readerx_pick_book_file。新增 Rust command 同步 invoke_handler 与所需 capability。安卓实体返回键默认走 WebView 历史返回；需要页面接管时用 src/lib/androidBack.ts 的 createAndroidBackHandler（注册 Tauri 的 back-button 监听即接管，注销即恢复默认），只在页面确实能消费返回时才为真，否则会出现按了没反应的返回。HarmonyOS 的 UA 含 OpenHarmony / HarmonyOS / ArkWeb，识别统一放 src/lib/platform.ts；HAP 走 harmonyos/ 的 ArkWeb 外壳与 hash 路由，PWA 外壳与安装事件见 src/lib/pwa.ts 和 public/，不要按 Android 能力处理。

## 按需参考

- 阅读、听书、在线缓存或本地导入：读 [功能实现与约束](references/features.md) 中对应部分；涉及 Rust 书库存储、备份、同步或身份迁移时同时使用 [数据技能](../readerx-data/SKILL.md)。
- 应用更新：读 [更新文档](../../../docs/app-updates.md)，入口为 src/lib/appUpdates.ts 与 src-tauri/src/app_updates.rs；安装包匹配需同步核对 scripts/collect-artifacts.mjs，下载沿用系统浏览器。
- HarmonyOS / PWA：读 [HarmonyOS 文档](../../../docs/harmonyos.md)。HAP 前端由 `pnpm build:hap` 以 `base=./` 生成到 harmonyos/ 的 rawfile；入口与虚拟域名拦截在 harmonyos/entry/src/main/ets/pages/Index.ets，改动后同步验证 hash 路由、返回键与 IndexedDB。manifest 与 sw.js 改动需同步 CACHE_VERSION；PWA / HAP 图标由 scripts/pwa-icons.mjs 在 dev / build 生成，不提交 PNG；IndexedDB 数据结构改在 webStore.ts，保持与 Tauri 后端同名函数的语义一致；不新增第三方存储、PWA 包或 oh-package 依赖。
- 文案与词典：读 [i18n 文档](../../../docs/i18n.md)。界面用 t()，中英 key/占位符同步；模块顶层只存 key，渲染时翻译。持久化兜底值参考 src/lib/bookDisplay.ts。日志、注释、匹配与持久化字符串不进词典，保持既有中文约定。
- 抽屉交互：读 [抽屉文档](../../../docs/drawers.md)。不为说明功能增加无意义页面或提示。
- 日志与失败：读 [日志文档](../../../docs/logging.md)。使用 createLogger，失败走 reportFailure，避免重复记错或输出正文、凭据。
- 剪贴板：日志复制使用 src/lib/clipboard.ts 的 writeClipboardText；Tauri 宿主走原生 clipboard-manager 插件，浏览器开发环境走 Clipboard API。插件在 src-tauri/src/lib.rs 注册，只在主窗口 capability 授予文本写入权限；失败交给调用方 reportFailure，不记录剪贴板内容。
- 原生插件依赖：JS 包与 Rust crate 的主次版本必须一致；剪贴板两端使用 ~ 约束次版本，更新时同时修改并检查锁文件中的实际版本。新增或更新 Tauri 插件后运行 pnpm tauri info 检查版本配对，单独 cargo check 或 pnpm build 无法覆盖 Android 构建的版本检查。
- 简繁词典：同时修改 scripts/han-dict.mjs 的 HAN_DICT_SECTIONS 与 src/lib/hanDict.ts 的 SECTIONS，保持 readerx-han-dict/1 格式契约。src/generated/han-dict-<方向>.bin 由 Vite 的 hanDict 插件在 dev/build 自动生成，数据来自 opencc-js，不手写或入库。大块数据使用构建期压缩资源、运行时按需加载，不改成 JS 模块。

## 完成检查

按 [技能维护规则](../../skills.md#技能维护) 同步本次改变的实现入口与约束。

运行 `pnpm exec tsc --noEmit`、`pnpm run i18n:check`、`pnpm build`。检查涉及交互的手机与 ≥900px 桌面布局；保活页检查切换后的状态、滚动和弹层，无法实测如实说明。仅提交任务文件，提交信息遵循 Conventional Commits（`type(scope): 中文摘要`，scope 可省略）；普通前端任务不修改版本、CHANGELOG 或 AGENTS.md；用户明确要求时按任务范围执行。组件 props 显式声明类型，非页面组件具名导出。

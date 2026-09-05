# AGENTS.md

本文件为仓库协作约定，面向人类与 AI 代理（CLAUDE.md 为指向本文件的软链）。

## 项目是什么

**ReaderX** —— 基于 **Tauri 2 + SolidJS** 的移动端风格电子书阅读器（书架 / 导入 / 设置 / 阅读）。

- 形态：移动端优先的 Web 前端（不要考虑桌面端，**只考虑移动端**），宿主为 Tauri（桌面窗口按手机宽度渲染，也可 `tauri android dev` 跑真机/模拟器）。
- 包管理：**pnpm**（仓库已有 `pnpm-lock.yaml`，新增依赖请用 `pnpm add`）。
- 本地书管理：此项目专注于本地书管理。
- 专注于**移动端**，永久不考虑桌面端，请不要写有关桌面端的逻辑。

## 常用命令

| 命令                     | 说明                                                 |
| ------------------------ | ---------------------------------------------------- |
| `pnpm dev`               | 启动 Vite 开发服务器（固定 `http://localhost:1420`） |
| `pnpm build`             | 生产构建（输出 `dist/`）                             |
| `pnpm exec tsc --noEmit` | 类型检查（严格模式，改动后必须跑，勿提交红叉）       |
| `pnpm tauri dev`         | Tauri 桌面开发窗口                                   |
| `pnpm tauri android dev` | Android 真机/模拟器开发                              |
| `pnpm tauri build`       | 打包发布                                             |

> 端口 1420 可能已被 `tauri android dev` 占用，勿再起第二个 dev server。

## 路由与懒加载约定

- 路由集中在 `src/App.tsx`，用 `@solidjs/router` v1 的 JSX API：

  ```tsx
  <Router root={AppShell}>
    <Route path="/" component={BookshelfPage} />
    ...
  </Router>
  ```

- **每个页面文件必须 default export 一个 Solid 组件**，并在 App.tsx 里用 `lazy(() => import(...))` 引入 —— 新增页面照抄现有写法即可，构建时 Vite 会自动拆 chunk。
- 根布局 `AppShell` 负责：`<Suspense>` 承接懒加载 fallback、根据路由显示/隐藏底部 Tab、路由切换回滚滚动位置。
- 主 Tab 页面才有底部导航；阅读页 / 404 等次级页不显示 Tab。
- 页面内跳转用 `useNavigate()` / `<A href>`（不要写原生 `<a href>`）。

## 状态约定（重要）

- 全局状态一律放 `src/lib/store.ts` 的**模块级 signal**（`createSignal` 于模块顶层创建，无需 Context）。
- 读取即响应式：组件里直接调用导出的 getter 函数即可被追踪；修改走导出的 setter/action。
- 页面内部一次性 UI 状态（搜索词、弹层开关）用组件内 `createSignal`。
- 阅读字号、主题、书架进度是**跨页面共享偏好**：书架→阅读页→设置页应实时联动，勿在页面里各自存一份。
- 不要引入 Redux/MobX 之类的状态库，不要用 `createEffect` 驱动 UI 渲染树。

## 主题与样式约定

- 样式统一使用 **Tailwind CSS v4**（`@tailwindcss/vite` 已接入，入口为 `src/index.css`）。不要在组件里新写手写 BEM/业务 CSS，复杂规则如需 CSS 也优先用 `@utility` 等 Tailwind 机制。
- 三套主题（浅色/深色/护眼 sepia）由 `html[data-theme]` 切换，CSS 变量仍定义在 `src/index.css`；Tailwind 颜色 token 通过 `@theme inline` 映射到 `var(--bg)` / `var(--surface)` / `var(--text)` / `var(--accent)` 等运行期变量。颜色一律走 `var(--*)` 或 Tailwind token（如 `text-text-2`、`bg-accent`），禁止在组件里写死色值。
- 应用外壳为 ≤480px 的居中手机列（`.app` 对应 Tailwind `mx-auto max-w-[480px]`），内容滚动区为 `.app-view` 对应 `flex-1 overflow-y-auto`；新页面按现有结构书写。
- 阅读字号来自全局 signal（px 值内联设置），行高/字距沿用阅读区既有排版（`leading-[1.95]` / `tracking-[0.01em]`、段首 `indent-[2em]`），修改字号勿破坏排版节奏。
- 图标不引第三方库：往 `src/components/icons.tsx` 里加内联 SVG 函数（线性 24px，stroke="currentColor"）。

## 类型与质量门槛

- tsconfig 开启 `strict / noUnusedLocals / noUnusedParameters`：未使用的 import、变量会直接报错，写完先 `pnpm exec tsc --noEmit`。
- 组件 props 用 interface/type 显式声明；页面组件 default export，其余组件具名导出。
- 提交前保证 `pnpm build` 通过；不要提交 `dist/` 与 `node_modules/`。
- 提交前保证是否过度依赖一个文件中的代码，即一个文件承担了太多职责。

## 平台提醒

- Tauri WebView 只认较新的 CSS：flex/grid/backdrop-filter 可用，但避免过度依赖实验特性（`color-mix` 已用，注意低版本 Android WebView 兼容性，必要时加 fallback）。
- 新增 Rust command 需同步注册 `src-tauri/src/lib.rs` 的 `invoke_handler`，并在 `src-tauri/capabilities` 里按需授权。

## 沙箱问题

- 遇到沙箱阻拦请提权。
- 如果需要安装系统库请告诉用户，而不是另找其他方法。
- 如果你发现`cargo` `pnpm`的缓存写入遭到沙箱阻拦，请提权。

错误做法：export一个临时cache目录。
**注意**：如果是临时测试，之后删除的话不要提权。

## 关于前端

- 请使用svg而不是表情，特殊的文本（如返回使用< 这是**绝对禁止**的）。
- 不要加入无意义的页面：可以不加入页面就不加入，除非用户要求。
- 不要加入无意义的文本提示，不要将用户的话写进页面中。

如：
用户：在这个页面中添加爬取`XXX`的功能。
你写的文件中：在此页面通过爬取XXX获取书籍，以便……

这个**绝对禁止**。

## 后端与储存

后端代码尽量写在Rust中，而不是webview。
储存数据，持久化数据请用Rust后端操作，不要将数据储存在webview中。

重要的是：要注意数据迁移。

## 功能删除与修改

- 除非用户强制要求，请不要随意删除功能。（包括删除页面，删除某个功能，删除有重要用途的方法）
- 修改功能可以随意抉择。

## 关于软件版本与更新

- 不要随意修改软件版本。
- 注意更新`CHANGELOG.md`。

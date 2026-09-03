# AGENTS.md

本文件为仓库协作约定，面向人类与 AI 代理（CLAUDE.md 为指向本文件的软链）。

## 项目是什么

**ReaderX** —— 基于 **Tauri 2 + SolidJS** 的移动端风格电子书阅读器（书架 / 发现 / 设置 / 阅读）。

- 形态：移动优先的 Web 前端，宿主为 Tauri（桌面窗口按手机宽度渲染，也可 `tauri android dev` 跑真机/模拟器）。
- 当前阶段：前端骨架 + 本地 mock 数据，尚无后端与真实书源。
- 包管理：**pnpm**（仓库已有 `pnpm-lock.yaml`，新增依赖请用 `pnpm add`）。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动 Vite 开发服务器（固定 `http://localhost:1420`） |
| `pnpm build` | 生产构建（输出 `dist/`） |
| `pnpm exec tsc --noEmit` | 类型检查（严格模式，改动后必须跑，勿提交红叉） |
| `pnpm tauri dev` | Tauri 桌面开发窗口 |
| `pnpm tauri android dev` | Android 真机/模拟器开发 |
| `pnpm tauri build` | 打包发布 |

> 端口 1420 可能已被 `tauri android dev` 占用，勿再起第二个 dev server。

## 目录结构

```
src/
  index.tsx        # 入口：初始化主题 + render(App)
  App.tsx          # 路由定义（JSX <Route>）+ 根布局 AppShell（Suspense + 底部 Tab）
  index.css        # 全局样式 & 三套主题变量（light/dark/sepia）
  components/      # 通用组件：TabBar、BookCover、PageHeader、icons(内联SVG)、LoadingScreen
  pages/           # 路由页面（default export），全部懒加载
    Bookshelf.tsx  # 书架（/）
    Discover.tsx   # 发现（/discover）
    Settings.tsx   # 设置（/settings）
    Reader.tsx     # 阅读（/book/:id，含目录抽屉）
    NotFound.tsx   # 404
  lib/
    mock.ts        # Book 类型 + 假书单 + 正文生成器（接后端时替换）
    store.ts       # 全局状态（主题/书架进度/字号），localStorage 持久化
src-tauri/         # Tauri/Rust 壳，一般无需改动
```

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
- 持久化键统一前缀 `readerx.*`（localStorage）。
- 页面内部一次性 UI 状态（搜索词、弹层开关）用组件内 `createSignal`。
- 阅读字号、主题、书架进度是**跨页面共享偏好**：书架→阅读页→设置页应实时联动，勿在页面里各自存一份。
- 不要引入 Redux/MobX 之类的状态库，不要用 `createEffect` 驱动 UI 渲染树。

## 主题与样式约定

- 三套主题（浅色/深色/护眼 sepia）由 `html[data-theme]` 切换，变量定义在 `src/index.css` 顶部；新增颜色一律走 `var(--*)`，禁止写死色值。
- 应用外壳为 ≤480px 的居中手机列（`.app`），内容滚动区 `.app-view`；新页面按此结构书写。
- 阅读区以字号变量缩放、行高/字距有专门约定（见 `.reader__ch`），修改字号勿破坏排版节奏。
- 图标不引第三方库：往 `src/components/icons.tsx` 里加内联 SVG 函数（线性 24px，stroke="currentColor"）。

## 类型与质量门槛

- tsconfig 开启 `strict / noUnusedLocals / noUnusedParameters`：未使用的 import、变量会直接报错，写完先 `pnpm exec tsc --noEmit`。
- 组件 props 用 interface/type 显式声明；页面组件 default export，其余组件具名导出。
- 提交前保证 `pnpm build` 通过；不要提交 `dist/` 与 `node_modules/`。

## 平台提醒

- Tauri WebView 只认较新的 CSS：flex/grid/backdrop-filter 可用，但避免过度依赖实验特性（`color-mix` 已用，注意低版本 Android WebView 兼容性，必要时加 fallback）。
- 新增 Rust command 需同步注册 `src-tauri/src/lib.rs` 的 `invoke_handler`，并在 `src-tauri/capabilities` 里按需授权。

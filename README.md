# ReaderX

基于 **Tauri 2 + SolidJS + TypeScript** 的移动端风格电子书阅读器。

> 移动优先布局，可跑在 Tauri 桌面窗口（手机宽度列）或 `tauri android dev` 的真机 / 模拟器上。

## 功能

- **书架** `/`：已加入书籍网格、继续阅读、阅读进度、空状态引导
- **发现** `/discover`：搜索 + 分类筛选、书籍列表、一键加入书架
- **设置** `/settings`：浅色 / 深色 / 护眼三套主题、正文字号、书架数据管理
- **阅读** `/book/:id`：章节阅读、上一章 / 下一章、目录抽屉、阅读进度跨页同步
- 路由页面全部**懒加载**（Vite 自动分包），Suspense 加载态
- 主题、书架、字号等偏好持久化在 localStorage（键前缀 `readerx.*`）

当前为前端骨架阶段，书目与正文为本地 mock（`src/lib/mock.ts`），后续可平滑替换为真实书源 / 后端。

## 技术栈

| 层 | 选型 |
| --- | --- |
| UI | SolidJS 1.9 |
| 路由 | @solidjs/router 1.x（JSX Route + lazy 懒加载） |
| 构建 | Vite 8 + TypeScript 6（strict） |
| 桌面/移动壳 | Tauri 2（Rust） |

## 开发

```bash
pnpm install
pnpm dev            # Vite 开发服务器 → http://localhost:1420
pnpm exec tsc --noEmit   # 类型检查
pnpm build          # 前端产物构建（dist/）

pnpm tauri dev            # 桌面窗口
pnpm tauri android dev    # Android 真机/模拟器
```

详见 [AGENTS.md](./AGENTS.md)（仓库协作与代码约定）。

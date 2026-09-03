# ReaderX

基于 **Tauri 2 + SolidJS + TypeScript** 的移动端风格电子书阅读器。

## 功能

- **书架** `/`：本地书籍网格、继续阅读、阅读进度、书籍删除管理
- **发现** `/discover`：书源浏览入口（暂为空态，等接入内容）
- **导入**：书架 `+` / 空状态按钮直接选择 TXT / EPUB，解析后立即入书架，不跳页面
- **设置** `/settings`：浅色 / 深色 / 护眼三套主题、正文字号，分章规则在独立子页管理
- **阅读** `/book/:id`：章节阅读、上一章 / 下一章、目录抽屉、阅读进度跨页同步
- 路由页面全部**懒加载**（Vite 自动分包），Suspense 加载态
- 主题、书架进度、字号、分章规则持久化在 localStorage（键前缀 `readerx.*`）
- 书籍正文与章节存储在浏览器 IndexedDB，全程离线可用

TXT 导入时依次尝试“分章规则”匹配章节标题，未命中自动按每章约 3000 字切分；内置中文章节、序章/楔子/尾声、Chapter 等规则，也可在分章规则页添加自定义正则。

## 技术栈

| 层          | 选型                                           |
| ----------- | ---------------------------------------------- |
| UI          | SolidJS 1.9                                    |
| 路由        | @solidjs/router 1.x（JSX Route + lazy 懒加载） |
| 构建        | Vite 8 + TypeScript 6（strict）                |
| 桌面/移动壳 | Tauri 2（Rust）                                |

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

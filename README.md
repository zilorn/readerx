# ReaderX

基于 **Tauri 2 + SolidJS + TypeScript** 的移动端风格电子书阅读器。

## 功能

- **书架** `/`：本地书籍网格、继续阅读、阅读进度、书籍删除管理
- **发现** `/discover`：书源搜索 / 分类发现，命中书籍加入书架后在线阅读
- **书源**：独立书源管理页（创建/编辑/启停/删除、JSON 导入导出、功能级开关）；书源以 JS 编写，在 Rust 内嵌 **Boa 引擎**沙箱运行，支持 async 规则；一次搜索同时运行多少个书源由用户全局设置控制（设置 → 书源 → 书源并发）；在线阅读按「当前章 ±5 章」窗口懒加载缓存，也支持一键批量下载全文离线阅读
- **导入**：书架 `+` / 空状态按钮直接选择 TXT / EPUB，解析后立即入书架，不跳页面
- **设置** `/settings`：浅色 / 深色 / 护眼三套主题、正文字号，分章规则在独立子页管理
- **阅读** `/book/:id`：章节阅读、上一章 / 下一章、目录抽屉、阅读进度跨页同步
- **听书**：阅读页点耳机图标进入听书。双引擎：**原生语音**（安卓系统 TTS，默认）与**自定义 HTTP 源**（自建 TTS 接口，返回音频字节）；悬浮球控制暂停 / 上一句 / 下一句，可调倍速（1x–3x）、音色、定时停止；正在朗读的句子在正文中实时橙色高亮（每章先读章节标题），跨章节连续朗读

TXT 导入时依次尝试“分章规则”匹配章节标题，未命中自动按每章约 3000 字切分；内置中文章节、序章/楔子/尾声、Chapter 等规则，也可在分章规则页添加自定义正则。

## 书源（在线发现与阅读）

入口：**设置 → 书源管理**（或「发现」页右上角）。

- **书源 = JS 规则**：定义 `searchBook / discoverBooks / discoverCategories / bookDetail / bookToc / bookContent`
  等入口函数，运行于 Rust 内嵌的 **Boa 引擎**沙箱；支持 `async/await` 写法。
  「书源并发」（设置 → 书源）为全局用户设置，指一次搜索同时运行多少个书源。
  规则可调用的宿主 API（`http` / `html` / `util` / `base64` / `cryptoUtil` / `console`）
  与格式规范见：
  - [docs/book-source-spec.md](./docs/book-source-spec.md)（JSON 结构与入口函数契约）
  - [docs/book-source-api.md](./docs/book-source-api.md)（宿主 API 参考）
  - [docs/book-source-guide.md](./docs/book-source-guide.md)（从零编写教程）
  - [docs/cloudflare.md](./docs/cloudflare.md)（Cloudflare/登录/防盗链站点处理）
- **启停与能力开关**：每个书源可整体启用/禁用，也可分别开关搜索 / 发现 / 详情 / 目录 / 正文。
- **导入导出**：JSON 单条或数组均可导入导出（管理页入口），自动归一化并提示覆盖冲突。
- **在线阅读**：搜索结果或分类发现 → 在线书页预览 → 「加入书架」（只保存目录元数据）；
  在书架打开后**只按需缓存「当前章前后 5 章」** 供阅读，跨章自动补窗；阅读页菜单的
  下载按钮可**批量下载剩余全部正文**，下载完成后断网也能读（并行度同样受「书源并发」设置约束）。
- **编辑与测试**：书源编辑页内置「保存并测试」，可逐能力填入参数运行并查看结果与 `console` 日志。
- **网页登录（Android）**：编辑页「网页登录」在应用内 WebView 浮层完成登录后自动捕获站点
  Cookie（含 httpOnly），按书源持久化并注入会话（重启自动生效，不随书源 JSON 导出）；
  书源代码也可调用 `webview.login(url)` 触发（见 [book-source-api.md](./docs/book-source-api.md)）。

> 书源仅供用户自行接入公开站点内容使用。**免责声明**：社区/第三方制作的书源与 ReaderX
> 项目及其作者无关，项目作者没有参与任何书源的制作与维护。书源代码运行在本地沙箱，但作者无法
> 保证其安全性——请仅导入你信任来源的书源，导入与启用时请阅读并确认相关提示。

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

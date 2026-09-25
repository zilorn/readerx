<p align="center">
  <img src="./public/favicon.svg" alt="ReaderX" width="96" height="96" />
</p>

<p align="center">
  <a href="https://github.com/zilorn/readerx/releases/latest"><img src="https://img.shields.io/github/v/release/zilorn/readerx?label=release&color=4f8ef7&logo=github" alt="Release" /></a>
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/SolidJS-1.9-2C4F7C?logo=solid&logoColor=white" alt="SolidJS" />
  <img src="https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/platform-Android%20%7C%20Linux%20%7C%20Windows-3DDC84?logo=android&logoColor=white" alt="Platform" />
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/zilorn/readerx?label=license&color=blue" alt="License" /></a>
</p>

<p align="center">
  <b>简体中文</b> | <a href="./README.en.md">English</a>
</p>

# ReaderX

基于 **Tauri 2 + SolidJS + TypeScript** 的电子书阅读器：手机（Android）上是一个单手可用的
移动端应用，桌面（Linux / Windows）上是侧边导航的窗口应用，两者共用同一套页面与本地书库。

## 功能

- **书架** `/`：本地书籍网格、继续阅读、阅读进度、书籍删除管理
- **发现** `/discover`：书源搜索 / 分类发现，命中书籍加入书架后在线阅读
- **书源**：独立书源管理页（创建/编辑/启停/删除、JSON 导入导出、功能级开关）；书源以 JS 编写，在 Rust 内嵌 **Boa 引擎**沙箱运行，支持 async 规则；一次搜索同时运行多少个书源由用户全局设置控制（设置 → 书源 → 书源并发）；在线阅读按「当前章 ±5 章」窗口预取缓存、阅读视图只读取当前章 ±1 章，也支持批量下载正文离线阅读（可只下第 x–y 章）
- **导入**：书架 `+` / 空状态按钮直接选择 TXT / EPUB / PDF，解析后立即入书架，不跳页面
- **设置** `/settings`：浅色 / 深色 / 护眼三套主题、正文字号、界面语言（跟随系统 / 简体中文 /
  English），分章规则在独立子页管理
- **阅读** `/book/:id`：章节阅读、上一章 / 下一章、目录抽屉、阅读进度跨页同步
- **听书**：阅读页点耳机图标进入听书。双引擎：**原生语音**（安卓系统 TTS，默认）与**自定义 HTTP 源**（自建 TTS 接口，返回音频字节）；悬浮球控制暂停 / 上一句 / 下一句，可调倍速（1x–3x）、音色、定时停止；正在朗读的句子在正文中实时橙色高亮（每章先读章节标题），跨章节连续朗读

TXT 导入时依次尝试“分章规则”匹配章节标题，未命中自动按每章约 3000 字切分；内置中文章节、序章/楔子/尾声、Chapter 等规则，也可在分章规则页添加自定义正则。

PDF 导入优先读文字层并还原成段落（页眉 / 页脚按「跨页重复 + 位于版心之外」剔除），
分章跟随 PDF 自带书签，没有可用书签时按字数分章；没有文字层的扫描页（以及封面 / 影印插页）
整页渲染成图片阅读，图片落盘到应用数据目录，书籍 JSON 里只留引用。

## 书源（在线发现与阅读）

入口：**设置 → 书源管理**（或「发现」页右上角）。

在书源管理页**新增、导入、启停或编辑保存**后，改动会**立即生效，无需重启软件**：
「发现」页的书源标签、搜索 / 分类发现会立刻反映最新的书源清单与启停 / 能力开关状态。

- **书源 = JS 规则**：定义 `searchBook / discoverBooks / discoverCategories / bookDetail / bookToc / bookContent`
  等入口函数，运行于 Rust 内嵌的 **Boa 引擎**沙箱；支持 `async/await` 写法。
  「书源并发」（设置 → 书源）为全局用户设置，指一次搜索同时运行多少个书源。
  规则可调用的宿主 API（`http` / `html` / `util` / `base64` / `cryptoUtil` / `console`）
  与格式规范见：
  - [docs/book-source-spec.md](./docs/book-source-spec.md)（JSON 结构与入口函数契约）
  - [docs/book-source-api.md](./docs/book-source-api.md)（宿主 API 参考）
  - [docs/book-source-guide.md](./docs/book-source-guide.md)（从零编写教程）
  - [docs/cloudflare.md](./docs/cloudflare.md)（Cloudflare/登录/防盗链站点处理）
  - [docs/book-source-cli.md](./docs/book-source-cli.md)（独立二进制 `readerx-source`：不启动应用跑书源，
    带浏览器 Cookie / WebKit 内核过挑战 / 连 Chrome 取 Cookie）
- **启停与能力开关**：每个书源可整体启用/禁用，也可分别开关搜索 / 发现 / 详情 / 目录 / 正文。
- **分组**：书源可归入分组（管理页筛选条 / 行内文件夹按钮 / 编辑页「分组」），分组管理支持新建、
  重命名、删除与整组一键启停；删除分组时组内书源退回未分组。「发现」页的筛选条与管理页共用同一个
  选中值：筛到某一组再搜索 / 发现，就只跑该组的已启用书源。导出只带可读的 `groupName`，
  导入按名字匹配本机分组（没有则新建），确认页可整体关闭分组导入。
- **批量管理**：**长按书源行进入多选**，点击行勾选 / 取消勾选，页头「全选」按当前筛选选中可见书源；
  底部操作条可批量启用 / 停用、一起归入或移出分组、导出为一个 JSON 数组（复制到剪贴板）与删除。
- **导入导出**：JSON 单条或数组均可导入导出（管理页入口），自动归一化并提示覆盖冲突；除选择
  本地文件 / 剪贴板粘贴外，也支持直接粘贴书源 JSON 的网址（http/https）**从网络拉取导入**，
  无需先下载文件。
- **在线阅读**：搜索结果或分类发现 → 在线书页预览 → 「加入书架」（只保存目录元数据），
  入架提示里可直接「加入分组」把新书归入书架分组；
- **编辑与测试**：书源编辑页内置「保存并测试」，可逐能力填入参数运行并查看结果与 `console` 日志。
- **网页登录 / 自动网页认证（Android / Linux / Windows）**：编辑页「网页登录」在应用内 WebView 里完成登录后
  自动捕获站点 Cookie（含 httpOnly 的 `cf_clearance`），按书源持久化并注入会话（重启自动生效，不随书源 JSON
  导出）；书源代码也可调用 `webview.login(url)` 触发。Android 是叠在 Activity 上的原生浮层，桌面端是独立
  登录窗口（系统文件选择器同一套原生体验）。每个书源默认开启「自动网页认证」：请求命中 Cloudflare 挑战
  （或 `cf_clearance` 令牌过期）时自动拉起 WebView 认证并重试，可在编辑页单独关闭
  （见 [docs/cloudflare.md](./docs/cloudflare.md)）。
  登录态里的 localStorage / sessionStorage / IndexedDB 快照在 Android 与 Windows / macOS 上采得到；
  **Linux 的 WebKitGTK 把宿主脚本与页面存储隔离**，该平台只以 Cookie 为登录态来源（详见
  [docs/cloudflare.md](./docs/cloudflare.md) 的平台差异一节）。

> 书源仅供用户自行接入公开站点内容使用。**免责声明**：社区/第三方制作的书源与 ReaderX
> 项目及其作者无关，项目作者没有参与任何书源的制作与维护。书源代码运行在本地沙箱，但作者无法
> 保证其安全性——请仅导入你信任来源的书源，导入与启用时请阅读并确认相关提示。

## 形态与平台

| 平台                 | 外壳                             | 说明                                            |
| -------------------- | -------------------------------- | ----------------------------------------------- |
| Android              | 手机列 + 底部 Tab                | 主目标平台，`input[type=file]`（SAF）导入本地书 |
| Linux / Windows 桌面 | 侧边导航 + 内容区（≥900px 宽时） | 窗口拉窄到 900px 以下自动回到手机外壳           |
| 浏览器（`pnpm dev`） | 同上（按窗口宽度）               | 无 Rust 后端的降级模式，仅用于调界面            |

桌面端的差异只在外壳与系统集成上：窗口尺寸/最小尺寸约束、原生文件选择导入、Esc 返回、
设置页的「开发者工具」入口（release 包也能打开检查器）、阅读页已经是左右方向键翻页、
重复启动只聚焦已有窗口而不开第二个进程（单实例，见 `src-tauri/src/single_instance.rs`）；
页面组件与本地书库两侧共用，不存在两份实现。

## 日志与排障

前后端共用一套日志：Rust 侧由 `readerx-log` 统一写入 `<应用数据目录>/logs/readerx.log`
（单文件 2 MB 轮转、保留 3 份历史），书源引擎、独立二进制与 WebView 里的前端记录都汇到同一份文件。
**设置 → 调试 → 应用日志**可直接按级别筛选、复制与清空，并能在「常规 / 详细」之间切换
（`READERX_LOG` 环境变量可临时覆盖，例如 `READERX_LOG=info,readerx_source=debug`）。
细节与排障流程见 [docs/logging.md](./docs/logging.md)。

## 开发

```bash
pnpm install
pnpm dev                 # Vite 开发服务器 → http://localhost:1420
pnpm exec tsc --noEmit   # 类型检查
pnpm run i18n:check      # 界面文案词典校验（中英 key / 占位符 / 漏改的中文）
pnpm build               # 前端产物构建（dist/）

pnpm tauri dev            # 桌面窗口
pnpm tauri android dev    # Android 真机/模拟器
```

界面文案与迁移写法见 [docs/i18n.md](./docs/i18n.md)。

构建与发版：`.github/workflows/` 下有三条工作流 —— `build-android.yml` 与
`build-desktop.yml`（手动触发，只出 artifact 不发布）、
`release.yml`（打 `v*` tag 触发，一次发布 Android APK + Linux x86_64 包 +
Windows x86_64 / aarch64 安装包到同一个 Release；桌面按 ABI 分开出包）。
产物文件名统一为 `readerx-<版本>-<平台>-<架构>…`（如 `readerx-0.2.0-linux-x86_64.AppImage`、
`readerx-0.2.0-windows-aarch64-setup.exe`），collect/改名口径集中在
`scripts/collect-artifacts.mjs`，三条工作流共用；下载说明见 `scripts/tip.md`。
质量门槛（`pnpm exec tsc --noEmit` / `pnpm build` / `cargo test`）在本地按需跑。

详见 [AGENTS.md](./AGENTS.md)（仓库协作与代码约定）。

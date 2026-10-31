# HarmonyOS 支持（HAP / PWA）

ReaderX 在 HarmonyOS 上提供两种安装方式，共用同一套 SolidJS 页面、路由与阅读逻辑：

- **HAP**：ArkTS + ArkWeb 原生应用外壳，前端资源打进安装包，离线启动；
- **PWA**：浏览器安装到桌面，使用 Web App Manifest 与 Service Worker。

两者都只使用系统 API / 标准 Web API，不引入第三方包。

## 为什么是 WebView 外壳

Tauri 2 的稳定版没有 HarmonyOS target。官方 `feat/open-harmony` 分支仍依赖
`cargo-mobile2`、`openharmony-ability` 等未发布依赖，本地 CLI 也没有 `ohos` 子命令；
接入它们等于把构建链押在第三方分支上。当前实现保留 ArkWeb 外壳：

- HAP 工程位于 `harmonyos/`，只依赖 HarmonyOS SDK；
- 前端通过 `pnpm build:hap` 以相对路径构建，复制到 `rawfile/www/`；
- 页面用 IndexedDB 持久化书库，不通过 Tauri invoke；
- 浏览器侧继续提供零依赖 PWA。

## HAP 构建与安装

环境：DevEco Studio 5.0+，HarmonyOS SDK API 12+。

```bash
pnpm install
pnpm build:hap
```

构建脚本会以 `base=./` 生成前端，并复制到
`harmonyos/entry/src/main/resources/rawfile/www/`（构建产物，不入库）。PWA 与 HAP
图标由 `scripts/pwa-icons.mjs` 同步绘制到各自的 media 目录，同样不提交二进制文件。

1. 用 DevEco Studio 打开 `harmonyos/`；
2. 等待 hvigor / ohpm 同步，在 Project Structure → Signing Configs 配置签名；
3. Build → Build Hap(s)/APP(s) → Build Hap(s)，或直接 Run 到真机 / 模拟器。

外壳的工作方式与目录说明见 [harmonyos/README.md](../harmonyos/README.md)。关键点：

- `https://readerx.local/` 是固定虚拟域名，`onInterceptRequest` 把它映射到 `rawfile/www/`；
- 使用 https origin 而不是 `resource://`，让 IndexedDB、模块脚本与同源请求正常工作；
- HAP 内使用 hash 路由（`#/book/...`），不依赖真实 HTTP 服务的 SPA 回退；
- 系统返回键先交给 WebView 历史，再交还系统。

## PWA 构建与安装

```bash
pnpm build
```

把 `dist/` 部署到 HTTPS 站点（本地调试可用 `pnpm serve`）。在 HarmonyOS 浏览器打开
站点后：

1. 浏览器给出安装提示时点「安装」；没有提示时用菜单里的「添加到桌面 / 将网页作为应用安装」。
2. 安装后从桌面图标启动，界面不再显示地址栏。
3. 设置 → 关于 出现「安装到桌面」时也可以从应用内拉起安装确认框。

Service Worker 只缓存应用外壳、图标与带哈希的构建产物，不缓存书库正文。正文、进度、
书签、注释、书源与译文都在 IndexedDB 中，首次启动会请求浏览器授予持久化存储。
HAP 内已内置资源，`src/lib/pwa.ts` 会跳过 Service Worker 与安装流程。

## 能力范围

| 能力 | HAP / PWA | 说明 |
| --- | --- | --- |
| 本地书库（TXT / EPUB / PDF） | 可用 | 系统文件选择器；数据存 IndexedDB |
| 阅读、目录、进度、书签、注释 | 可用 | 与原生端共用页面和数据结构 |
| 阅读设置、主题、分组、分章 / 替换规则 | 可用 | 偏好按 `readerx.*` 键持久化 |
| 书源导入 / 编辑 / 分组 / 导出 | 可用 | 书源本身可存取 |
| 执行书源 JS（搜索、发现、正文） | 不可用 | 引擎是 Rust + Boa，WebView 外壳没有该后端 |
| WebDAV 导入 | 可用 | 依赖服务器允许跨域访问 |
| 智能翻译 | 视接口而定 | 浏览器直接请求服务商，需接口允许 CORS |
| 听书 | 部分可用 | 原生 TTS 插件不可用；HTTP 语音源受 CORS 限制 |
| MOBI 解析 | 不可用 | 解压逻辑在 Rust 侧 |
| PDF 页面图回退 | 不可用 | 位图渲染走 Rust；文本层仍可读 |
| 局域网同步、ZIP 备份 / 恢复 | 不可用 | 依赖原生文件系统与 Rust 同步引擎 |
| 应用内更新 | 不走发布包 | HAP 随包更新；PWA 由 Service Worker 更新外壳 |

未实现的能力沿用现有降级文案（如 `library.source.appOnly`、`backup.appOnly`），
不会静默失败。

> IndexedDB 属于应用 / 浏览器存储：清除数据、卸载应用或系统回收存储都会删除书库。
> 重要书籍请保留原始文件；需要整库备份时使用 Android / 桌面版。

## 实现入口

| 文件 | 作用 |
| --- | --- |
| `harmonyos/entry/src/main/ets/pages/Index.ets` | ArkWeb、虚拟域名拦截、返回键 |
| `harmonyos/entry/src/main/ets/entryability/EntryAbility.ets` | 应用启动与页面加载 |
| `scripts/build-hap.mjs` | `base=./` 构建并复制到 HAP rawfile |
| `scripts/pwa-icons.mjs` | 用 Node 内置模块绘制 PWA / HAP 图标，不提交 PNG |
| `src/lib/platform.ts` | 识别 `OpenHarmony` / `HarmonyOS` / `ArkWeb` 与 HAP 虚拟 origin |
| `src/App.tsx` | HAP 使用 HashRouter，其它环境保持 BrowserRouter |
| `src/lib/webStore.ts` | IndexedDB 存储：偏好、书籍、书签、注释、书源、译文 |
| `src/lib/backend.ts` | Tauri 走 `invoke`，Web / HAP 走 `webStore` |
| `src/lib/pwa.ts` | PWA Service Worker、安装事件；HAP 内跳过 |
| `public/manifest.webmanifest` | PWA 名称、图标、独立窗口与启动地址 |
| `public/sw.js` | PWA 外壳预缓存、导航网络优先、静态资源缓存优先 |

## 验证

```bash
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
pnpm build:hap
```

构建后确认 HAP 资源包含入口与图标，且 HTML 只引用相对路径：

```bash
test -f harmonyos/entry/src/main/resources/rawfile/www/index.html
test -f harmonyos/AppScope/resources/base/media/app_icon.png
grep -E 'src="\./assets/' harmonyos/entry/src/main/resources/rawfile/www/index.html
```

真机检查项：

- HAP 从桌面图标启动，首屏加载 `https://readerx.local/index.html`，无白屏与地址栏；
- 切换页面后按系统返回键回到上一页，再按退出应用；
- 断网后重新打开，书架与已导入书籍仍可阅读；
- 导入 TXT / EPUB 后强制关闭再打开，书籍、进度、书签仍在；
- PWA 安装后以独立窗口启动，Service Worker 可离线打开外壳；
- 未支持的入口（书源执行、备份、同步）显示既有降级提示。

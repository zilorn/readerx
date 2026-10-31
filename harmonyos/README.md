# ReaderX HarmonyOS HAP

这是 ReaderX 的 HarmonyOS 应用外壳（Stage 模型，ArkTS + ArkWeb）。它把仓库根目录
`dist/` 的 Web 资源打进 HAP，不依赖 Tauri、Rust 运行时或任何 `oh-package` 第三方依赖。

## 工作方式

- `entry/src/main/ets/pages/Index.ets` 用 ArkWeb 加载 `https://readerx.local/index.html`；
- 同一文件里的 `onInterceptRequest` 把该虚拟域名的请求映射到 `rawfile/www/`；
- 用 https 虚拟 origin 而不是 `resource://`，是为了让 IndexedDB、`fetch`、模块脚本和
  同源资源都按正常安全上下文工作；
- 页面内部使用 hash 路由（`#/book/...`），刷新或系统返回不会向虚拟域名请求不存在的路径；
- 书库、进度、书签、书源和译文由页面的 IndexedDB 保存（见 `src/lib/webStore.ts`），
  PWA Service Worker 在 HAP 内主动跳过。

## 构建

环境：DevEco Studio 5.0 或更高版本，HarmonyOS SDK API 12 及以上。

```bash
pnpm install
pnpm build:hap
```

`build:hap` 会以 `base=./` 构建前端，把产物复制到
`entry/src/main/resources/rawfile/www/`，并用 `scripts/pwa-icons.mjs` 生成应用图标。
这两个目录都是构建产物，不入库。

然后用 DevEco Studio 打开本目录：

1. 等待 hvigor / ohpm 同步完成；
2. 在 File → Project Structure → Signing Configs 配置自动签名或手工签名；
3. Build → Build Hap(s)/APP(s) → Build Hap(s)，或使用 DevEco 的 Run 按钮安装到设备。

产物通常位于 `entry/build/default/outputs/default/`。安装包签名与上架配置属于本机
DevEco 环境，不写入仓库。

## 版本

`AppScope/app.json5` 的 `versionName` / `versionCode` 当前与根 `package.json` 的
0.7.0 对齐。发布新版本时需要同步修改，`versionCode` 必须单调递增。

## 能力范围

HAP 与浏览器 PWA 共用同一份前端和 IndexedDB 数据层，因此能力范围一致：

- 可用：本地 TXT / EPUB / PDF 导入、阅读、进度、书签、注释、分组、分章 / 替换规则、
  书源管理、WebDAV、界面偏好、HTTP 翻译（受服务端 CORS 限制）。
- 不可用：书源 JS 执行（Rust + Boa）、MOBI 解析、PDF 页面图回退、局域网同步、
  ZIP 备份 / 恢复、原生 TTS、应用内 WebView 登录。

Tauri 2 稳定版没有 HarmonyOS target，官方 OpenHarmony 分支仍依赖未发布的第三方
crate 与 CLI。本工程选择只保留 ArkWeb 外壳，避免把构建链绑到这些依赖上；完整的
原生能力仍以 Android / 桌面版为准。详见 [docs/harmonyos.md](../docs/harmonyos.md)。

## 目录

| 路径 | 作用 |
| --- | --- |
| `AppScope/app.json5` | 包名、版本、应用图标与名称 |
| `entry/src/main/module.json5` | 入口 Ability、设备类型、INTERNET 权限 |
| `entry/src/main/ets/entryability/EntryAbility.ets` | 启动并加载页面 |
| `entry/src/main/ets/pages/Index.ets` | ArkWeb、虚拟域名拦截、返回键处理 |
| `entry/src/main/resources/rawfile/www/` | `pnpm build:hap` 生成的前端产物 |

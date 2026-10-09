# CI 与手动构建

## 手动构建已签名 arm64 APK

在 Actions 选择 **Build Android (signed arm64, no publish)** → **Run workflow**，选择包含工作流的分支或 tag。PR #13 的分支为 `codex/sqlite-books`。
此工作流只出 `arm64-v8a` release APK，使用当前仓库版本，不创建 tag 或 GitHub Release。
成功后下载 `readerx-android-arm64-signed` artifact，文件名为 `readerx-<版本>-android-arm64-v8a.apk`，保留 14 天。

首次运行前在 Settings → Secrets and variables → Actions 配置以下仓库 Secrets，与 tag 发布共用同一证书：

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | keystore 文件的 base64（Linux：`base64 -w0 readerx-release.keystore`） |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 口令 |
| `ANDROID_KEY_ALIAS` | 签名 key 的别名 |
| `ANDROID_KEY_PASSWORD` | key 口令 |

缺少任何 Secret 会直接失败。工作流验证 APK 签名及唯一原生 ABI，并在成功或失败后清理签名文件；只上传 APK。
新工作流首次进入默认分支前，Actions 页面可能不显示 Run workflow；可在工作流进入默认分支后选择 PR 分支执行。
原来的 **Build Android (debug, no publish)** 仍用于手动 universal debug 构建；多 ABI 正式发布使用 `release.yml`。

## PR 自动检查

所有目标分支的 PR 在 opened / synchronize / reopened / ready_for_review 时触发，不使用路径过滤，避免前端构建依赖变化漏检。重复更新取消旧检查。

| 工作流 / Job | 检查范围 |
| --- | --- |
| PR CI / Frontend | 产物收集回归、`tsc --noEmit`、`i18n:check`、生产前端构建 |
| PR CI / Windows | 前端资源构建后，`cargo check --locked --workspace --all-targets` 编译检查 Windows App、workspace 与测试目标；不运行 Windows 测试、不打安装包 |
| PR CI / Android | 构建 arm64 debug APK，覆盖 Android Rust / bundled SQLite、原生插件及 Gradle 打包；无需仓库 Secrets，artifact 保留 7 天 |
| Test book storage and data compatibility / Linux | 前端构建后，分步运行 SQLite 书库 / state、书籍 ID 迁移、分组 / 规则 ID 迁移、备份兼容、App 同步落库、同步协议、书源引擎回归；Boa 测试串行 |

自动 PR 检查使用 `pull_request` 和只读 contents 权限，不接入 release 签名 Secrets。首次贡献者仍受 GitHub 的工作流审批策略限制。
这些工作流也支持手动触发。分支保护的 required checks 需在仓库设置中按上述 Job 选择；工作流文件本身不会修改保护规则。

产物命名由 `scripts/collect-artifacts.mjs` 统一处理。Android `--abi arm64-v8a` 只收 arm64；省略 `--abi` 时 release 仍要求四个 ABI 齐全，保持 tag 发布的验收条件。

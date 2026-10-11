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
签名的生成（keystore 落盘与 `keystore.properties`）集中在 `.github/actions/setup-android-signing`，本工作流与 PR CI 的 Android Job 共用，避免两处口令转义与失败提示走偏。
新工作流首次进入默认分支前，Actions 页面可能不显示 Run workflow；可在工作流进入默认分支后选择 PR 分支执行。
原来的 **Build Android (debug, no publish)** 仍用于手动 universal debug 构建；多 ABI 正式发布使用 `release.yml`。

## PR 自动检查

所有目标分支的 PR 在 opened / synchronize / reopened / ready_for_review 时触发，不使用路径过滤。重复更新取消旧检查。
PR CI 的默认口径仍是只做检查，不运行前端生产构建、Rust 测试或 Windows 打包。
唯一的构建例外是 **Signed Android arm64 APK**：每个同仓库 PR 都出一个可直接安装的 arm64 release 包，便于在真机验证改动；桌面产物仍只在手动构建或 tag 发布时生成。
Rust 使用 `cargo check` 检查代码与测试目标；Cargo 仍会编译依赖和运行构建脚本，但不会生成应用安装包。Linux Job 安装 Tauri 检查所需系统开发库。

| 检查步骤 | 检查范围 |
| --- | --- |
| TypeScript types | `tsc --noEmit`，只做类型检查 |
| i18n keys and user-facing text | `i18n:check`，检查词典与界面文案 |
| Artifact collection regression | Node 测试使用临时模拟 APK 文件，验证收集与命名规则，不构建 APK |
| Rust workspace and test target checks | `cargo check --locked --workspace --all-targets`，检查 Rust 代码和测试目标，不执行测试、不打包 |
| GitHub Actions syntax | 固定版本 actionlint 检查工作流语法 |
| Signed Android arm64 APK | `--target aarch64 --split-per-abi` 出 `arm64-v8a` release 包，收集时校验签名与唯一原生 ABI |

自动 PR 检查使用 `pull_request` 与只读 contents 权限。**Signed Android arm64 APK** 用到与手动签名构建相同的仓库 Secrets，而 GitHub 不会把 Secrets 交给 fork PR 的工作流，因此 fork PR 的这个 Job 直接跳过，同仓库分支 PR 与手动触发照常构建；首次贡献者仍受 GitHub 的工作流审批策略限制。
该 Job 成功后上传 `readerx-pr-android-arm64-signed` artifact（`readerx-<版本>-android-arm64-v8a.apk`，保留 7 天），并在构建后清理 keystore 与 `keystore.properties`。
**Test book storage and data compatibility** 改为只支持手动触发；需要验证 SQLite、迁移、备份与同步时再手动运行，它会构建前端并编译执行 Rust 测试。
Android / Desktop 手动构建和 tag 发布继续独立运行。分支保护的 required checks 需在仓库设置中选择 `Frontend and workflow checks` 与 `Rust workspace and test target checks`；新增的 Android Job 默认不参与保护规则，要卡 PR 需自行在仓库设置中勾选；工作流文件本身不会修改保护规则。

产物命名由 `scripts/collect-artifacts.mjs` 统一处理。Android `--abi arm64-v8a` 只收 arm64；省略 `--abi` 时 release 仍要求四个 ABI 齐全，保持 tag 发布的验收条件。

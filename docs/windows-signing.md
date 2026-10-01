# Windows 代码签名

GitHub Actions 通过 Tauri 的 Windows 签名配置，在打包时对应用程序与 NSIS 安装包签名，覆盖 x86_64 与 aarch64。使用 SHA-256 摘要和 RFC 3161 时间戳，构建完成后检查两类文件的签名、证书指纹和时间戳；校验失败不上传、不发布。

## 仓库配置

在 Settings → Secrets and variables → Actions 添加：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Secret | `WINDOWS_CERTIFICATE_BASE64` | 包含私钥的代码签名 PFX/P12 文件，纯 base64（不含 PEM 头尾） |
| Secret | `WINDOWS_CERTIFICATE_PASSWORD` | PFX 导出口令，不能为空 |
| Variable（可选） | `WINDOWS_TIMESTAMP_URL` | 颁发机构提供的 RFC 3161 服务；默认 `http://timestamp.digicert.com` |

在本地 PowerShell 编码证书，再将结果粘贴到 Secret：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\private\readerx.pfx')) | Set-Clipboard
```

不要将证书、私钥、口令或编码结果提交到仓库。证书必须在有效期内、包含私钥及代码签名用途（OID `1.3.6.1.5.5.7.3.3`），PFX 只能包含一个满足条件的签名证书。公开发布应使用受信任的证书；自签名证书不会自动获得用户系统信任。

此接入只适用于可导出的 PFX 私钥。硬件令牌、HSM 或云签名证书需使用颁发机构的服务及 Tauri `signCommand`，不能将公钥证书转成含私钥的 PFX。[Tauri 签名文档](https://v2.tauri.app/distribute/sign/windows/) 对现代 OV/EV 证书的限制与云签名方式有说明。

## 工作流行为

- `build-desktop.yml`：手动运行时勾选 `sign-windows` 才签名，默认仍可构建未签名测试包；勾选后缺少 Secrets 会失败。
- `release.yml`：Windows 正式发布强制签名；缺少 Secrets 或签名校验失败会阻止整个 Release 发布。
- Linux 和 Android 构建沿用原流程。

共享 action 在 Windows runner 的当前用户证书库导入证书，生成临时 Tauri 配置（不改仓库配置），导入后立即删除 PFX；工作流通过 `always()` 清理签名证书及配置。Secrets 只传给导入步骤。仅对可信分支或 tag 执行使用签名凭据的工作流。

签名不能保证消除 SmartScreen 提示，新文件和证书仍需要积累信誉。发布说明中的已签名描述适用于正式 Release，不适用于未勾选签名的手动构建包。

本地 Linux 检查无法替代 Windows 的实际签名验证；首次配置后应手动运行一次带签名的桌面构建，确认两个 Windows 架构都通过验证，再打发布 tag。

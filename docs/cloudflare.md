# 处理 Cloudflare / 登录态 / 防盗链站点

## 自动网页认证（Cloudflare 挑战，Android）

**每个书源默认开启「自动网页认证」**（书源 JSON 的 `autoAuth`，默认 `true`，可在书源编辑页的
「网页登录」卡片里**单独关闭**）。它解决两类问题：站点套了 Cloudflare 人机挑战，或挑战令牌
（`cf_clearance`，通常有效期很短）过期。

流程（引擎请求层自动完成，书源代码**无需改动**）：

1. `http.*` 请求返回 Cloudflare 挑战页（`cf-mitigated: challenge`，或 403/503 + 典型挑战内容，
   恒为 HTML）；
2. 若该书源 `autoAuth` 开启且平台支持（Android），自动拉起应用内 **WebView 浮层**加载出问题的
   地址（GET/HEAD 用原地址，其它方法用站点根），用户在真实浏览器内核里完成验证；
3. 点「完成」后宿主收集该站点 Cookie（含 httpOnly 的 `cf_clearance`、`__cf_bm` 等）→ 覆盖式
   持久化到该书源（旧的失效令牌整行移除）并立即注入会话；
4. 引擎**自动重试原请求一次**，之后书源代码拿到的就是重试结果——刷新成功时响应干净无标记，
   规则照常解析。

**令牌过期**：`cf_clearance` 过期后再次请求会重新出现挑战页，第 1–4 步自动再次触发并刷新，
无需手动操作。

**防打扰**：两次自动弹窗之间全局有约 45 秒冷却（批量下载全文 / 多源并发搜索不会连环弹窗）；
同一次认证若用户取消/超时，原响应原样返回给规则，不会反复纠缠。

### 未自动处理的失败

以下情况不会弹窗，原 403 响应直接返回（响应对象会带一个 `cf` 字段便于规则与排查，见
[book-source-api.md](./book-source-api.md) 的 `Response`）：

- 该书源关闭了「自动网页认证」：`cf.auto = "disabled"`；
- 平台不支持（桌面 / iOS / 浏览器预览）：`cf.auto = "unsupported"`；
- 距上次自动弹窗不足 45 秒：`cf.auto = "cooldown"`；
- 用户取消 / 超时：`cf.auto = "cancelled"`；
- 认证成功后重试仍被拦截（令牌未生效 / 站点校验浏览器指纹）：`cf.auto = "stale"`——此时把书源
  User-Agent 填成与网页一致（见下文「手动兜底」），并考虑重试一次。

## 每源会话（基础能力）

书源引擎内置**每源 HTTP 会话**：

- 独立 `reqwest` 客户端 + 自动 cookie jar：书源运行期间站点 `Set-Cookie` 会被保存并在后续请求自动携带；
- 书源的「默认请求头」（含 `Cookie`）与「User-Agent」每请求合并；
- JS 内可用 `http.setCookie(text)` 向会话追加 Cookie、`http.cookies()`/`http.clearCookies()` 查看与清空；
- 请求并行度是**用户级设置**（设置 → 书源 → 书源并发），不是书源字段；一次搜索按该值同时运行多个书源。

## 独立二进制（readerx-source）

书源引擎可以脱离应用编译成命令行工具，用来在**不启动 App** 的情况下复现这些站点问题
（完整用法见 [book-source-cli.md](./book-source-cli.md)）：

- `auth cookie --cookie-file <文件>`：导入浏览器导出的 Cookie（Netscape / JSON / DevTools 文本）。
  带域名信息的 Cookie 按**请求域名 / 路径 / https 逐条筛选**后发送；
- `auth webkit`：用系统 WebKitGTK（与 App 同内核）打开页面，人工过验证后点「完成」取回 Cookie；
- `auth cdp --cdp http://127.0.0.1:9222`：连已有 Chrome 的 DevTools 端口取 Cookie
  （`--browser` 也可由工具自己拉起浏览器）。

抓到的 `cf_clearance` 等 Cookie 会覆盖式保存为该源登录态并立即注入会话，后续 `call` / `run`
自动携带。CLI 里没有 Android 插件，因此引擎的自动认证走的就是 `--auth` 指定的后端：

| 情况 | 响应里的 `cf.auto` |
| --- | --- |
| `--auth none`，或该书源关闭了自动网页认证 | `disabled` |
| 无显示环境且 `--auth webkit` | `unsupported` |
| 距上次自动认证不足 45 秒 | `cooldown` |
| 用户取消 / 超时 | `cancelled` |
| 认证后重试仍被拦截（令牌未生效 / 指纹不符） | `stale` |

`stale` 在 CLI 里尤其常见：HTTP 客户端（reqwest/rustls）的 TLS 指纹与浏览器不同，而
`cf_clearance` 与 **IP + UA + TLS 指纹**绑定。此时把书源 UA 调成与认证浏览器一致
（`--ua` 或身份文件），或改用 `auth cdp` 让「认证」和「后续请求」出自同一浏览器环境。

## 应用内网页登录（Android）

需要**账号登录**（或站点没被自动识别为 CF 挑战）时，仍可用原「网页登录」：

1. 书源编辑页点「网页登录」→ 在浮层里完成验证码/扫码/账号登录；
2. 点「完成」返回（编辑页会提示捕获到几个 Cookie）；
3. 直接「保存并测试」搜索/正文即可命中。

与自动流程相同：Cookie 按书源**持久化**到独立文件（**不随书源 JSON 导出/分享**，不写进书源代码），
应用重启后自动注入。该手动入口**不受**「自动网页认证」开关影响——它是用户主动操作。

## 书源代码触发登录

宿主在 Boa 引擎开放 `webview.login(url, opts?)`。返回对象与限制见
[book-source-api.md](./book-source-api.md)。注意：

- 书源代码触发的是「书源主动拉起」，受该书源 `autoAuth` 开关约束：关闭时返回 `ok:false`
  （message 说明被该书源设置禁用），规则内请自行降级；
- 平台不支持（桌面/iOS/浏览器预览）时返回 `ok:false` 且不抛错。

## 手动兜底（任意平台）

- 需要 Referer/UA：写进书源的「默认请求头 / User-Agent」；
- Cloudflare 站点认证后仍 403：`cf_clearance` 与 **IP + UA + TLS 指纹**相关，建议把书源
  User-Agent 填成与你完成认证的浏览器一致的 UA 字符串，再重试；
- 临时 Cookie：在自己浏览器登录后，复制请求头里的 `Cookie: …` 粘贴到「默认请求头」，
  或用书源代码 `http.setCookie(...)`（只对本次运行会话有效，重启失效）；
- 不要把浏览器私有 Cookie 写进**公开分享**的书源；登录 Cookie 走「网页登录 / 自动网页认证」
  才能与书源 JSON 分离并随源持久化。
- **不要在同一源里既用默认请求头的 `Cookie:` 又依赖自动认证刷新**：旧值会排在 Cookie 头前面，
  同名 `cf_clearance` 可能被站点取旧值而一直 403（表现为 `cf.auto = "stale"`）。CF 站点请走
  网页登录 / 自动认证，需要额外请求头时只写 Referer/UA 等非常量头。

## 常见排查

- 请求被 403/429 时，先检查：UA/Referer 是否一致、Cookie 是否过期（CF 挑战是否再次出现）、
  网页登录的账号是否真的成功（看编辑页提示捕获条数）、全局「书源并发」是否调得过高（设置 → 书源）。
- 命令行侧排查：`readerx-source --source <书源> auth show` 看当前实际带上的头与 Cookie，
  `call … --verbose` 看书源自己的 `console` 日志（见 [book-source-cli.md](./book-source-cli.md)）。
- 用编辑页「测试」跑一次：若响应带 `cf` 字段且 `auto` 为 `disabled / unsupported / cooldown`，
  说明自动认证没被触发，按对应原因处理（打开开关 / 换 Android 端 / 稍后再试）。

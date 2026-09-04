# 处理 Cloudflare / 登录态 / 防盗链站点

## 每源会话（基础能力）

书源引擎内置**每源 HTTP 会话**：

- 独立 `reqwest` 客户端 + 自动 cookie jar：书源运行期间站点 `Set-Cookie` 会被保存并在后续请求自动携带；
- 书源的「默认请求头」（含 `Cookie`）与「User-Agent」每请求合并；
- JS 内可用 `http.setCookie(text)` 向会话追加 Cookie、`http.cookies()`/`http.clearCookies()` 查看与清空；
- 请求并行度是**用户级设置**（设置 → 书源 → 书源并发），不是书源字段；一次搜索按该值同时运行多个书源。

## 应用内网页登录（Android）

**Android 版**提供「网页登录」：在书源编辑页（或书源代码 `webview.login(url)`）拉起应用内
**WebView 浮层**，用户在真实浏览器内核里完成验证码/扫码/账号登录后点「完成」，宿主会：

1. 用系统 CookieManager 收集当前站点的 Cookie（**含 httpOnly**，`cf_clearance`、`__cf_bm` 等均在列）；
2. 把 Cookie 写回该书源会话——等价于 `http.setCookie(...)`，之后该源每次请求自动携带；
3. 按书源**持久化**到独立文件，应用重启后自动注入；该数据**不随书源 JSON 导出/分享**，
   也不会写进书源代码。

因此需要登录（或 Cloudflare 人机验证后拿 `cf_clearance`）的站点流程简化为：

1. 书源编辑页点「网页登录」→ 在浮层里完成登录；
2. 点「完成」返回（编辑页会提示捕获到几个 Cookie）；
3. 直接「保存并测试」搜索/正文即可命中。

> 浮层 15 分钟无操作自动关闭；想换账号先点「清空登录 Cookie」。

## 书源代码触发登录

宿主在 Boa 引擎开放了 `webview.login(url, opts?)`：入口函数发现 401/403 时可自动拉起登录，
返回 `{ ok, url, cookies, count, message }`，详见 [book-source-api.md](./book-source-api.md)。
平台不支持（桌面/iOS/浏览器预览）时返回 `ok:false` 且不抛错，书源代码可自行降级。

## 手动兜底（任意平台）

- 需要 Referer/UA：写进书源的「默认请求头 / User-Agent」；
- 临时 Cookie：在自己浏览器登录后，复制请求头里的 `Cookie: …` 粘贴到「默认请求头」，
  或用书源代码 `http.setCookie(...)`（只对本次运行会话有效，重启失效）；
- 不要把浏览器私有 Cookie 写进**公开分享**的书源；登录 Cookie 走上面「网页登录」
  才能与书源 JSON 分离并随源持久化。

## 常见排查

- 请求被 403/429 时，先检查：UA/Referer 是否一致、Cookie 是否过期、网页登录的账号是否真的
  成功（看编辑页提示捕获条数）、全局「书源并发」是否调得过高（设置 → 书源）。

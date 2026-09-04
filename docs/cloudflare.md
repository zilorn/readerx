# 处理 Cloudflare / 登录态 / 防盗链站点

## 现状（本版本提供的能力）

书源引擎内置**每源 HTTP 会话**：

- 独立 `reqwest` 客户端 + 自动 cookie jar：书源运行期间站点 `Set-Cookie` 会被保存并在后续请求自动携带；
- 书源的「默认请求头」（含 `Cookie`）与「User-Agent」每请求合并；
- JS 内可用 `http.setCookie(text)` 向会话追加 Cookie、`http.cookies()`/`http.clearCookies()` 查看与清空；
- 请求并行度是**用户级设置**（设置 → 书源 → 书源并发），不是书源字段；一次搜索按该值同时运行多个书源。

因此对**能靠 Cookie/请求头通过**的站点（多数登录、部分轻量反爬、Cloudflare 的
`cf_clearance` 等在有效期内可作为 Cookie 直接使用），流程是：

1. 在浏览器（推荐桌面浏览器 DevTools）访问目标站点并完成验证/登录；
2. 从请求里复制 `User-Agent` 与 `Cookie`（或仅 `cf_clearance` 等关键项）填入该书源的
   「默认请求头」/「User-Agent」；
3. 保存并测试搜索/正文是否命中。

> 提示：Cookie 有有效期，失效后重复第 2 步即可；不要把浏览器私有 Cookie 写进公开分享的书源。

## 计划中的增强（插件化，暂未实现）

设计目标是在**应用内 WebView** 打开目标 URL 让用户完成 Cloudflare 人机验证/登录后，
自动把该域 Cookie（`cf_clearance`、`__cf_bm` 等）写回对应书源会话。

扩展点已就绪：

- 引擎 HTTP 会话按 `sourceId` 独立隔离，且 `http.setCookie` / 默认请求头即为注入通道；
- 后续以独立插件实现“WebView 捕获”，产物只是往该书源会话追加 Cookie 行，无需改动书源 JS 契约。

因此社区插件/书源无需等待：只要能在书源 JS 里拿到 Cookie 文本（无论来自手动粘贴还是未来插件的
全局注入 API），一律用 `http.setCookie(...)` 或默认请求头即可生效。

## 其他建议

- 需要真实浏览器的站点请优先用系统浏览器验证（见书源管理页/README），不要把验证码交互写进书源。
- 请求被 403/429 时，先检查：UA/Referer 是否一致、Cookie 是否过期、全局「书源并发」是否调得过高（设置 → 书源）。

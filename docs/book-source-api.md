# 书源宿主 API 参考

书源 JS 在 Boa 沙箱中运行，以下全局对象/函数可用。除注明外均为**同步**（返回普通值，
规则内直接使用；在 async 函数里 `await` 也合法）。约定：
- 规则抛错、HTTP 失败统一以 JS `Error` 抛出（消息含原因）；建议入口函数内自行 try/catch 并按需降级。
- 网络请求自动携带：该书源的 cookie jar（reqwest 会话）、默认请求头与 UA。
- 字符集：按响应 `Content-Type` 的 `charset` 解码；否则 UTF-8 合法即用，替代符过多退回 GB18030。

## `http`

| 成员 | 说明 |
| --- | --- |
| `http.request(method, url, opts?)` | 任意方法请求，返回 `Response` |
| `http.get(url, opts?)` | GET 便捷方法 |
| `http.post(url, body?, opts?)` | POST 便捷方法（未指定 body/json/form 时把第二参当 body） |
| `http.setCookie(text)` | 手动追加一行 Cookie 头内容（持久到该源会话，跨调用生效） |
| `http.cookies()` | 返回已手动追加的 Cookie 行数组 |
| `http.clearCookies()` | 清空手动 Cookie |

`opts`（可选对象）：

```js
{
  headers: { "Referer": "https://..." }, // 附加请求头
  params:  { q: "keyword", page: 2 },     // 拼到 query（URL 编码）
  body:    "raw=1",                       // 原始 body（字符串）
  json:    { a: 1 },                      // JSON body（自动 Content-Type）
  form:    { a: "1" },                    // 表单编码 body
  timeoutMs: 15000,                       // 100–120000
  redirect: true                          // false = 不跟随重定向
}
```

`Response`：

```js
{
  ok: true,                 // status 是否为 2xx
  status: 200,
  statusText: "OK",
  headers: { "content-type": "…" }, // 键名小写
  body: "…",                // 按字符集解码后的文本
  url: "https://…",          // 请求地址
  truncated: false          // 响应体超限被截断时为 true
}
```

规则惯例：`const resp = await http.get(url); if (!resp.ok) throw new Error("HTTP " + resp.status);`

## `webview`（网页登录，仅 Android）

在 **Android** 应用内弹出原生 WebView 登录浮层（顶部有「取消 / 完成」）。
点「完成」后宿主收集当前站点的 Cookie（**含 httpOnly**），自动完成两件事：

1. 写入该书源的 HTTP 会话（等价于 `http.setCookie`，之后每次请求自动携带）；
2. 持久化到该书源独立文件（应用重启后自动注入，**不会**随书源 JSON 导出/分享）。

| 成员 | 说明 |
| --- | --- |
| `webview.isSupported()` | 当前平台/环境是否支持网页登录（Android 为 true） |
| `webview.login(url, opts?)` | 打开 `url` 登录页并**阻塞等待**用户操作，返回结果对象 |

返回对象：

```js
{
  ok: true,               // false = 取消 / 超时 / 失败（不抛错，用 ok 分支）
  url: "https://…",       // 点完成时停留的地址
  cookies: "sid=…; token=…", // Cookie 文本（含 httpOnly）；ok 时已自动注入并持久化
  count: 2,               // Cookie 条数
  message: ""             // 取消/失败原因，如「已取消登录」
}
```

`ok:true` 时**无需**再手动 `http.setCookie(...)`——宿主在返回前已处理。

典型用法（发现接口提示未登录时自动拉起登录后重试）：

```js
async function searchBook(keyword) {
  let resp = await http.get(BASE + "/search", { headers: { Referer: BASE } });
  if (resp.status === 401 || resp.status === 403) {
    const login = await webview.login(BASE + "/user/login");
    if (!login.ok) throw new Error("该站需要登录：" + login.message);
    resp = await http.get(BASE + "/search", { headers: { Referer: BASE } });
  }
  // …解析 resp
}
```

约定与限制：

- `webview.login` 是**同步阻塞**等待（在浮层内完成/取消/超时前不返回），
  且一次只允许一个登录窗口；已有窗口时新调用返回 `ok:false`。
- 登录窗口 **15 分钟**无操作会自动关闭并返回 `ok:false`。
- 目标地址仅支持 `http/https`；非法地址返回 `ok:false`（message 说明）。
- 桌面 / iOS / 纯浏览器预览：`isSupported()` 为 false，`login` 直接返回 `ok:false`
  （message 提示当前平台不支持），**不会抛错**，书源代码可自行降级。

## `html`（CSS 选择器 + 正文清洗）

基于 Rust `scraper`（HTML5 解析 + CSS 选择器子集）。

| 成员 | 说明 |
| --- | --- |
| `html.queryAll(html, selector)` | 命中全部元素 → 元素数组 |
| `html.query(html, selector)` | 首个命中或 `null` |
| `html.text(html, sep?)` | 把 HTML 片段清洗为纯文本（sep 默认 `"\n"`） |

元素对象：

```js
{ tag: "a",
  attrs: { href: "/book/1", class: "item" },
  text: "第一章",   // 内部文本（不保证去掉脚本/样式，请优先用 html.text）
  html: "<a …>第一章</a>" }  // 外部 HTML，可用于嵌套二次查询
```

常用写法（嵌套查询 = 取外层元素的 `html` 再查）：

```js
const items = html.queryAll(pageHtml, "ul.book-list li");
const list = items.map((li) => ({
  name: html.text(html.query(li.html, "h3 a")?.html ?? ""),
  url:  util.urlJoin(base, html.query(li.html, "h3 a")?.attrs.href ?? ""),
}));
```

## `util`

| 成员 | 说明 |
| --- | --- |
| `util.stripHtml(html)` | 剥标签转文本并 trim |
| `util.trim(s)` | 合并空白并 trim |
| `util.urlJoin(base, rel)` | 相对/绝对 URL 合并并规范化 `./ ../` |
| `util.queryString(obj)` | 对象 → `a=b&c=d`（URL 编码） |
| `util.queryParse(urlOrQuery)` | 解析 query → 对象（只保留首个同名） |
| `util.decodeEntities(s)` | 常见 HTML 实体解码 |
| `util.sleep(ms)` | 阻塞式等待（0–10000ms，勿在热路径使用） |

## `base64` / `cryptoUtil`

- `base64.encode(str)` / `base64.decode(str)`（解码失败抛错）
- `cryptoUtil.md5(str)` / `cryptoUtil.sha1(str)` → 小写 hex

## `console`

`console.log/info/warn/error(...)`：写入本次调用的日志缓冲（≤200 行），编辑页「测试」面板可见。

## 可用但注意语义的内建

标准 ES（String/Array/Map/Set/RegExp/JSON/Date/Promise/async-await 等）齐全；
`encodeURIComponent`/`decodeURIComponent` 可用。**没有**浏览器对象：
无 `fetch`/`XMLHttpRequest`/`DOMParser`/`location`/`window`/`localStorage`，无定时器。

## 错误与超时

- 网络/超时/参数错误 → 抛出 `Error`，消息如 `请求失败: …` / `HTTP 403`。
- 书源 JS 语法错误在「保存并测试」时即给出定位信息。
- 函数执行有预算（默认 45s；单章正文 30s），超时中止并返回错误。

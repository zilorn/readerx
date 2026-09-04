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

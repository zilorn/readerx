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
  truncated: false,          // 响应体超限被截断时为 true
  cf: {                      // 仅命中 Cloudflare 挑战且未自动解决时出现（见下）
    challenge: true,
    auto: "cooldown",        // disabled | unsupported | cooldown | cancelled | stale
    message: "…"
  }
}
```

规则惯例：`const resp = await http.get(url); if (!resp.ok) throw new Error("HTTP " + resp.status);`

### Cloudflare 挑战自动认证（Android）

书源默认开启「自动网页认证」（书源 JSON `autoAuth: true`，编辑页可单独关闭）。`http.*` 请求
命中 Cloudflare 挑战时，引擎会**自动**拉起应用内 WebView 让用户完成验证，成功后把新 Cookie
持久化并注入会话，然后**自动重试一次原请求**（`cf_clearance` 过期后同样会自动刷新），详见
[cloudflare.md](./cloudflare.md)。

- 刷新成功：规则拿到的就是重试后的正常响应，无额外字段；
- 未弹窗/被取消/刷新后仍被拦截：原挑战响应返回，附 `cf` 字段说明原因（`disabled` 表示该书源
  已关闭自动网页认证；桌面/iOS/浏览器预览恒为 `unsupported`），规则可据此提示或降级。


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
- 该书源关闭「自动网页认证」（`autoAuth: false`，编辑页开关）时返回 `ok:false`
  （message 说明被该书源设置禁用），规则内请自行降级；编辑页手动「网页登录」不受影响。
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

加解密与摘要都吃**字节保留字符串**：`base64.decode` / `cryptoUtil.hexDecode` 解码出来的字符串
里「1 个字符 = 1 个字节」（U+0000–U+00FF），可以直接当密钥 / 明文 / 密文再传回来，也可以拼进
请求体。传进去的普通文本按 **UTF-8** 取字节（中文一个字 3 字节）。

### `base64`

| 成员 | 说明 |
| --- | --- |
| `base64.encode(s)` | → base64 文本 |
| `base64.decode(s)` | → 字节保留字符串；容忍 URL-safe（`-_`）、省略的 `=` 与空白，非法输入抛错 |

### 摘要

| 成员 | 说明 |
| --- | --- |
| `cryptoUtil.md5(s, encoding?)` | → 小写 hex（默认）或 base64 |
| `cryptoUtil.sha1(s, encoding?)` | 同上 |
| `cryptoUtil.sha256(s, encoding?)` | 同上 |

`encoding` 取 `"hex"`（默认）/ `"base64"`。三个摘要都接受字节保留字符串，所以
`cryptoUtil.sha256(base64.decode(resp.data))` 签的是**原始字节**，不会被再编码一次。

### HMAC

| 成员 | 说明 |
| --- | --- |
| `cryptoUtil.hmac(algorithm, key, data, encoding?)` | `algorithm` 取 `md5` / `sha1` / `sha256`（写法随意：`HMAC-SHA256`、`sha-256` 都认），返回小写 hex 或 base64 |

`key` 按 UTF-8 文本取字节，长度不限（RFC 2104）。

```js
const sign = cryptoUtil.hmac("sha256", "secret", "page=2&q=" + keyword);
```

### 十六进制

| 成员 | 说明 |
| --- | --- |
| `cryptoUtil.hexEncode(s)` | 字节保留字符串 → 小写 hex（别名 `toHex`） |
| `cryptoUtil.hexDecode(s)` | hex → 字节保留字符串（别名 `fromHex`）；容忍空白 / 冒号分隔 / 大写 / `0x` 前缀，非法输入抛错 |

### AES-256-GCM

| 成员 | 说明 |
| --- | --- |
| `cryptoUtil.aesGcmEncrypt(opts)` | 加密，返回 `{ iv, ivHex, key, keyHex, encoding, hex, base64, text }` |
| `cryptoUtil.aesGcmDecrypt(opts)` | 解密，返回明文字符串；认证失败 / 参数不对抛 `Error` |

`aesGcmEncrypt` 的 `opts`：

```js
{
  data: "明文",            // 必填
  key:  "32 字节密钥",      // 必填；见下方「密钥与 IV 的写法」
  iv:   "12 字节 IV",      // 选填；不给则随机生成（12 字节，每次调用都不同）
  aad:  "附加认证数据",      // 选填；给了就必须在解密时给同一份
  encoding: "base64"       // 选填：hex | base64，只影响返回值里的 hex / base64 字段
}
```

返回的 `iv` / `key` 是 **base64**、`ivHex` / `keyHex` 是 **hex**，`hex` / `base64` 是同一份密文
（密文尾部已按 WebCrypto 约定接上 16 字节认证标签）的两种写法，`text` 是字节保留字符串。
解密时 `{ data, iv, key }` 三者任选一种写法混搭都行——最省事的做法是原样回传：

```js
const key = "0123456789abcdef0123456789abcdef"; // 32 字节
const cipher = cryptoUtil.aesGcmEncrypt({ data: JSON.stringify(payload), key: key });
// 请求体里带上 cipher.base64 与 cipher.iv
const resp = await http.post(API, JSON.stringify({ data: cipher.base64, iv: cipher.iv }), {
  headers: { "Content-Type": "application/json" }
});
// 站方原样返回 data / iv 时：
const plain = cryptoUtil.aesGcmDecrypt({ data: resp.data, iv: resp.iv, key: key });
const payload = JSON.parse(plain);
```

### 密钥与 IV 的写法

`key` 必须是 **32 字节**、`iv` 必须是 **12 字节**（AES-256-GCM）。三种写法都认，
按「base64 → hex → UTF-8 字面量」的顺序取第一个刚好对上字节数的解释：

| 写法 | 例子 |
| --- | --- |
| base64 | `cipher.key` / `base64.encode(密钥字节)` |
| hex | `"0".repeat(64)`、`cipher.keyHex`；`cryptoUtil.hexDecode(...)` 转换出的字节串同样可以 |
| UTF-8 字面量 | `"0123456789abcdef0123456789abcdef"`（正好 32 字符） |

长度对不上会**直接抛错**并列出各解释解出的字节数，不做静默填充或截断——把口令当密钥用，
或者想把 32 字符的 hex 串当密钥，都会是另一把密钥而不是「差不多能用」。真要按 hex 用，
先 `cryptoUtil.hexDecode(...)` 转出来再把结果传进去（或直接用 64 字符的写法）。

## `console`

`console.log/info/warn/error(...)`：写入本次调用的日志缓冲（≤200 行），编辑页「测试」Tab 可见。

## 可用但注意语义的内建

标准 ES（String/Array/Map/Set/RegExp/JSON/Date/Promise/async-await 等）齐全；
`encodeURIComponent`/`decodeURIComponent` 可用。**没有**浏览器对象：
无 `fetch`/`XMLHttpRequest`/`DOMParser`/`location`/`window`/`localStorage`，无定时器。

## 错误与超时

- 网络/超时/参数错误 → 抛出 `Error`，消息如 `请求失败: …` / `HTTP 403`。
- 书源 JS 语法错误在「保存并测试」时即给出定位信息。
- 函数执行有预算（默认 45s；单章正文 30s），超时中止并返回错误。
- 死循环 / 无限递归会被引擎上限中断，返回可读错误（`循环次数超出上限（书源代码可能存在死循环）`、
  `递归过深（书源代码可能存在无限递归）`），详见 [book-source-spec.md](./book-source-spec.md) 的「容量与超时」。
- 引擎或解析过程中的**意外内部异常**只会让当前这次调用失败，并以 `…内部异常: <原因>` 的形式
  作为普通错误返回（同一批正文拉取里其余章节不受影响），不会让应用闪退。

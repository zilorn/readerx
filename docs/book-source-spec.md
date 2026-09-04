# 书源格式规范（JSON v1）

书源 = 「元信息 + 能力开关 + JS 代码」。JS 在 **Boa 引擎**（Rust 内嵌）沙箱执行，只暴露白名单宿主 API（见 [book-source-api.md](./book-source-api.md)）。

## JSON 结构

```jsonc
{
  "schemaVersion": 1,
  "id": "src-m7x2k9p4q1",      // 导出保留；导入时同 id/同名同站会覆盖
  "name": "示例源",
  "bookSourceUrl": "https://example.com", // 站点根
  "author": "",
  "version": "1.0.0",
  "comment": "",
  "enabled": true,               // 整体启停
  "capabilities": {              // 功能级开关
    "search": true,              //   搜索
    "discover": true,            //   发现
    "detail": true,              //   详情富化
    "toc": true,                 //   目录
    "content": true              //   正文
  },
  "userAgent": "",               // 空 = 内置默认
  "headers": { "Referer": "https://..." }, // 每请求合并的默认头（可含 Cookie）
  "updateTime": 1725400000000,
  "js": "async function searchBook(keyword){ ... }"
}
```

- 导出为单个书源对象；也可导出数组（批量）。导入支持单对象与数组，自动归一化缺省字段。
- 接口不保证 HTTP/HTTPS 以外协议。

## JS 入口函数（书源作者实现）

所有入口函数可以写同步或 `async`（引擎统一 await 结果）。程序以「参数数组」调用并把返回值转成 JSON。
相对 URL（`/a/b`、`../x`）需自行用 `util.urlJoin` 拼绝对地址（推荐），引擎不自动补全。

| 能力开关 | 函数 | 参数 | 返回 |
| --- | --- | --- | --- |
| search | `searchBook(keyword)` | string | `BookItem[]` |
| discover | `discoverBooks(category, page?)` | 分类对象（无分类传 `{name:"",url:""}`）| `BookItem[]` |
| discover（可选） | `discoverCategories()` | 无 | `{name,url}[]` |
| detail（可选） | `bookDetail(book)` | `BookItem` | 富化后的 `BookItem` |
| toc | `bookToc(book)` | `BookItem` | `ChapterItem[]` |
| content | `bookContent(chapter, book)` | `ChapterItem, BookItem` | 正文文本 string |

### 对象形状

```js
// BookItem
{ bookName: "书名",      // 必填
  author: "作者",         // 可选
  cover: "https://...",   // 可选
  intro: "简介…",          // 可选
  latest: "最新章节名",     // 可选（列表展示）
  updateTime: "2024-01-01",// 可选
  bookUrl: "https://.../book/1" } // 必填：全书稳定身份（sourceId+bookUrl 去重）

// ChapterItem
{ chapterName: "第一章",   // 必填
  chapterUrl: "https://.../chapter/1" } // 必填
```

`bookUrl` 同时是「加入书架后按窗口缓存与批量下载」的定位依据，站内改版前请尽量稳定。

### 正文返回约定

`bookContent` 返回**纯文本**：段落间用空行分隔即可；若返回 HTML，引擎/前端会尽力剥标签并把
`<br>`、`</p>`、`</div>`、`<li>` 等折算为换行，但**不保证精确排版**——复杂页面请用
`html` 对象选中正文容器后再 `html.text(el.html)`（见 api 文档示例）。

## 容量与超时

- 搜索结果：单源 ≤ 100 条截断展示；目录：≤ 20000 章。
- 单次响应体 ≤ 32 MiB；单章正文 ≤ 5 MiB（超出截断并置 `truncated`）。
- 单请求默认超时 15s（`opts.timeoutMs` 可调，上限 120s）；单函数调用预算 45s、单章正文 30s。
- 书源 JS 中**不可用**：定时器（`setTimeout`…）、真 DOM、`fetch`、文件/进程访问；
  纯 CPU 死循环无法被杀停（属已知限制，请勿在规则里写死循环）。
- 「书源并发」是**用户级全局设置**（设置 → 书源），指一次搜索同时运行多少个书源；
  批量拉正文的单源内部并行请求数也以该设置值为上限（1–8，默认 3）。它不是书源 JSON 的字段。

## 常见坑

- 顶层（函数体外）代码**每次调用都会执行**：引擎每批/每次调用都新建上下文并 `eval` 全书源代码。
  不要在顶层做初始化请求；顶层级联初始化可放进入口函数内部判空。
- `await http.get(...)` 可用（宿主调用为同步完成，微任务由引擎驱动），但一次入口调用内部的多个请求是**串行**的；
  并发能力来自“一次并行运行多个书源/批量拉正文的并行请求”，数值受用户「书源并发」设置约束。
- 不要把用户 Cookie 明文写死进规则；放书源的「默认请求头」或运行时 `http.setCookie`，见 cloudflare.md。

## 能力开关行为

- 某能力关闭后：发现页不显示对应入口，引擎也会拒绝调用（双重校验）。
- 若开关开着但函数没实现：调用返回结构化错误（`bookXxx is not defined`），界面上可读展示。

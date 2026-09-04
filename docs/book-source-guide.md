# 从零编写一个书源（入门）

目标：让「发现 → 搜索 → 加入书架 → 阅读（按需缓存正文）」跑通一个返回 JSON 的书站。

## 1. 新建

发现页右上角 → 书源管理 → `+`（新建，会预填模板）。填三样：**名称**、**站点地址**、
**JS 代码**。保存前可用下方「测试」面板直接「保存并测试」。

## 2. 最小搜索（JSON API 站点）

```js
const BASE = "https://api.example.com";

async function searchBook(keyword) {
  const resp = await http.get(BASE + "/search?q=" + encodeURIComponent(keyword), {
    headers: { Referer: "https://www.example.com/" },
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const data = JSON.parse(resp.body); // { list: [...] }
  return data.list.map((it) => ({
    bookName: it.title,
    author: it.author,
    intro: it.desc,
    latest: it.latest_chapter,
    updateTime: it.update_time,
    bookUrl: BASE + it.link,
  }));
}
```

测试：切到「搜索」，参数保持 `["关键词"]` → 保存并测试 → 应打印结果数组。
字段除 `bookName`、`bookUrl` 都可省略。

## 3. 目录（HTML 站 + CSS 选择器）

```js
async function bookToc(book) {
  const resp = await http.get(book.bookUrl, { headers: { Referer: BASE } });
  const links = html.queryAll(resp.body, "div#list a, div.catalog a");
  return links.map((el) => ({
    chapterName: html.text(el.html),
    chapterUrl: util.urlJoin(book.bookUrl, el.attrs.href),
  }));
}
```

测试：参数换成 `[{ "bookName": "书名", "bookUrl": "https://…/book/1" }]`。

## 4. 正文

```js
async function bookContent(chapter, book) {
  const resp = await http.get(chapter.chapterUrl, { headers: { Referer: book.bookUrl } });
  const el = html.query(resp.body, "div#content");
  if (!el) throw new Error("找不到正文容器");
  return html.text(el.html); // 段落间空行分隔
}
```

测试参数：

```json
[
  { "chapterName": "第一章", "chapterUrl": "https://…/chapter/1" },
  { "bookName": "书名", "bookUrl": "https://…/book/1" }
]
```

### 正文是 JS 渲染/分页接口

可先在 `bookContent` 里 `console.log(resp.status, resp.body.slice(0,200))` 观察（日志会显示在测试面板）。
很多站正文以「分页 HTML 多段拼接」或 JSON 下发，常见做法：

- 请求章节页拿“章节分页数/下一页”，循环 `http.get` 拼 text；
- 返回 JSON 时 `JSON.parse` 取正文段数组后 `.join("\n\n")`。

## 5. 详情与发现（可选）

- `bookDetail(book)`：返回富化后的 `BookItem`（补 `cover/intro/latest/updateTime`），失败可不实现。
- `discoverBooks(category, page)` + 可选 `discoverCategories()`：分类发现。列表页会自动把
  `{name,url}` 当作分类参数传给 discoverBooks。

## 6. 测试与迭代

「测试」面板= 当前能力 → 参数(JSON 数组) → **保存并测试**：
结果展示成功/失败、耗时与 `console` 输出。保存后同一书源再次修改会覆盖。

## 7. 分享/备份

书源管理列表每行「文件」图标复制单源 JSON；或导入/导出支持批量数组。给别人导入时对方只需：
书源管理 → 导入（选择文件或粘贴）→ 确认（含免责声明）。

## 进阶：需要登录 / Cloudflare / 防盗链

见 [cloudflare.md](./cloudflare.md)；简单经验：
- 需要 Referer/UA：写进书源的「默认请求头 / User-Agent」；
- 需要 Cookie：先在自己浏览器验证登录后，把 `Cookie: …` 粘到默认请求头，或用书源代码里 `http.setCookie`；
- 带鉴权的正文接口通常也在同一源会话里拿 cookie，放在 `bookContent` 前先调一次登录/初始化接口即可。

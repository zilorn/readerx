# 从零编写一个书源（入门）

目标：让「发现 → 搜索 → 加入书架 → 阅读（按需缓存正文）」跑通一个返回 JSON 的书站。

## 1. 新建

发现页右上角 → 书源管理 → `+`（新建，会预填模板）。填三样：**名称**、**站点地址**、
**JS 代码**。保存前可切到「测试」Tab 直接「保存并测试」。

编辑页顶部是常驻的三块 Tab，来回切换不丢草稿：

| Tab | 内容 |
| --- | --- |
| 书源信息 | 名称 / 站点地址 / 作者 / 版本、分组、启停与各能力开关、UA 与默认请求头、网页登录 |
| JS代码 | 占满整页的代码编辑器（行号 + 语法高亮；长行横向滚动，不折行） |
| 测试 | 选入口函数、填参数、**保存并测试**，查看结果与 `console` 输出 |

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
字段除 `bookName`、`bookUrl` 都可省略；若站点给了分类/标签，可一并返回 `tags: ["玄幻", "热血"]`（详见
[book-source-spec.md](./book-source-spec.md) 的 BookItem 形状）。

若书站能给出书籍封面，搜索结果里带上 `cover: "https://…/cover.jpg"`（绝对地址）即可：
「发现」的列表行与「书籍详情」预览会展示真实封面，「加入书架」时应用经**该书源会话**下载并
压缩成缩略图随书保存（书架 / 详情页都显示真实封面）。封面**始终可选**——没返回、地址非法或
下载失败都会自动回退书名首字占位封面，不影响任何流程。封面只有详情页才有的站，让 `bookDetail`
补返回 `cover` 即可。已加入书架的书若当时缺简介 / 封面（或书源后来更新），可在书架书籍详情页
点右上角刷新按钮重新调 `bookDetail` 拉取最新简介与封面，无需重新入架。

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

### 正文是图片（漫画 / 扫描 / 图文混排）

`bookContent` 返回含 `<img>` 的 HTML（或对象 `{ text?, images? }`）即可让本章带图，
阅读器会在用户读到这一章时逐张下载并本地化图片（走书源会话 / Cookie / 防盗链 Referer；
下载失败的图片占位文字右边可点「重试」），窗口内已下载章节的图片也会在正文取完后预取，详见
[book-source-image.md](./book-source-image.md)。纯文字写法不受任何影响。

## 5. 详情与发现（可选）

- `bookDetail(book)`：返回富化后的 `BookItem`（补 `cover/intro/latest/updateTime/tags`），失败可不实现。
- `discoverBooks(category, page)` + 可选 `discoverCategories()`：分类发现。列表页会自动把
  `{name,url}` 当作分类参数传给 discoverBooks。

## 6. 测试与迭代

「测试」Tab = 当前能力 → 参数(JSON 数组) → **保存并测试**：
结果展示成功/失败、耗时与 `console` 输出。保存后同一书源再次修改会覆盖。
「保存并测试」会先把当前代码存盘再运行，因此改完 JS 直接点它即可，不必先回信息 Tab 保存。

书源改动**即时生效**：新增 / 导入 / 启停 / 编辑保存后无需重启软件，「发现」页
（书源标签、搜索、分类发现）立刻按最新清单与开关状态工作——引擎每次调用都会重新
读取该书源文件，列表页也会在每次写盘后同步刷新。

## 7. 分组

书源管理页顶部的筛选条按分组过滤书源（全部 / 未分组 / 各自定义分组，带数量），尾部「分组」按钮进入
分组管理：新建、重命名、删除，以及对整组一键启用 / 停用（只改写状态不一致的书源）。书源行右侧的
文件夹图标把该书源归入某个分组，编辑页「书源信息 → 分组」同理。删除分组时组内书源退回未分组，
书源本身不受影响。

「发现」页顶部有同一条筛选条，且与书源管理页共用同一个选中值（会被记住）：筛到某一组再搜索 /
发现，就只跑该组的已启用书源。

## 8. 批量管理（多选）

书源多了之后不必逐个点：**长按书源行进入多选**（该行随即选中），此后点击行即勾选 / 取消勾选，
页头显示已选数量与「全选」——全选按当前筛选来，只作用于此时可见的书源，配合分组筛选就能
「先把一组筛出来、再全选」。页头右侧 ✕ 退出多选。

选中后底部操作条提供：**启用 / 停用**（只改写状态不一致的书源）、**分组**（把所选书源一起归入
某个分组，也能一并移出分组）、**导出**（把所选书源作为一个 JSON 数组复制到剪贴板）、
**删除**（连点两次确认）。操作完成后自动退出多选。

## 9. 分享/备份

书源管理列表每行「文件」图标复制单源 JSON；多选后底部「导出」可把多个书源作为一个数组复制
（见上一节）。给别人导入时对方只需：
书源管理 → 导入（选择文件 / 粘贴 / 粘贴 JSON 网址）→ 确认（含免责声明）。

导出的 JSON 会带可读的 `groupName`（不带本机分组 id）：对方导入时按名字匹配自己的分组，
没有同名分组就新建一个；导入确认页可以整体关掉「按分组名导入分组」，关掉后新导书源不归组、
覆盖已有书源时保留本机原有的分组。

把书源 JSON 传到网上（如 GitHub Gist / raw 链接）后，对方可在书源管理页点右上角「链接」图标，
直接粘贴该网址拉取导入，无需下载文件；导入前同样会先列出冲突与免责声明供确认。

## 进阶：需要登录 / Cloudflare / 防盗链

见 [cloudflare.md](./cloudflare.md) 与 [book-source-api.md](./book-source-api.md) 的 `webview` 段。

**Cloudflare 站点（Android，推荐）**：书源默认开启「自动网页认证」（编辑页「网页登录」卡片内可单独
关闭）。只要站点返回 CF 人机挑战（含 `cf_clearance` 过期后的再次挑战），引擎会自动拉起应用内
WebView 完成验证、刷新 Cookie 并重试原请求——搜索/目录/正文**不需要在书源代码里做任何处理**，
普通 `http.get` 写法即可。认证后仍 403 时把书源 UA 填成与网页一致的浏览器 UA（见 cloudflare.md）。

**Android 端（推荐）**：在书源编辑页点「网页登录」，应用内弹出 WebView 浮层，
登录完成后宿主自动捕获该站 Cookie（含 httpOnly）并**持久化到该书源**（重启自动注入），
之后的搜索/目录/正文请求都会自动带上：

```js
async function searchBook(keyword) {
  let resp = await http.get(BASE + "/search", { headers: { Referer: BASE } });
  if (resp.status === 401 || resp.status === 403) {
    const login = await webview.login(BASE + "/login"); // Android 应用内浮层
    if (!login.ok) throw new Error("需要登录：" + login.message);
    resp = await http.get(BASE + "/search", { headers: { Referer: BASE } });
  }
  // …
}
```

没有 Android 环境时仍可退而求其次：

- 需要 Referer/UA：写进书源的「默认请求头 / User-Agent」；
- 需要 Cookie：先在自己浏览器验证登录后，把 `Cookie: …` 粘到默认请求头，或用书源代码里
  `http.setCookie`；
- 带鉴权的正文接口通常也在同一源会话里拿 cookie，放在 `bookContent` 前先调一次登录/初始化接口即可。

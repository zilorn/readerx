# 书源图片正文（漫画 / 扫描 / 图文混排）

阅读器支持「正文 = 图片」的章节（整章图片）以及「文字中嵌插图」的图文混排。
书源作者**不需要新增能力开关、不用改 schemaVersion**，只需让 `bookContent` 把图片表达出来即可。
图片下载、防盗链请求、本地缓存全部由阅读器自动完成。

## 1. 如何表达图片

### 方式 A：返回含 `<img>` 的 HTML（推荐，与老协议兼容）

`bookContent` 照旧返回字符串。纯文本时的行为与旧版**完全一致**；一旦返回的 HTML 里出现
`<img>`，阅读器会按出现顺序抽取图片，并把图片前后的文字一起保留：

```js
async function bookContent(chapter, book) {
  const resp = await http.get(chapter.chapterUrl, { headers: { Referer: book.bookUrl } });
  const el = html.query(resp.body, "div#comic-img"); // 漫画：图片列表容器
  if (!el) throw new Error("找不到图片容器");
  return el.html; // <img src="https://img.xx/1.webp"><img src=".../2.webp">…
}
```

图文混排同样适用：文字段落与 `<img>` 交错出现即可，段落与图片会按顺序连成一章内容。

- 图片地址取 `src`；站内懒加载常见写法也兼容：`data-src` / `data-original` /
  `original` / `data-lazy-src` / `lazy-src` / `data-url` / `data-echo`（按上述顺序逐个尝试）。
- 相对地址（`/imgs/1.jpg`、`../x.png`）按**正文页地址**（`chapterUrl`）自动解析为绝对地址。
- `script` / `style` / 注释内部出现的 `<img` 不会误识别；没有可用地址的 `<img>` 会被当作不存在。
- 解析不了的内容（对象里没有 `text` / `images` 键）仍按普通文本返回，保持旧行为。

### 方式 B：返回对象 `{ text?, images? }`

需要显式表达“这一章是一组图”时，可直接返回对象（`images` 也可写作 `imgs`）：

```js
async function bookContent(chapter, book) {
  // …从分页接口收集到本章所有图
  return { text: "本章说明文字（可省略）", images: ["https://img.xx/1.webp", "…2.webp"] };
}
```

- `text`：可选，会作为普通正文段落（放在图片前）。
- `images` / `imgs`：图片地址数组（字符串），相对地址同样按 `chapterUrl` 解析。

## 2. 图片怎么被下载与存储

识别出图片后，阅读器在拉正文时**逐张下载并保存为 data URL** 写进章节本地缓存：

- 请求走**该书源的 HTTP 会话**：自动携带书源的默认请求头、User-Agent 与已保存的
  Cookie（含网页登录捕获的 Cookie）。
- 每张图的 `Referer` 自动取**正文页地址**（`chapterUrl`）——绝大多数防盗链图站校验的正是
  阅读页同域 Referer，因此无需书源额外配置。
- 下载后的图片随章节正文本地化：**离线可读**、反复翻页不重复请求（与 EPUB 插图同一套存储）。

> 因此请尽量让 `chapterUrl` 就是**实际出现图片的页面地址**；若某站要求 Referer 为首页等
> 其它地址，可在章节规则里用 `http.get` 自行换取图片直链，并在默认请求头中配好 Referer。

## 3. 整章图片章节

当一章只由图片组成（没有可读文字）时：

- 阅读器把它当作普通一章展示：分页/滚动模式会像排版一张张插图那样排这些图。
- 图片不计入章节字符（字数统计 / 阅读进度按“章”计），与 EPUB 里的插图口径一致。
- 若**所有图片都下载失败且本章没有文字**，该章会被判定为拉取失败（可重试 /
  阅读设置里「重新加载本章」重拉）。

## 4. 兼容性与注意事项

- **老书源零改动**：`bookContent` 返回纯文本的写法与旧版本行为完全一致。
- **已缓存章节不受影响**：之前按纯文本缓存的章节照常阅读；重新拉取才会带上图片。
- **数据格式未变**：书源 `schemaVersion` 仍为 1；章节 `blocks`（含既有 `img` 块）结构不变，
  旧版客户端读新版书库、新版读旧版书库都不会崩（旧版无 `img` 能力的本地书仅不显示图）。
- 图片以 data URL 存入本地书 JSON：体积随图片增长明显。**「下载全部正文」会把整本书的图都
  下载到本地**，漫画/扫描书请预估磁盘占用后再用。
- 单张图上限 24 MiB、单次请求超时 60 秒；图片下载的并发与全局「书源并发」设置一致。

## 5. 常见问题

| 现象 | 排查 |
| --- | --- |
| 图片显示“图片缺失”占位框 | 该图下载失败（无网 / 超限 / 非图片响应）。先确认 `chapterUrl` 可访问；图站防盗链的 Referer 域名与章节页不一致时，可在规则里先用 `http.get` 换到可直链的地址。 |
| 整章都是占位框，正文提示失败 | 纯图章所有图均下载失败：检查网络 / Cookie 是否过期（网页登录重新登录）。 |
| 返回的是 JSON 站点接口 | 老写法 `JSON.parse(...).join("\n\n")` 仍可用；需要带图时改用方式 B 返回 `{ text, images }`。 |

## 相关

- 书源返回约定总览：[book-source-spec.md](./book-source-spec.md)
- 宿主 API（http / html / util 等）：[book-source-api.md](./book-source-api.md)
- 入门示例：[book-source-guide.md](./book-source-guide.md)

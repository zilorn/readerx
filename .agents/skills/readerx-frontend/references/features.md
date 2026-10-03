# 前端功能实现与约束

只读取本次任务对应部分。下列代码路径以仓库根目录为起点；具体数值与状态机以实现为准，修改契约时同步本参考。

## 书库加载与导入

- src/lib/books.ts 维护元数据与已物化正文两级缓存；书架、搜索、详情优先读元数据，阅读等需要正文时才 ensureLocalBookContent。元信息编辑走 patchRemoteBookMeta，不把整本正文经 IPC 往返。
- 类型与结构化块在 src/lib/booksTypes.ts；EPUB/MOBI 的 HTML 转换共用 src/lib/ebookHtml.ts。导入图片沿用 images/ 文件与 readerx-img 协议，不把新图片字节塞入书籍 JSON。
- PDF 入口 src/lib/pdf.ts，子模块在 src/lib/pdf/；pdf.js 与 worker 按需加载。保留文字层优先、扫描页图片兜底和两遍解析，避免整本中间数据常驻内存；解析前分配 bookId，页面图命名与最终书籍 ID 一致。
- MOBI 的 Rust 解析与前端转换边界、支持格式及测试见 [MOBI 文档](../../../../docs/mobi.md)。离屏读取书内 HTML，不执行脚本、不加载外部图片；没有 Rust 宿主时明确提示不可用。
- 本地文件导入与 WebDAV 使用相同格式支持和落库语义；新增格式检查 src/components/ImportButton.tsx、src/lib/webdav.ts 及重新导入路径。

## 阅读排版与位置

- src/pages/Reader.tsx 接线；src/lib/readerLayout.ts 算几何，pagination.ts 分页，renderWindow.ts 管渲染窗口，readerPageTurn.ts / readerAutoPage.ts 管翻页。调整某项能力时优先改对应模块。
- 分页始终按单页列宽排版；宽屏双页是相邻两页组成一屏，跳页、书签定位与翻页需沿用 spreadStart 对齐屏首。滚动模式仍为单栏；不能用双页整块宽度传给单页排版器。
- 阅读进度使用稳定 chapterCid 与章节镜像字符偏移，查看 src/lib/progress.ts；字号、窗口宽度或排版变化不能把页码当持久化位置。
- 进度累计字符缓存仅按书籍对象 WeakMap 保存，不强引用整书；正文更新与显示副本沿用新对象独立统计。缓存改动运行 `node --expose-gc scripts/progress-cache-test.mjs`，验证同 ID 内容隔离与对象回收。
- 分页 / 滚动切换需在正文 DOM 更新前捕获字符位置并设置 resumeTarget，滚动转分页采样旧视口以补上未执行的滚动帧；恢复落定前不提交新视图的位置。切换时序回归运行 `node scripts/reader-position-transition-test.mjs`（Solid 浏览器运行时，覆盖单双页、未提交滚动、章首与连续切换）。
- 书签、选区、搜索与朗读共用正文字符坐标。src/lib/bookmarks.ts 的 buildTextMirror 拼接 p/h 文本，图片占零字符；段内图的 at 是 UTF-16 偏移。渲染保留 data-u/data-c，嵌套高亮 span 不新增或删减锚定文本。
- 书签重定位使用 resolveBookmarkTarget 的结构信息与前后文回退，并保留 uncertain 结果；目录覆盖或重载正文沿用风险预览与确认组件，不能只按文本首次出现位置静默跳转。
- 简繁转换与文本替换沿用 src/lib/hanDisplay.ts、textReplacements.ts 的显示派生路径，不改写存盘正文和章节 cid。显示文本变化时检查进度恢复、搜索、书签和朗读是否仍使用一致的镜像。

## 在线正文与图片

- src/lib/online.ts 管窗口预取、批量下载、重载和目录更新；src/lib/chapterImages.ts / imageAssets.ts 管图片状态与本地资源。引擎逐章任务在 src-tauri/src/chapter_runs.rs，宿主调用或规则改动使用书源引擎技能。
- 加入书架先存目录，正文按需逐章取回并立即保存。预取范围与实际渲染窗口是两种职责，读取实现中的 LAZY_WINDOW 与渲染窗口定义，不因后台远章落盘刷新整本阅读树。
- 普通下载不覆盖已存在正文，显式重载才覆盖；目录覆盖推进世代，按旧下标在飞的回写必须失效。取消、重试与用户优先级沿用现有任务机制。
- chapterHasContent 将 blocks 已定义（包括空数组）视为已取回，不能把合法空章当作未下载反复请求。正文与图片就绪分别判断，图片失败允许独立重试。

## 听书

- src/lib/ttsPlayer.ts 是阅读页生命周期内的播放器；ttsEngine.ts、httpTts.ts、webAudio.ts 分别承接原生、HTTP 合成与音频播放，ttsSegment.ts 管镜像分句，audioCache.ts 管缓存。
- 原生 TTS 暂停通过停止当前句实现，继续从句首重读；HTTP 播放暂停使用 AudioContext，保持句中位置。修改统一按钮时不能假设两者具有相同暂停能力。
- 阅读视图与朗读位置独立；取消跟读或浏览跨章后，播放器推进不挪动视图，返回跟读才追回。HTTP 预热由起播或打开听书面板触发，普通阅读不发合成请求。
- 停止旧会话再起播时保留现有定时语义：分钟倒计时在停止期间冻结，本章定时留给下一次朗读；显式关闭或到点才解除。dispose 清理监听、计时器与音频节点。

## 跨功能验证

前端检查按 SKILL.md 执行。按改动选择实际交互：窄屏/宽屏与单双页切换后的阅读位置、重复文本及跨段书签、含图或纯图章节、目录覆盖期间取消下载、两种听书引擎暂停与取消跟读。统计计时和同步/恢复后的缓存重载使用 [数据技能](../../readerx-data/SKILL.md)，无需为无关功能重复全量实测。

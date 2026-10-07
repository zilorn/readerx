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
- 书签的线条与颜色是记录上的可选字段 `style` / `color`（缺省 = 直线 + 主题强调色，旧记录与外部导入经 normalizeBookmark* 回默认）。选区菜单「书签」右侧的伸缩面板作用于当前选区的书签：已有则改样式，没有则按所选样式新建，只增改不删除；调整后菜单保持展开以便连续换样式（点菜单外收起），页面为此保留选区区间兜底——正文重渲染会替换文字节点，原生选区锚点与分页锚点 Range 都可能脱离文档。渲染走 index.css 的 `readerx-bookmark-*` 类，颜色经 CSS 变量 `--bm-color` 注入。
- 段落注释入口为 src/components/AnnotationSheet.tsx 与 src/lib/annotations.ts，由 Reader.tsx 接通 SelectionMenu。锚点取原书 chapterCid + unitIndex + SHA-256 原段与邻段指纹，显示替换/简繁转换不改变段落身份；只允许同一正文 p 单元内的选区（沿用 spanOfSelectionTarget 以兼容书签样式保留选区）。分页只在末片段显示一个无正文文本、零排版宽度的图标；保持列间与右侧留白可绘制。注释打开时暂停翻页/音量键/边缘菜单，表单聚焦不能滚动阅读区；Android 返回和 Escape 收起抽屉。保存快照带 previous，后端只应用 note 差集并返回实际合并结果；同步事件按书失效并重载，抽屉草稿保留，聚合后按稳定 note id 继续编辑。运行 `node scripts/annotations-test.mjs`；存储、备份与同步见 [阅读注释](../../../../docs/annotations.md)。
- 简繁转换与文本替换沿用 src/lib/hanDisplay.ts、textReplacements.ts 的显示派生路径，不改写存盘正文和章节 cid。显示文本变化时检查进度恢复、搜索、书签和朗读是否仍使用一致的镜像。

## 在线正文与图片

- src/lib/online.ts 管窗口预取、批量下载、重载和目录更新；src/lib/chapterImages.ts / imageAssets.ts 管图片状态与本地资源。引擎逐章任务在 src-tauri/src/chapter_runs.rs，宿主调用或规则改动使用书源引擎技能。
- 加入书架先存目录，正文按需逐章取回并立即保存。预取范围与实际渲染窗口是两种职责，读取实现中的 LAZY_WINDOW 与渲染窗口定义，不因后台远章落盘刷新整本阅读树。
- 普通下载不覆盖已存在正文，显式重载才覆盖；目录覆盖推进世代，按旧下标在飞的回写必须失效。取消、重试与用户优先级沿用现有任务机制。
- chapterHasContent 将 blocks 已定义（包括空数组）视为已取回，不能把合法空章当作未下载反复请求。正文与图片就绪分别判断，图片失败允许独立重试。

## 听书

- src/lib/ttsPlayer.ts 是阅读页生命周期内的播放器；ttsEngine.ts、httpTts.ts、webAudio.ts 分别承接原生、HTTP 合成与音频播放，ttsSegment.ts 管镜像分句，audioCache.ts 管缓存。
- 播放器 chapterAt 必须返回文本替换与简繁转换后的显示副本；分句缓存同时按章节对象与分页边界失效，HTTP 内存音频按实际句子文本和请求指纹匹配。修改该链路运行 `node scripts/tts-replacements-test.mjs`，覆盖窗口/整本预热、播放缓存与规则更新/删除；含正文或接口配置的内存缓存键不得写入日志。
- 原生 TTS 暂停通过停止当前句实现，继续从句首重读；HTTP 播放暂停使用 AudioContext，保持句中位置。修改统一按钮时不能假设两者具有相同暂停能力。
- 阅读视图与朗读位置独立；取消跟读或浏览跨章后，播放器推进不挪动视图，可通过「返回跟读」追回。HTTP 预热由起播或打开听书面板触发，普通阅读不发合成请求。
- 分页模式手动翻页 / 跳页落回朗读句所在屏时自动恢复跟读（双页含右页）；选区存在时保持暂停，取消选中后若仍在跟读屏则恢复。恢复检查的挂起状态必须能触发补判，不能只依赖在置位前已更新的页码；正文 / 分页未就绪时保留挂起。修改该链路运行 `node scripts/tts-follow-recovery-test.mjs`，覆盖选取跨屏、同步 / 动画翻页、单双页、跳页、重排与跨章等待。
- 停止旧会话再起播时保留现有定时语义：分钟倒计时在停止期间冻结，本章定时留给下一次朗读；显式关闭或到点才解除。dispose 清理监听、计时器与音频节点。

## 跨功能验证

前端检查按 SKILL.md 执行。按改动选择实际交互：窄屏/宽屏与单双页切换后的阅读位置、重复文本及跨段书签、含图或纯图章节、目录覆盖期间取消下载、两种听书引擎暂停与取消跟读。统计计时和同步/恢复后的缓存重载使用 [数据技能](../../readerx-data/SKILL.md)，无需为无关功能重复全量实测。

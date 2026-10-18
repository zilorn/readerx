# 前端功能实现与约束

只读取本次任务对应部分。下列代码路径以仓库根目录为起点；具体数值与状态机以实现为准，修改契约时同步本参考。

## 书库加载与导入

- src/lib/books.ts 维护元数据与已物化正文两级缓存；书架、搜索、详情优先读元数据，阅读等需要正文时才 ensureLocalBookContent。元信息编辑走 patchRemoteBookMeta，不把整本正文经 IPC 往返。
- 类型与结构化块在 src/lib/booksTypes.ts；EPUB/MOBI 的 HTML 转换共用 src/lib/ebookHtml.ts。导入图片沿用 images/ 文件与 readerx-img 协议，不把新图片字节塞入书籍 JSON。
- PDF 入口 src/lib/pdf.ts，子模块在 src/lib/pdf/；pdf.js 与 worker 按需加载，两端统一使用 `pdfjs-dist/legacy/build` 补齐 Iterator 等 API。`pdfjs.ts` 和 `pdf.worker.mjs` 各自先载入 `compat.mjs`，补齐 legacy 未覆盖的 Promise.withResolvers 与 ReadableStream 异步迭代；只补缺失接口，保留原生流以及正常读完、提前退出、异常时的锁释放与取消语义。worker 入口经 `?worker&url` 打包，Vite 配置保留 ES 模块具名导出 WorkerMessageHandler，供主线程回退使用。保留文字层优先、扫描页图片兜底和两遍解析，避免整本中间数据常驻内存；解析前分配 bookId，页面图命名与最终书籍 ID 一致。
- PDF 兼容回归：运行 `node scripts/pdf-stream-compatibility-test.mjs` 验证原生接口保留、迭代/取消/解压流语义；运行 `node scripts/pdf-compatibility-test.mjs`，构建后再加 `--built`，验证同时缺失 Iterator / Promise.withResolvers / 流异步迭代时，独立线程与主线程回退都能解析普通/压缩内容流并重复导入。Android 实机与实际文件另验。
- MOBI 的 Rust 解析与前端转换边界、支持格式及测试见 [MOBI 文档](../../../../docs/mobi.md)。离屏读取书内 HTML，不执行脚本、不加载外部图片；没有 Rust 宿主时明确提示不可用。
- 本地文件导入与 WebDAV 使用相同格式支持和落库语义；新增格式检查 src/components/ImportButton.tsx、src/lib/webdav.ts 及重新导入路径。

## 阅读排版与位置

- src/pages/Reader.tsx 接线；src/lib/readerLayout.ts 算几何，pagination.ts 分页，renderWindow.ts 管渲染窗口，readerPageTurn.ts / readerAutoPage.ts 管翻页。调整某项能力时优先改对应模块。
- 分页翻页只挂载当前与前后相邻屏，`Reader.tsx` 的 `mountedSpreads` / `renderPagedSpread` 按屏首和分页结果的页数组复用 DOM；目标屏在折页中直接显示，落页仅切换可见性与当前屏引用，不重挂已加载图片。`readerPageTurn.ts` 只克隆当前纸面，目标屏不能再克隆；每屏须有不透明的主题纸张底色，预览屏层级高于当前屏，防止折页揭开处两屏正文叠显。分页图使用 eager / sync，滚动图保持 lazy / async。选区与书签闪亮查询限定当前屏，避免命中相邻屏。运行 `node scripts/reader-page-turn-test.mjs` 验证复用、单双页、窗口释放、打断/回弹和跨章取消；原生 `readerx-img` 协议的瞬时显示仍需在设备上观察。
- 分页始终按单页列宽排版；宽屏双页是相邻两页组成一屏，跳页、书签定位与翻页需沿用 spreadStart 对齐屏首。滚动模式仍为单栏；不能用双页整块宽度传给单页排版器。
- 章首页回翻以目标章节 cid 保留末页请求，等待正文与分页；正文或译文状态刷新不能用临时章首的字符恢复目标覆盖它。目录或工具栏改跳其它章即取消；工具栏上一章仍从章首开始。运行 `node scripts/reader-chapter-boundary-test.mjs` 验证译文开关、异步正文、单双页、动画与跨章往返/取消。
- 阅读进度使用稳定 chapterCid 与章节镜像字符偏移，查看 src/lib/progress.ts；字号、窗口宽度或排版变化不能把页码当持久化位置。
- 进度累计字符缓存仅按书籍对象 WeakMap 保存，不强引用整书；正文更新与显示副本沿用新对象独立统计。缓存改动运行 `node --expose-gc scripts/progress-cache-test.mjs`，验证同 ID 内容隔离与对象回收。
- 分页 / 滚动切换需在正文 DOM 更新前捕获字符位置并设置 resumeTarget，滚动转分页采样旧视口以补上未执行的滚动帧；恢复落定前不提交新视图的位置。切换时序回归运行 `node scripts/reader-position-transition-test.mjs`（Solid 浏览器运行时，覆盖单双页、未提交滚动、章首与连续切换）。
- 选区菜单竖直定位在 src/lib/selectionMenuPosition.ts：首个可见选中行距正文页顶不足四个正文行高时贴可见选区与末手柄下方，否则贴可见选区与起始手柄上方，间距 10px；空间不足只夹取安全区，不翻面或放到选区中间。Reader.tsx 的 pageSelLayout 提供正文页顶、行高和按阅读顺序的首个可见行（双页不能取两页纵坐标最小值），手柄仍只传屏内真实端点；原生选区使用屏内客户矩形与计算行高。回归运行 `node scripts/selection-menu-position-test.mjs`。
- 书签、选区、搜索与朗读共用正文字符坐标。src/lib/bookmarks.ts 的 buildTextMirror 拼接 p/h 文本，图片占零字符；段内图的 at 是 UTF-16 偏移。渲染保留 data-u/data-c，嵌套高亮 span 不新增或删减锚定文本。
- 书签重定位使用 resolveBookmarkTarget 的结构信息与前后文回退，并保留 uncertain 结果；目录覆盖或重载正文沿用风险预览与确认组件，不能只按文本首次出现位置静默跳转。
- 书签的线条与颜色是记录上的可选字段 `style` / `color`（缺省 = 直线 + 主题强调色，旧记录与外部导入经 normalizeBookmark* 回默认）。选区菜单「书签」右侧的伸缩面板作用于当前选区的书签：已有则改样式，没有则按所选样式新建，只增改不删除；调整后菜单保持展开以便连续换样式（点菜单外收起），页面为此保留选区区间兜底——正文重渲染会替换文字节点，原生选区锚点与分页锚点 Range 都可能脱离文档。渲染走 index.css 的 `readerx-bookmark-*` 类，颜色经 CSS 变量 `--bm-color` 注入。
- 段落注释入口为 src/components/AnnotationSheet.tsx 与 src/lib/annotations.ts，由 Reader.tsx 接通 SelectionMenu。锚点取原书 chapterCid + unitIndex + SHA-256 原段与邻段指纹，显示替换/简繁转换不改变段落身份；只允许同一正文 p 单元内的选区（沿用 spanOfSelectionTarget 以兼容书签样式保留选区）。分页只在末片段显示一个无正文文本、零排版宽度的图标；保持列间与右侧留白可绘制。注释打开时暂停翻页/音量键/边缘菜单，表单聚焦不能滚动阅读区；Android 返回和 Escape 收起抽屉。保存快照带 previous，后端只应用 note 差集并返回实际合并结果；同步事件按书失效并重载，抽屉草稿保留，聚合后按稳定 note id 继续编辑。运行 `node scripts/annotations-test.mjs`；存储、备份与同步见 [阅读注释](../../../../docs/annotations.md)。
- 章节正文编辑入口为 `ReaderSettingsSheet`，抽屉为 `ChapterEditSheet`，文本与图片锚点转换在 `src/lib/chapterEditing.ts`。编辑原章而非显示副本；确认覆盖后经 `updateBookChapters` 队列复核 cid / 地址 / 原文并合并最新图片引用，只回写正文，成功回章首。取消丢弃草稿，失败保留草稿；交互与图片策略见 [抽屉文档](../../../../docs/drawers.md#章节正文编辑)，回归运行 `node scripts/chapter-editing-test.mjs`。
- 简繁转换与文本替换沿用 src/lib/hanDisplay.ts、textReplacements.ts 的显示派生路径，不改写存盘正文和章节 cid。显示文本变化时检查进度恢复、搜索、书签和朗读是否仍使用一致的镜像。

## 在线搜索与换源

- `src/lib/onlineSearch.ts` 按去除首尾空白后的原始书名合并搜索结果；最多 120 个书名，已保留书名的后续来源仍补入，来源按 sourceId + bookUrl 去重。不按作者或展示简繁转换结果合并。
- `Discover` 点击合并项随机预览一个来源；同名在线书已在书架时优先使用书架绑定。`OnlineBookSheet` 的候选切换只改会话状态，详情、目录、文字预览按请求序号隔离；点击章节预览文字，完整图片阅读仍走入架后的阅读器。
- `BookDetail` 的换源入口由 `BookSourceSwitch` 按原始书名搜索所有已启用且支持搜索的书源；阅读器点击书名到详情页后使用相同入口。仅在线书显示，逐源失败不抹去成功候选，关闭后停止分发并丢弃在飞结果。
- 已入架书明确确认后由 `switchOnlineBookSource` 停止旧任务、推进目录世代，在既有整书写队列内替换来源绑定、目录、简介和书源标签；稳定 ID、手编标签、分组、书签、注释和进度记录保留。旧正文不跨源继承，即使 URL 相同。目录序号与正文差异可能需要重新定位进度、书签或注释，确认区必须说明。回归运行 `node scripts/online-sources-test.mjs`。

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


## 智能翻译

入口为 src/lib/translation/（配置、提供商协议、采样/指纹、任务调度、阅读接线）、
src/pages/TranslationSettings.tsx、TranslationManagement.tsx 与 BookTranslationSettings / TranslationPopup / GlossarySheet。
全局总开关默认关闭，按书覆盖项沿用未修改的全局项。译文是显示副本，保持原文单元编号；
pagination.ts 的译文片段按源字符跨度映射进度，测量与渲染字号一致；重排前撤去翻页动画，
沿用阅读位置恢复通道；滚动恢复须从同一次视口采样记录原文/译文节点类型，
随恢复目标传递，不能用同段存在译文来推断。独立切换按钮为
`TranslationReadingToggle` 只修改独立的 `readingText` 听书原译文偏好，不修改显示 `mode`；
阅读设置写本书覆盖项，全局设置/翻译配置页写全局默认，缺省朗读原文。
TTS 经 `speechText` 只转换合成文字，保持原文分句坐标，两种引擎及主动音频预热共用；
配置更新调用 `refreshText` 取消旧翻译并保留位置/暂停状态。修改时运行 `node scripts/tts-replacements-test.mjs`。
本书阅读设置直接提供术语表开关和翻译管理入口；管理页支持单章强制重译与术语表编辑/重新生成，
`BookTranslationActions` 通过 translation/manual.ts 显式切换书名译名与翻译全部已下载正文，
支持取消、进度与缓存续译；translation/title.ts 的 createBookTitle 只读本地状态用于显示，
原始书名仍用于元数据编辑与换源。回归运行 `node scripts/translation-manual-test.mjs`。
发现页搜索/浏览行与 OnlineBookSheet、BookDetail 通过 `translation/metadata.ts` 的
`createMetadataTranslation` 和 `MetadataTranslationActions` 翻译书名及非空简介，支持重译、取消、原文切换。
设置页的 `autoTranslateMetadata` 默认 false，只自动处理活动发现页与已加载详情的预览；
保活页离开必须传 active=false 取消任务，详情页始终手动。未入架译文保留有界会话缓存，
本地书籍简介使用可选 introEnabled/introTranslation 字段，沿用既有翻译状态；原始元数据不变。
自动失败逐项重试，手动失败走 reportFailure，书籍信息请求共用 engine.ts 的 limited 并发预算。
回归仍运行 `node scripts/translation-manual-test.mjs`，覆盖自动开关、活动状态和迟到结果。
本书配置开关不自动启动全书批量翻译，全书操作只由手动按钮触发。运行 `node scripts/translation-position-test.mjs`
验证两侧恢复、后续批次与按钮保存。双语折叠模式仅在展开浮窗时翻译单段，忽略预翻译章数，
不提前生成术语表；切回内嵌双语或仅译文后恢复已保存的预翻译配置。
折叠浮窗复用选区定位规则，翻页/换章收起。完整约束见
[智能翻译](../../../../docs/smart-translation.md)。回归：`node scripts/translation-test.mjs`，
术语表草稿语言与 AI 畸形响应回归：`node scripts/glossary-test.mjs`；
原文匹配与浏览器缓存回归：`node scripts/translation-storage-test.mjs`；SQLite 逐原文清理契约见数据技能。
追加既有阅读位置、翻页、选区、注释和章节编辑检查；真实服务与原生平台单独实测。

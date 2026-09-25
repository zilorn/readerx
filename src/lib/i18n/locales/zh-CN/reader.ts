/**
 * 阅读页正文（菜单、目录、搜索、高亮、听书入口、在线书下载等）。
 *
 * 书签面板 / 选区菜单 / 排版设置等阅读器外壳在 `readerChrome`，听书面板在 `tts`；
 * 这里只收阅读页自身的界面文案。书籍正文、章节标题、作者、书源地址都是用户数据，不进词典。
 * 「佚名」是书库写入的持久化取值（`book.author`），阅读页里与它比较的字符串保持原样。
 */
export const reader = {
  // 通用状态与空态
  "reader.backToShelf": "返回书架",
  "reader.bookMissing": "本地书籍不存在或已被删除",
  "reader.loadingBook": "加载书籍…",
  "reader.loading": "正在加载…",
  "reader.typesetting": "排版中…",
  "reader.currentChapter": "当前章节",
  "reader.thisChapter": "本章",
  "reader.authorSuffix": "{author} 著",
  "reader.tapCenterHint": "点屏幕中间唤出菜单",
  "reader.listSeparator": "、",

  // 章节与进度
  "reader.chapterOrdinal": "第 {index} 章",
  "reader.chapterRange": "第 {from}–{to} 章",
  "reader.prevChapter": "上一章",
  "reader.nextChapter": "下一章",
  "reader.chapterCount": "共 {count} 章",
  "reader.chapterCountShort": "{count} 章",
  "reader.textChapterCount": "{count} 章正文",
  "reader.imageCount": "{count} 张图片",
  "reader.menuChapterProgress": "{index}/{total}章",
  "reader.statusPageProgress": " · {page} / {total} 页",
  "reader.menuPageProgress": " · {page}/{total}页",

  // 目录抽屉
  "reader.toc": "目录",
  "reader.closeToc": "关闭目录",
  "reader.searchBook": "全书搜索",
  "reader.badgeDownloading": "下载中",
  "reader.badgeDownload": "下载",
  "reader.badgeCurrent": "当前",

  // 图片占位
  "reader.imageMissing": "图片缺失",
  "reader.imageShort": "图",
  "reader.reloadImage": "重新加载图片",
  "reader.imageReloadFailed": "图片重新加载失败：{error}",
  "reader.fetchingImages": "正在获取图片 {settled} / {total}",

  // 书签
  "reader.bookmarkAdded": "已添加书签",
  "reader.bookmarkRemoved": "已移除书签",
  "reader.bookmarkFailed": "无法添加书签",
  "reader.bookmarkNoContent": "当前内容无法添加书签",
  "reader.bookmarkSelectText": "请选择要标记的文字",
  "reader.bookmarkOverlap": "所选文字与已有书签重叠，无法添加书签",
  "reader.bookmarkTooLong": "所选文字过长，无法添加书签",
  "reader.bookmarkNeedParagraph": "书签需在正文段落内选取",
  "reader.bookmarkNotFound": "未能定位该书签",

  // 选区与复制
  "reader.copyFailed": "复制失败",
  "reader.adjustSelectionStart": "调整选区起点",
  "reader.adjustSelectionEnd": "调整选区终点",

  // 菜单 / 工具栏 / 搜索模式
  "reader.readingSettings": "阅读设置",
  "reader.bookmarks": "书签",
  "reader.downloadTitle": "下载正文",
  "reader.ttsListen": "听书",
  "reader.ttsStop": "停止听书",
  "reader.resumeFollow": "返回跟读",
  "reader.restoreProgress": "返回原进度",
  "reader.closeRestoreHint": "关闭返回提示",
  "reader.restorePreSearchPosition": "返回搜索前进度",
  "reader.backToSearchResults": "返回搜索结果列表",
  "reader.searchingTerm": "「{term}」搜索中",
  "reader.prevResult": "上一个结果",
  "reader.nextResult": "下一个结果",
  "reader.prev": "上一个",
  "reader.next": "下一个",
  "reader.exitSearchMode": "关闭搜索模式",

  // 在线书：章节获取 / 重新加载 / 目录更新
  "reader.fetchingChapter": "正在获取章节正文…",
  "reader.phaseDownload": "批量下载",
  "reader.phaseWindow": "窗口预取",
  "reader.cachedChaptersReadable": "已缓存的章节仍可正常阅读",
  "reader.fetchCancelled": "获取已取消",
  "reader.fetchFailed": "章节获取失败",
  "reader.retryFetch": "重试获取",
  "reader.chapterEmpty": "本章正文为空",
  "reader.chapterEmptyHint": "已从书源获取，但没有解析出正文，可能章节本身为空或需刷新重取",
  "reader.reloadChapter": "重新加载本章",
  "reader.reloadingChapter": "重新加载中…",
  "reader.reloadingChapterOverlay": "正在重新加载本章…",
  "reader.reloadChapterHint": "已从书源重新获取正文，完成后会覆盖本章",
  "reader.reloadFailedBackToProgress": "重新加载失败，已回到原进度：{error}",
  "reader.reloadedChapter": "已重新加载「{title}」",
  "reader.tocUpToDate": "目录已是最新，暂无更新",
  "reader.tocAppended": "已更新 {count} 个章节",
  "reader.updateCheckFailed": "检查更新失败：{error}",
  "reader.tocOverwritten": "目录已覆盖更新，共 {count} 章",
  "reader.overwriteFailed": "覆盖更新失败：{error}",

  // 听书预热（进度文案交给听书面板显示）
  "reader.prewarmPreparing": "准备中…",
  "reader.prewarmDone": "预热完成：{count} 句已写入缓存",

  // 在线书：批量下载正文
  "reader.downloadSummary": "{total} 章 · 已下载 {done} 章",
  "reader.downloadHint":
    "平时阅读只按需缓存当前章与前后各 {window} 章（顺序阅读不断章）；这里可把所选范围的正文批量下载到本机，之后断网也能读。",
  "reader.downloadConcurrencyHint":
    "请求并行度跟随全局「书源并发」设置（设置 → 书源）。",
  "reader.downloadRangeLabel": "下载范围",
  "reader.wholeBook": "全书",
  "reader.startChapter": "起始章",
  "reader.endChapter": "结束章",
  "reader.rangeTo": "至",
  "reader.pendingInRange": "范围内 {count} 章待下载",
  "reader.imageDownloadHint":
    "含图片的章节（漫画 / 图文）在正文下完后单独再过一遍图片（阅读时读到的章节也会随手缓存），占用空间随图片数量明显增大。",
  "reader.phaseWindowBusy": "窗口预取中…",
  "reader.phaseImages": "图片下载中…",
  "reader.phaseDownloading": "批量下载中…",
  "reader.chaptersFailed": "{count} 章失败",
  "reader.imagesFailedRetry": "{count} 张图片失败（阅读时可在图片上重试）",
  "reader.chaptersNotDownloaded": "上次有 {count} 章未下载成功",
  "reader.imagesNotDownloaded": "{count} 张图片未下载成功（阅读时可在图片上重试）",
  "reader.stopDownload": "停止下载",
  "reader.downloading": "下载中…",
  "reader.downloadRemaining": "下载剩余全部",
  "reader.downloadRangeButton": "下载{range}",
  "reader.downloadRangeDone": "{range}正文均已下载",
  "reader.downloadAllDone": "全书正文均已下载",
  "reader.downloadDoneCached": "下载完成：{items} 已缓存",
  "reader.downloadDoneFailed": "下载完成：{items}；{failed}失败",
  "reader.downloadStorageNote": "下载内容同样保存在本机书库，删除书籍时一并清除",
};

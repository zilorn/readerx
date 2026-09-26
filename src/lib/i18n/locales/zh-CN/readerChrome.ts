/**
 * 阅读器外壳：设置抽屉、书签面板、选区菜单、排版与进度。
 *
 * 覆盖 src/components 的阅读器浮层（设置抽屉 / 书签 / 选区菜单 / 章节范围 / 进度条）
 * 与它们依赖的 lib 里的界面文案（书签章节兜底名、简繁转换与取图的失败提示）。
 * 阅读页正文（src/pages/Reader.tsx）用 `reader.` 前缀，两边不要互相引用。
 */
export const readerChrome = {
  // 阅读设置抽屉
  "readerChrome.settings.title": "阅读设置",
  "readerChrome.settings.closeLabel": "关闭阅读设置",
  "readerChrome.settings.textReplace": "文本替换",
  "readerChrome.settings.textReplaceDesc": "替换阅读正文，不改动原文文件",
  "readerChrome.settings.statusBar": "底部状态栏",
  "readerChrome.settings.statusBarDesc": "阅读时在正文底部常驻显示章节名与阅读进度",
  "readerChrome.settings.progressScope": "进度百分比口径",
  "readerChrome.settings.progressScopeDesc": "状态栏百分比按哪个范围统计",
  "readerChrome.settings.scopeBook": "整本书",
  "readerChrome.settings.scopeChapter": "当前章节",
  "readerChrome.settings.menuSlider": "菜单进度条",
  "readerChrome.settings.menuSliderDesc": "左右翻页时在菜单上方显示，可拖动跳转页数",
  "readerChrome.settings.checkUpdate": "检查书籍更新",
  "readerChrome.settings.checkUpdateDesc": "重新获取书源目录，追加最新章节",
  "readerChrome.settings.checkUpdateBusy": "正在检查更新…",
  "readerChrome.settings.reloadChapter": "重新加载本章",
  "readerChrome.settings.reloadChapterDesc": "从书源重新获取当前章节正文",
  "readerChrome.settings.reloadChapterBusyDesc": "正在重新获取本章正文",
  "readerChrome.settings.reloadChapterBusy": "正在重新加载本章…",

  // 阅读设置行（与「设置」页共用）
  "readerChrome.reading.fontSize": "正文字号",
  "readerChrome.reading.fontSizeDecrease": "减小正文字号",
  "readerChrome.reading.fontSizeIncrease": "增大正文字号",
  "readerChrome.reading.paraSpacing": "段落间距",
  "readerChrome.reading.paraSpacingDesc": "正文段落之间的留白",
  "readerChrome.reading.pageMode": "翻页方式",
  "readerChrome.reading.pageModePaged": "左右翻页",
  "readerChrome.reading.pageModeScroll": "上下滚动",
  "readerChrome.reading.hanMode": "简繁转换",
  "readerChrome.reading.hanModeDesc": "书名、简介、目录与正文",
  "readerChrome.reading.hanOff": "关闭",
  "readerChrome.reading.hanS2T": "简→繁",
  "readerChrome.reading.hanT2S": "繁→简",

  // 正文选区菜单
  "readerChrome.selection.bookmark": "书签",
  "readerChrome.selection.speak": "朗读",
  "readerChrome.selection.replace": "替换",

  // 书签面板
  "readerChrome.bookmark.title": "书签",
  "readerChrome.bookmark.closeLabel": "关闭书签",
  "readerChrome.bookmark.totalCount": "共 {count} 条",
  /** 章节数后缀（接在「共 N 条」之后，仅 2 章以上时出现） */
  "readerChrome.bookmark.chapterCount": " · {count} 章",
  "readerChrome.bookmark.foundCount": "找到 {count} 条",
  "readerChrome.bookmark.itemCount": "{count} 条",
  "readerChrome.bookmark.currentBadge": "本章",
  "readerChrome.bookmark.deleteLabel": "删除书签",
  /** 首点删除后按钮变成对勾，提示再点一次才真删 */
  "readerChrome.bookmark.deleteConfirmLabel": "再点一次删除该书签",
  "readerChrome.bookmark.emptyTitle": "暂无书签",
  "readerChrome.bookmark.emptyHint": "长按正文选取文字后点「书签」即可添加",
  "readerChrome.bookmark.searchPlaceholder": "搜索章节或书签内容",
  "readerChrome.bookmark.clearSearch": "清空搜索词",
  "readerChrome.bookmark.noMatch": "未找到匹配的书签",
  "readerChrome.bookmark.noMatchHint": "可搜索章节标题或书签里的文字",
  /** 章节没有标题时书签卡片显示的兜底章名 */
  "readerChrome.bookmark.chapterFallback": "第 {index} 章",

  // 重新导入前的书签失效提示
  "readerChrome.bookmarkRisk.title": "部分书签可能失效",
  "readerChrome.bookmarkRisk.dialogLabel": "重新导入《{title}》可能导致书签失效",
  "readerChrome.bookmarkRisk.allFailed":
    "重新导入《{title}》后，原有的 {count} 条书签将全部无法在新内容中定位：",
  "readerChrome.bookmarkRisk.someFailed":
    "重新导入《{title}》后，原有的 {count} 条书签中有 {failed} 条无法在新内容中精确定位：",
  "readerChrome.bookmarkRisk.reason":
    "正文可能被修改或章节变动，重新导入后这些书签将无法跳转或可能跳错。",
  "readerChrome.bookmarkRisk.restKept": "其余书签会按原样保留。",
  "readerChrome.bookmarkRisk.cancelHint": "取消本次重新导入即可保留现有内容与书签。",
  "readerChrome.bookmarkRisk.proceed": "仍要重新导入",
  "readerChrome.bookmarkRisk.importing": "正在导入…",

  // 章节页进度条
  "readerChrome.pageSlider.label": "本章页数进度",
  "readerChrome.pageSlider.valueText": "{page}/{total}页",

  // 章节范围选择抽屉
  "readerChrome.chapterRange.hint": "可选第 {min}–{max} 章",
  /** 章节序号输入框的前后半句（中文夹在输入框两侧，英文只留前缀） */
  "readerChrome.chapterRange.ordinalPrefix": "第",
  "readerChrome.chapterRange.ordinalSuffix": "章",
  "readerChrome.chapterRange.ordinalLabel": "章节序号",
  "readerChrome.chapterRange.notCached": "未缓存",

  // 排版与取图（lib 里的界面文案）
  "readerChrome.page.authorBy": "{author} 著",
  "readerChrome.image.downloadFailed": "图片下载失败",
  "readerChrome.han.dictLoadFailed": "简繁转换词典载入失败",
  "readerChrome.han.settingsLoadFailed": "简繁转换设置载入失败",
  "readerChrome.han.dictRequestFailed": "词典资源请求失败：HTTP {status}",
  "readerChrome.han.dictMismatch": "词典资源与当前版本不匹配（请重新构建）",
};

/**
 * 发现页：在线搜索、结果列表、书籍详情弹层、书源分组筛选，
 * 以及在线书内容加载（src/lib/online.ts）与全书搜索面板（src/components/BookSearchPanel.tsx）
 * 抛给用户看的错误。
 */
export const discover = {
  // 页头与入口
  "discover.page.manageSources": "书源管理",
  "discover.page.sourcesLoading": "书源加载中…",
  "discover.page.noSources": "没有已启用的书源",
  "discover.page.goManageSources": "去管理书源",

  // 在线搜索
  "discover.search.placeholder": "输入书名 / 作者…",
  "discover.search.noSources": "没有可搜索的已启用书源",
  "discover.search.groupNoSources": "该分组没有可搜索的已启用书源",
  "discover.search.progress": "正在搜索书源 {done} / {total}（并发{parallel}）",
  "discover.search.failed": "搜索失败：{message}",
  "discover.search.noResults": "没有找到结果",
  "discover.search.foundMore": "已找到 {count} 条 · 仍在搜索其他书源…",
  "discover.search.resultCount": "{count} 条结果 · 点击查看详情并加入书架",

  // 发现（书源分类浏览）
  "discover.browse.noSources": "没有支持「发现」的已启用书源",
  "discover.browse.groupNoSources": "该分组没有支持「发现」的已启用书源",
  "discover.browse.loadMore": "加载更多",

  // 书名 / 作者 / 标签的快速搜索
  "discover.quickSearch.title": "搜索书名",
  "discover.quickSearch.author": "搜索作者",
  /** 可点击文字的无障碍名称：`{action}` 是「搜索书名」这类动作，`{text}` 是被搜索的词 */
  "discover.quickSearch.aria": "{action}：{text}",

  // 在线书详情抽屉
  "discover.sheet.aria": "在线书详情",
  "discover.sheet.title": "书籍详情",
  "discover.sheet.alreadyInShelf": "已在书架中",

  // 在线书信息（详情抽屉与 /online 页面共用）
  "discover.online.title": "在线书",
  "discover.online.expired": "这本书已失效",
  "discover.online.expiredHint": "请回到「发现」页重新搜索",
  "discover.online.readOnShelf": "去书架阅读",
  "discover.online.addNote":
    "加入书架只保存章节列表；正文在阅读时按需缓存「当前章与前后各 {window} 章」，阅读页也可按章节范围批量下载用于离线",
  "discover.online.latest": "最新：{value}",
  "discover.online.updateTime": "更新：{value}",
  "discover.online.inShelf": "已在书架",
  "discover.online.intro": "简介",
  "discover.online.noIntro": "暂无简介",
  "discover.online.introFailed": "简介获取失败：{message}",
  "discover.online.introLoading": "简介加载中…",
  "discover.online.toc": "目录",
  "discover.online.tocCount": "共 {count} 章",
  "discover.online.tocLoading": "目录加载中…",
  "discover.online.tocFetching": "正在获取目录…",
  "discover.online.tocUnsupported": "该书源未启用「目录」能力，无法预览章节",
  "discover.online.tocNotReady": "目录尚未就绪，暂时无法加入书架",
  "discover.online.expandChapters": "展开全部章节（还有 {count} 章）",
  "discover.online.addToShelf": "加入书架",
  "discover.online.addAndRead": "加入书架并阅读",
  "discover.online.startReading": "开始阅读",
  "discover.online.adding": "正在加入…",

  // 全书搜索面板
  "discover.bookSearch.title": "全书搜索",
  "discover.bookSearch.close": "关闭全书搜索",
  "discover.bookSearch.placeholder": "搜索标题或正文",
  "discover.bookSearch.clear": "清空搜索词",
  "discover.bookSearch.scopeTitle": "标题",
  "discover.bookSearch.scopeBody": "正文",
  "discover.bookSearch.kindTitle": "章标题",
  "discover.bookSearch.current": "当前",
  "discover.bookSearch.count": "{count} 处",
  "discover.bookSearch.hint": "输入关键词搜索全书",
  "discover.bookSearch.hintDetail": "可匹配章节标题与正文内容",
  "discover.bookSearch.noMatch": "未找到匹配内容",
  "discover.bookSearch.noMatchHint": "可切换搜索范围后重试",
  "discover.bookSearch.truncated": "命中过多，仅显示前 {count} 处",

  // 在线书内容加载失败（src/lib/online.ts，这些会显示给用户）
  "discover.error.tocFetchFailed": "获取目录失败",
  "discover.error.tocNoArray": "bookToc 未返回章节数组",
  "discover.error.tocEmpty": "目录为空（书源未解析出章节）",
  "discover.error.chapterNoUrl": "章节缺少地址",
  "discover.error.chapterFetchFailed": "获取正文失败",
  "discover.error.reloadBusy": "本章正在重新加载",
  "discover.error.reloadOtherBusy": "已有章节正在重新加载",
  "discover.error.tocChanged": "目录已更新，未写入本章",
  "discover.error.bookGone": "书籍已不在书库，未重新加载",
  "discover.error.chapterChanged": "章节已变化，未重新加载",
  "discover.error.notOnlineBook": "不是在线书，无法检查更新",
  "discover.error.missingBookUrl": "该书缺少书源书籍地址，无法检查更新",
  "discover.error.sourceDeleted": "该书源已删除，无法检查更新",
  "discover.error.sourceDeletedForRefresh": "该书源已删除，无法重新拉取",
  "discover.error.sourceDisabled": "该书源已停用，请先在「书源」中启用",
  "discover.error.tocCapability": "该书源未启用「目录」能力，无法检查更新",
  "discover.error.refreshOnlineOnly": "仅在线书支持重新拉取书籍信息",
  "discover.error.detailCapability": "该书源未启用「详情」能力，无法重新拉取书籍信息",
  "discover.error.refreshFailed": "拉取书籍信息失败",
};

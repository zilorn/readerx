/** 书架、书架搜索、导入入口、书籍封面与标签 */
export const shelf = {
  // 书架页头
  "shelf.title": "书架",
  "shelf.loading.library": "加载本地书库…",
  "shelf.onShelfCount": "{count} 本在架",
  "shelf.searchAria": "搜索书架书籍",

  // 书籍卡片
  "shelf.openAria": "打开《{title}》",
  "shelf.selectBookAria": "选中《{title}》",
  "shelf.deselectBookAria": "取消选中《{title}》",
  "shelf.progress.finished": "已读完",
  "shelf.progress.percent": "读到 {percent}%",

  // 多选
  "shelf.select.title": "选中书籍",
  "shelf.select.count": "已选 {count} 本",
  "shelf.select.allAria": "全选当前可见书籍",
  "shelf.select.noneAria": "取消全选当前可见书籍",
  "shelf.select.exitAria": "取消选择",
  "shelf.select.hint": "长按书籍进入多选；点击已选书籍可取消，底部可移动到分组或删除",
  "shelf.select.moveToGroup": "移动到分组",
  "shelf.select.confirmDelete": "确认删除",

  // 筛选标签（来源名与 BookCover 的「在线」标识共用）
  "shelf.source.local": "本地",
  "shelf.source.online": "在线",

  // 空状态
  "shelf.empty.noBooks": "书架空空如也",
  "shelf.empty.noBooksHint": "导入 TXT / EPUB / PDF 到本地书架",
  "shelf.empty.allHidden": "全部书籍均已隐藏",
  "shelf.empty.allHiddenHint": "点上方「隐藏」分组即可查看",
  "shelf.empty.group": "该分组暂无书籍",
  "shelf.empty.groupHint": "回到书架顶部点「全部」即可看到其它书籍",
  "shelf.empty.noMatch": "没有符合条件的书籍",
  "shelf.empty.noMatchHint": "切换书架顶部的筛选条件即可看到其它书籍",

  // 导入入口
  "shelf.import.title": "导入书籍",
  "shelf.import.local": "导入本地书",
  "shelf.import.localDesc": "从设备选择 TXT / EPUB / PDF",
  "shelf.import.webdav": "从 WebDAV 导入",
  "shelf.import.webdavDesc": "浏览 WebDAV 云盘书库",
  "shelf.import.importing": "正在导入…",
  "shelf.import.imported": "已导入《{title}》",
  "shelf.import.added": "已新增《{title}》",
  "shelf.import.reimported": "已重新导入《{title}》",
  "shelf.import.failed": "导入失败",
  "shelf.import.failedCheckFile": "导入失败，请检查文件",
  "shelf.import.reimportFailed": "重新导入失败",
  "shelf.import.reimportCancelled": "已取消重新导入",
  "shelf.import.readFailed": "读取所选文件失败",
  /** 解析阶段的三条错误（books.ts 抛出后直接进 Toast） */
  "shelf.import.errorUnsupported": "仅支持导入 .txt / .epub / .pdf 文件",
  "shelf.import.errorEmptyTxt": "TXT 文件内容为空，无法导入",
  "shelf.import.errorNoContent": "没有读取到可阅读的正文内容",

  // 同名书籍冲突弹层
  "shelf.import.conflictTitle": "《{title}》已在书架中",
  "shelf.import.conflictDesc":
    "重新导入会用所选文件替换这本书的内容，阅读进度、分组与书签会尝试继承；也可以保留原书，把所选文件作为一本新书加入书架。",
  "shelf.import.reimport": "重新导入",
  "shelf.import.checkingBookmarks": "正在检查书签…",
  "shelf.import.addAsNew": "作为新书加入书架",

  // 书架搜索
  "shelf.search.title": "搜索书架",
  "shelf.search.back": "返回书架",
  "shelf.search.placeholder": "书名 / 作者 / 文件名",
  "shelf.search.clear": "清空搜索词",
  "shelf.search.resultCount": "{count} 本",
  "shelf.search.prompt": "输入关键词开始搜索",
  "shelf.search.promptHint": "支持按书名、作者、文件名模糊匹配",
  "shelf.search.noResults": "未找到相关书籍",

  // 封面与标签
  "shelf.cover.ariaLabel": "{title}封面",
  "shelf.tag.removeAria": "移除标签 {tag}",
};

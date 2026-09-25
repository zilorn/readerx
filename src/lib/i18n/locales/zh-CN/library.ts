/**
 * 书库读写与解析（EPUB / PDF）、后端通道与异常兜底。
 *
 * 覆盖 src/lib/backend.ts、epub.ts、pdf.ts 与 pdf/ 下的渲染、分章子模块：
 * 这里只有 `reportFailure(...)` 的操作名、抛给用户的解析失败提示，以及图片 alt 兜底。
 * 日志文本（`log.*`）保持中文，不进词典。
 */
export const library = {
  /** 纯浏览器调试环境下的能力缺失说明（作为失败原因展示） */
  "library.app.onlyInApp": "仅在应用内可用",

  // 后端状态读写（readerx.* 状态文件）
  "library.state.readFailed": "读取本地设置失败",
  "library.state.writeFailed": "保存本地设置失败",
  "library.state.removeFailed": "清除本地设置失败",

  // 书籍读写
  "library.book.readFailed": "读取书籍失败",
  "library.bookmarks.readFailed": "读取书签失败",
  "library.bookmarks.writeFailed": "保存书签失败",

  // 书源
  "library.source.listFailed": "读取书源列表失败",
  "library.source.readFailed": "读取书源失败",
  "library.source.appOnly": "书源功能仅在应用内可用",
  "library.source.fetchContentsFailed": "拉取章节正文失败",
  "library.source.imageAppOnly": "书源图片仅应用内可用",
  "library.source.imageDownloadFailed": "图片下载失败",

  // 桌面端原生文件选择导入
  "library.file.appOnly": "原生文件选择仅在应用内可用",
  "library.file.noContent": "读取所选文件失败：没有拿到文件内容",

  // 开发者工具
  "library.devTools.failed": "打开开发者工具失败",

  // 网页登录
  "library.login.appOnly": "网页登录仅在应用内可用",
  "library.login.clearFailed": "清除登录状态失败",

  // EPUB 解析
  "library.epub.unzipFailed": "无法解压 EPUB（文件可能损坏或不是有效的 ZIP）",
  "library.epub.noContainer": "EPUB 缺少 META-INF/container.xml，不是标准 EPUB",
  "library.epub.noOpfPath": "EPUB container.xml 中未找到 OPF 清单",
  "library.epub.opfMissing": "EPUB 清单不存在：{path}",
  "library.epub.spineItemMissing": "EPUB spine 引用了不存在的清单项：{id}",
  "library.epub.contentMissing": "EPUB 正文文件缺失：{path}",
  /** 章节没有可用标题时的默认章节名 */
  "library.epub.sectionFallback": "第 {index} 节",
  /** EPUB 图片没有 alt 属性时的替代文本 */
  "library.epub.imageAlt": "插图",
  "library.epub.noChapters": "EPUB 中没有解析出可读章节，请确认文件未加密",

  // PDF 解析
  "library.pdf.pageImageAppOnly": "PDF 页面图仅应用内可落盘",
  "library.pdf.noPages": "PDF 没有可阅读的页面",
  "library.pdf.noContent": "PDF 中没有解析出可读内容，请确认文件未加密且未损坏",
  /** 单页章节的标题，以及页面图章节的图片替代文本 */
  "library.pdf.page": "第 {page} 页",
  "library.pdf.pageRange": "第 {start}–{end} 页",
  /** 大纲标题 + 页码范围（正文标题为「标题（第 1–3 页）」） */
  "library.pdf.chapterTitle": "{title}（{pages}）",
};

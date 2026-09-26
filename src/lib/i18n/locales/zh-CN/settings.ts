/**
 * 设置页与「开源许可 / 第三方声明 / 应用日志 / 听书缓存」相关界面。
 *
 * 主题选项、日志筛选项这类模块顶层常量数组存 key（`labelKey`），渲染时才调 `t()`
 * ——模块顶层求值发生在词典载入之前，也拿不到语言变化的响应式更新。
 * LICENSE 与 THIRD-PARTY-NOTICES.md 是随包文本（由 Rust 读取），其正文不进词典，
 * 这里只有容器的标题 / 说明 / 无障碍标签。
 */
export const settings = {
  // 区块标题（「书架」区块与「设置」页头分别复用 shell.tab.shelf / shell.tab.settings）
  "settings.section.appearance": "外观",
  "settings.section.reading": "阅读",
  "settings.section.sources": "书源",
  "settings.section.import": "导入",
  "settings.section.data": "数据",
  "settings.section.debug": "调试",
  "settings.section.about": "关于",

  // 外观：主题（行标题与 radiogroup 无障碍标签共用）
  "settings.theme.title": "主题",
  "settings.theme.light": "浅色",
  "settings.theme.dark": "深色",
  "settings.theme.sepia": "护眼",

  // 书源
  "settings.sources.manage": "书源管理",
  "settings.sources.manageDesc": "管理在线书来源与书源功能开关",
  "settings.sources.parallel": "书源并发",
  "settings.sources.parallelDesc": "一次搜索同时运行多少个书源",
  "settings.sources.parallelDecrease": "减小书源并发",
  "settings.sources.parallelIncrease": "增大书源并发",

  // 导入
  "settings.chapterRules.title": "分章规则",
  "settings.chapterRules.desc": "管理导入 TXT 时的自动分章",

  // 书架
  "settings.shelf.sourceFilter": "来源筛选",
  "settings.shelf.sourceFilterDesc": "在书架顶部显示「本地 / WebDAV / 在线」筛选",
  "settings.shelf.sourceFilterToggle": "书架来源筛选",

  // 数据
  "settings.data.ttsCache": "管理听书缓存",
  "settings.data.ttsCacheDesc": "查看并删除各书籍的合成音频缓存",
  "settings.data.resetProgress": "重置全部阅读进度",
  "settings.data.resetConfirm": "再点一次确认重置",
  "settings.data.resetProgressDesc": "所有书籍回到第 1 章，本地书籍文件不会删除",

  // 调试
  "settings.debug.logsDesc": "查看最近的后端与界面日志，可复制或清空",
  "settings.debug.devTools": "开发者工具",
  "settings.debug.devToolsDesc": "打开 WebView 开发者工具",

  // 关于
  "settings.about.tagline": "本地电子书阅读器",
  "settings.about.github": "GitHub 主页",
  "settings.about.githubDesc": "查看源码与发布动态",
  "settings.about.builtWith": "ReaderX {version} · 基于 Tauri 2 构建",

  // 开源许可（弹层标题是许可名 “GNU General Public License v3.0”，保持原样）
  "settings.license.title": "开源许可",
  "settings.license.subtitle": "ReaderX 开源许可",
  "settings.license.close": "关闭开源许可",
  "settings.license.error": "无法读取许可文本",

  // 开源库声明
  "settings.notices.title": "开源库声明",
  "settings.notices.subtitle": "ReaderX 使用的第三方开源库",
  "settings.notices.desc": "第三方开源库与其许可、用途",
  "settings.notices.close": "关闭开源库声明",
  "settings.notices.error": "无法读取开源库声明",

  // 听书缓存
  "settings.ttsCache.title": "听书缓存",
  "settings.ttsCache.subtitle": "本机合成音频",
  "settings.ttsCache.limitTitle": "每本书额度",
  "settings.ttsCache.unlimited": "不限",
  "settings.ttsCache.segments": "{count} 段",
  "settings.ttsCache.limitNote": "额度是每本书各自的上限，写满后写入新音频会淘汰最旧的；选「不限」则一直保留",
  "settings.ttsCache.booksTitle": "缓存书籍",
  "settings.ttsCache.booksDesc": "自定义源合成好的音频按书籍保存在本机，同一本书、同一声源再次朗读时直接使用缓存；删除书籍时缓存会自动清理",
  "settings.ttsCache.empty": "暂无听书缓存",
  "settings.ttsCache.bookUsage": "{count} 段 · {size}",
  /** 「已用 / 上限」形式：段数随上限读，故不用 {count}，英语也不配 _one / _other */
  "settings.ttsCache.bookUsageLimited": "{used} / {limit} 段 · {size}",
  "settings.ttsCache.clear": "清除",
  "settings.ttsCache.clearAll": "清空全部听书缓存",
  "settings.ttsCache.clearAllDesc": "删除所有书籍的合成音频，之后重新朗读会再次合成",

  /** 两段式确认：清空听书缓存与清空日志共用同一句 */
  "settings.action.clearConfirm": "再点一次确认清空",

  // 应用日志（弹层）
  "settings.logs.title": "应用日志",
  "settings.logs.close": "关闭应用日志",
  /** 日志按「天 + 本次启动」分文件，这一行是文件选择器的标签与「正在写的这一份」 */
  "settings.logs.file": "文件",
  "settings.logs.runCurrent": "本次 {moment}",
  "settings.logs.filterInfo": "信息",
  "settings.logs.filterWarn": "警告",
  "settings.logs.filterError": "错误",
  "settings.logs.copy": "复制日志",
  "settings.logs.copyEmpty": "没有可复制的日志",
  "settings.logs.copied": "日志已复制到剪贴板",
  "settings.logs.copyFailed": "复制日志失败",
  "settings.logs.refresh": "刷新日志",
  "settings.logs.level": "级别",
  "settings.logs.levelNormal": "常规",
  "settings.logs.levelVerbose": "详细",
  "settings.logs.verboseOn": "已开启详细日志",
  "settings.logs.verboseOff": "已恢复常规日志",
  "settings.logs.levelFailed": "切换日志级别失败",
  "settings.logs.verboseNote": "详细日志会记录每一步请求与解析，排障结束后建议切回常规",
  "settings.logs.cleared": "日志已清空",
  "settings.logs.clearFailed": "清空日志失败",
  "settings.logs.empty": "暂无日志",
  "settings.logs.emptyAtLevel": "该级别下暂无日志",
  "settings.logs.readFailed": "读取日志失败：{reason}",
  "settings.logs.browserOnly": "日志查看仅在应用内可用（浏览器开发环境没有后端日志）",
  "settings.logs.inAppOnly": "日志查看仅在应用内可用",
  "settings.logs.levelInAppOnly": "日志级别仅在应用内可调",
};

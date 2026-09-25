/**
 * 应用外壳：文档标题、主 Tab、侧边栏、页头默认文案、404。
 * 主 Tab 文案由 src/shell/routes.ts 的 key 引用，手机底部导航与桌面侧边栏共用。
 */
export const shell = {
  /** 文档 / 窗口标题 */
  "app.title": "ReaderX · 阅读",

  // 语言偏好（设置页）
  "app.language.title": "语言",
  "app.language.system": "跟随系统",
  /** 语言名用各自的语言书写，不随界面语言变化 */
  "app.language.zhCN": "简体中文",
  "app.language.en": "English",

  // 主 Tab
  "shell.tab.shelf": "书架",
  "shell.tab.discover": "发现",
  "shell.tab.settings": "设置",
  /** 底部 / 侧边导航的无障碍标签 */
  "shell.nav.main": "主导航",

  // 桌面侧边栏
  "shell.sidebar.tagline": "本地书管理",
  "shell.sidebar.expand": "展开侧边栏",
  "shell.sidebar.collapse": "收起侧边栏",

  // 启动
  "shell.startup.settingsFailed": "本地设置载入失败",
  "shell.startup.libraryFailed": "书库载入失败",

  // 懒加载占位
  "shell.loading.page": "页面加载中…",

  // 404
  "shell.notFound.title": "页面走丢了",
  "shell.notFound.desc": "你访问的页面不存在或已被移除",
  "shell.notFound.action": "回到书架",
};

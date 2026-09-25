/** 书源编辑器与其确认弹层 */
export const sourceEditor = {
  // 编辑器外壳
  "sourceEditor.title.new": "新建书源",
  "sourceEditor.title.edit": "编辑书源",
  "sourceEditor.action.save": "保存",
  "sourceEditor.tabs.label": "书源编辑",
  "sourceEditor.tab.info": "书源信息",
  "sourceEditor.tab.code": "JS代码",
  "sourceEditor.tab.test": "测试",
  "sourceEditor.code.docHint":
    "入口函数与宿主 API 见 docs/book-source-spec.md / docs/book-source-api.md",
  "sourceEditor.code.fillTemplate": "填入模板",
  "sourceEditor.code.confirmOverwrite": "再点一次覆盖",
  "sourceEditor.code.ariaLabel": "书源 JS 代码",

  // 书籍信息表单
  "sourceEditor.form.name": "名称",
  "sourceEditor.form.bookSourceUrl": "站点地址（bookSourceUrl）",
  "sourceEditor.form.author": "作者",
  "sourceEditor.form.version": "版本",
  "sourceEditor.form.group": "分组",
  "sourceEditor.form.enabled": "启用书源",
  /** 能力开关的无障碍标签（可见文案仍是 CAPABILITY_LABELS） */
  "sourceEditor.form.ability": "{name}能力",
  "sourceEditor.form.userAgent": "User-Agent（留空用内置默认；过 CF 等站点可在此填浏览器 UA）",
  "sourceEditor.form.headers":
    "默认请求头（每行「名称: 值」，Cookie 等可在此粘贴，CF 站点见 docs/cloudflare.md）",
  "sourceEditor.form.webLogin": "网页登录",
  "sourceEditor.form.webLoginHint": "WebView 浮层内完成登录，捕获含 httpOnly 的 Cookie",
  "sourceEditor.form.autoAuth": "自动网页认证",
  "sourceEditor.form.autoAuthHint":
    "请求遇 Cloudflare 挑战时自动弹窗认证并重试（令牌过期自动刷新）；书源代码 webview.login 同受此开关控制",
  "sourceEditor.form.autoAuthOff":
    "已关闭：该书源请求被拦截时不会自动弹出认证窗，书源代码的 webview.login 也会返回不可用；编辑页「打开登录页」不受影响",
  "sourceEditor.form.loginOpening": "登录窗口已打开…",
  "sourceEditor.form.openLogin": "打开登录页",
  "sourceEditor.form.clearLogin": "清空登录 Cookie",
  "sourceEditor.form.unsupported":
    "当前平台不支持网页登录（Android 应用内浮层 / 桌面端独立登录窗口）；可在代码里用 webview.login(url) 触发。",

  // 保存与删除
  "sourceEditor.validation.nameRequired": "名称不能为空",
  "sourceEditor.validation.urlRequired": "站点地址不能为空",
  "sourceEditor.validation.jsRequired": "JS 代码不能为空",
  "sourceEditor.validation.loginUrl": "请输入合法的 http/https 登录地址",
  "sourceEditor.unnamedSource": "未命名书源",
  "sourceEditor.saved": "书源已保存",
  "sourceEditor.deleted": "书源已删除",
  "sourceEditor.deleteConfirm": "再点一次确认删除",
  "sourceEditor.action.deleteSource": "删除书源",

  // 测试
  "sourceEditor.test.argsInvalid": "参数不是合法 JSON 数组",
  "sourceEditor.test.ok": "成功 · {ms}ms",
  "sourceEditor.test.noResult": "无返回",

  // 网页登录结果
  "sourceEditor.login.cookieCount": "{count} 个 Cookie",
  "sourceEditor.login.storageCount": "{count} 项存储",
  /** 「A 与 B」「A and B」的连接词，由登录结果里的各项拼接（登录项 ≥ 2 时用得到） */
  "sourceEditor.login.join": " 与 ",
  "sourceEditor.login.captured": "已捕获 {parts} 并保存到该书源",
  "sourceEditor.login.nothingCaptured": "登录完成，但没有捕获到登录信息",
  "sourceEditor.login.cancelled": "已取消登录",
  "sourceEditor.login.failed": "登录失败",
  "sourceEditor.login.cleared": "已清空登录态",
  "sourceEditor.login.none": "没有保存的登录态",

  // 导入确认弹层
  "sourceEditor.import.ariaLabel": "导入书源",
  "sourceEditor.import.title": "导入书源",
  "sourceEditor.import.summary": "{create} 新增 · {overwrite} 覆盖",
  "sourceEditor.import.disclaimer":
    "社区/第三方制作的书源与 ReaderX 及其作者无关，作者未参与任何书源制作。书源 JS 会在本地沙箱执行，但作者无法保证其安全性——仅导入可信来源。",
  "sourceEditor.import.skipped": "跳过 {count} 条无法解析的条目：{items}",
  /** 无法解析的条目之间的分隔符（仅界面拼接用） */
  "sourceEditor.import.issueSeparator": "；",
  "sourceEditor.import.duplicateTitle": "与本机重复的书源（同名 · 同站点），默认用导入内容覆盖",
  "sourceEditor.import.skip": "跳过",
  "sourceEditor.import.overwrite": "覆盖",
  "sourceEditor.import.overwriteAria": "覆盖书源 {name}",
  "sourceEditor.import.groupsTitle": "导入内容里的分组",
  "sourceEditor.import.grouped": "归入分组",
  "sourceEditor.import.groupToggleAria": "按分组名导入分组",
  "sourceEditor.import.groupCount": "{count} 个 · {state}",
  "sourceEditor.import.groupExisting": "已有",
  "sourceEditor.import.groupNew": "新建",
  "sourceEditor.import.apply": "仍要导入",
  "sourceEditor.import.pasteMore": "继续粘贴导入",

  // 粘贴导入抽屉
  "sourceEditor.paste.ariaLabel": "粘贴导入书源",
  "sourceEditor.paste.title": "粘贴导入",
  "sourceEditor.paste.subtitle": "书源 JSON 或 JSON 网址",
  /** 输入框示例：中文部分只是示例值（示例书名），JSON 字段名保持原样 */
  "sourceEditor.paste.placeholder": '[{"name": "书源名", "bookSourceUrl": "https://…"}]',
  "sourceEditor.paste.readClipboard": "读剪贴板",
  "sourceEditor.paste.url": "网址",
  "sourceEditor.paste.charCount": "{count} 字符",
  "sourceEditor.paste.emptyClipboard": "剪贴板里没有可导入的内容，可直接粘贴或输入 JSON",
  "sourceEditor.paste.failed": "导入失败",
  "sourceEditor.paste.processing": "处理中…",
  "sourceEditor.paste.fetch": "拉取并导入",
  "sourceEditor.paste.parse": "解析并导入",

  // 重新加载本章的书签风险弹窗
  "sourceEditor.reload.ariaLabel": "重新加载《{chapterTitle}》可能导致书签失效",
  "sourceEditor.reload.title": "重载后书签可能失效",
  "sourceEditor.reload.allFailed":
    "本章现有的 {count} 条书签，在重新获取的正文中都将无法精确定位：重新加载会用书源的最新正文替换本章内容，正文变化后这些书签可能无法跳转或可能跳错。",
  "sourceEditor.reload.partialFailed":
    "本章现有的 {total} 条书签中，有 {failed} 条在重新获取的正文中无法精确定位：重新加载会用书源的最新正文替换本章内容，正文变化后这些书签可能无法跳转或可能跳错。",
  "sourceEditor.reload.restKept": "其余书签不受影响，仍按原样保留。",
  "sourceEditor.reload.keepHint": "取消本次重新加载即可保留本章现有正文与书签。",
  "sourceEditor.reload.proceed": "仍要重新加载",

  // 在线目录覆盖确认弹窗
  "sourceEditor.toc.ariaLabel": "覆盖更新《{bookTitle}》的目录",
  "sourceEditor.toc.title": "目录与书架不一致",
  "sourceEditor.toc.desc":
    "《{bookTitle}》的书源返回了最新目录（{oldCount} 章 → {newCount} 章），与书架中的差异不是单纯的末尾新增，无法安全地直接追加。",
  "sourceEditor.toc.effect":
    "覆盖将以最新目录整本替换章节列表：章节地址未变的章节会保留已缓存正文，被修改 / 调整的章节之后会按需重新获取；章节结构变动可能影响阅读进度与书签的精确跳转。",
  "sourceEditor.toc.confirm": "覆盖更新",
  "sourceEditor.toc.applying": "正在覆盖…",

  // JS 代码编辑器
  "sourceEditor.js.fallbackLabel": "JS 代码",
};

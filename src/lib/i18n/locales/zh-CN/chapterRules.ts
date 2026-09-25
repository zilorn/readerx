/**
 * 分章规则与文本替换。
 *
 * 内置规则的正则源码、中文数字表、规则 id 与规则对象里的 `name` 都是匹配 / 持久化数据，
 * 一律保持原样、不进词典；内置规则的**显示名**单独放在 `chapterRules.builtin.*`
 * （渲染时按规则 id 取，见 src/lib/chapterRules.ts 的 chapterRuleDisplayName），
 * 用户自定义规则的名称是用户填写的内容，同样不翻译。
 */
export const chapterRules = {
  // 分章规则页
  "chapterRules.title": "分章规则",
  "chapterRules.subtitle": "导入 TXT 时生效",
  "chapterRules.section.auto": "自动分章（按列表顺序尝试）",
  "chapterRules.badge.builtin": "内置",
  "chapterRules.action.add": "添加分章规则",
  "chapterRules.action.save": "保存规则",
  /** 列表里删除按钮的无障碍标签（{name} 为规则名） */
  "chapterRules.action.deleteAria": "删除规则「{name}」",
  "chapterRules.hint.builtinLocked":
    "内置规则不可删除；全部规则未命中时自动按字数分章",
  "chapterRules.hint.appliesToImports":
    "新增规则会立即用于之后导入的 TXT 文件",
  "chapterRules.error.addFailed": "添加失败",

  // 添加规则抽屉
  "chapterRules.sheet.patternHint": "正则匹配标题",
  "chapterRules.form.name": "规则名称",
  "chapterRules.form.namePlaceholder": "如：第X集",
  "chapterRules.form.pattern": "正则表达式",
  /** 说明里的 `^` 是页面上带样式的代码片段，夹在 hintBefore 与 hintAfter 之间 */
  "chapterRules.form.hintBefore": "命中后整行作为章节标题，行首用",
  "chapterRules.form.hintAfter": "更稳妥；自动以忽略大小写 + 多行模式匹配。",
  "chapterRules.form.fillSample": "填入示例：中文章节标题",

  // 内置规则的显示名（规则对象里的 name 不翻译，按 id 取这里的文案）
  "chapterRules.builtin.zhPrelude": "中文章节（开头可带简介）",
  "chapterRules.builtin.zhChapter": "中文章节（第X章 / 回 / 节）",
  "chapterRules.builtin.zhFront": "序章 / 楔子 / 尾声 / 番外",
  "chapterRules.builtin.enChapter": "英文 Chapter / CHAPTER",
  "chapterRules.builtin.zhVolume": "卷 / 部 / 集 分卷",

  // 分章方式说明（回退按字数分章时显示）
  /** 导入时生成的分章标题（原文没有可用标题时用；落库值随当时的界面语言） */
  "chapterRules.generated.chapter": "第{index}章",
  "chapterRules.generated.section": "第{index}节",
  "chapterRules.generated.frontMatter": "开篇",
  "chapterRules.split.byChars": "按字数分章（每章约 {count} 字）",

  // 校验（规则名称、正则、替换的查找内容）
  "chapterRules.validation.nameRequired": "请填写规则名称",
  "chapterRules.validation.patternRequired": "请输入正则表达式",
  "chapterRules.validation.patternInvalid": "正则表达式无法解析",
  "chapterRules.validation.findRequired": "请填写要查找的文字",

  // 文本替换抽屉
  "chapterRules.replace.title": "文本替换",
  "chapterRules.replace.subtitle": "仅影响阅读显示，不改动原文",
  "chapterRules.replace.new": "新建替换",
  "chapterRules.replace.edit": "编辑替换",
  "chapterRules.replace.backToList": "返回替换列表",
  "chapterRules.replace.close": "关闭文本替换",
  "chapterRules.replace.empty": "还没有文本替换",
  "chapterRules.replace.save": "保存替换",
  "chapterRules.replace.delete": "删除此替换",
  "chapterRules.replace.saved": "已保存替换",
  "chapterRules.replace.added": "已添加替换",
  "chapterRules.replace.deleted": "已删除替换",

  // 替换表单
  "chapterRules.replace.find": "查找",
  "chapterRules.replace.findPlaceholder": "要被替换的文字",
  "chapterRules.replace.replaceWith": "替换为",
  "chapterRules.replace.replacePlaceholder": "留空 = 删除匹配文字",
  /** 列表里「替换为」为空时显示的占位说明 */
  "chapterRules.replace.deletedMatch": "删除匹配文字",
  "chapterRules.replace.regex": "正则",
  "chapterRules.replace.scope": "作用范围",
  "chapterRules.replace.scopeGlobal": "全局",
  "chapterRules.replace.scopeGlobalHint": "对书架里所有书生效",
  "chapterRules.replace.scopeGlobalSection": "全局（所有书生效）",
  "chapterRules.replace.scopeBook": "仅本书",
  "chapterRules.replace.scopeBookHint": "只作用于当前这本书",
  "chapterRules.replace.scopeBookHintTitle": "只作用《{title}》",
  "chapterRules.replace.scopeBookSection": "仅《{title}》",
  "chapterRules.replace.scopeBookSectionFallback": "仅当前这本书",
  /** 列表条目上的作用域标签 */
  "chapterRules.replace.scopeBookBadge": "本书",
  /** 正则说明里的 `$1` 是页面上带样式的代码片段，夹在 hintBefore 与 hintAfter 之间 */
  "chapterRules.replace.regexHintBefore":
    "按正则表达式查找并全部替换，替换内容支持",
  "chapterRules.replace.regexHintAfter":
    "等捕获组引用；去掉正则即按普通文字匹配。",
  "chapterRules.replace.error.noBook": "缺少目标书籍，无法保存为「仅本书」",
  /** 列表条目无障碍标签（{find} 为该条要查找的文字） */
  "chapterRules.replace.editAria": "编辑替换：{find}",
  "chapterRules.replace.deleteAria": "删除替换：{find}",
};

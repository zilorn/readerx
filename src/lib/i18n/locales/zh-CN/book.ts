/**
 * 书籍详情、元信息编辑与分组管理。
 *
 * 分区分工：`book.detail.*` 是详情页文案与字段值，`book.field.*` 是元信息字段名
 * （详情行、区块标题与编辑表单共用），`book.meta.*` 是元信息编辑抽屉，
 * `book.groups.*` / `book.picker.*` 是分组管理与「移入分组」抽屉。
 * 用户填写的书名 / 作者 / 分组名不在这里，它们是数据不是文案。
 */
export const book = {
  // 书籍详情页
  "book.detail.title": "书籍详情",
  "book.detail.refresh": "重新拉取书籍信息（简介、封面与标签）",
  "book.detail.loading": "加载本地书库…",
  "book.detail.notFound": "书籍不存在",
  "book.detail.tagsEmpty": "暂无标签，点击右上角「编辑」添加",
  "book.detail.introEmpty": "暂无简介，点击右上角「编辑」补充",
  "book.detail.searchTitle": "搜索书名",
  "book.detail.searchAuthor": "搜索作者",
  "book.detail.openInBrowser": "在浏览器打开{name}",
  /** 重新拉取成功时列出的更新字段，如「简介、封面已更新」 */
  "book.detail.updated": "{fields}已更新",
  "book.detail.upToDate": "书籍信息已是最新",
  "book.detail.refreshFailed": "重新拉取失败：{reason}",
  /** 更新字段列表的分隔符（中文顿号、英文逗号加空格） */
  "book.detail.fieldSeparator": "、",
  /** 格式与来源的取值：在线书在格式与来源两处都这么显示 */
  "book.detail.online": "在线书",
  "book.detail.webdavImport": "WebDAV 导入",
  "book.detail.localImport": "本地导入",
  "book.detail.chapterCount": "{count} 章",
  "book.detail.charCount": "{count} 字",

  // 元信息字段名（详情行、区块标题与编辑表单共用）
  "book.field.title": "书名",
  "book.field.author": "作者",
  "book.field.format": "格式",
  "book.field.source": "来源",
  "book.field.bookUrl": "书源地址",
  "book.field.chapters": "章节",
  "book.field.chars": "字数",
  "book.field.size": "大小",
  "book.field.file": "文件",
  "book.field.group": "分组",
  "book.field.importedAt": "导入时间",
  "book.field.intro": "简介",
  "book.field.tags": "标签",
  "book.field.cover": "封面",

  // 元信息编辑抽屉
  "book.meta.title": "编辑书籍信息",
  "book.meta.subtitle": "保存后书架同步更新",
  "book.meta.noCover": "无封面",
  "book.meta.changeCover": "更换封面",
  "book.meta.removeCover": "移除封面",
  "book.meta.tagsEmpty": "暂无标签",
  "book.meta.tagPlaceholder": "输入标签，回车或加号添加",
  "book.meta.addTag": "添加标签",
  "book.meta.introPlaceholder": "书籍简介（可留空）",
  "book.meta.titleRequired": "书名不能为空",
  "book.meta.saveFailed": "保存失败，请重试",
  "book.meta.saving": "正在保存…",
  "book.meta.coverReadFailed": "无法读取该图片，请换一张 JPG / PNG",

  // 书架分组管理
  "book.groups.title": "书架分组",
  "book.groups.manage": "书架分组管理",
  "book.groups.subtitle": "新建、重命名或删除书架分组",
  "book.groups.close": "关闭书架分组管理",
  "book.groups.empty": "还没有书架分组，在下方创建一个。",
  "book.groups.rename": "重命名《{name}》",
  "book.groups.delete": "删除分组《{name}》",
  "book.groups.confirmDelete": "确认删除分组《{name}》",
  "book.groups.saveName": "保存分组名",
  "book.groups.newPlaceholder": "新建分组",
  /** 内置隐藏分组的显示名（groups.ts 的 HIDDEN_GROUP_NAME 是保留名，不翻译） */
  "book.groups.hidden": "隐藏",
  "book.groups.hiddenHint": "加入后不在书架与搜索中显示",
  "book.groups.bookMissing": "这本书已不在书架",
  "book.groups.movedTo": "已移入「{name}」",
  "book.groups.movedOut": "已移出分组",
  "book.groups.addedToShelf": "已放入书架",
  "book.groups.joinGroup": "加入分组",

  // 移入分组抽屉
  "book.picker.choose": "选择分组",
  "book.picker.title": "移入分组",
  "book.picker.subtitle": "选择一个书架分组",
  "book.picker.create": "创建",
};

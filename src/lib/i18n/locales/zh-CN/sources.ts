/** 书源列表页：书源行、导入、测试面板、批量选择 */
export const sources = {
  // 页头与多选
  "sources.page.title": "书源管理",
  "sources.page.titleSelecting": "选中书源",
  "sources.page.selectedCount": "已选 {count} 个",
  "sources.page.enabledCount": "已启用 {enabled} / {total} 个书源",
  "sources.select.allHint": "全选当前筛选的书源",
  "sources.select.deselectAllHint": "取消全选当前筛选的书源",
  "sources.select.exit": "退出多选",
  "sources.select.hint": "长按书源进入多选；点击已选书源可取消，底部可批量启停、分组、导出或删除",

  // 页头操作
  "sources.import.json": "导入 JSON",
  "sources.paste.label": "粘贴导入",
  "sources.url.label": "从网址导入",
  "sources.new.label": "新建书源",

  // 空状态
  "sources.empty.title": "还没有书源",
  "sources.empty.hint": "从社区导入 JSON，或在「发现」页使用模板新建",
  "sources.empty.noUngrouped": "没有未分组的书源",
  "sources.empty.group": "该分组还没有书源",

  // 批量操作
  "sources.batch.enableDone": "已启用 {count} 个书源",
  "sources.batch.disableDone": "已停用 {count} 个书源",
  "sources.batch.noChange": "所选书源状态未变化",
  "sources.batch.grouped": "{count} 个书源已归入「{name}」",
  "sources.batch.ungrouped": "{count} 个书源已移出分组",
  "sources.batch.missing": "所选书源已不存在",
  "sources.batch.exported": "已复制 {count} 个书源的 JSON",
  "sources.batch.deleted": "已删除 {count} 个书源",
  "sources.batch.group": "分组",
  "sources.batch.export": "导出",

  // 导入（文件 / 粘贴 / 网址共用）
  "sources.import.none": "没有识别到可导入的书源",
  "sources.import.unrecognized": "未识别到书源：{reason}",
  "sources.import.done": "导入完成：新增 {created} 个，覆盖 {overwritten} 个",
  "sources.import.doneKept": "导入完成：新增 {created} 个，覆盖 {overwritten} 个，保留本机 {kept} 个",
  /** 逐条解析失败的原因（展示在确认弹层的「跳过 N 条」里） */
  "sources.import.issue.notObject": "不是对象",
  "sources.import.issue.missingName": "缺少名称 name",
  "sources.import.issue.missingUrl": "缺少站点地址 bookSourceUrl",
  "sources.import.issue.missingJs": "缺少 JS 代码 js",
  "sources.import.issue.badJson": "JSON 解析失败",
  "sources.import.issue.unparsable": "无法解析",

  // 从网址导入
  "sources.url.missing": "请输入书源 JSON 的网址",
  "sources.url.noSource": "该网址内容里没有可导入的书源",
  "sources.url.dialogAria": "从网址导入书源",
  "sources.url.hint": "输入指向书源 JSON（单条或数组）的网址，拉取后进入确认",
  "sources.url.fetching": "拉取中…",
  "sources.url.fetchAndImport": "拉取并导入",
  "sources.url.invalid": "请输入以 http(s):// 开头的书源网址",
  "sources.url.httpFailed": "拉取失败：HTTP {status}",
  "sources.url.empty": "该网址没有返回可导入的内容",
  "sources.url.timeout": "请求超时（30 秒），请检查网址与网络后重试",
  "sources.url.unreachable": "无法访问该网址：{reason}",

  // 删除书源
  "sources.delete.aria": "删除书源",
  "sources.delete.title": "删除书源？",
  "sources.delete.desc": "已用该书源下载到本地的书籍不受影响",
  "sources.delete.done": "书源已删除",

  // 归组与导出
  "sources.group.assigned": "已归入「{name}」",
  "sources.group.removed": "已移出分组",
  "sources.copy.done": "书源 JSON 已复制",

  // 书源行
  "sources.row.select": "选中书源《{name}》",
  "sources.row.deselect": "取消选中书源《{name}》",
  "sources.row.edit": "编辑书源《{name}》",
  "sources.row.enable": "启用书源《{name}》",
  "sources.row.disable": "停用书源《{name}》",
  "sources.row.assignGroup": "归入分组：{name}",
  "sources.row.copyExport": "复制导出 JSON：{name}",
  "sources.row.delete": "删除书源：{name}",

  // 测试面板
  "sources.test.title": "测试",
  "sources.test.hint": "保存当前代码后运行",
  "sources.test.running": "运行中…",
  "sources.test.run": "保存并测试",
  "sources.test.exportJson": "导出 JSON",

  // 能力与入口函数（CAPABILITY_LABELS / ENTRY_FUNCTION_META 只存 key）
  "sources.capability.discover": "发现",
  "sources.capability.toc": "目录",
  "sources.capability.content": "正文",
  "sources.entryDesc.search": "按关键词搜索",
  "sources.entryDesc.discover": "按分类发现书籍",
  "sources.entryDesc.detail": "富化书籍信息",
  "sources.entryDesc.toc": "获取章节列表",
  "sources.entryDesc.content": "获取单章正文",
};

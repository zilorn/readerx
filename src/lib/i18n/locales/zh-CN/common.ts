/**
 * 跨页面复用的通用词（确定 / 取消 / 删除 / 加载中…）。
 *
 * 只放**含义与语气都一致**的词：同一个中文词在不同语境下英文可能不同
 * （如「清空」在搜索框是 Clear、在缓存页是 Delete all），这类放各自模块，不要塞进这里。
 * 迁移时优先复用这里的 key，不要重复造同义词。
 */
export const common = {
  // 操作
  "common.confirm": "确定",
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.save": "保存",
  "common.saved": "已保存",
  "common.delete": "删除",
  "common.deleted": "已删除",
  "common.remove": "移除",
  "common.edit": "编辑",
  "common.done": "完成",
  "common.back": "返回",
  "common.retry": "重试",
  "common.refresh": "刷新",
  "common.reload": "重新加载",
  "common.copy": "复制",
  "common.copied": "已复制",
  "common.clear": "清空",
  "common.selectAll": "全选",
  "common.deselectAll": "取消全选",
  "common.add": "添加",
  "common.create": "新建",
  "common.rename": "重命名",
  "common.enable": "启用",
  "common.disable": "停用",
  "common.enabled": "已启用",
  "common.disabled": "已停用",

  // 状态
  "common.loading": "加载中…",
  "common.loadingDots": "读取中…",
  "common.search": "搜索",
  "common.searching": "搜索中…",
  "common.all": "全部",
  "common.none": "无",
  "common.unknown": "未知",
  "common.unknownError": "未知错误",
  "common.unnamed": "未命名",
  "common.unnamedBook": "未命名书籍",
  "common.anonymousAuthor": "佚名",
  "common.ungrouped": "未分组",
  "common.failed": "失败",
  "common.notFound": "不存在",
  "common.empty": "暂无内容",
  "common.yes": "是",
  "common.no": "否",

  // 其他
  "common.more": "更多",
  "common.details": "详情",
  "common.notice": "提示",
  /** 失败提示里「操作：原因」的分隔符（中文全角、英文半角加空格） */
  "common.failureSeparator": "：",
  /** 空值占位（日志与调试输出里用得到） */
  "common.placeholderNone": "（无）",
};

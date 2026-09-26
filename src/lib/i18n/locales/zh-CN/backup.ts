/**
 * 数据备份 / 恢复（设置 → 数据 → 数据备份）。
 *
 * 文案要讲清三件事：备份里**有什么**（含正文与插图的整库）、**登录信息默认不含**、
 * 以及导入的两种语义（「合并」不删本机数据，「覆盖恢复」会删掉备份里没有的书与书源）。
 */
export const backup = {
  "backup.appOnly": "仅应用内可用",
  "backup.title": "数据备份",
  "backup.subtitle": "把整台设备的数据导出一个文件，或从备份恢复",

  // 导出
  "backup.section.export": "导出",
  "backup.export.desc":
    "备份包含书架与书籍全文、书签、分组、书源、插图、替换与分章规则、阅读进度与界面偏好。",
  "backup.export.credentials": "包含登录信息",
  "backup.export.credentialsDesc":
    "书源网页登录的 Cookie 与 WebDAV 密码也会写进备份文件，别把它分享给别人",
  "backup.export.action": "导出备份",
  "backup.export.busy": "正在导出…",
  "backup.export.done": "已导出 {name}（{size}）",
  "backup.export.failed": "导出备份失败",

  // 导入
  "backup.section.import": "导入",
  "backup.import.desc":
    "从备份文件恢复数据：合并只补齐缺失与同 id 的内容，覆盖恢复会删掉备份里没有的书与书源。",
  "backup.import.pick": "选择备份文件",
  "backup.import.picking": "正在读取备份…",
  "backup.import.failed": "导入备份失败",
  "backup.import.readFailed": "读取备份失败",

  // 导入前的预览
  "backup.preview.title": "这份备份里有",
  "backup.preview.time": "导出于 {time}",
  "backup.preview.books": "{count} 本书",
  "backup.preview.images": "{count} 张插图",
  "backup.preview.sources": "{count} 个书源",
  "backup.preview.size": "文件大小 {size}",
  "backup.preview.credentials": "包含登录信息（Cookie 与 WebDAV 密码）",
  "backup.preview.dismiss": "取消",

  // 导入方式
  "backup.mode.merge": "合并导入",
  "backup.mode.mergeDesc": "本机已有的书与书源一个都不删",
  "backup.mode.replace": "覆盖恢复",
  "backup.mode.replaceDesc": "删除备份里没有的书与书源，内容类设置回到备份那一刻",
  "backup.mode.replaceConfirm": "再点一次确认覆盖",

  // 进度
  "backup.progress.exporting": "正在导出 {step} {done}/{total}",
  "backup.progress.importing": "正在导入 {step} {done}/{total}",
  "backup.step.state": "设置",
  "backup.step.books": "书籍",
  "backup.step.images": "插图",
  "backup.step.sources": "书源",
  "backup.step.sessions": "登录信息",

  // 结果
  "backup.result.title": "导入完成",
  "backup.result.booksAdded": "新增 {count} 本书",
  "backup.result.booksUpdated": "覆盖 {count} 本书",
  "backup.result.booksSkipped": "已有 {count} 本（按书籍身份识别，未重复导入）",
  "backup.result.booksRemoved": "删除 {count} 本书",
  "backup.result.images": "写入 {count} 张插图",
  "backup.result.sourcesAdded": "新增 {count} 个书源",
  "backup.result.sourcesUpdated": "覆盖 {count} 个书源",
  "backup.result.sourcesSkipped": "已有 {count} 个书源（同一站点，未重复导入）",
  "backup.result.sourcesRemoved": "删除 {count} 个书源",
  "backup.result.state": "更新 {count} 项设置",
};

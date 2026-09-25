/** WebDAV 导入与服务器管理 */
export const webdav = {
  // 页面
  "webdav.page.title": "WebDAV 导入",
  "webdav.page.backToShelf": "返回书架",
  "webdav.page.configureServer": "配置 WebDAV 服务器",

  // 目录浏览
  "webdav.dir.up": "返回上级目录",
  "webdav.dir.refresh": "刷新当前目录",
  "webdav.dir.searchPlaceholder": "搜索本目录",
  "webdav.dir.searchLabel": "搜索当前目录中的文件夹与书籍",
  "webdav.dir.clearKeyword": "清空搜索词",
  "webdav.dir.importableCount": "{count} 本可导入",
  "webdav.dir.importedCount": "，已导入 {count} 本",
  "webdav.dir.selectAll": "全选本目录",
  "webdav.hint.importedBooks": "已导入的书：点击直接阅读，长按可重新导入",

  // 目录条目
  "webdav.entry.select": "选择《{name}》",
  "webdav.entry.deselect": "取消选择《{name}》",
  "webdav.entry.openImported": "打开《{name}》阅读（已导入，长按可重新导入）",
  "webdav.entry.imported": "已导入",
  "webdav.entry.enterDir": "进入文件夹 {name}",

  // 空状态与加载
  "webdav.empty.noServerTitle": "尚未激活 WebDAV 服务器",
  "webdav.empty.noServerDesc": "先配置并激活一台服务器，即可浏览远程书库导入",
  "webdav.empty.noServers": "还没有 WebDAV 服务器",
  "webdav.empty.noMatch": "未找到匹配的内容",
  "webdav.empty.noImportable": "当前目录没有可导入的内容",
  "webdav.action.configureServer": "配置服务器",
  "webdav.loading.config": "读取配置…",
  "webdav.loading.directory": "读取目录…",

  // 底部操作条
  "webdav.bar.selectedCount": "已选 {count} 本",
  "webdav.bar.clearSelection": "取消选择",
  "webdav.bar.importSelected": "导入所选（{count}）",
  "webdav.bar.importing": "正在导入 {done}/{total}",

  // 重新导入
  "webdav.reimport.dialogLabel": "重新导入《{name}》",
  "webdav.reimport.title": "重新导入《{name}》？",
  "webdav.reimport.desc":
    "这本书已导入本地书架。重新导入会用服务器上的最新文件替换本地内容，阅读进度与分组会保留，书签会尝试随新内容继承。",
  "webdav.reimport.action": "重新导入",
  "webdav.reimport.checking": "正在检查…",

  // 提示（Toast）
  "webdav.toast.importedCount": "已导入 {count} 本书",
  "webdav.toast.importAllFailed": "导入失败 {count} 本，请检查文件与网络",
  "webdav.toast.importPartial": "导入 {ok} 本，失败 {failed} 本",
  "webdav.toast.reimported": "已重新导入《{title}》",
  "webdav.toast.reimportCancelled": "已取消重新导入",
  "webdav.toast.reimportMissing": "未找到本地对应的书籍，请刷新目录后重试",
  "webdav.toast.serverSaved": "已保存服务器配置",
  "webdav.toast.serverAdded": "已添加服务器",
  "webdav.toast.serverDeleted": "已删除服务器",

  // 错误
  "webdav.error.urlRequired": "请填写服务器地址",
  "webdav.error.saveFailed": "保存失败",
  "webdav.error.listFailed": "读取目录失败",
  "webdav.error.downloadBookFailed": "下载书籍失败",
  "webdav.error.downloadFailed": "下载失败，无法连接服务器",
  "webdav.error.connectFailed": "无法连接服务器，请检查地址与网络",
  "webdav.error.parseFailed": "服务器返回了无法解析的目录数据",
  "webdav.error.unsupportedFormat": "不支持的书籍格式：{name}",
  "webdav.error.reimportFailed": "重新导入失败",
  /** 失败提示里「动作（原因）」的组合（中文全角括号、英文半角加空格） */
  "webdav.error.withReason": "{action}（{reason}）",
  "webdav.error.auth": "认证失败，请检查服务器账号密码与权限",
  "webdav.error.notFound": "目录不存在或地址配置有误",
  "webdav.error.serverError": "服务器出错",

  // 服务器抽屉
  "webdav.drawer.dialogLabel": "WebDAV 服务器配置",
  "webdav.drawer.title": "WebDAV 服务器",
  "webdav.drawer.backToList": "返回服务器列表",
  "webdav.drawer.hint": "可配置多台服务器，点选一台即在导入页使用",

  // 服务器表单
  "webdav.form.name": "名称",
  "webdav.form.namePlaceholder": "如：我的坚果云",
  "webdav.form.url": "服务器地址",
  "webdav.form.username": "账号",
  "webdav.form.usernamePlaceholder": "（留空则为匿名访问）",
  "webdav.form.password": "密码",
  "webdav.form.saving": "保存中…",

  // 服务器列表项
  "webdav.server.add": "新增服务器",
  "webdav.server.edit": "编辑服务器",
  "webdav.server.account": "账号 {name}",
  "webdav.server.anonymous": "匿名访问",
  "webdav.server.inUse": "{name}（正在使用）",
  "webdav.server.use": "使用 {name}",
  "webdav.server.editLabel": "编辑 {name}",
  "webdav.server.deleteLabel": "删除 {name}",
  "webdav.server.confirmDelete": "确认",
};

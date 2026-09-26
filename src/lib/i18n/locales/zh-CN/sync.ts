/**
 * 局域网同步（设置 → 同步 / 冲突裁决）。
 *
 * 这里的文案要讲清两件事：**同步什么**（元信息 / 进度 / 书签 / 分组 / 书源，不含正文）
 * 与**关掉同步会发生什么**（本地照常记账，重新开启后一起同步出去）。
 */
export const sync = {
  "sync.title": "同步",

  // 分区
  "sync.section.enable": "同步",
  "sync.section.status": "状态",
  "sync.section.thisDevice": "本机",
  "sync.section.connect": "连接设备",
  "sync.section.auto": "自动同步",
  "sync.section.data": "数据",

  // 总开关
  "sync.enable.title": "局域网同步",
  "sync.enable.onDesc": "与同一局域网内已配对的设备互相同步",
  "sync.enable.offDesc": "同步的是书籍信息、阅读进度、书签、分组与书源；正文与封面不参与",
  "sync.enable.toggle": "开启或关闭同步",
  "sync.enable.failed": "切换同步开关失败",

  // 状态
  "sync.status.syncing": "正在同步…",
  "sync.status.idle": "已就绪",
  "sync.status.lastSync": "上次同步：{time}",
  "sync.action.syncNow": "同步",
  "sync.now.failed": "同步失败",
  "sync.result.ok": "已与 {names} 同步",
  "sync.auto.failed": "修改自动同步失败",
  "sync.applied.reloadFailed": "同步结果载入界面失败",

  // 相对时间
  "sync.time.never": "尚未同步",
  "sync.time.justNow": "刚刚",
  "sync.time.minutesAgo": "{count} 分钟前",
  "sync.time.hoursAgo": "{count} 小时前",
  "sync.time.daysAgo": "{count} 天前",

  // 本机信息
  "sync.deviceName.title": "设备名称",
  "sync.deviceName.desc": "其它设备在局域网里看到的名字",
  "sync.deviceName.save": "保存设备名称",
  "sync.deviceName.failed": "修改设备名称失败",
  "sync.address.title": "本机地址",
  "sync.address.desc": "同一局域网内的设备用这个地址连接本机",
  "sync.address.empty": "暂时没有可用的局域网地址：请先连接 Wi-Fi 或网线",
  "sync.pairing.title": "配对码",
  "sync.pairing.desc": "在另一台设备的「加入其它设备」里填入即可连接",
  "sync.pairing.copy": "复制",
  "sync.pairing.copied": "配对码已复制",
  "sync.pairing.copyFailed": "复制失败，请长按选中",
  "sync.pairing.failed": "读取配对码失败",

  // 失败原因（按后端错误码翻文案，见 lib/sync.ts 的 syncErrorText）
  "sync.error.groupMismatch":
    "两台设备不在同一同步群组：在其中一台复制配对码，到另一台的「加入其它设备」里填入",
  "sync.error.removedByPeer":
    "本机已被对端从设备列表里删除：在「查找局域网设备」里对这台设备点「重新接受」",
  "sync.error.notTrusted": "本机不在对端的信任名单里：需要在对方设备上放行本机",
  "sync.error.protocolMismatch": "两台设备的同步协议版本不一致：请把 ReaderX 升级到同一版本",
  "sync.error.busy": "对端正在处理其它同步连接，稍后再试",
  "sync.error.authFailed":
    "群组密钥不一致：在其中一台复制配对码，到另一台的「加入其它设备」里填入",
  "sync.error.unexpectedMessage": "对端不是 ReaderX 的同步服务，或两台设备版本差异过大",
  "sync.error.unsupportedVersion": "对端的数据格式版本比本程序新：请升级 ReaderX",
  "sync.error.notReaderx": "对端不是 ReaderX 的同步服务：检查地址与端口是否正确",

  // 连接设备
  "sync.join.title": "加入其它设备",
  "sync.join.desc": "填入对方设备上的配对码",
  "sync.join.placeholder": "配对码",
  "sync.join.action": "加入",
  "sync.join.done": "已加入同步群组",
  "sync.join.failed": "加入同步群组失败",
  "sync.discover.title": "查找局域网设备",
  "sync.discover.desc": "同一局域网内、同一同步群组的设备",
  "sync.discover.action": "查找",
  "sync.discover.running": "查找中…",
  "sync.discover.empty": "没有找到可同步的设备",
  "sync.discover.emptyHint": "确认对方已开启同步，且两台设备在同一个局域网内",
  "sync.discover.failed": "查找设备失败",
  "sync.discover.removed": "已删除",
  "sync.discover.reaccept": "重新接受",
  "sync.peer.lastSync": "上次同步：{time}（共 {count} 次）",
  "sync.peer.empty": "还没有已配对的设备：自动同步会在配对完成后开始",
  "sync.peer.removeAria": "删除设备 {name}",
  "sync.peer.removeConfirm": "确认删除",
  "sync.peer.removed": "已删除设备 {name}",
  "sync.peer.removeFailed": "删除设备失败",
  "sync.peer.acceptFailed": "重新接受设备失败",
  "sync.peer.removedHint": "已删除 {count} 台设备：它们不再与本机同步；在「查找」结果里可以重新接受",

  // 自动同步
  "sync.auto.title": "自动同步",
  "sync.auto.desc": "在后台按间隔与已配对的设备同步",
  "sync.auto.toggle": "开启或关闭自动同步",
  "sync.interval.title": "同步间隔",
  "sync.interval.desc": "两台设备都在使用时取更短的那个间隔",
  "sync.interval.minutes": "{count} 分钟",
  "sync.interval.hours": "{count} 小时",

  // 数据
  "sync.scope.title": "已纳入同步的数据",
  "sync.scope.desc": "书籍信息 / 进度 / 书签 / 分组 / 书源；正文与封面留在各自设备上",
  "sync.scope.count": "{count} 条",
  "sync.reset.title": "清空同步数据",
  "sync.reset.confirm": "确认清空同步数据？",
  "sync.reset.desc": "只清空同步记录与配对关系，本地书库、书源与进度不受影响",
  "sync.reset.done": "同步数据已清空",
  "sync.reset.failed": "清空同步数据失败",

  // 冲突
  "sync.conflict.title": "同步冲突",
  "sync.conflict.pending": "{count} 项待处理",
  "sync.conflict.none": "没有待处理的冲突",
  "sync.conflict.toast": "有 {count} 项同步冲突待处理",
  "sync.conflict.toastAction": "去处理",
  "sync.conflict.loadFailed": "读取冲突列表失败",
  "sync.conflict.resolveFailed": "处理冲突失败",
  "sync.conflict.resolved": "已处理",
  "sync.conflict.filterPending": "待处理",
  "sync.conflict.filterAll": "全部",
  "sync.conflict.empty": "没有冲突",
  "sync.conflict.emptyHint": "两台设备同时改了同一处内容时，会在这里让你决定保留哪一份",
  "sync.conflict.localSide": "本机",
  "sync.conflict.remoteSide": "对端",
  "sync.conflict.emptyValue": "（空）",
  "sync.conflict.keepLocal": "保留本机",
  "sync.conflict.keepRemote": "采用对端",
  "sync.conflict.dismiss": "忽略",

  // 冲突原因
  "sync.conflict.reason.concurrentWrite": "同一字段被两台设备同时改写",
  "sync.conflict.reason.multiValue": "两台设备同时修改了同一份内容",
  "sync.conflict.reason.uniqueKey": "两条记录占用了同一个唯一标识",
  "sync.conflict.reason.deleteVsUpdate": "一台设备删除、另一台同时修改",
  "sync.conflict.reason.frozenWrite": "不可改动的字段被改写",
  "sync.conflict.reason.listMove": "同一项被同时移动到不同位置",
  "sync.conflict.reason.duplicateEntity": "两台设备同时新建了同一条记录",
  "sync.conflict.reason.cascadeBlocked": "还有记录引用它，删除被阻止",
  "sync.conflict.reason.unknown": "内容冲突",

  // 冲突字段与对象类型
  "sync.field.title": "书名",
  "sync.field.author": "作者",
  "sync.field.intro": "简介",
  "sync.field.tags": "标签",
  "sync.field.sourceTags": "书源标签",
  "sync.field.group": "分组",
  "sync.field.name": "名称",
  "sync.field.sourceJson": "书源配置",
  "sync.field.note": "备注",
  "sync.field.entity": "整条记录",
  "sync.kind.book": "书籍",
  "sync.kind.source": "书源",
  "sync.kind.group": "分组",
  "sync.kind.bookmark": "书签",
  "sync.kind.progress": "阅读进度",
};

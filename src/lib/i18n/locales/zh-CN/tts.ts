/** 听书：设置、播放、缓存、解码 */
export const tts = {
  // 听书设置面板（TtsSheet）
  "tts.sheet.title": "听书设置",
  "tts.sheet.close": "关闭听书设置",
  "tts.sheet.nativeHint": "暂停后从当前句开头重读",
  "tts.sheet.httpHint": "服务端返回音频后逐句播放",
  /** 自定义源 POST body 的输入提示（{$TEXT} 是服务端占位，原样展示） */
  "tts.sheet.bodyPlaceholder": '{"text": "{$TEXT}"} 或 text={$TEXT}',

  // 分区标题
  "tts.section.engine": "引擎",
  "tts.section.voice": "音色",
  "tts.section.httpConfig": "自定义源配置",
  "tts.section.rate": "倍速",
  "tts.section.timer": "定时停止",

  // 引擎
  "tts.engine.native": "原生语音",
  "tts.engine.nativeDesc": "系统 TTS",
  "tts.engine.http": "自定义源",
  "tts.engine.httpDesc": "HTTP 接口",

  // 音色
  "tts.voice.loading": "正在获取系统语音…",
  "tts.voice.unavailable": "当前环境无系统语音（需在 Tauri 内运行）",
  "tts.voice.none": "未检测到可用语音，将使用系统默认音色",
  "tts.voice.default": "系统默认音色",

  // 批量预热
  "tts.prewarm.book": "批量预热整本书（写入按书籍缓存）",
  "tts.prewarm.bookAria": "批量预热整本书",
  "tts.prewarm.running": "预热中 {text}",

  // 自定义源填写说明
  "tts.help.heading": "占位与编码",
  "tts.help.text": "当前句文本，默认 URL 编码一次",
  "tts.help.noEncoding": "不编码",
  "tts.help.doubleEncoding": "编码两次（数字可任意）",
  "tts.help.rate": "当前倍速数值（1 / 1.5 / 2 …），由服务端变速不变调",
  /** {$RATE} 是服务端占位、不是词典占位符，原样展示 */
  "tts.help.rateClient":
    "地址里用了 {$RATE} 时客户端原速播放；没声明则退回客户端变速（可能有变调）",
  "tts.help.postBody": "POST 的 body 以 { 或 [ 开头按 JSON 发送，否则按表单编码",
  "tts.help.audioBytes": "服务端返回音频字节（mp3 / wav / ogg）",
  "tts.help.cache": "合成好的音频按书籍缓存（设置 → 听书缓存 可查看 / 清除）",

  // 定时
  "tts.timer.off": "关闭",
  "tts.timer.minutes": "{count} 分钟",
  "tts.timer.chapterEnd": "本章结束",
  "tts.timer.remaining": "剩余 {time} 后自动停止",
  "tts.timer.chapterHint": "朗读到本章结尾自动停止",

  // 操作
  "tts.action.stop": "停止朗读",

  // 悬浮球（TtsBubble）
  "tts.bubble.prev": "上一句",
  "tts.bubble.next": "下一句",
  "tts.bubble.pause": "暂停",
  "tts.bubble.play": "播放",

  // 播放提示（ttsPlayer 的 notify）
  "tts.notify.bookFinished": "本书已朗读完毕",
  "tts.notify.noMoreContent": "后续章节暂无内容，已停止朗读",
  "tts.notify.laterNoText": "后面的章节没有可朗读的文字",
  "tts.notify.chapterNoTextTitle": "「{title}」没有可朗读的文字",
  "tts.notify.chapterNoText": "本章没有可朗读的文字",
  "tts.notify.chapterTimerEnd": "定时：本章朗读结束",
  "tts.notify.timerEnd": "定时结束，已停止朗读",

  // 播放错误（ttsPlayer / ttsEngine / httpTts）
  "tts.error.nativeUnavailable": "原生语音需在 Tauri 应用内运行（Android 真机），当前环境不可用",
  "tts.error.nativePlugin": "系统语音插件不可用，请确认已在安卓设备上运行",
  "tts.error.nativeFallback": "系统语音不可用，请检查系统语音设置",
  "tts.error.speech": "语音朗读出错：{reason}",
  "tts.error.speechGeneric": "系统语音出错，请稍后重试",
  "tts.error.synthFallback": "语音合成失败，请检查自定义源配置与网络",
  "tts.error.playFailed": "音频播放失败",
  "tts.error.decodeFailedLinux":
    "音频解码失败：系统缺少该格式的解码器（常见于 Linux 缺少 MP3 插件），修复方法见弹出的指南",
  "tts.error.decodeFailedHttp": "音频解码失败：自定义源需返回可解码的音频（mp3 / wav / ogg）",
  "tts.error.noUrl": "请先填写自定义源地址（听书设置 → 自定义源）",
  "tts.error.noText": "没有可朗读的文本",
  "tts.error.timeout": "自定义源请求超时（45 秒），请检查地址与网络",
  "tts.error.requestFailed": "自定义源请求失败：{reason}",
  "tts.error.httpStatus": "自定义源返回错误：HTTP {status}",
  "tts.error.notAudio": "自定义源未返回音频（Content-Type: {contentType}）",
  "tts.error.emptyAudio": "自定义源返回了空音频",

  // 「音频解码失败」修复指南（TtsDecodeGuideDialog）
  "tts.guide.aria": "音频解码失败修复指南",
  "tts.guide.close": "关闭修复指南",
  "tts.guide.copyCommand": "复制命令：{cmd}",
  "tts.guide.heading": "缺少音频解码器",
  "tts.guide.cause":
    "你的 GStreamer 缺少播放 MP3 所需的解码器插件。这通常是因为 MP3 格式的专利许可问题，" +
    "许多 Linux 发行版默认不包含相关插件。WebKit 进程播放音频时调用了 GStreamer，" +
    "系统里却没有能处理 MPEG-1 Layer 3 的组件，于是解码失败。",
  "tts.guide.solutionLead": "安装包含 MP3 解码器的 GStreamer 插件包：",
  "tts.guide.debian": "Debian / Ubuntu 及其衍生版（Pop!_OS、Linux Mint）",
  "tts.guide.debianPackages":
    "gstreamer1.0-plugins-ugly 含专利风险插件（其中有 MP3 解码器），" +
    "gstreamer1.0-libav 基于 FFmpeg，编解码器覆盖面最广。",
  "tts.guide.debianFluendo": "备选：这是专门用于 MP3 解码的插件。",
  "tts.guide.fedora": "Fedora / CentOS / RHEL",
  "tts.guide.fedoraNote": "这些系统需要先启用 RPM Fusion 软件源，才能安装含专利编解码器的插件。",
  "tts.guide.fedoraRepo": "启用 RPM Fusion 源（已经启用过可跳过）。",
  "tts.guide.arch": "Arch Linux / Manjaro",
  "tts.guide.suse": "openSUSE",
  "tts.guide.verifyHeading": "验证插件是否装好",
  "tts.guide.verifyLead": "用 gst-inspect-1.0 检查系统是否已识别到 MP3 解码器：",
  "tts.guide.verifyExpect":
    "能看到 mad: mad、avdec_mp3: libav mp3 decoder 或 mpg123audiodec: mpg123 audio decoder 即安装成功。",
  "tts.guide.extraRestart":
    "重启应用：装完插件要完全关闭并重新启动应用（而不是只退出阅读页），新插件才会被加载。",
  "tts.guide.extraLogs":
    "查看日志：问题依旧时可到「设置 → 调试 → 应用日志」按「错误」筛选，把日志复制出来定位原因。",
  "tts.guide.extraFallback":
    "替代方案：让自定义源返回 WAV 或 Ogg 格式的音频，这两类格式的解码器在基础插件里通常已经存在。",
  "tts.guide.ok": "知道了",
};

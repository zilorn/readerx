/**
 * 自定义源播放失败时的「解码问题」判定与修复指南内容。
 *
 * 背景：WebAudio 的 `decodeAudioData` 走的是 WebView 自己的媒体后端 ——
 * Linux 桌面端是 WebKitGTK + GStreamer，而多数发行版出于 MP3 专利许可考虑
 * 默认不带 MP3 解码器，于是自定义源返回 mp3 时解码直接失败，界面只看到
 * 「音频解码失败」。这类失败靠换配置解决不了，必须让用户知道缺什么、怎么装。
 *
 * 本模块只做三件事（不含界面）：
 * - [`isLinuxDesktop`]：判断是否 Linux 桌面端（只有这里才需要 GStreamer 指南）；
 * - [`sniffAudioFormat`]：从字节头认出实际音频格式（日志与「替代方案」文案用）；
 * - [`TTS_DECODE_GUIDE`]：按发行版分组的安装命令与验证步骤（原文给用户看）。
 */

/** 与真实包管理器无关：这里只把「哪条命令」列出来，执不执行由用户决定 */
export interface TtsGuideCommand {
  /** 终端里输入的命令（可整条复制） */
  cmd: string;
  /** 该命令的作用 / 为什么需要它 */
  note: string;
}

export interface TtsGuideDistro {
  id: string;
  /** 发行版名称（如 Debian / Ubuntu） */
  name: string;
  /** 该发行版需要额外说明时给出（如 Fedora 需要先启用 RPM Fusion） */
  note?: string;
  commands: TtsGuideCommand[];
}

/** Linux 桌面端判定：Android 的 UA 里同样带 Linux，必须先排除手机端 */
export function isLinuxDesktop(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return false;
  return /Linux/i.test(ua);
}

/**
 * 从字节头认出音频格式（只读前几十字节，失败返回 null）。
 * 服务端声明的 MIME 未必可信，真正决定能否解码的是字节本身。
 */
export function sniffAudioFormat(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  const ascii = (from: number, to: number): string => {
    let text = "";
    for (let i = from; i < to; i++) text += String.fromCharCode(bytes[i]);
    return text;
  };
  if (ascii(0, 3) === "ID3") return "MP3（带 ID3 标签）";
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "MP3";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "WAV";
  if (ascii(0, 4) === "OggS") return "Ogg";
  if (ascii(0, 4) === "fLaC") return "FLAC";
  if (ascii(4, 8) === "ftyp") return "MP4";
  if (ascii(0, 4) === "ADIF") return "AAC";
  return null;
}

/**
 * 修复指南（Linux 桌面端解码失败时弹出）。
 *
 * `lead` 是出错原因，随后是按包管理器分组的解决方案、验证方法与补充说明。
 */
export const TTS_DECODE_GUIDE = {
  heading: "缺少音频解码器",
  cause:
    "你的 GStreamer 缺少播放 MP3 所需的解码器插件。这通常是因为 MP3 格式的专利许可问题，" +
    "许多 Linux 发行版默认不包含相关插件。WebKit 进程播放音频时调用了 GStreamer，" +
    "系统里却没有能处理 MPEG-1 Layer 3 的组件，于是解码失败。",
  solutionLead: "安装包含 MP3 解码器的 GStreamer 插件包：",
  distros: [
    {
      id: "debian",
      name: "Debian / Ubuntu 及其衍生版（Pop!_OS、Linux Mint）",
      commands: [
        {
          cmd: "sudo apt update",
          note: "",
        },
        {
          cmd: "sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav",
          note:
            "gstreamer1.0-plugins-ugly 含专利风险插件（其中有 MP3 解码器），" +
            "gstreamer1.0-libav 基于 FFmpeg，编解码器覆盖面最广。",
        },
        {
          cmd: "sudo apt install gstreamer1.0-fluendo-mp3",
          note: "备选：这是专门用于 MP3 解码的插件。",
        },
      ],
    },
    {
      id: "fedora",
      name: "Fedora / CentOS / RHEL",
      note: "这些系统需要先启用 RPM Fusion 软件源，才能安装含专利编解码器的插件。",
      commands: [
        {
          cmd: "sudo dnf install https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm https://download1.rpmfusion.org/nonfree/fedora/rpmfusion-nonfree-release-$(rpm -E %fedora).noarch.rpm",
          note: "启用 RPM Fusion 源（已经启用过可跳过）。",
        },
        {
          cmd: "sudo dnf install gstreamer1-plugins-good gstreamer1-plugins-ugly gstreamer1-plugins-bad-free gstreamer1-libav",
          note: "",
        },
      ],
    },
    {
      id: "arch",
      name: "Arch Linux / Manjaro",
      commands: [
        {
          cmd: "sudo pacman -S gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav",
          note: "",
        },
      ],
    },
    {
      id: "suse",
      name: "openSUSE",
      commands: [
        {
          cmd: "sudo zypper install gstreamer-plugins-base gstreamer-plugins-good gstreamer-plugins-bad gstreamer-plugins-ugly gstreamer-plugins-libav",
          note: "",
        },
      ],
    },
  ] satisfies TtsGuideDistro[],
  verify: {
    lead: "用 gst-inspect-1.0 检查系统是否已识别到 MP3 解码器：",
    cmd: "gst-inspect-1.0 | grep -i mp3",
    expect:
      "能看到 mad: mad、avdec_mp3: libav mp3 decoder 或 mpg123audiodec: mpg123 audio decoder 即安装成功。",
  },
  extras: [
    "重启应用：装完插件要完全关闭并重新启动应用（而不是只退出阅读页），新插件才会被加载。",
    "查看日志：问题依旧时可到「设置 → 调试 → 应用日志」按「错误」筛选，把日志复制出来定位原因。",
    "替代方案：让自定义源返回 WAV 或 Ogg 格式的音频，这两类格式的解码器在基础插件里通常已经存在。",
  ],
} as const;

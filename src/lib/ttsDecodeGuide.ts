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
 * - [`sniffAudioFormat`]：从字节头认出实际音频格式（日志用，格式名不进界面）；
 * - [`TTS_DECODE_GUIDE`]：按发行版分组的安装命令与验证步骤。
 *
 * 指南里的文案只存 key（模块顶层不能调 `t()`，而且拿不到语言变化），
 * 由界面（TtsDecodeGuideDialog）渲染时经 `t()` 取；命令本身是给终端用的，保持原样。
 */
import type { MessageKey } from "./i18n";

/** 与真实包管理器无关：这里只把「哪条命令」列出来，执不执行由用户决定 */
export interface TtsGuideCommand {
  /** 终端里输入的命令（可整条复制） */
  cmd: string;
  /** 该命令的作用 / 为什么需要它 */
  noteKey?: MessageKey;
}

export interface TtsGuideDistro {
  id: string;
  /** 发行版名称（如 Debian / Ubuntu） */
  nameKey: MessageKey;
  /** 该发行版需要额外说明时给出（如 Fedora 需要先启用 RPM Fusion） */
  noteKey?: MessageKey;
  commands: TtsGuideCommand[];
}

/** 修复指南的数据形状（文案一律存 key） */
export interface TtsDecodeGuide {
  headingKey: MessageKey;
  causeKey: MessageKey;
  solutionLeadKey: MessageKey;
  distros: TtsGuideDistro[];
  verify: {
    leadKey: MessageKey;
    cmd: string;
    expectKey: MessageKey;
  };
  extras: MessageKey[];
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
 * `causeKey` 是出错原因，随后是按包管理器分组的解决方案、验证方法与补充说明。
 */
export const TTS_DECODE_GUIDE: TtsDecodeGuide = {
  headingKey: "tts.guide.heading",
  causeKey: "tts.guide.cause",
  solutionLeadKey: "tts.guide.solutionLead",
  distros: [
    {
      id: "debian",
      nameKey: "tts.guide.debian",
      commands: [
        {
          cmd: "sudo apt update",
        },
        {
          cmd: "sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav",
          noteKey: "tts.guide.debianPackages",
        },
        {
          cmd: "sudo apt install gstreamer1.0-fluendo-mp3",
          noteKey: "tts.guide.debianFluendo",
        },
      ],
    },
    {
      id: "fedora",
      nameKey: "tts.guide.fedora",
      noteKey: "tts.guide.fedoraNote",
      commands: [
        {
          cmd: "sudo dnf install https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm https://download1.rpmfusion.org/nonfree/fedora/rpmfusion-nonfree-release-$(rpm -E %fedora).noarch.rpm",
          noteKey: "tts.guide.fedoraRepo",
        },
        {
          cmd: "sudo dnf install gstreamer1-plugins-good gstreamer1-plugins-ugly gstreamer1-plugins-bad-free gstreamer1-libav",
        },
      ],
    },
    {
      id: "arch",
      nameKey: "tts.guide.arch",
      commands: [
        {
          cmd: "sudo pacman -S gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav",
        },
      ],
    },
    {
      id: "suse",
      nameKey: "tts.guide.suse",
      commands: [
        {
          cmd: "sudo zypper install gstreamer-plugins-base gstreamer-plugins-good gstreamer-plugins-bad gstreamer-plugins-ugly gstreamer-plugins-libav",
        },
      ],
    },
  ],
  verify: {
    leadKey: "tts.guide.verifyLead",
    cmd: "gst-inspect-1.0 | grep -i mp3",
    expectKey: "tts.guide.verifyExpect",
  },
  extras: ["tts.guide.extraRestart", "tts.guide.extraLogs", "tts.guide.extraFallback"],
};

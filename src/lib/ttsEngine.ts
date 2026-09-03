/**
 * 原生 TTS 引擎（安卓系统 TextToSpeech 等原生语音）。
 *
 * 基于社区插件 tauri-plugin-tts（crate: tauri-plugin-tts，npm: tauri-plugin-tts-api）：
 * - speak() 直接交给系统引擎合成播放（Android/iOS/桌面 OS 各有实现），无需网络；
 * - 系统引擎没有逐句音频文件，也没有暂停 API —— 播放控制器通过 speech:finish
 *   事件获知「一句读完了」再切下一句；暂停只能停止，续播从当前句开头重读；
 * - 音色来自系统已安装的语音（getVoices），Android 上含本地与联网两种；
 *   中文文本优先展示中文语音，其余语言也一并列出。
 *
 * 桌面 Linux 默认不编译该插件的桌面后端（需要系统 speech-dispatcher），
 * 本模块在非 Tauri / 插件不可用环境直接返回不可用，由 UI 提示。
 */
import { createSignal } from "solid-js";
import { isTauri } from "@tauri-apps/api/core";
import {
  getVoices,
  isInitialized,
  onSpeechEvent,
  speak as pluginSpeak,
  stop as pluginStop,
  type SpeechEvent,
  type Voice,
} from "tauri-plugin-tts-api";
import {
  currentTtsVoice,
  setTtsVoice,
} from "./ttsSettings";

export type NativeVoice = Voice;

export type NativeVoicesState = "idle" | "loading" | "ready" | "unavailable";

/** Tauri 运行时才有该插件（纯浏览器 dev 不可用） */
export function isNativeTtsAvailable(): boolean {
  return isTauri();
}

const [voicesSignal, setVoicesSignal] = createSignal<NativeVoice[]>([]);
const [stateSignal, setStateSignal] = createSignal<NativeVoicesState>("idle");

export function nativeVoiceList(): NativeVoice[] {
  return voicesSignal();
}

export function nativeVoicesState(): NativeVoicesState {
  return stateSignal();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function chineseScore(voice: NativeVoice): number {
  const lang = voice.language.toLowerCase().replace(/_/g, "-");
  const zh = lang.startsWith("zh") || lang.startsWith("cmn") || lang.startsWith("yue");
  const region = lang.endsWith("-cn") || lang.endsWith("-tw") || lang.endsWith("-hk") || lang.endsWith("-sg");
  return zh ? (region ? 0 : 1) : 2;
}

/** 排序：中文（含大陆/台湾等）优先，其余语言靠后，保持稳定顺序便于选角 */
function sortVoices(list: NativeVoice[]): NativeVoice[] {
  const seen = new Set<string>();
  const unique: NativeVoice[] = [];
  for (const v of list) {
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    unique.push(v);
  }
  unique.sort(
    (a, b) =>
      chineseScore(a) - chineseScore(b) ||
      a.language.localeCompare(b.language) ||
      a.name.localeCompare(b.name),
  );
  return unique;
}

/** 语音列表加载：等引擎就绪后拉取一次并缓存。非 Tauri / 插件异常 → unavailable */
let loadPromise: Promise<void> | null = null;
export function ensureNativeVoicesLoaded(): Promise<void> {
  if (!isNativeTtsAvailable()) {
    if (stateSignal() !== "unavailable") setStateSignal("unavailable");
    return Promise.resolve();
  }
  if (stateSignal() === "ready" || stateSignal() === "loading") {
    return loadPromise ?? Promise.resolve();
  }
  loadPromise = (async () => {
    setStateSignal("loading");
    try {
      // 移动端引擎异步初始化，getVoices() 在就绪前返回空；先轮询就绪状态
      for (let i = 0; i < 20; i++) {
        const st = await isInitialized();
        if (st.initialized && st.voiceCount > 0) break;
        await sleep(300);
      }
      const list = await getVoices();
      setVoicesSignal(sortVoices(list));
      setStateSignal("ready");
    } catch {
      setStateSignal("unavailable");
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

/**
 * 让当前选中的音色落在这个引擎可用的语音里：
 * 列表为空时回到系统默认（voice=""）；否则沿用已选中的语音，
 * 无效的旧值（例如曾属于其它引擎）自动换成第一个中文语音。
 * @returns 实际生效的语音 id（"" 表示交给系统默认）
 */
export async function ensureNativeVoiceSelected(): Promise<string> {
  await ensureNativeVoicesLoaded();
  const cur = currentTtsVoice();
  const list = voicesSignal();
  if (list.some((v) => v.id === cur)) return cur;
  const first = list.find((v) => chineseScore(v) === 0) ?? list[0];
  const next = first?.id ?? "";
  if (next !== cur) setTtsVoice(next);
  return next;
}

/** 语音在界面上的展示名（未选中/未知时给一个兜底文案） */
export function nativeVoiceName(id: string): string {
  if (!id) return "系统默认音色";
  return voicesSignal().find((v) => v.id === id)?.name ?? id;
}

/** 调用系统引擎朗读一句（resolve 表示已被引擎接收开始出声） */
export async function speakNativeSentence(
  text: string,
  voiceId: string,
  rate: number,
): Promise<void> {
  await pluginSpeak({
    text,
    voiceId: voiceId || null,
    rate,
    pitch: null,
    volume: null,
    language: null,
    queueMode: null,
  });
}

/** 立即停止系统朗读（Android 无暂停，只能整句停止） */
export async function stopNativeSpeech(): Promise<void> {
  if (!isNativeTtsAvailable()) return;
  try {
    await pluginStop();
  } catch {
    /* 未在朗读时 stop 也可能被拒，忽略 */
  }
}

export interface NativeSpeechEvent {
  type: "start" | "finish" | "cancel" | "error" | "interrupted" | "backgroundPause";
  id?: string;
  error?: string;
  reason?: string;
}

/**
 * 订阅系统语音的朗读事件（逐句播放靠 speech:finish 驱动）。
 * 订阅前会经由插件的 register_listener 建立移动端事件中继，桌面为 no-op。
 */
export async function subscribeNativeSpeechEvents(
  cb: (ev: NativeSpeechEvent) => void,
): Promise<() => void> {
  const types = [
    "speech:start",
    "speech:finish",
    "speech:cancel",
    "speech:error",
    "speech:interrupted",
    "speech:backgroundPause",
  ] as const;
  const unlist = await Promise.all(
    types.map((t) =>
      onSpeechEvent(t, (ev: SpeechEvent) =>
        cb({ type: t.slice("speech:".length) as NativeSpeechEvent["type"], id: ev.id, error: ev.error, reason: ev.reason }),
      ),
    ),
  );
  return () => {
    for (const u of unlist) u();
  };
}

/** 把插件抛出的错误对象整理成一句可读文案 */
export function describeNativeError(err: unknown, fallback = "系统语音不可用，请检查系统语音设置"): string {
  if (err && typeof err === "object") {
    const o = err as { code?: unknown; message?: unknown; toString?: () => string };
    const msg = typeof o.message === "string" && o.message ? o.message : "";
    const code = typeof o.code === "string" && o.code ? `（${o.code}）` : "";
    const text = `${msg}${code}`.trim();
    if (text) return text;
    if (typeof o.toString === "function") {
      const s = o.toString();
      if (s && s !== "[object Object]") return s;
    }
  }
  return err === undefined || err === null ? fallback : String(err);
}

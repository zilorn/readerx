/**
 * 听书偏好（引擎 / 音色 / 倍速 / 自定义源）：全局共享，跨会话持久化。
 * 持久化走 Rust 后端（readerx.tts），WebView 不落盘。
 *
 * 引擎分两类：
 * - "native"：系统原生 TTS（默认），音色来自系统已安装语音（ttsEngine.ts）；
 * - "http"：自定义 HTTP 语音源，由用户提供地址/方法与 body，文本用
 *   {$TEXT} 占位注入，服务端返回音频字节由播放器播放（httpTts.ts）。
 * voice 仅在原生引擎下有意义；空串表示跟随系统默认。
 */
import { createSignal } from "solid-js";
import { readState, writeState } from "./backend";

export const TTS_KEY = "readerx.tts";

/** 支持的倍速档位（原生引擎按 1.0=正常语速解释；HTTP 源用 <audio> 播放速率实现） */
export const TTS_RATES = [1, 1.5, 2, 2.5, 3] as const;

export type TtsEngine = "native" | "http";
export type HttpTtsMethod = "GET" | "POST";

const DEFAULT_ENGINE: TtsEngine = "native";
const DEFAULT_RATE = 1;

const [engineSignal, setEngineSignal] = createSignal<TtsEngine>(DEFAULT_ENGINE);
const [voiceSignal, setVoiceSignal] = createSignal<string>("");
const [rateSignal, setRateSignal] = createSignal<number>(DEFAULT_RATE);
const [httpMethodSignal, setHttpMethodSignal] = createSignal<HttpTtsMethod>("GET");
const [httpUrlSignal, setHttpUrlSignal] = createSignal<string>("");
const [httpBodySignal, setHttpBodySignal] = createSignal<string>("");

let loaded = false;
let loadPromise: Promise<void> | null = null;

interface StoredTtsPrefs {
  engine?: string;
  voice?: string;
  rate?: number;
  httpMethod?: string;
  httpUrl?: string;
  httpBody?: string;
}

/** 从后端载入一次听书偏好 */
export function ensureTtsPrefsLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const stored = await readState<StoredTtsPrefs>(TTS_KEY);
      if (stored && typeof stored === "object") {
        if (stored.engine === "native" || stored.engine === "http") {
          setEngineSignal(stored.engine);
        }
        if (typeof stored.voice === "string") {
          setVoiceSignal(stored.voice);
        }
        const r = stored.rate;
        if (typeof r === "number" && (TTS_RATES as readonly number[]).includes(r)) {
          setRateSignal(r);
        }
        if (stored.httpMethod === "GET" || stored.httpMethod === "POST") {
          setHttpMethodSignal(stored.httpMethod);
        }
        if (typeof stored.httpUrl === "string") setHttpUrlSignal(stored.httpUrl);
        if (typeof stored.httpBody === "string") setHttpBodySignal(stored.httpBody);
      }
    } catch {
      /* 后端不可用保持默认 */
    }
  })().finally(() => {
    loadPromise = null;
    loaded = true;
  });
  return loadPromise;
}

let writeQueue: Promise<void> = Promise.resolve();
function persist(): void {
  const prefs: StoredTtsPrefs = {
    engine: engineSignal(),
    voice: voiceSignal(),
    rate: rateSignal(),
    httpMethod: httpMethodSignal(),
    httpUrl: httpUrlSignal(),
    httpBody: httpBodySignal(),
  };
  writeQueue = writeQueue.then(() => writeState(TTS_KEY, prefs));
}

export function currentTtsEngine(): TtsEngine {
  return engineSignal();
}

export function setTtsEngine(engine: TtsEngine): void {
  if (engine === engineSignal()) return;
  setEngineSignal(engine);
  persist();
}

export function currentTtsVoice(): string {
  return voiceSignal();
}

export function currentTtsRate(): number {
  return rateSignal();
}

export function setTtsVoice(id: string): void {
  if (id === voiceSignal()) return;
  setVoiceSignal(id);
  persist();
}

export function setTtsRate(rate: number): void {
  if (!(TTS_RATES as readonly number[]).includes(rate)) return;
  if (rate === rateSignal()) return;
  setRateSignal(rate);
  persist();
}

export function httpTtsMethod(): HttpTtsMethod {
  return httpMethodSignal();
}

export function httpTtsUrl(): string {
  return httpUrlSignal();
}

export function httpTtsBody(): string {
  return httpBodySignal();
}

export function httpTtsConfigured(): boolean {
  return httpUrlSignal().trim().length > 0;
}

export function setHttpTtsMethod(method: HttpTtsMethod): void {
  if (method === httpMethodSignal()) return;
  setHttpMethodSignal(method);
  persist();
}

export function setHttpTtsUrl(url: string): void {
  if (url === httpUrlSignal()) return;
  setHttpUrlSignal(url);
  persist();
}

export function setHttpTtsBody(body: string): void {
  if (body === httpBodySignal()) return;
  setHttpBodySignal(body);
  persist();
}

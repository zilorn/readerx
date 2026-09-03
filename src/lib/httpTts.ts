/**
 * 自定义 HTTP 语音源（用户可配置的 GET/POST 接口）。
 *
 * 约定：
 * - 请求地址/body 里的 `{$TEXT}` 占位会被替换成当前要朗读的句子文本；
 * - 默认对该文本做一次 URL 编码（encodeURIComponent）；
 *   可在占位里带参数关闭或叠加：`{$TEXT?URLencoding=0}` 不编码、
 *   `{$TEXT?URLencoding=2}` 编码两次，数字可任意（N=编码 N 次）；
 * - `{$RATE}` 占位会被替换成当前倍速数值，由服务端自行实现「变速不变调」；
 *   声明了 {$RATE} 的请求指纹含倍速（不同倍速缓存不同的音频），客户端原速播放；
 * - 地址与 body 中都可使用占位，按各自出现的占位规则独立替换；
 * - 服务端应直接返回音频字节（mp3/wav 等）；POST 的 body 内容类型按
 *   模板启发式判断：以 `{` 或 `[` 开头视为 JSON，其余按表单编码。
 *
 * 预热与缓存：
 * - 合成结果按「书籍 + 声源指纹 + 句子」持久化（audioCache.ts → Rust 磁盘），
 *   同书同声源下次直接读缓存，不再请求服务端；
 * - 播放/预取都会走这里，播放时天然把后续句子预热进缓存（ttsPlayer.ts）。
 *
 * 本模块只负责“文本 → 音频字节”，WebAudio 解码/播放由 ttsPlayer/webAudio 处理。
 */
import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  currentTtsRate,
  httpTtsBody,
  httpTtsMethod,
  httpTtsUrl,
  type HttpTtsMethod,
} from "./ttsSettings";
import { readTtsAudioCache, writeTtsAudioCache } from "./audioCache";

const MARKER = /\{\$TEXT(?:\?\s*URLencoding=(\d+))?\}/g;
const RATE_MARKER = /\{\$RATE(?:\?\s*URLencoding=(\d+))?\}/g;
/** 非全局副本用于探测占位是否存在（避免 /g 的 lastIndex 状态） */
const HAS_RATE = /\{\$RATE(?:\?\s*URLencoding=\d+)?\}/;

export interface SynthesizedAudio {
  /** 音频 MIME（audio/mpeg / audio/wav / audio/ogg …） */
  mime: string;
  /** 音频原始字节 */
  bytes: Uint8Array;
}

/** Tauri 内走 Rust 侧请求（无 CORS 限制），纯浏览器回退 window.fetch */
function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (isTauri()) return tauriFetch(url, init);
  return fetch(url, init);
}

/** 按占位规则对文本编码：无参数 → 一次；0 → 原样；N → N 次 */
function encodeText(text: string, times: number | undefined): string {
  if (times === undefined) return encodeURIComponent(text);
  if (times <= 0) return text;
  let out = text;
  for (let i = 0; i < times; i++) out = encodeURIComponent(out);
  return out;
}

/** 在 url / body 中逐个替换 {$TEXT...} 与 {$RATE...} 占位 */
function applyPlaceholders(template: string, text: string, rate: number): string {
  let out = template.replace(MARKER, (_full, timesRaw?: string) => {
    const times = timesRaw === undefined ? undefined : Number(timesRaw);
    return encodeText(text, times);
  });
  out = out.replace(RATE_MARKER, (_full, timesRaw?: string) => {
    const times = timesRaw === undefined ? undefined : Number(timesRaw);
    // 倍速交给服务端处理（变速不变调）；数值本身无需编码，带参时按规则处理
    return encodeText(String(rate), times);
  });
  return out;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || "未知错误";
  return String(err);
}

/** POST body 的内容类型：JSON 模板与表单模板都能工作 */
function guessContentType(bodyTemplate: string): string {
  const trimmed = bodyTemplate.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "application/json; charset=UTF-8";
  return "application/x-www-form-urlencoded; charset=UTF-8";
}

/** 是否在地址/body 里声明了 {$RATE}（有则倍速由服务端负责，客户端原速播放） */
export function httpHasRatePlaceholder(): boolean {
  return HAS_RATE.test(httpTtsUrl()) || HAS_RATE.test(httpTtsBody());
}

/** 当前声源指纹（方法 + 地址 + body，不含句子文本） */
export function httpSourceSignature(): string {
  return `${httpTtsMethod()}|${httpTtsUrl()}|${httpTtsBody()}`;
}

/**
 * 请求指纹：声明了 {$RATE} 时，倍速不同 → 服务端音频不同，故把倍速并入指纹；
 * 未声明时倍速只影响客户端播放，合成产物相同，指纹不带倍速。
 */
export function httpRequestFingerprint(): string {
  const sig = httpSourceSignature();
  return httpHasRatePlaceholder() ? `${sig}\u0000rate=${currentTtsRate()}` : sig;
}

/** 句子缓存 key：声源/请求指纹 + 句子文本的 SHA-256 摘要（64 位 hex 前缀） */
export async function sentenceCacheKey(text: string): Promise<string> {
  const sig = httpRequestFingerprint();
  const data = new TextEncoder().encode(`${sig}\u0000${text}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 请求一次自定义源（优先读本机缓存），把当前句文本合成为音频字节。
 * @param text   当前朗读句
 * @param bookId 书籍 id（用于按书籍缓存；空串/纯浏览器环境跳过磁盘缓存）
 */
export async function synthesizeHttpAudio(text: string, bookId?: string): Promise<SynthesizedAudio> {
  const method: HttpTtsMethod = httpTtsMethod();
  const urlTemplate = httpTtsUrl();
  if (!urlTemplate.trim()) {
    throw new Error("请先填写自定义源地址（听书设置 → 自定义源）");
  }
  if (!text.trim()) throw new Error("没有可朗读的文本");

  // 1) 磁盘缓存命中 → 直接用缓存字节，不再请求服务端
  const book = bookId ?? "";
  let key = "";
  if (book) {
    key = await sentenceCacheKey(text);
    const hit = await readTtsAudioCache(book, key);
    if (hit && hit.data) {
      return { mime: hit.mime || "audio/mpeg", bytes: base64ToBytes(hit.data) };
    }
  }

  // 2) 请求服务端合成
  const rate = currentTtsRate();
  const url = applyPlaceholders(urlTemplate, text, rate);
  const bodyTemplate = httpTtsBody();
  const body = applyPlaceholders(bodyTemplate, text, rate);

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const init: RequestInit = { method, signal: controller.signal };
      if (method === "POST" && bodyTemplate.length > 0) {
        init.headers = { "Content-Type": guessContentType(bodyTemplate) };
        init.body = body;
      }
      res = await httpFetch(url, init);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("自定义源请求超时（45 秒），请检查地址与网络");
    }
    throw new Error(`自定义源请求失败：${describeError(err)}`);
  }

  if (!res.ok) {
    throw new Error(`自定义源返回错误：HTTP ${res.status}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct && !ct.toLowerCase().startsWith("audio/")) {
    throw new Error(`自定义源未返回音频（Content-Type: ${ct || "未知"}）`);
  }
  const buf = await res.arrayBuffer();
  if (!buf || buf.byteLength === 0) {
    throw new Error("自定义源返回了空音频");
  }
  const mime = ct || "audio/mpeg";
  const bytes = new Uint8Array(buf);

  // 3) 写盘预热（失败不影响本次播放，等下一句自然覆盖）
  if (book && key) {
    const data64 = bytesToBase64(bytes);
    void writeTtsAudioCache(book, key, data64, mime);
  }

  return { mime, bytes };
}

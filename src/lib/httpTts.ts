/**
 * 自定义 HTTP 语音源（用户可配置的 GET/POST 接口）。
 *
 * 约定：
 * - 请求地址/body 里的 `{$TEXT}` 占位会被替换成当前要朗读的句子文本；
 * - 默认对该文本做一次 URL 编码（encodeURIComponent）；
 *   可在占位里带参数关闭或叠加：`{$TEXT?URLencoding=0}` 不编码、
 *   `{$TEXT?URLencoding=2}` 编码两次，数字可任意（N=编码 N 次）；
 * - 地址与 body 中都可使用占位，按各自出现的占位规则独立替换；
 * - 服务端应直接返回音频字节（mp3/wav 等）；POST 的 body 内容类型按
 *   模板启发式判断：以 `{` 或 `[` 开头视为 JSON，其余按表单编码。
 *
 * 预热与缓存：
 * - 合成结果按「书籍 + 声源指纹 + 句子」持久化（audioCache.ts → Rust 磁盘），
 *   同书同声源下次直接读缓存，不再请求服务端；
 * - 播放/预取都会走这里，播放时天然把后续句子预热进缓存（ttsPlayer.ts）。
 *
 * 本模块只负责“文本 → 音频地址”，逐句播放/缓存/暂停由 ttsPlayer.ts 处理。
 */
import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  httpTtsBody,
  httpTtsMethod,
  httpTtsUrl,
  type HttpTtsMethod,
} from "./ttsSettings";
import { readTtsAudioCache, writeTtsAudioCache } from "./audioCache";

const MARKER = /\{\$TEXT(?:\?\s*URLencoding=(\d+))?\}/g;

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

/** 在 url / body 中逐个替换 {$TEXT...} 占位 */
function applyPlaceholders(template: string, text: string): string {
  return template.replace(MARKER, (_full, timesRaw?: string) => {
    const times = timesRaw === undefined ? undefined : Number(timesRaw);
    return encodeText(text, times);
  });
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

// ---------------------------------------------------------------------------
// 音频缓存相关
// ---------------------------------------------------------------------------

/** 当前声源指纹（方法 + 地址 + body，不含句子文本） */
export function httpSourceSignature(): string {
  return `${httpTtsMethod()}|${httpTtsUrl()}|${httpTtsBody()}`;
}

/** 句子缓存 key：声源指纹 + 句子文本的 SHA-256 摘要（64 位 hex 前缀） */
async function sentenceCacheKey(text: string): Promise<string> {
  const sig = httpSourceSignature();
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

// ---------------------------------------------------------------------------
// 合成
// ---------------------------------------------------------------------------

/**
 * 请求一次自定义源（优先读本机缓存），把当前句文本合成为一段音频。
 * @param text   当前朗读句
 * @param bookId 书籍 id（用于按书籍缓存；空串/纯浏览器环境跳过磁盘缓存）
 * @returns      可播放的 blob URL（由 revokeHttpAudio 统一回收）
 */
export async function synthesizeHttpSentence(text: string, bookId?: string): Promise<string> {
  const method: HttpTtsMethod = httpTtsMethod();
  const urlTemplate = httpTtsUrl();
  if (!urlTemplate.trim()) {
    throw new Error("请先填写自定义源地址（听书设置 → 自定义源）");
  }
  if (!text.trim()) throw new Error("没有可朗读的文本");

  // 1) 磁盘缓存命中 → 直接播放，不再请求服务端
  const book = bookId ?? "";
  let key = "";
  if (book) {
    key = await sentenceCacheKey(text);
    const hit = await readTtsAudioCache(book, key);
    if (hit && hit.data) {
      const mime = hit.mime || "audio/mpeg";
      return URL.createObjectURL(new Blob([base64ToBytes(hit.data)], { type: mime }));
    }
  }

  // 2) 请求服务端合成
  const url = applyPlaceholders(urlTemplate, text);
  const bodyTemplate = httpTtsBody();
  const body = applyPlaceholders(bodyTemplate, text);

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

  // 3) 写盘预热（失败不影响本次播放，等下一句自然覆盖）
  if (book && key) {
    const bytes = new Uint8Array(buf);
    const data64 = bytesToBase64(bytes);
    void writeTtsAudioCache(book, key, data64, mime);
  }

  return URL.createObjectURL(new Blob([buf], { type: mime }));
}

/** 回收由本模块创建的临时音频地址（停止/换源/销毁时调用） */
const createdUrls = new Set<string>();
export function trackHttpUrl(url: string): void {
  if (url.startsWith("blob:")) createdUrls.add(url);
}
export function revokeHttpAudio(): void {
  for (const u of createdUrls) {
    URL.revokeObjectURL(u);
  }
  createdUrls.clear();
}

/**
 * 书源封面加载（BookItem.cover —— 可选字段的端到端支持）。
 *
 * - 封面 URL 来自书源 searchBook / discoverBooks / bookDetail 返回的 `cover`；
 *   图片大多带防盗链 / 需要登录，页面 <img> 无法直连远程地址，必须经书源会话
 *   （Cookie / UA / 默认请求头，可带 Referer）下载后再展示；
 * - 下载结果统一按 EPUB 封面同一套规则压缩为缩略图 data URL（≤600px JPEG），
 *   列表行 / 详情抽屉即时展示，加入书架时也以同一份缩略图落盘；
 * - 封面始终「可选」：无地址 / 非法地址 / 下载失败 / 无法解码 / 体积超限 → 一律
 *   返回 null，调用方回退程序化封面，绝不阻塞任何流程。
 *
 * 模块级并发闸 + 会话缓存：一次搜索的整页结果可能同时出现几十上百个封面地址，
 * 把它们收敛到「书源并发」规模（最多 4 路）串行下载，并复用同源同址的下载结果。
 */
import { fetchRemoteSourceImage } from "./backend";
import { makeCoverThumb } from "./coverImage";
import { currentSourceParallel } from "./store";

/** 原始封面 data URL 的最大长度（字符）：超过视为超限，避免超大图解码卡顿 / 撑爆内存 */
const MAX_RAW_DATA_URL_LENGTH = 6_000_000;
/** 压缩后缩略图的最大长度（字符）：SVG/GIF 等无法重采样的格式会原样直通，仍受此上限约束 */
const MAX_THUMB_DATA_URL_LENGTH = 2_000_000;
/** 会话内封面缩略图缓存：条目数与总字节预算（超出时按最旧淘汰） */
const CACHE_MAX_ENTRIES = 200;
const CACHE_MAX_BYTES = 32_000_000;
/** 封面网络请求并发上限（受全局「书源并发」设置约束，且不高于此值） */
const NETWORK_CONCURRENCY_CAP = 4;

const thumbCache = new Map<string, string>();
let thumbCacheBytes = 0;
const inflight = new Map<string, Promise<string | null>>();

// 并发闸：批量出现的封面（搜索结果列表）经它受限地走书源会话
const waiters: Array<() => void> = [];
let active = 0;

function poolSize(): number {
  return Math.max(
    1,
    Math.min(NETWORK_CONCURRENCY_CAP, Math.round(currentSourceParallel())),
  );
}

function kick(): void {
  const cap = poolSize();
  while (active < cap && waiters.length > 0) {
    const start = waiters.shift()!;
    active += 1;
    start();
  }
}

/** 占用一个下载名额；返回释放函数（用完后必须调用） */
function acquireSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    waiters.push(() => {
      resolve(() => {
        active -= 1;
        kick();
      });
    });
    kick();
  });
}

function rememberThumb(key: string, thumb: string): void {
  if (thumbCache.has(key)) thumbCacheBytes -= thumbCache.get(key)!.length;
  thumbCache.set(key, thumb);
  thumbCacheBytes += thumb.length;
  while (
    thumbCache.size > 0 &&
    (thumbCache.size > CACHE_MAX_ENTRIES || thumbCacheBytes > CACHE_MAX_BYTES)
  ) {
    const oldest = thumbCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    thumbCacheBytes -= thumbCache.get(oldest)!.length;
    thumbCache.delete(oldest);
  }
}

/** 只接受绝对 http(s) 地址与 data:image 数据；其余（相对地址/其它协议）视为无封面 */
function normalizeCoverUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^data:image\//i.test(trimmed)) return trimmed;
  return "";
}

export function sourceCoverKey(sourceId: string, url: string): string {
  return `${sourceId}|${url}`;
}

/** 同步读取会话内已加载的封面缩略图（未加载过返回 null，不发起请求） */
export function peekSourceCoverThumb(sourceId: string, url: string): string | null {
  const target = normalizeCoverUrl(url);
  if (!target) return null;
  return thumbCache.get(sourceCoverKey(sourceId, target)) ?? null;
}

/**
 * 加载一张书源封面的缩略图 data URL（失败返回 null）。
 * - http(s) 地址经书源会话下载（带 Referer）；data:image 地址直接本地压缩；
 * - 同源同址同时只会发起一次下载，结果进入会话缓存供列表 / 抽屉 / 落盘复用。
 */
export async function loadSourceCoverThumb(
  sourceId: string,
  url: string,
  referer?: string | null,
): Promise<string | null> {
  const target = normalizeCoverUrl(url);
  if (!target) return null;
  const key = sourceCoverKey(sourceId, target);
  const hit = thumbCache.get(key);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async (): Promise<string | null> => {
    try {
      const ref = referer?.trim();
      const dataUrl = target.startsWith("data:")
        ? target
        : await acquireSlot().then((release) =>
            fetchRemoteSourceImage(sourceId, target, ref || null).finally(release),
          );
      if (!dataUrl) return null;
      if (dataUrl.length > MAX_RAW_DATA_URL_LENGTH) return null;
      const thumb = await makeCoverThumb(dataUrl).catch(() => null);
      if (!thumb || thumb.length > MAX_THUMB_DATA_URL_LENGTH) return null;
      rememberThumb(key, thumb);
      return thumb;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

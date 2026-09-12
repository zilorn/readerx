/**
 * 在线书正文图片的「阅读时按需下载」。
 *
 * 拉取章节正文时只保存图片地址（不下载），图片在用户读到这一章时才经**该书源会话**
 * （默认请求头 / UA / Cookie，Referer 取正文页地址）逐张取回：
 *
 * - 图片字节由 Rust 写成本地文件（`images/<bookId>_<sha1(地址)>.<ext>`），这里只保留
 *   「本地文件名 + 原始尺寸」。**不再把图片变成 data URL**：base64 副本既会写进书籍 JSON，
 *   又要在 IPC 与 JS 字符串里各存一份，一章几百张图足以把应用撑崩（见 book_images.rs）；
 * - 下载结果存本会话内存缓存：同一张图一次运行内只取一次，翻回 / 重排不再请求；
 * - 失败（无网 / 防盗链 / 非图片响应）自动重试：同一地址两次自动尝试之间有冷却，
 *   因此「再次读到这一章」或重新排版时会再试一次，不会连环打服务器；
 * - 仍失败时由占位框提供手动重试（忽略冷却，立即重试）；
 * - 章节内容的落盘（把本地文件名写回章节块）由 online.ts 负责，本模块只管取图。
 */
import { createSignal } from "solid-js";
import { fetchRemoteChapterImageFile } from "./backend";
import { cachedImageSize, invalidateImageAsset, rememberImageSize } from "./imageAssets";
import { currentSourceParallel } from "./store";

/** 图片下载并发上限（受全局「书源并发」设置约束，且不高于此值：正文图片数量多，避免占满会话） */
const NETWORK_CONCURRENCY_CAP = 4;
/** 同一地址两次自动重试之间的最小间隔（毫秒）：冷却内的失败直接按失败返回，等下次阅读再试 */
const AUTO_RETRY_COOLDOWN_MS = 4_000;

export type ChapterImagePhase = "loading" | "ready" | "failed";

/** 一张图下载成功后的结果：本地文件名 + 原始尺寸 */
export interface ChapterImageFile {
  local: string;
  width: number;
  height: number;
}

interface ImageEntry {
  phase: ChapterImagePhase;
  /** 本地副本文件名；loading / failed 时为空 */
  local: string;
  /** 失败原因（可读）；非 failed 时为空 */
  error: string;
  /** 进行中的请求；无请求时为空 */
  inflight: Promise<ChapterImageFile | null> | null;
  /** 最近一次尝试失败的时间戳；从没失败过为 0 */
  failedAt: number;
}

const entries = new Map<string, ImageEntry>();

/**
 * 状态版本：任一张图进入 loading / ready / failed 都会 +1。
 * 渲染侧经下面的 getter 读取它建立响应式依赖（本仓库统一用模块级 signal）。
 */
const [imageRevision, setImageRevision] = createSignal(0);

function bumpRevision(): void {
  setImageRevision((value) => value + 1);
}

/** 一张图当前的本地副本文件名；未下载 / 下载中 / 失败返回空串 */
export function chapterImageLocal(url: string): string {
  imageRevision();
  return entries.get(url)?.local ?? "";
}

/** 一张图当前的阶段；从没请求过视为 idle */
export function chapterImagePhase(url: string): ChapterImagePhase | "idle" {
  imageRevision();
  return entries.get(url)?.phase ?? "idle";
}

/** 一张图最近一次失败原因；无失败为空串 */
export function chapterImageError(url: string): string {
  imageRevision();
  return entries.get(url)?.error ?? "";
}

// ---------------------------------------------------------------------------
// 下载（并发闸 + 同址去重）
// ---------------------------------------------------------------------------

function poolSize(): number {
  return Math.max(1, Math.min(NETWORK_CONCURRENCY_CAP, Math.round(currentSourceParallel())));
}

const waiters: Array<() => void> = [];
let active = 0;

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

function entryOf(url: string): ImageEntry {
  let entry = entries.get(url);
  if (!entry) {
    entry = { phase: "loading", local: "", error: "", inflight: null, failedAt: 0 };
    entries.set(url, entry);
  }
  return entry;
}

/**
 * 取一张正文图片的本地副本（文件名 + 尺寸）。
 * - 已下载 → 直接返回；进行中 → 复用同一个请求；
 * - 之前失败且仍在冷却内且非强制 → 返回 null（等下次阅读 / 手动重试）；
 * - 排队期间 shouldStop 变真（用户离开了这一章 / 批量下载被停止）→ 不发请求、不记为失败；
 * - 其余情况发起一次下载。
 */
function loadChapterImage(
  sourceId: string,
  bookId: string,
  url: string,
  referer: string | null,
  force: boolean,
  shouldStop?: () => boolean,
  refresh?: boolean,
): Promise<ChapterImageFile | null> {
  const entry = entryOf(url);
  // 同一张图的并发请求合并（重试时也复用正在跑的那次）
  if (entry.inflight) return entry.inflight;
  if (!force) {
    if (entry.local) return Promise.resolve({ local: entry.local, ...sizeOf(entry.local) });
    if (entry.phase === "failed" && Date.now() - entry.failedAt < AUTO_RETRY_COOLDOWN_MS) {
      return Promise.resolve(null);
    }
  }
  entry.phase = "loading";
  entry.error = "";
  bumpRevision();
  const task = (async (): Promise<ChapterImageFile | null> => {
    const release = await acquireSlot();
    try {
      if (shouldStop?.()) {
        // 还没轮到就已被放弃：不占请求、也不留下失败记录（下次读到这一章再取）
        if (entries.get(url) === entry && !entry.local) entries.delete(url);
        return null;
      }
      const result = await fetchRemoteChapterImageFile(sourceId, bookId, url, referer);
      if (result.ok && result.local) {
        entry.local = result.local;
        entry.phase = "ready";
        entry.error = "";
        rememberImageSize(result.local, result.width, result.height);
        // 手动重试：文件名由地址哈希决定、重下不会改名，必须让渲染地址带版本参数
        // 重新请求一次，否则 WebView 仍按已失败的旧地址处理
        if (refresh) invalidateImageAsset(result.local);
        return { local: result.local, width: result.width, height: result.height };
      }
      entry.phase = "failed";
      entry.error = result.error || "图片下载失败";
      entry.failedAt = Date.now();
      return null;
    } catch (err) {
      entry.phase = "failed";
      entry.error = err instanceof Error ? err.message : String(err);
      entry.failedAt = Date.now();
      return null;
    } finally {
      release();
      entry.inflight = null;
      bumpRevision();
    }
  })();
  entry.inflight = task;
  return task;
}

/** 本地文件名 → 尺寸（本会话已登记过才有；未登记的由排版侧批量补查后缓存） */
function sizeOf(local: string): { width: number; height: number } {
  const size = cachedImageSize(local);
  return size ? { width: size.w, height: size.h } : { width: 0, height: 0 };
}

export interface ChapterImagesRequest {
  sourceId: string;
  /** 本地副本的归属书籍（Rust 侧按它给文件命名、删书时清理） */
  bookId: string;
  /** 防盗链 Referer：正文页地址 */
  referer: string | null;
  /** 需要就绪的图片地址（网络地址） */
  urls: readonly string[];
  /** 忽略自动重试冷却（批量下载「把图片也下一遍」用：要的是本次真的再试一次） */
  force?: boolean;
  /** 中止判定（批量下载「停止」用）：返回 true 时不再发起新的请求，已发出的等它结束 */
  shouldStop?: () => boolean;
}

/**
 * 确保一批图片已就绪（返回地址 → 本地副本，失败为 null）。
 * 已在会话内下载过的直接命中；失败过的按冷却自动再试。
 */
export async function ensureChapterImages(
  request: ChapterImagesRequest,
): Promise<Map<string, ChapterImageFile | null>> {
  const result = new Map<string, ChapterImageFile | null>();
  const tasks: Promise<void>[] = [];
  for (const url of request.urls) {
    if (!url) continue;
    if (request.shouldStop?.()) break;
    tasks.push(
      loadChapterImage(
        request.sourceId,
        request.bookId,
        url,
        request.referer,
        !!request.force,
        request.shouldStop,
      ).then((file) => {
        result.set(url, file);
      }),
    );
  }
  await Promise.all(tasks);
  return result;
}

/** 手动重试一张图片（忽略冷却，立即请求，并让渲染侧重新请求该文件）；失败返回 null */
export async function retryChapterImage(
  sourceId: string,
  bookId: string,
  url: string,
  referer: string | null,
): Promise<ChapterImageFile | null> {
  return loadChapterImage(sourceId, bookId, url, referer, true, undefined, true);
}

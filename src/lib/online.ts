/**
 * 在线书会话与内容缓存：
 * - 书源搜索/发现命中的“待预览书”暂存（会话级）；
 * - 「加入书架」= 只落 toc 元数据的本地书（format: online），正文按需下载；
 * - 阅读时按「当前章 ±5 章」窗口懒加载并落盘（逐批写回同一本 LocalBook）；
 * - 显式批量下载剩余全部正文（并发可配、可取消）。
 */
import { createSignal } from "solid-js";
import {
  callRemoteSource,
  fetchRemoteChapterContents,
} from "./backend";
import { addBookRecord, commitBookContentUpdate, localBookById } from "./books";
import { isOnlineBook, type LocalBook, type LocalBookChapter } from "./booksTypes";
import type {
  BookItem,
  BookSourceSummary,
  ChapterItem,
  ChapterContentResult,
} from "./bookSourcesTypes";

/** 阅读懒加载窗口半径（前后各 N 章） */
export const LAZY_WINDOW = 5;
/** 单批拉取章节数 */
const BATCH_SIZE = 20;

// ---------------------------------------------------------------------------
// 会话级「待预览书」暂存（不持久化）
// ---------------------------------------------------------------------------

export interface PickedBook {
  key: string;
  source: BookSourceSummary;
  item: BookItem;
}

const pickMap = new Map<string, PickedBook>();

/** 稳定 key：sourceId|bookUrl → base64url */
export function onlineKeyOf(sourceId: string, bookUrl: string): string {
  const raw = `${sourceId}|${bookUrl}`;
  let b64: string;
  try {
    b64 = btoa(unescape(encodeURIComponent(raw)));
  } catch {
    b64 = btoa(raw);
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 记录一次命中并返回跳转用 key */
export function rememberPicked(source: BookSourceSummary, item: BookItem): string {
  const key = onlineKeyOf(source.id, item.bookUrl);
  pickMap.set(key, { key, source, item });
  return key;
}

export function getPicked(key: string): PickedBook | undefined {
  return pickMap.get(key);
}

// ---------------------------------------------------------------------------
// 章节内容判定与文本规范化
// ---------------------------------------------------------------------------

/**
 * 章节正文是否已就绪：paragraphs 有内容，或 blocks 已定义（包括空数组，
 * 表示“已拉取过但正文为空”，避免重复拉取）。
 */
export function chapterHasContent(chapter: LocalBookChapter): boolean {
  return (
    (chapter.paragraphs?.length ?? 0) > 0 || chapter.blocks !== undefined
  );
}

/** 把引擎返回的原始正文清洗成段落数组（分段 = 空行；HTML 先行剥标签） */
export function normalizeContentText(raw: string): string[] {
  let t = raw ?? "";
  t = t
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  if (t.includes("<")) {
    t = t
      .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|tr|table|ul|ol|section|article|blockquote|td|dd|dt)>/gi, "\n")
      .replace(/<[^>]*>/g, "");
  }
  t = t
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const c = Number(code);
      return Number.isFinite(c) && c > 0 ? String.fromCodePoint(c) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => {
      const c = parseInt(code, 16);
      return Number.isFinite(c) && c > 0 ? String.fromCodePoint(c) : "";
    })
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n");
  const paragraphs = t
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/\s*\n\s*/g, "").replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  if (paragraphs.length > 0) return paragraphs;
  const single = t.replace(/\s+/g, " ").trim();
  return single ? [single] : [];
}

function toBookItem(book: LocalBook): BookItem {
  return {
    bookName: book.title,
    author: book.author || undefined,
    bookUrl: book.bookUrl ?? "",
  };
}

function newBookId(): string {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function hueFrom(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** 「加入书架」前先取目录，再按 toc 生成只有元数据的本地书 */
export async function fetchBookToc(
  source: BookSourceSummary,
  item: BookItem,
): Promise<ChapterItem[]> {
  const result = await callRemoteSource(source.id, "bookToc", [item]);
  if (!result.ok) throw new Error(result.error ?? "获取目录失败");
  const value = result.value;
  if (!Array.isArray(value)) throw new Error("bookToc 未返回章节数组");
  const chapters: ChapterItem[] = [];
  for (const raw of value as unknown[]) {
    const r = raw as Record<string, unknown>;
    const chapterName = typeof r.chapterName === "string" ? r.chapterName.trim() : "";
    const chapterUrl = typeof r.chapterUrl === "string" ? r.chapterUrl.trim() : "";
    if (chapterName && chapterUrl) chapters.push({ chapterName, chapterUrl });
  }
  if (chapters.length === 0) throw new Error("目录为空（书源未解析出章节）");
  return chapters;
}

/** 组装在线书本骨架（全 toc、空正文），加入书架 */
export async function addOnlineBookToShelf(
  source: BookSourceSummary,
  item: BookItem,
  chapters: ChapterItem[],
): Promise<LocalBook> {
  const now = Date.now();
  const localChapters: LocalBookChapter[] = chapters.map((ch, index) => ({
    cid: `c${String(index + 1).padStart(4, "0")}`,
    title: ch.chapterName,
    paragraphs: [],
    url: ch.chapterUrl,
  }));
  const book: LocalBook = {
    id: newBookId(),
    title: item.bookName.trim() || "未命名书籍",
    author: (item.author ?? "").trim() || "佚名",
    ...(item.intro?.trim() ? { intro: item.intro.trim() } : {}),
    format: "online",
    fileName: `${(item.bookName || "online").slice(0, 60)}.txt`,
    size: 0,
    importedAt: now,
    hue: hueFrom(item.bookName + item.bookUrl),
    splitDesc: `书源：${source.name}`,
    chapters: localChapters,
    source: "online",
    bookSourceId: source.id,
    bookUrl: item.bookUrl,
  };
  await addBookRecord(book);
  return book;
}

// ---------------------------------------------------------------------------
// 并发拉取执行器（每本书串行 one-flight；批内按并发请求）
// ---------------------------------------------------------------------------

export type OnlineRunPhase = "idle" | "window" | "download";

export interface OnlineRunState {
  phase: OnlineRunPhase;
  busy: boolean;
  total: number;
  done: number;
  failed: { index: number; error: string }[];
  /** 本次拉取中仍待获取（含正在获取）的章节下标，取到正文后即移出 */
  pending: number[];
  cancelled: boolean;
}

const [runMap, setRunMap] = createSignal<Record<string, OnlineRunState>>({});

export function onlineRunState(bookId: string): OnlineRunState {
  return (
    runMap()[bookId] ?? {
      phase: "idle",
      busy: false,
      total: 0,
      done: 0,
      failed: [],
      pending: [],
      cancelled: false,
    }
  );
}

const cancellations = new Set<string>();

export function cancelOnlineRun(bookId: string): void {
  cancellations.add(bookId);
  const current = runMap()[bookId];
  if (current) {
    setRunMap({
      ...runMap(),
      [bookId]: { ...current, cancelled: true, pending: [] },
    });
  }
}

function patchRun(bookId: string, patch: Partial<OnlineRunState>): void {
  const current = runMap()[bookId] ?? {
    phase: "idle" as const,
    busy: false,
    total: 0,
    done: 0,
    failed: [],
    pending: [],
    cancelled: false,
  };
  setRunMap({ ...runMap(), [bookId]: { ...current, ...patch } });
}

/** 某一本书内部是否正在拉正文 */
export function onlineRunBusy(bookId: string): boolean {
  return runMap()[bookId]?.busy ?? false;
}

/**
 * 依次下载 book 中缺失正文的章节（分批提交，每批内部并行上限由用户全局“书源并发”设置决定）。
 * indexes 为空时表示「剩余全部」。
 */
async function runFetch(
  bookId: string,
  indexes: number[] | null,
  phase: OnlineRunPhase,
  onProgress?: (state: OnlineRunState) => void,
): Promise<void> {
  if (onlineRunBusy(bookId)) return;
  let book = localBookById(bookId);
  if (!book || !isOnlineBook(book)) return;
  const sourceId = book.bookSourceId!;
  const chapters = book.chapters;
  const total = chapters.length;
  let targets = indexes;
  if (targets === null) {
    targets = chapters
      .map((ch, i) => (chapterHasContent(ch) ? -1 : i))
      .filter((i) => i >= 0);
  } else {
    targets = targets.filter((i) => i >= 0 && i < total);
  }
  targets = targets.filter((i) => i >= 0 && !chapterHasContent(chapters[i]));
  if (targets.length === 0) {
    patchRun(bookId, { phase: "idle", busy: false, total: 0, done: 0, pending: [] });
    return;
  }

  cancellations.delete(bookId);
  patchRun(bookId, {
    phase,
    busy: true,
    total: targets.length,
    done: 0,
    failed: [],
    pending: [...targets],
    cancelled: false,
  });
  const failed: { index: number; error: string }[] = [];
  let done = 0;

  for (let start = 0; start < targets.length; start += BATCH_SIZE) {
    if (cancellations.has(bookId)) break;
    book = localBookById(bookId);
    if (!book) break;
    const slice = targets.slice(start, start + BATCH_SIZE);
    const metas: ChapterItem[] = [];
    for (const idx of slice) {
      const ch = book.chapters[idx];
      if (ch?.url) metas.push({ chapterName: ch.title, chapterUrl: ch.url });
    }
    const results: ChapterContentResult[] = await fetchRemoteChapterContents(
      sourceId,
      toBookItem(book),
      metas,
    );
    if (cancellations.has(bookId)) break;
    const nextBook = structuredClone(book);
    results.forEach((res, offset) => {
      const chapterIndex = slice[offset];
      const chapter = nextBook.chapters[chapterIndex];
      if (!chapter) return;
      if (res.ok) {
        chapter.paragraphs = normalizeContentText(res.text);
        if (chapter.paragraphs.length > 0) {
          chapter.blocks = undefined;
        } else {
          // 已拉取但正文为空：标记为已获取，避免反复请求
          chapter.blocks = [];
        }
      } else {
        failed.push({ index: chapterIndex, error: res.error || "未知错误" });
      }
    });
    done += results.length;
    await commitBookContentUpdate(nextBook);
    const remaining = targets.slice(start + slice.length);
    patchRun(bookId, {
      done: Math.min(done, targets.length),
      failed: [...failed],
      pending: remaining,
    });
    onProgress?.(runMap()[bookId] ?? onlineRunState(bookId));
  }

  const cancelled = cancellations.has(bookId);
  cancellations.delete(bookId);
  patchRun(bookId, {
    phase: "idle",
    busy: false,
    pending: [],
    cancelled,
  });
}

/** 阅读窗口预取：确保 [idx-WINDOW, idx+WINDOW] 内章节有正文 */
export async function ensureReadingWindow(
  bookId: string,
  chapterIndex: number,
): Promise<void> {
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book) || onlineRunBusy(bookId)) return;
  const lo = Math.max(0, chapterIndex - LAZY_WINDOW);
  const hi = Math.min(book.chapters.length - 1, chapterIndex + LAZY_WINDOW);
  const missing: number[] = [];
  for (let i = lo; i <= hi; i++) {
    if (!chapterHasContent(book.chapters[i])) missing.push(i);
  }
  if (missing.length === 0) return;
  await runFetch(bookId, missing, "window");
}

/** 批量下载剩余全部正文（下载按钮） */
export async function downloadRemainingChapters(
  bookId: string,
  onProgress?: (state: OnlineRunState) => void,
): Promise<void> {
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book)) return;
  await runFetch(bookId, null, "download", onProgress);
}

/**
 * 强制重新获取单个章节正文（阅读设置「重新加载本章」）：
 * 先清掉该章已缓存的正文（含“已拉取但为空”的标记），再单独重拉一次并落盘。
 * 有其它拉取任务正在进行时不动作（UI 端已据此禁用入口）。
 */
export async function reloadChapterContent(
  bookId: string,
  chapterIndex: number,
): Promise<void> {
  if (onlineRunBusy(bookId)) return;
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book)) return;
  const next = structuredClone(book);
  const chapter = next.chapters[chapterIndex];
  if (!chapter || !chapter.url) return;
  chapter.paragraphs = [];
  chapter.blocks = undefined;
  await commitBookContentUpdate(next);
  await runFetch(bookId, [chapterIndex], "window");
}

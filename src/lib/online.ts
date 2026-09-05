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
  fetchRemoteSourceImage,
} from "./backend";
import { addBookRecord, commitBookContentUpdate, localBookById } from "./books";
import { isOnlineBook, type LocalBook, type LocalBookChapter } from "./booksTypes";
import type {
  BookItem,
  BookSourceSummary,
  ChapterItem,
  ChapterContentResult,
} from "./bookSourcesTypes";
import { currentSourceParallel } from "./store";
import {
  buildSourceChapterContent,
  type SourceContentBuild,
} from "./sourceContent";

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

// 正文文本规范化已迁至 sourceContent.ts（供“含图正文”解析共用）；这里再导出保持旧引用可用
export { normalizeContentText } from "./sourceContent";

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

/** 单章拉取计划：引擎返回 + 结构化解析结果 */
interface BatchPlan {
  chapterIndex: number;
  chapter: LocalBookChapter;
  build: SourceContentBuild;
}

/**
 * 依次下载 book 中缺失正文的章节（分批；引擎正文拉取按批并发，批内图片下载限并发）。
 * - indexes 为空表示「剩余全部」（download 相位，每批统一落盘，保持批量 I/O）；
 * - window 相位按传入顺序逐章处理并逐章落盘（调用方已把当前阅读章排在前面，
 *   使其尽早可读，其余窗口章节随后在后台补齐）。
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
  const concurrency = Math.max(1, currentSourceParallel());

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

    // 单章图片下载（章内限并发；取消/失败时该图留占位 src=""，阅读器显示占位框）
    const fetchPlanImages = async (plan: BatchPlan): Promise<number> => {
      const refs = plan.build.imageRefs;
      if (refs.length === 0) return 0;
      const cache = new Map<string, string | null>();
      let cursor = 0;
      let loaded = 0;
      const cap = Math.max(1, Math.min(concurrency, refs.length));
      const worker = async (): Promise<void> => {
        for (;;) {
          const ref = refs[cursor];
          if (!ref) return;
          cursor++;
          const block = plan.build.blocks[ref.index];
          if (!block || block.kind !== "img") continue;
          if (cancellations.has(bookId)) {
            block.src = "";
            continue;
          }
          let data = cache.get(ref.url);
          if (data === undefined) {
            data = await fetchRemoteSourceImage(sourceId, ref.url, plan.chapter.url || null);
            cache.set(ref.url, data);
          }
          if (data) {
            block.src = data;
            loaded++;
          } else {
            block.src = "";
          }
        }
      };
      await Promise.all(Array.from({ length: cap }, () => worker()));
      return loaded;
    };

    // 把解析结果写入章节；纯图章一张图都没成功时视为失败（不落盘，供 UI 重试）。
    const applyOne = async (plan: BatchPlan): Promise<boolean> => {
      const { chapter, build } = plan;
      const imgCount = build.blocks.filter((b) => b.kind === "img").length;
      // data: 直给图片无需下载，视为已就绪
      const ready = imgCount - build.imageRefs.length;
      const loaded = build.imageRefs.length > 0 ? await fetchPlanImages(plan) : 0;
      if (build.hasImages) {
        if (build.paragraphs.length === 0 && ready + loaded === 0) {
          failed.push({
            index: plan.chapterIndex,
            error: `图片加载失败（0/${build.imageRefs.length}）`,
          });
          return false;
        }
        chapter.paragraphs = build.paragraphs;
        chapter.blocks = build.blocks;
        return true;
      }
      // 纯文本：保持旧行为（无图片不写 blocks，避免旧读者差异；空正文标记已拉取）
      chapter.paragraphs = build.paragraphs;
      if (build.paragraphs.length > 0) {
        chapter.blocks = undefined;
      } else {
        chapter.blocks = [];
      }
      return true;
    };

    // 组装批次计划（引擎失败的章节直接进失败列表）
    const plans: BatchPlan[] = [];
    for (let offset = 0; offset < slice.length; offset++) {
      const res = results[offset];
      const chapterIndex = slice[offset];
      const chapter = nextBook.chapters[chapterIndex];
      if (!chapter) continue;
      if (!res.ok) {
        failed.push({ index: chapterIndex, error: res.error || "未知错误" });
        done++;
        continue;
      }
      const build = buildSourceChapterContent(res.text, chapter.url || undefined);
      plans.push({ chapterIndex, chapter, build });
    }

    if (phase === "window") {
      // 逐章处理并逐章落盘：当前阅读章在调用方传入顺序最前，尽快可读
      for (const plan of plans) {
        if (cancellations.has(bookId)) break;
        const applied = await applyOne(plan);
        done++;
        if (applied) await commitBookContentUpdate(nextBook);
      }
    } else {
      for (const plan of plans) {
        await applyOne(plan);
        done++;
      }
      await commitBookContentUpdate(nextBook);
    }

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

/** 阅读窗口预取：确保 [idx-WINDOW, idx+WINDOW] 内章节有正文（当前章优先） */
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
  // 离当前章近的先拉（同距按下标升序），runFetch 按此顺序逐章落盘，阅读无需等整窗
  missing.sort((a, b) => Math.abs(a - chapterIndex) - Math.abs(b - chapterIndex) || a - b);
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

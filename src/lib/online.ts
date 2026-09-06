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
import {
  addBookRecord,
  commitBookContentUpdate,
  localBookById,
  updateBookChapters,
} from "./books";
import {
  previewChapterBookmarkReplacement,
  type BookmarkInheritPreview,
} from "./bookmarks";
import {
  bookSourceSummaryById,
  ensureBookSourcesLoaded,
} from "./bookSources";
import {
  chapterCid,
  isOnlineBook,
  type LocalBook,
  type LocalBookChapter,
} from "./booksTypes";
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
 * 单章图片下载（章内限并发；取消/失败时该图留占位 src=""，阅读器显示占位框）。
 * 返回成功下载张数（data: 直给图片无需下载，不计入）。
 */
async function fetchChapterImages(
  bookId: string,
  sourceId: string,
  chapterUrl: string | null,
  build: SourceContentBuild,
  concurrency: number,
): Promise<number> {
  const refs = build.imageRefs;
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
      const block = build.blocks[ref.index];
      if (!block || block.kind !== "img") continue;
      if (cancellations.has(bookId)) {
        block.src = "";
        continue;
      }
      let data = cache.get(ref.url);
      if (data === undefined) {
        data = await fetchRemoteSourceImage(sourceId, ref.url, chapterUrl);
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
}

/**
 * 把一个章节的解析结果写入 chapter 对象（含图片下载）。
 * 纯图章一张图都没成功时返回 false（不落盘，供调用方标记失败/提示）。
 */
async function applyChapterBuild(
  bookId: string,
  sourceId: string,
  chapter: LocalBookChapter,
  build: SourceContentBuild,
  concurrency: number,
): Promise<boolean> {
  const imgCount = build.blocks.filter((b) => b.kind === "img").length;
  // data: 直给图片无需下载，视为已就绪
  const ready = imgCount - build.imageRefs.length;
  const loaded =
    build.imageRefs.length > 0
      ? await fetchChapterImages(
          bookId,
          sourceId,
          chapter.url || null,
          build,
          concurrency,
        )
      : 0;
  if (build.hasImages) {
    if (build.paragraphs.length === 0 && ready + loaded === 0) return false;
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
}

/** 让出主线程一拍，保证分片解析/图片回写期间渲染与交互不被饿死 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

/** 把若干章节“原位替换”到一本书上：其余章节对象原样复用（不做整本深拷贝） */
function patchChapters(
  book: LocalBook,
  patches: Array<{ index: number; chapter: LocalBookChapter }>,
): LocalBook {
  if (patches.length === 0) return book;
  const byIndex = new Map<number, LocalBookChapter>();
  for (const patch of patches) byIndex.set(patch.index, patch.chapter);
  const chapters = book.chapters.map((ch, i) => byIndex.get(i) ?? ch);
  return { ...book, chapters };
}

/**
 * 依次下载 book 中缺失正文的章节（分批；引擎正文拉取按批并发，批内图片下载限并发）。
 * - indexes 为空表示「剩余全部」（download 相位，每批统一落盘，保持批量 I/O）；
 * - window 相位按传入顺序逐章处理并逐章落盘（调用方已把当前阅读章排在前面，
 *   使其尽早可读，其余窗口章节随后在后台补齐）。
 *
 * 说明（在线书含图后的大书优化）：
 * - 不再对整本做 structuredClone / 整本 JSON 过 IPC —— 只把本次真正写好的章节
 *   增量交给后端（updateBookChapters），避免含 data URL 图片的大书反复整本拷贝，
 *   这正是逐批下载卡顿 / 内存暴涨闪退的根因；
 * - 章节解析等 CPU 步骤之间让出主线程（yieldToMain），渲染与翻页不被阻塞。
 */
async function runFetch(
  bookId: string,
  indexes: number[] | null,
  phase: OnlineRunPhase,
  onProgress?: (state: OnlineRunState) => void,
): Promise<void> {
  if (onlineRunBusy(bookId)) return;
  const initial = localBookById(bookId);
  if (!initial || !isOnlineBook(initial)) return;
  const sourceId = initial.bookSourceId!;
  const total = initial.chapters.length;
  let targets = indexes;
  if (targets === null) {
    targets = initial.chapters
      .map((ch, i) => (chapterHasContent(ch) ? -1 : i))
      .filter((i) => i >= 0);
  } else {
    targets = targets.filter((i) => i >= 0 && i < total);
  }
  targets = targets.filter((i) => i >= 0 && !chapterHasContent(initial.chapters[i]));
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
  // 最近一次已回写/已发布到书库的书（只替换本次写入章节，深拷贝整本只发生一次：无）
  let published = initial;

  try {
    for (let start = 0; start < targets.length; start += BATCH_SIZE) {
      if (cancellations.has(bookId)) break;
      const bookNow = published;
      const slice = targets.slice(start, start + BATCH_SIZE);
      const metas: ChapterItem[] = [];
      for (const idx of slice) {
        const ch = bookNow.chapters[idx];
        if (ch?.url) metas.push({ chapterName: ch.title, chapterUrl: ch.url });
      }
      const results: ChapterContentResult[] = await fetchRemoteChapterContents(
        sourceId,
        toBookItem(bookNow),
        metas,
      );
      if (cancellations.has(bookId)) break;

      // 组装批次计划（引擎失败的章节直接进失败列表）；每次解析之间让出主线程
      const plans: BatchPlan[] = [];
      for (let offset = 0; offset < slice.length; offset++) {
        if (cancellations.has(bookId)) break;
        const res = results[offset];
        const chapterIndex = slice[offset];
        const chapter = bookNow.chapters[chapterIndex];
        if (!chapter) continue;
        if (!res.ok) {
          failed.push({ index: chapterIndex, error: res.error || "未知错误" });
          done++;
          continue;
        }
        const build = buildSourceChapterContent(res.text, chapter.url || undefined);
        plans.push({ chapterIndex, chapter, build });
        if (offset % 3 === 2) await yieldToMain(); // 分片解析不长时间独占主线程
      }
      // plans 可能为空（本批引擎全部失败）：仍要走到底部 patchRun，把失败结果汇报给 UI

      // 单章：在全新的章节对象上完成解析与图片下载；纯图章全失败视为失败
      const fillChapter = async (
        plan: BatchPlan,
      ): Promise<LocalBookChapter | null> => {
        const draft: LocalBookChapter = {
          cid: plan.chapter.cid,
          title: plan.chapter.title,
          paragraphs: [],
          blocks: undefined,
          url: plan.chapter.url,
        };
        const ok = await applyChapterBuild(
          bookId,
          sourceId,
          draft,
          plan.build,
          concurrency,
        );
        if (!ok) {
          failed.push({
            index: plan.chapterIndex,
            error: `图片加载失败（0/${plan.build.imageRefs.length}）`,
          });
          return null;
        }
        return draft;
      };

      const batchPatch: Array<{ index: number; chapter: LocalBookChapter }> = [];
      if (phase === "window") {
        // 逐章处理并逐章落盘：当前阅读章在调用方传入顺序最前，尽快可读
        for (const plan of plans) {
          if (cancellations.has(bookId)) break;
          const filled = await fillChapter(plan);
          done++;
          if (!filled) continue;
          batchPatch.push({ index: plan.chapterIndex, chapter: filled });
          published = patchChapters(published, batchPatch);
          await updateBookChapters(published, [...batchPatch]);
          batchPatch.length = 0;
          if (plans.length > 1) await yieldToMain();
        }
      } else {
        for (const plan of plans) {
          const filled = await fillChapter(plan);
          done++;
          if (filled) batchPatch.push({ index: plan.chapterIndex, chapter: filled });
        }
        if (batchPatch.length > 0) {
          published = patchChapters(published, batchPatch);
          await updateBookChapters(published, batchPatch);
        }
      }

      const remaining = targets.slice(start + slice.length);
      patchRun(bookId, {
        done: Math.min(done, targets.length),
        failed: [...failed],
        pending: remaining,
      });
      onProgress?.(runMap()[bookId] ?? onlineRunState(bookId));
    }
  } catch (err) {
    // 意外中断（磁盘 I/O 等）：清掉 busy 状态，避免该书永远卡在“下载中”
    console.error("[online] 章节下载意外中断", err);
  } finally {
    const cancelled = cancellations.has(bookId);
    cancellations.delete(bookId);
    patchRun(bookId, {
      phase: "idle",
      busy: false,
      pending: [],
      cancelled,
    });
  }
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

export interface ReloadChapterOutcome {
  /** 新正文已写入书库（含新旧正文相同的情形） */
  applied: boolean;
  /** 用户取消（书签风险提示选择不重载，书库与阅读位置不变） */
  cancelled: boolean;
  /** applied=false 且非用户取消时的可读错误 */
  error?: string;
}

export interface ReloadChapterOptions {
  /** 新正文会让本章书签失效时回调（给出预演结果）；返回 false 则放弃本次重载 */
  confirmRisk?: (preview: BookmarkInheritPreview) => Promise<boolean>;
}

/**
 * 强制重新获取单个章节正文（阅读设置「重新加载本章」）：
 * - 先拉取最新正文并解析，期间不动书库（成功才覆盖，失败保留旧正文）；
 * - 新正文会替换本章书签锚定的文字：通过 options.confirmRisk 交调用方询问，
 *   用户选择放弃时既不覆盖正文也不改动书签；
 * - 有其它拉取任务正在进行时不动作（UI 端已据此禁用入口）。
 */
export async function reloadChapterContent(
  bookId: string,
  chapterIndex: number,
  options?: ReloadChapterOptions,
): Promise<ReloadChapterOutcome> {
  if (onlineRunBusy(bookId)) return { applied: false, cancelled: false };
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book)) return { applied: false, cancelled: false };
  const chapter = book.chapters[chapterIndex];
  if (!chapter?.url) return { applied: false, cancelled: false };
  const sourceId = book.bookSourceId!;
  const concurrency = Math.max(1, currentSourceParallel());

  // 占用 run 状态：与其余拉取互斥，“下载中”提示 / 相关入口禁用一并生效
  cancellations.delete(bookId);
  patchRun(bookId, {
    phase: "window",
    busy: true,
    total: 1,
    done: 0,
    failed: [],
    pending: [chapterIndex],
    cancelled: false,
  });
  const settle = (patch: Partial<OnlineRunState>): void => {
    patchRun(bookId, { phase: "idle", busy: false, pending: [], ...patch });
  };

  try {
    const results = await fetchRemoteChapterContents(sourceId, toBookItem(book), [
      { chapterName: chapter.title, chapterUrl: chapter.url },
    ]);
    const res = results[0];
    if (!res?.ok) {
      const error = res?.error || "获取正文失败";
      settle({ failed: [{ index: chapterIndex, error }] });
      return { applied: false, cancelled: false, error };
    }
    if (cancellations.has(bookId)) {
      cancellations.delete(bookId);
      settle({ cancelled: true });
      return { applied: false, cancelled: true };
    }
    const build = buildSourceChapterContent(res.text, chapter.url);

    // 新正文会替换本章书签锚定的文字：先预演，部分书签无法精确定位时交调用方询问
    if (options?.confirmRisk) {
      const nextChapter: LocalBookChapter = {
        ...chapter,
        paragraphs: build.paragraphs,
        blocks: build.hasImages ? build.blocks : build.paragraphs.length > 0 ? undefined : [],
      };
      const preview = await previewChapterBookmarkReplacement(
        book,
        chapterIndex,
        nextChapter,
      );
      if (preview.failedCount > 0) {
        const proceed = await options.confirmRisk(preview);
        if (!proceed) {
          settle({});
          return { applied: false, cancelled: true };
        }
      }
    }

    // 拉取期间书库可能已更新（其它窗口预取落盘）：以最新书为基底只补当前章
    const latest = localBookById(bookId) ?? book;
    const target = latest.chapters[chapterIndex];
    if (!target) {
      settle({});
      return { applied: false, cancelled: false, error: "章节已变化，未重新加载" };
    }
    // 只构建/回写本章的新对象（不整本深拷贝），大书含图时不再反复整本过 IPC
    const draft: LocalBookChapter = {
      cid: target.cid,
      title: target.title,
      paragraphs: [],
      blocks: undefined,
      url: target.url,
    };
    const okApply = await applyChapterBuild(
      bookId,
      sourceId,
      draft,
      build,
      concurrency,
    );
    if (cancellations.has(bookId)) {
      cancellations.delete(bookId);
      settle({ cancelled: true });
      return { applied: false, cancelled: true };
    }
    if (!okApply) {
      const error = `图片加载失败（0/${build.imageRefs.length}）`;
      settle({ failed: [{ index: chapterIndex, error }] });
      return { applied: false, cancelled: false, error };
    }
    const next = patchChapters(latest, [{ index: chapterIndex, chapter: draft }]);
    await updateBookChapters(next, [{ index: chapterIndex, chapter: draft }]);
    settle({ done: 1, failed: [] });
    return { applied: true, cancelled: false };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    settle({ failed: [{ index: chapterIndex, error }] });
    return { applied: false, cancelled: false, error };
  }
}

// ---------------------------------------------------------------------------
// 在线书「检查书籍更新」：重新获取书源目录并与书架目录比对后更新。
// 判定规则（章节身份 = 书源侧章节地址）：
// - 最新目录是书架现有目录的「逐位前缀 + 末尾新增」→ 纯追加（返回新增数）；
// - 与现有目录完全一致 → 无更新；
// - 其余情况（中段被增删 / 重排 / 章节地址变动，无法安全追加）→ conflict，
//   交由 UI 询问是否整本覆盖。
// ---------------------------------------------------------------------------

export interface OnlineTocConflict {
  /** 书架现有章节数 */
  oldCount: number;
  /** 书源最新目录章节数 */
  newCount: number;
  /** 书源最新目录（用户确认覆盖后用于整本替换） */
  fresh: ChapterItem[];
}

export type OnlineTocUpdate =
  | { kind: "none" }
  | { kind: "append"; added: ChapterItem[] }
  | { kind: "conflict"; conflict: OnlineTocConflict };

/** 重新获取在线书的书源目录（阅读设置「检查书籍更新」用）。
 *  书源缺失 / 停用 / 未启用目录能力，或拉取失败时抛出可读错误。 */
export async function fetchOnlineBookToc(book: LocalBook): Promise<ChapterItem[]> {
  if (!isOnlineBook(book)) throw new Error("不是在线书，无法检查更新");
  if (!book.bookUrl) throw new Error("该书缺少书源书籍地址，无法检查更新");
  const sourceId = book.bookSourceId!;
  await ensureBookSourcesLoaded();
  const source = bookSourceSummaryById(sourceId);
  if (!source) throw new Error("该书源已删除，无法检查更新");
  if (!source.enabled) throw new Error("该书源已停用，请先在「书源」中启用");
  if (!source.capabilities.toc) throw new Error("该书源未启用「目录」能力，无法检查更新");
  const item: BookItem = {
    bookName: book.title,
    ...(book.author && book.author !== "佚名" ? { author: book.author } : {}),
    bookUrl: book.bookUrl,
  };
  return await fetchBookToc(source, item);
}

/** 比对书源最新目录与书架现有目录，给出本次「检查更新」的更新方式 */
export function diffOnlineBookToc(
  book: Pick<LocalBook, "chapters">,
  fresh: ChapterItem[],
): OnlineTocUpdate {
  const old = book.chapters;
  const oldCount = old.length;
  const newCount = fresh.length;
  // 现有目录是否是「最新目录」的逐位前缀（章节身份按书源侧章节地址比对；
  // 旧章节缺失地址时视为无法核对 → 交给覆盖流程）
  let prefix = 0;
  while (prefix < oldCount && prefix < newCount) {
    if ((old[prefix].url ?? "").trim() !== (fresh[prefix].chapterUrl ?? "").trim()) break;
    prefix++;
  }
  if (prefix === oldCount && newCount >= oldCount) {
    if (newCount === oldCount) return { kind: "none" };
    return { kind: "append", added: fresh.slice(oldCount) };
  }
  return { kind: "conflict", conflict: { oldCount, newCount, fresh } };
}

/** 执行追加更新：把末尾新增章节并入书架目录（正文留空，阅读时按窗口懒加载）。
 *  返回实际追加的章节数。 */
export async function applyOnlineTocAppend(
  book: LocalBook,
  added: ChapterItem[],
): Promise<number> {
  if (added.length === 0) return 0;
  const next = structuredClone(book);
  const start = next.chapters.length;
  for (let i = 0; i < added.length; i++) {
    const item = added[i];
    next.chapters.push({
      cid: chapterCid(start + i),
      title: item.chapterName,
      paragraphs: [],
      url: item.chapterUrl,
    });
  }
  await commitBookContentUpdate(next);
  return added.length;
}

/** 执行覆盖更新：以最新目录整本替换章节列表。
 *  章节地址未变的旧章节保留已缓存正文，其余章节正文留空（阅读时按需重新获取）。
 *  返回覆盖后的章节总数。 */
export async function applyOnlineTocOverwrite(
  book: LocalBook,
  fresh: ChapterItem[],
): Promise<number> {
  const oldByUrl = new Map<string, LocalBookChapter>();
  for (const ch of book.chapters) {
    const url = (ch.url ?? "").trim();
    if (url && !oldByUrl.has(url)) oldByUrl.set(url, ch);
  }
  const next = structuredClone(book);
  next.chapters = fresh.map((item, index) => {
    const carried = oldByUrl.get((item.chapterUrl ?? "").trim());
    const chapter: LocalBookChapter = {
      cid: chapterCid(index),
      title: item.chapterName,
      paragraphs: carried?.paragraphs ?? [],
      url: item.chapterUrl,
    };
    if (carried && carried.blocks !== undefined) chapter.blocks = carried.blocks;
    return chapter;
  });
  await commitBookContentUpdate(next);
  return next.chapters.length;
}

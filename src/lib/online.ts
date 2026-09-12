/**
 * 在线书会话与内容缓存：
 * - 书源搜索/发现命中的“待预览书”暂存（会话级）；
 * - 「加入书架」= 只落 toc 元数据的本地书（format: online），正文按需下载；
 * - 阅读时按「当前章 ±5 章」窗口预取并落盘（逐批写回同一本 LocalBook）：
 *   正在读的那一章单独先取、取回即落盘，其余窗口章节后台补齐；
 *   预取只取正文，图片留到用户读到该章时按需下载（见 chapterImages.ts）；
 * - 显式批量下载剩余全部正文（并发可配、可取消）：正文下完后单独再过一遍图片。
 */
import { createSignal } from "solid-js";
import {
  callRemoteSource,
  fetchRemoteChapterContents,
} from "./backend";
import {
  ensureChapterImages,
  retryChapterImage,
  type ChapterImageFile,
} from "./chapterImages";
import {
  addBookRecord,
  bookMetaById,
  commitBookContentUpdate,
  localBookById,
  updateBookChapters,
  updateBookInfo,
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
  normalizeBookTags,
  type ChapterBlock,
  type LocalBook,
  type LocalBookChapter,
} from "./booksTypes";
import type {
  BookItem,
  BookSourceSummary,
  ChapterItem,
} from "./bookSourcesTypes";
import { loadSourceCoverThumb } from "./sourceCover";
import { currentSourceParallel } from "./store";
import {
  buildSourceChapterContent,
  type SourceContentBuild,
} from "./sourceContent";

/** 预取窗口半径（前后各 N 章，共 2N+1 章）：后台把这一圈章节的正文抓下来落盘，
 *  顺序阅读 / 听书跨章时下一章永远已经就绪；正在读的那一章永远最先取（见 runWindowFetch）。
 *  注意：这是「提前抓」的半径，与阅读视图实际读取的范围无关 ——
 *  渲染只读当前章 ±1 章（见 Reader 的 RENDER_WINDOW），窗口外章节的落盘不会惊动前端。 */
export const LAZY_WINDOW = 5;
/** 单批拉取章节数（批量下载用；窗口预取按书源并发另定批大小，见 runWindowFetch） */
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

function toBookItem(
  book: Pick<LocalBook, "title" | "author" | "bookUrl" | "tags">,
): BookItem {
  const tags = normalizeBookTags(book.tags);
  return {
    bookName: book.title,
    author: book.author || undefined,
    bookUrl: book.bookUrl ?? "",
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/** 把书源详情返回值里非空的字符串字段合并进基础命中项 */
export function mergeBookDetail(base: BookItem, value: unknown): BookItem {
  if (!value || typeof value !== "object") return base;
  const raw = value as Record<string, unknown>;
  const str = (key: string): string =>
    typeof raw[key] === "string" ? (raw[key] as string).trim() : "";
  const out: BookItem = { ...base };
  const bookName = str("bookName");
  if (bookName) out.bookName = bookName;
  const author = str("author");
  if (author) out.author = author;
  const cover = str("cover");
  if (cover) out.cover = cover;
  const intro = str("intro");
  if (intro) out.intro = intro;
  const latest = str("latest");
  if (latest) out.latest = latest;
  const updateTime = str("updateTime");
  if (updateTime) out.updateTime = updateTime;
  const bookUrl = str("bookUrl");
  if (bookUrl) out.bookUrl = bookUrl;
  // 详情返回的标签视为完整集合；为空/缺失时沿用基础项的标签
  const tags = normalizeBookTags(raw["tags"]);
  if (tags.length > 0) out.tags = tags;
  return out;
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

/** 「加入书架」后按书源会话后台拉取封面缩略图并落盘（书源封面为可选字段）：
 *  封面缺失 / 下载失败 / 期间书被删都不影响入架，书架回退程序化封面。 */
async function attachOnlineBookCover(
  source: BookSourceSummary,
  book: LocalBook,
  coverUrl: string,
): Promise<void> {
  const referer = book.bookUrl || source.bookSourceUrl || "";
  const thumb = await loadSourceCoverThumb(source.id, coverUrl, referer);
  if (!thumb) return;
  // 等待期间书可能已被删除 / 用户已手动换封面：书还在书架才写入
  if (!bookMetaById(book.id)) return;
  await updateBookInfo(book.id, { cover: thumb });
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
  const tags = normalizeBookTags(item.tags);
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
    ...(tags.length > 0 ? { tags } : {}),
  };
  await addBookRecord(book);
  // 封面（可选）：书源返回 cover 时经书源会话下载缩略图并落盘，失败 / 无封面静默回退
  const coverUrl = (item.cover ?? "").trim();
  if (coverUrl) {
    void attachOnlineBookCover(source, book, coverUrl).catch((err) => {
      console.warn("[online] 拉取书源封面失败", err);
    });
  }
  return book;
}

// ---------------------------------------------------------------------------
// 并发拉取执行器（每本书串行 one-flight；批内按并发请求）
// ---------------------------------------------------------------------------

export type OnlineRunPhase = "idle" | "window" | "download" | "images";

/** 批量下载的图片阶段进度（正文本就绪的章节单独过一遍图片；见 runDownloadFetch） */
export interface OnlineImageProgress {
  total: number;
  done: number;
  failed: number;
}

export interface OnlineRunState {
  phase: OnlineRunPhase;
  busy: boolean;
  total: number;
  done: number;
  failed: { index: number; error: string }[];
  /** 本次拉取中仍待获取（含正在获取）的章节下标，取到正文后即移出 */
  pending: number[];
  cancelled: boolean;
  /** 图片阶段进度（其余阶段为 0） */
  images: OnlineImageProgress;
}

const EMPTY_IMAGE_PROGRESS: OnlineImageProgress = { total: 0, done: 0, failed: 0 };

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
      images: EMPTY_IMAGE_PROGRESS,
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
    images: EMPTY_IMAGE_PROGRESS,
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
 * 把一个章节的解析结果写入 chapter 对象。
 * 纯文本保持旧行为（无图片不写 blocks，避免旧读者差异；空正文标记已拉取）；
 * 含图章节只落图片地址，图片本身留到阅读时按需下载（见 chapterImages.ts）。
 */
function applyChapterBuild(chapter: LocalBookChapter, build: SourceContentBuild): void {
  if (build.hasImages) {
    chapter.paragraphs = build.paragraphs;
    chapter.blocks = build.blocks;
    return;
  }
  chapter.paragraphs = build.paragraphs;
  if (build.paragraphs.length > 0) {
    chapter.blocks = undefined;
  } else {
    chapter.blocks = [];
  }
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

// ---------------------------------------------------------------------------
// 拉取流程：窗口预取（阅读时按需补齐）与批量下载（离线全本）
//
// 共同约定（在线书含图后的大书优化）：
// - 不对整本做 structuredClone / 整本 JSON 过 IPC —— 只把本次真正写好的章节增量交给后端
//   （updateBookChapters），避免含 data URL 图片的大书反复整本拷贝（逐批下载卡顿 /
//   内存暴涨闪退的根因）；
// - 章节解析等 CPU 步骤之间让出主线程（yieldToMain），渲染与翻页不被阻塞；
// - 写入前重新取「最新的书库对象」当基底原位替换，不长期攥着旧快照。
// ---------------------------------------------------------------------------

/** 一次拉取 run 内失败的章节（下标 + 可读原因） */
type FailedChapter = { index: number; error: string };

/** 离 center 一个预取窗口（LAZY_WINDOW）之内、还没有正文的章节下标；skip 中的跳过 */
function windowMissing(
  book: Pick<LocalBook, "chapters">,
  center: number,
  skip?: ReadonlySet<number>,
): number[] {
  const lo = Math.max(0, center - LAZY_WINDOW);
  const hi = Math.min(book.chapters.length - 1, center + LAZY_WINDOW);
  const missing: number[] = [];
  for (let i = lo; i <= hi; i++) {
    if (skip?.has(i)) continue;
    if (!chapterHasContent(book.chapters[i])) missing.push(i);
  }
  // 近的先取（同距按下标升序）：center 本身永远排在最前
  missing.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
  return missing;
}

/**
 * 拉取任务的「阅读焦点」：当前正在读的章节下标。用户切章时由 ensureReadingWindow 更新，
 * 在跑的窗口预取 / 批量下载于下一批之后读取它并改以新焦点为准 —— 读到哪一章就先取哪一章，
 * 不必等它把别的章节取完（一本书同一时刻只有一个 run，此处只换优先级，不并发写书）。
 */
const windowFocus = new Map<string, number>();

/** 取回并解析一批章节（引擎失败的章节计入 failed）；解析之间让出主线程。
 *  章节地址缺失的章节直接计失败，保证返回结果与请求顺序严格对应。 */
async function fetchChapterPlans(
  bookId: string,
  sourceId: string,
  book: LocalBook,
  slice: number[],
  failed: FailedChapter[],
): Promise<BatchPlan[]> {
  const jobs: Array<{ index: number; item: ChapterItem }> = [];
  for (const idx of slice) {
    const chapter = book.chapters[idx];
    if (chapter?.url) {
      jobs.push({ index: idx, item: { chapterName: chapter.title, chapterUrl: chapter.url } });
    } else {
      failed.push({ index: idx, error: "章节缺少地址" });
    }
  }
  if (jobs.length === 0) return [];
  const results = await fetchRemoteChapterContents(
    sourceId,
    toBookItem(book),
    jobs.map((job) => job.item),
  );
  if (cancellations.has(bookId)) return [];
  const plans: BatchPlan[] = [];
  for (let offset = 0; offset < jobs.length; offset++) {
    const job = jobs[offset];
    const chapter = book.chapters[job.index];
    const res = results[offset];
    if (!chapter) continue;
    if (!res?.ok) {
      failed.push({ index: job.index, error: res?.error || "未知错误" });
      continue;
    }
    plans.push({
      chapterIndex: job.index,
      chapter,
      build: buildSourceChapterContent(res.text, chapter.url || undefined),
    });
    if (offset % 3 === 2) await yieldToMain(); // 分片解析不长时间独占主线程
  }
  return plans;
}

/** 单章：在全新的章节对象上完成解析并落盘（图片留到阅读时下载） */
function fillChapterDraft(plan: BatchPlan): LocalBookChapter {
  const draft: LocalBookChapter = {
    cid: plan.chapter.cid,
    title: plan.chapter.title,
    paragraphs: [],
    blocks: undefined,
    url: plan.chapter.url,
  };
  applyChapterBuild(draft, plan.build);
  return draft;
}

/** 把本次写好的章节落盘并原位替换书库（只把变动的章节交给后端，不整本深拷贝） */
async function persistChapters(
  bookId: string,
  patches: Array<{ index: number; chapter: LocalBookChapter }>,
): Promise<void> {
  if (patches.length === 0) return;
  const base = localBookById(bookId);
  if (!base) return;
  await updateBookChapters(patchChapters(base, patches), patches);
}

/**
 * 阅读窗口预取：把 [center ± LAZY_WINDOW] 内缺正文的章节取回来。
 *
 * 两条规则保证「正在读的那一章」不必陪跑其余预取：
 * - 该章单独请求、取回即落盘 —— 阅读器拿到本章正文就能显示，不等其余窗口章节；
 * - 其余章节按小批（约 2×书源并发）后台补齐、逐章落盘，每批之后复查 windowFocus：
 *   用户跳到别的章节就立刻转向新章（新章同样单独先取），不必等旧窗口跑完。
 */
async function runWindowFetch(bookId: string, center: number): Promise<void> {
  if (onlineRunBusy(bookId)) return;
  const initial = localBookById(bookId);
  if (!initial || !isOnlineBook(initial)) return;
  const sourceId = initial.bookSourceId!;
  const concurrency = Math.max(1, currentSourceParallel());
  // 非当前章一批取多少：吃满书源并发即可（批越小，跳章之后转向越快）
  const bulk = Math.max(1, Math.min(BATCH_SIZE, concurrency * 2));
  cancellations.delete(bookId);
  const failed: FailedChapter[] = [];
  // 本 run 已请求过的章节：失败 / 空正文的章节不在同一轮里反复重取（重试走 UI 入口）
  const attempted = new Set<number>();
  let focus = Math.max(0, Math.min(center, initial.chapters.length - 1));
  windowFocus.set(bookId, focus);
  let done = 0;
  let pending = windowMissing(initial, focus);
  patchRun(bookId, {
    phase: "window",
    busy: true,
    total: pending.length,
    done: 0,
    failed: [],
    pending,
    cancelled: false,
    images: EMPTY_IMAGE_PROGRESS,
  });
  try {
    let focusFirst = true; // 本次焦点章还没单独取过
    for (;;) {
      if (cancellations.has(bookId)) break;
      const bookNow = localBookById(bookId) ?? initial;
      const missing = windowMissing(bookNow, focus, attempted);
      if (missing.length === 0) break;
      const slice = missing.slice(0, focusFirst && missing[0] === focus ? 1 : bulk);
      focusFirst = false;
      const plans = await fetchChapterPlans(bookId, sourceId, bookNow, slice, failed);
      for (const idx of slice) attempted.add(idx);
      done += slice.length;
      // 逐章落盘：焦点章一落盘阅读器即可显示，其余章节随后陆续就位
      for (const plan of plans) {
        if (cancellations.has(bookId)) break;
        const filled = fillChapterDraft(plan);
        await persistChapters(bookId, [{ index: plan.chapterIndex, chapter: filled }]);
        if (plans.length > 1) await yieldToMain();
      }
      const latest = localBookById(bookId) ?? bookNow;
      pending = windowMissing(latest, focus, attempted);
      patchRun(bookId, { total: done + pending.length, done, failed: [...failed], pending });
      // 阅读章变了（用户跳章 / 听书跨章）：立刻改以新章为中心，新章同样单独先取
      const want = windowFocus.get(bookId);
      if (want !== undefined && want !== focus) {
        focus = Math.max(0, Math.min(want, latest.chapters.length - 1));
        focusFirst = true;
      }
    }
  } catch (err) {
    // 意外中断（磁盘 I/O 等）：清掉 busy 状态，避免该书永远卡在“获取中”
    console.error("[online] 窗口预取意外中断", err);
  } finally {
    windowFocus.delete(bookId);
    const cancelled = cancellations.has(bookId);
    cancellations.delete(bookId);
    patchRun(bookId, { phase: "idle", busy: false, pending: [], cancelled });
  }
}

/**
 * 批量下载剩余全部正文（下载按钮）：一次算好缺正文章节，按批取回、按批落盘（保持批量 I/O）。
 * 下载期间用户在阅读页读到未缓存的章节时，先把那一章单独取回，不按目录顺序排在后面。
 * 正文下完后再单独过一遍图片（runDownloadImages）：图片不与正文同时请求。
 */
async function runDownloadFetch(
  bookId: string,
  onProgress?: (state: OnlineRunState) => void,
): Promise<void> {
  if (onlineRunBusy(bookId)) return;
  const initial = localBookById(bookId);
  if (!initial || !isOnlineBook(initial)) return;
  const sourceId = initial.bookSourceId!;
  const targets: number[] = [];
  for (let i = 0; i < initial.chapters.length; i++) {
    if (!chapterHasContent(initial.chapters[i])) targets.push(i);
  }
  cancellations.delete(bookId);
  const failed: FailedChapter[] = [];
  const handled = new Set<number>();
  const syncRun = (): void => {
    patchRun(bookId, {
      done: handled.size,
      failed: [...failed],
      pending: targets.filter((i) => !handled.has(i)),
    });
  };

  /** 阅读焦点章优先：正在阅读页上未缓存的那一章先单独取回并落盘 */
  const fetchFocused = async (): Promise<void> => {
    const idx = windowFocus.get(bookId);
    if (idx === undefined || handled.has(idx) || !targets.includes(idx)) return;
    handled.add(idx);
    const plans = await fetchChapterPlans(
      bookId,
      sourceId,
      localBookById(bookId) ?? initial,
      [idx],
      failed,
    );
    const plan = plans[0];
    if (plan) {
      await persistChapters(bookId, [{ index: idx, chapter: fillChapterDraft(plan) }]);
    }
    syncRun();
  };
  try {
    if (targets.length > 0) {
      patchRun(bookId, {
        phase: "download",
        busy: true,
        total: targets.length,
        done: 0,
        failed: [],
        pending: [...targets],
        cancelled: false,
        images: EMPTY_IMAGE_PROGRESS,
      });
      for (let start = 0; start < targets.length; start += BATCH_SIZE) {
        if (cancellations.has(bookId)) break;
        // 读到哪一章就先取哪一章：不必等下载按目录顺序排到它
        await fetchFocused();
        if (cancellations.has(bookId)) break;
        const slice = targets.slice(start, start + BATCH_SIZE).filter((i) => !handled.has(i));
        if (slice.length === 0) continue;
        const bookNow = localBookById(bookId) ?? initial;
        const plans = await fetchChapterPlans(bookId, sourceId, bookNow, slice, failed);
        // 这一批的网络请求期间用户可能又读到了未缓存的章节：立即单独取回，
        // 不等本批的解析 / 写盘走完
        await fetchFocused();
        if (cancellations.has(bookId)) break;
        const patches: Array<{ index: number; chapter: LocalBookChapter }> = [];
        for (const plan of plans) {
          patches.push({ index: plan.chapterIndex, chapter: fillChapterDraft(plan) });
        }
        for (const idx of slice) handled.add(idx);
        if (patches.length > 0) await persistChapters(bookId, patches);
        syncRun();
        onProgress?.(runMap()[bookId] ?? onlineRunState(bookId));
      }
    } else {
      // 正文都已缓存：只跑图片阶段，章节计数清零（下载面板按图片进度显示）
      patchRun(bookId, {
        total: 0,
        done: 0,
        failed: [],
        pending: [],
        cancelled: false,
        images: EMPTY_IMAGE_PROGRESS,
      });
    }
    if (!cancellations.has(bookId)) await runDownloadImages(bookId, sourceId, onProgress);
  } catch (err) {
    // 意外中断（磁盘 I/O 等）：清掉 busy 状态，避免该书永远卡在“下载中”
    console.error("[online] 章节下载意外中断", err);
  } finally {
    windowFocus.delete(bookId);
    const cancelled = cancellations.has(bookId);
    cancellations.delete(bookId);
    patchRun(bookId, { phase: "idle", busy: false, pending: [], cancelled });
  }
}

/**
 * 批量下载的图片阶段：正文全部就绪后，单独把各章尚未本地化的图片过一遍。
 * 与正文分两趟跑（不与获取章节同时取图片）：图片同样经书源会话下载并写回章节，
 * 失败不计入章节失败，之后阅读该章时按占位框的「重试」再取。
 */
async function runDownloadImages(
  bookId: string,
  sourceId: string,
  onProgress?: (state: OnlineRunState) => void,
): Promise<void> {
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book)) return;
  const jobs = book.chapters
    .map((chapter, index) => ({ index, chapter, urls: pendingImageUrls(chapter) }))
    .filter((job) => job.urls.length > 0);
  if (jobs.length === 0) return;
  const total = jobs.reduce((sum, job) => sum + job.urls.length, 0);
  let done = 0;
  let failedImages = 0;
  const sync = (): void => {
    patchRun(bookId, { phase: "images", images: { total, done, failed: failedImages } });
  };
  // 注意：章节计数（total / done / failed / pending）此时保持正文阶段的结果，
  // 图片进度单独放在 images 里 —— 下载面板按阶段显示，完成后汇总两者。
  patchRun(bookId, {
    phase: "images",
    busy: true,
    pending: [],
    images: { total, done: 0, failed: 0 },
  });
  for (const job of jobs) {
    if (cancellations.has(bookId)) break;
    const results = await ensureChapterImages({
      sourceId,
      bookId,
      referer: job.chapter.url ?? null,
      urls: job.urls,
      force: true,
      shouldStop: () => cancellations.has(bookId),
    });
    if (cancellations.has(bookId)) break;
    const ready = new Map<string, ChapterImageFile>();
    for (const [url, file] of results) {
      if (file) ready.set(url, file);
      else failedImages++;
    }
    done += job.urls.length;
    await persistReadyImages(bookId, job.index, ready);
    sync();
    onProgress?.(runMap()[bookId] ?? onlineRunState(bookId));
  }
}

/** 阅读窗口预取：确保 [idx ± LAZY_WINDOW] 内章节有正文（当前章优先）。
 *  已有拉取任务在跑时不新起一轮，只把焦点换成新的阅读章：窗口预取会在下一批之后以本章
 *  为中心继续，批量下载也会把本章提前取回 —— 读到哪一章就先出哪一章，不必等别的章节。 */
export async function ensureReadingWindow(
  bookId: string,
  chapterIndex: number,
): Promise<void> {
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book)) return;
  const run = onlineRunState(bookId);
  if (run.busy) {
    if (run.phase !== "idle") windowFocus.set(bookId, chapterIndex);
    return;
  }
  if (windowMissing(book, chapterIndex).length === 0) return;
  await runWindowFetch(bookId, chapterIndex);
}

/** 批量下载剩余全部正文（下载按钮） */
export async function downloadRemainingChapters(
  bookId: string,
  onProgress?: (state: OnlineRunState) => void,
): Promise<void> {
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book)) return;
  await runDownloadFetch(bookId, onProgress);
}

// ---------------------------------------------------------------------------
// 阅读时按需下载正文图片（拉正文阶段只存地址，见 chapterImages.ts）
// ---------------------------------------------------------------------------

/**
 * 章节里还没本地化的图片地址（去重、保序）。
 * 只认 img 块的 remote（在线图片身份）：已经写好本地副本（`local`）的不再请求。
 */
function pendingImageUrls(chapter: LocalBookChapter): string[] {
  const blocks = chapter.blocks;
  if (!blocks || blocks.length === 0) return [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.kind !== "img") continue;
    const remote = block.remote;
    if (!remote || block.local) continue;
    if (seen.has(remote)) continue;
    seen.add(remote);
    urls.push(remote);
  }
  return urls;
}

/**
 * 把本次下载好的图片写回章节：只补上本地副本引用（`local`），**不动 src / remote**。
 * src 保持网络地址、remote 保持图片身份，因此：
 * - 书籍 JSON 体积与图片字节无关（Rust 侧文件才是图片本体）；
 * - 图片身份不变 → 阅读器的「当前章内容等价」判定不受影响，不会因下图触发整章重排。
 * 一次写盘（只提交本章）。
 */
async function persistReadyImages(
  bookId: string,
  chapterIndex: number,
  ready: ReadonlyMap<string, ChapterImageFile>,
): Promise<void> {
  if (ready.size === 0) return;
  const base = localBookById(bookId);
  const chapter = base?.chapters[chapterIndex];
  if (!base || !chapter?.blocks) return;
  let changed = false;
  const blocks = chapter.blocks.map((block): ChapterBlock => {
    if (block.kind !== "img" || !block.remote) return block;
    const file = ready.get(block.remote);
    if (!file || block.local === file.local) return block;
    changed = true;
    return { ...block, local: file.local };
  });
  if (!changed) return;
  const next: LocalBookChapter = { ...chapter, blocks };
  await persistChapters(bookId, [{ index: chapterIndex, chapter: next }]);
}

/**
 * 阅读时备好一章的图片：经书源会话逐张下载（图片由 Rust 落成本地文件），
 * 成功即把本地副本文件名写回本地书库（离线可读、不再重复请求）。
 * 返回「地址 → 本地副本」（失败为 null），供分页按真实尺寸排版。
 * shouldStop 用于「用户已离开这一章」时放弃还没发出的请求（已发出的等它结束，结果照常缓存）。
 */
export async function loadReadingChapterImages(
  bookId: string,
  chapterIndex: number,
  shouldStop?: () => boolean,
): Promise<Map<string, ChapterImageFile | null>> {
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book)) return new Map();
  const chapter = book.chapters[chapterIndex];
  if (!chapter) return new Map();
  const urls = pendingImageUrls(chapter);
  if (urls.length === 0) return new Map();
  const results = await ensureChapterImages({
    sourceId: book.bookSourceId!,
    bookId,
    referer: chapter.url ?? null,
    urls,
    ...(shouldStop ? { shouldStop } : {}),
  });
  const ready = new Map<string, ChapterImageFile>();
  for (const [url, file] of results) {
    if (file) ready.set(url, file);
  }
  await persistReadyImages(bookId, chapterIndex, ready);
  return results;
}

/** 阅读页「重试」单张图片：忽略自动重试冷却立即重取，成功即写回本地书库 */
export async function retryReadingImage(
  bookId: string,
  chapterIndex: number,
  url: string,
): Promise<ChapterImageFile | null> {
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book) || !url) return null;
  const chapter = book.chapters[chapterIndex];
  const file = await retryChapterImage(book.bookSourceId!, bookId, url, chapter?.url ?? null);
  if (file) await persistReadyImages(bookId, chapterIndex, new Map([[url, file]]));
  return file;
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
    images: EMPTY_IMAGE_PROGRESS,
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
    applyChapterBuild(draft, build);
    if (cancellations.has(bookId)) {
      cancellations.delete(bookId);
      settle({ cancelled: true });
      return { applied: false, cancelled: true };
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
  const tags = normalizeBookTags(book.tags);
  const item: BookItem = {
    bookName: book.title,
    ...(book.author && book.author !== "佚名" ? { author: book.author } : {}),
    bookUrl: book.bookUrl,
    ...(tags.length > 0 ? { tags } : {}),
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

// ---------------------------------------------------------------------------
// 在线书「重新拉取书籍信息」（书籍详情页）：
// 以书架里保存的标题 / 作者 / 书源地址为入参，重调书源「详情」（bookDetail），
// 把书源返回的非空简介与封面重新写回书架（简介 / 封面为缺失或与当前一致时不写）。
// 封面 URL 与「加入书架」同一套规则：经该书源会话下载压缩为缩略图 data URL。
// ---------------------------------------------------------------------------

export interface RefreshOnlineBookInfoResult {
  /** 简介是否被书源返回的新内容覆盖 */
  introUpdated: boolean;
  /** 封面是否被书源返回的新封面覆盖 */
  coverUpdated: boolean;
}

/** 在线书重新拉取书籍信息（简介 / 封面）；非在线书或书源不可用时抛可读错误 */
export async function refreshOnlineBookInfo(
  bookId: string,
): Promise<RefreshOnlineBookInfoResult> {
  const meta = bookMetaById(bookId);
  if (!meta || !isOnlineBook(meta) || !meta.bookSourceId || !meta.bookUrl) {
    throw new Error("仅在线书支持重新拉取书籍信息");
  }
  await ensureBookSourcesLoaded();
  const source = bookSourceSummaryById(meta.bookSourceId);
  if (!source) throw new Error("该书源已删除，无法重新拉取");
  if (!source.enabled) throw new Error("该书源已停用，请先在「书源」中启用");
  if (!source.capabilities.detail) {
    throw new Error("该书源未启用「详情」能力，无法重新拉取简介与封面");
  }
  const tags = normalizeBookTags(meta.tags);
  const item: BookItem = {
    bookName: meta.title,
    ...(meta.author && meta.author !== "佚名" ? { author: meta.author } : {}),
    bookUrl: meta.bookUrl,
    ...(tags.length > 0 ? { tags } : {}),
  };
  const result = await callRemoteSource(source.id, "bookDetail", [item]);
  if (!result.ok) throw new Error(result.error ?? "拉取书籍信息失败");
  const merged = mergeBookDetail(item, result.value);

  let introUpdated = false;
  let coverUpdated = false;
  const intro = merged.intro?.trim();
  if (intro && intro !== (meta.intro ?? "").trim()) {
    introUpdated = true;
    await updateBookInfo(bookId, { intro });
  }
  const coverUrl = merged.cover?.trim();
  if (coverUrl) {
    const referer = meta.bookUrl || source.bookSourceUrl || "";
    const thumb = await loadSourceCoverThumb(source.id, coverUrl, referer);
    if (thumb && thumb !== meta.cover) {
      coverUpdated = true;
      await updateBookInfo(bookId, { cover: thumb });
    }
  }
  return { introUpdated, coverUpdated };
}

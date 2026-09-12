/**
 * 在线书会话与内容缓存：
 * - 书源搜索/发现命中的“待预览书”暂存（会话级）；
 * - 「加入书架」= 只落 toc 元数据的本地书（format: online），正文按需下载；
 * - 阅读时按「当前章 ±5 章」窗口预取并落盘（逐批写回同一本 LocalBook）：
 *   正在读的那一章单独先取、取回即落盘，其余窗口章节后台补齐；
 *   正文预取完毕后再单独过一遍窗口内**已下载章节**的图片（失败即放弃，读到该章时再取，
 *   见 prefetchWindowImages）；
 * - 显式批量下载剩余全部正文（并发可配、可取消）：正文下完后单独再过一遍图片；
 * - 以上三种拉取（窗口预取 / 批量下载 / 重新加载本章）可并存且互不阻塞，冲突时以用户
 *   操作为准：批量下载开始时后台窗口预取让位，正文回写先到先得（只有「重新加载本章」
 *   能覆盖已有正文），目录覆盖更新推进「目录世代」让按旧下标在飞的回写作废。
 */
import { createSignal } from "solid-js";
import {
  callRemoteSource,
  fetchRemoteChapterContents,
} from "./backend";
import {
  chapterImagePhase,
  chapterImagePrefetchable,
  ensureChapterImages,
  retryChapterImage,
  type ChapterImageFile,
} from "./chapterImages";
import {
  addBookRecord,
  bookMetaById,
  localBookById,
  updateBookChapterInPlace,
  updateBookChapters,
  updateBookContent,
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

/** 按下标判断某章是否已有正文（目录可能刚被覆盖更新：越界下标一律视为「没有」） */
function chapterHasContentAt(book: Pick<LocalBook, "chapters">, index: number): boolean {
  const chapter = book.chapters[index];
  return !!chapter && chapterHasContent(chapter);
}

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
// 并发拉取执行器：同一本书上的三种拉取可以并存，冲突时一律以用户操作为准
// - 后台窗口预取：阅读时按需补齐「当前章 ± LAZY_WINDOW」；
// - 用户批量下载（下载面板）：开始时后台窗口预取立刻让位 —— 用户操作优先，且它本就
//   覆盖窗口范围内的章节，并按「阅读焦点」优先取回正在读的那一章，无需两处重复请求；
// - 用户单章重载（重新加载本章）：与其余拉取并存，期间其余拉取跳过这一章。
// 书库回写侧的冲突规则：正文先到先得（只有「重新加载本章」能覆盖已有正文）；
// 目录覆盖更新推进「目录世代」，此前发出、随后才回来的正文回写按旧下标丢弃。
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

const IDLE_RUN_STATE: OnlineRunState = {
  phase: "idle",
  busy: false,
  total: 0,
  done: 0,
  failed: [],
  pending: [],
  cancelled: false,
  images: EMPTY_IMAGE_PROGRESS,
};

/** 一次拉取的取消令牌（同一本书的不同拉取各持一枚，互不牵连） */
interface CancelToken {
  cancelled: boolean;
}

/** 一次正文拉取的进度（窗口预取 / 批量下载各占一个槽位，可并存） */
interface RunSlot {
  phase: Exclude<OnlineRunPhase, "idle">;
  total: number;
  done: number;
  pending: number[];
  cancelled: boolean;
  images: OnlineImageProgress;
  /** 是否仍在跑；结束后保留结果（下载面板据此显示「上次有 N 章失败」） */
  active: boolean;
  /** 启动序号：没有活动任务时取最近启动的一次作为显示来源 */
  seq: number;
  token: CancelToken;
}

interface BookRuns {
  /** 后台窗口预取（阅读时按需补齐） */
  window: RunSlot | null;
  /** 用户批量下载（下载面板「下载剩余全部」） */
  download: RunSlot | null;
  /** 正在「重新加载本章」的章节（用户操作；其余拉取跳过它） */
  reload: { index: number; token: CancelToken } | null;
  /** 各章最近一次拉取失败原因（三种拉取共同记录，新一轮拉取开始时清空） */
  failures: Map<number, string>;
  /** 目录世代：目录被覆盖更新时 +1，早先发出的正文回写据此丢弃 */
  epoch: number;
  /** run 启动序号计数 */
  seq: number;
}

function emptyRuns(): BookRuns {
  return { window: null, download: null, reload: null, failures: new Map(), epoch: 0, seq: 0 };
}

const [runMap, setRunMap] = createSignal<Record<string, BookRuns>>({});

/** 该书的拉取运行态（无记录时给空态；只读快照） */
function runsOf(bookId: string): BookRuns {
  return runMap()[bookId] ?? emptyRuns();
}

function patchRuns(bookId: string, patch: (runs: BookRuns) => BookRuns): void {
  const all = runMap();
  setRunMap({ ...all, [bookId]: patch(all[bookId] ?? emptyRuns()) });
}

function patchSlot(bookId: string, kind: "window" | "download", patch: Partial<RunSlot>): void {
  patchRuns(bookId, (runs) => {
    const slot = runs[kind];
    if (!slot) return runs;
    const next = { ...slot, ...patch };
    return kind === "window" ? { ...runs, window: next } : { ...runs, download: next };
  });
}

/** 最近启动的一次拉取（没有活动任务时的显示来源） */
function latestSlot(runs: BookRuns): RunSlot | null {
  const slots: RunSlot[] = [];
  if (runs.download) slots.push(runs.download);
  if (runs.window) slots.push(runs.window);
  if (slots.length === 0) return null;
  return slots.reduce((a, b) => (b.seq > a.seq ? b : a));
}

/**
 * 该书的拉取状态（UI 只读这一份）：
 * - 有活动任务时按「用户批量下载 > 后台窗口预取」取用进度；没有活动任务时沿用最近一次
 *   的结果（失败 / 取消记录得以保留，供下载面板与正文 gate 显示，「重新加载本章」不占此口径）；
 * - pending 是各活动任务的并集（目录「下载中」徽标用），failed 汇集三种拉取的失败章节。
 */
export function onlineRunState(bookId: string): OnlineRunState {
  const runs = runMap()[bookId];
  if (!runs) return IDLE_RUN_STATE;
  const active: RunSlot[] = [];
  if (runs.download?.active) active.push(runs.download);
  if (runs.window?.active) active.push(runs.window);
  const pick = active[0] ?? latestSlot(runs);
  const failed = [...runs.failures.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, error]) => ({ index, error }));
  if (!pick) return { ...IDLE_RUN_STATE, failed };
  const pendingSet = new Set<number>();
  for (const slot of active) {
    for (const index of slot.pending) pendingSet.add(index);
  }
  return {
    phase: active.length > 0 ? pick.phase : "idle",
    busy: active.length > 0,
    total: pick.total,
    done: pick.done,
    failed,
    pending: [...pendingSet].sort((a, b) => a - b),
    cancelled: pick.cancelled,
    images: pick.images,
  };
}

/** 该书是否有正文拉取在跑（窗口预取 / 批量下载；不含「重新加载本章」） */
export function onlineRunBusy(bookId: string): boolean {
  const runs = runMap()[bookId];
  return !!runs && ((runs.window?.active ?? false) || (runs.download?.active ?? false));
}

/** 该书的用户批量下载是否在跑（下载面板显示进度、按钮据此禁用） */
export function onlineDownloadActive(bookId: string): boolean {
  return runMap()[bookId]?.download?.active ?? false;
}

/** 该书是否正在「重新加载本章」（用户单章重取） */
export function onlineReloadActive(bookId: string): boolean {
  return (runMap()[bookId]?.reload ?? null) !== null;
}

/** 该章是否有已知的拉取失败原因（正文 gate 显示失败详情用） */
export function onlineChapterFailure(bookId: string, index: number): string | null {
  return runMap()[bookId]?.failures.get(index) ?? null;
}

// ---------------------------------------------------------------------------
// 取消入口（各拉取互不牵连：停止批量下载不会顺手打断窗口预取，反之亦然）
// ---------------------------------------------------------------------------

function cancelSlot(bookId: string, kind: "window" | "download"): void {
  const slot = runMap()[bookId]?.[kind];
  if (!slot?.active) return;
  slot.token.cancelled = true;
  patchSlot(bookId, kind, { cancelled: true, pending: [] });
}

/** 停止后台窗口预取（不再取新章节；在飞请求的结果按取消丢弃） */
export function cancelBackgroundFetch(bookId: string): void {
  cancelSlot(bookId, "window");
}

/** 停止用户批量下载（下载面板「停止下载」） */
export function cancelChapterDownload(bookId: string): void {
  cancelSlot(bookId, "download");
}

/** 取消正在进行的「重新加载本章」 */
export function cancelChapterReload(bookId: string): void {
  const reload = runMap()[bookId]?.reload;
  if (!reload) return;
  reload.token.cancelled = true;
  patchRuns(bookId, (runs) =>
    runs.reload?.token === reload.token ? { ...runs, reload: null } : runs,
  );
}

/** 停止该书的全部章节拉取（返回书架 / 离开阅读页等场景） */
export function cancelOnlineRun(bookId: string): void {
  cancelBackgroundFetch(bookId);
  cancelChapterDownload(bookId);
  cancelChapterReload(bookId);
}

// ---------------------------------------------------------------------------
// 运行态维护
// ---------------------------------------------------------------------------

/** 启动一次拉取：返回该次拉取的取消令牌（进度经 patchSlot 更新）。
 *  options.resetFailures=false 用于「只补图片、不取正文」的一轮：不动已有的章节失败记录
 *  （否则别处失败章节的「N 章失败」会凭空消失）。 */
function startRun(
  bookId: string,
  kind: "window" | "download",
  phase: Exclude<OnlineRunPhase, "idle">,
  total: number,
  pending: number[],
  options?: { resetFailures?: boolean },
): CancelToken {
  const resetFailures = options?.resetFailures ?? true;
  const token: CancelToken = { cancelled: false };
  patchRuns(bookId, (runs) => {
    const seq = runs.seq + 1;
    const slot: RunSlot = {
      phase,
      total,
      done: 0,
      pending,
      cancelled: false,
      images: EMPTY_IMAGE_PROGRESS,
      active: true,
      seq,
      token,
    };
    // 新一轮正文拉取从零计失败；只补图片的一轮沿用已有失败记录；目录世代沿用
    const failures = resetFailures ? new Map<number, string>() : runs.failures;
    return kind === "window"
      ? { ...runs, seq, failures, window: slot }
      : { ...runs, seq, failures, download: slot };
  });
  return token;
}

/** 收尾一次拉取：保留结果但标记为非活动 */
function finishRun(
  bookId: string,
  kind: "window" | "download",
  patch: Partial<RunSlot>,
): void {
  patchSlot(bookId, kind, { ...patch, active: false, pending: [] });
}

/** 记录某章拉取失败原因（三种拉取共用） */
function markFailure(bookId: string, index: number, error: string): void {
  patchRuns(bookId, (runs) => {
    const failures = new Map(runs.failures);
    failures.set(index, error);
    return { ...runs, failures };
  });
}

/** 清掉若干章节的失败记录（这些章已取回正文） */
function clearFailures(bookId: string, indexes: readonly number[]): void {
  patchRuns(bookId, (runs) => {
    if (indexes.every((index) => !runs.failures.has(index))) return runs;
    const failures = new Map(runs.failures);
    for (const index of indexes) failures.delete(index);
    return { ...runs, failures };
  });
}

/** 当前目录世代（在飞的正文回写按它判断下标是否仍然有效） */
function tocEpochOf(bookId: string): number {
  return runsOf(bookId).epoch;
}

/** 目录覆盖更新：推进世代，让按旧下标在飞的正文回写失效（旧下标的失败记录一并清空） */
function bumpTocEpoch(bookId: string): void {
  patchRuns(bookId, (runs) => ({ ...runs, epoch: runs.epoch + 1, failures: new Map() }));
}

/** 目录整体重排前停掉在跑的正文拉取（用户操作优先；在飞结果由目录世代兜底丢弃） */
function stopChapterFetches(bookId: string): void {
  cancelBackgroundFetch(bookId);
  cancelChapterDownload(bookId);
  cancelChapterReload(bookId);
}

/** 其余拉取要跳过的章节：正在「重新加载本章」的那一章由用户独占 */
function reloadSkipSet(bookId: string): ReadonlySet<number> | undefined {
  const index = runMap()[bookId]?.reload?.index;
  return index === undefined ? undefined : new Set([index]);
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

// ---------------------------------------------------------------------------
// 拉取流程：窗口预取（阅读时按需补齐）与批量下载（离线全本）
//
// 共同约定（在线书含图后的大书优化）：
// - 不对整本做 structuredClone / 整本 JSON 过 IPC —— 只把本次真正写好的章节增量交给后端
//   （updateBookChapters），避免含 data URL 图片的大书反复整本拷贝（逐批下载卡顿 /
//   内存暴涨闪退的根因）；
// - 章节解析等 CPU 步骤之间让出主线程（yieldToMain），渲染与翻页不被阻塞；
// - 写入由 books.ts 按书排队串行，并在队列内以「最新缓存 + 最新目录」复核后套用补丁，
//   因此多路拉取并发时不会互相覆盖、也不会按旧下标写错章节。
// ---------------------------------------------------------------------------

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
 * 不必等它把别的章节取完（焦点只换优先级，不改变「谁在写书」）。
 */
const windowFocus = new Map<string, number>();

/** 取回并解析一批章节（引擎失败的章节记为失败）；解析之间让出主线程。
 *  章节地址缺失的章节直接计失败，保证返回结果与请求顺序严格对应。 */
async function fetchChapterPlans(
  bookId: string,
  sourceId: string,
  book: LocalBook,
  slice: number[],
  token: CancelToken,
): Promise<BatchPlan[]> {
  const jobs: Array<{ index: number; item: ChapterItem }> = [];
  for (const idx of slice) {
    const chapter = book.chapters[idx];
    if (chapter?.url) {
      jobs.push({ index: idx, item: { chapterName: chapter.title, chapterUrl: chapter.url } });
    } else {
      markFailure(bookId, idx, "章节缺少地址");
    }
  }
  if (jobs.length === 0) return [];
  const results = await fetchRemoteChapterContents(
    sourceId,
    toBookItem(book),
    jobs.map((job) => job.item),
  );
  if (token.cancelled) return [];
  const plans: BatchPlan[] = [];
  for (let offset = 0; offset < jobs.length; offset++) {
    const job = jobs[offset];
    const chapter = book.chapters[job.index];
    const res = results[offset];
    if (!chapter) continue;
    if (!res?.ok) {
      markFailure(bookId, job.index, res?.error || "未知错误");
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

/**
 * 把本次取回的章节落盘并原位替换书库（只把变动的章节交给后端，不整本深拷贝）。
 * 并发拉取下的冲突规则：
 * - 目录世代变了（目录被覆盖更新）→ 本批结果按旧下标已无意义，整批丢弃；
 * - 正文先到先得：目标章已有正文（别的任务刚写回 / 用户刚重载过）就跳过；
 *   overwrite 只由用户显式的「重新加载本章」置位。
 * 校验在写入队列内执行（见 books.ts），因此与并发写入不会交错。
 * 返回实际写入的章节数。
 */
async function persistChapters(
  bookId: string,
  patches: Array<{ index: number; chapter: LocalBookChapter }>,
  options: { epoch: number; overwrite?: boolean },
): Promise<number> {
  if (patches.length === 0) return 0;
  const overwrite = !!options.overwrite;
  return await updateBookChapters(bookId, patches, (update, latest) => {
    if (tocEpochOf(bookId) !== options.epoch) return false;
    const current = latest.chapters[update.index];
    if (!current) return false;
    return overwrite || !chapterHasContent(current);
  });
}

/**
 * 阅读窗口预取：把 [center ± LAZY_WINDOW] 内缺正文的章节取回来；正文齐了之后接着
 * 预取窗口内**已下载章节**的图片（见 prefetchWindowImages）。
 *
 * 两条规则保证「正在读的那一章」不必陪跑其余预取：
 * - 该章单独请求、取回即落盘 —— 阅读器拿到本章正文就能显示，不等其余窗口章节；
 * - 其余章节按小批（约 2×书源并发）后台补齐、逐章落盘，每批之后复查 windowFocus：
 *   用户跳到别的章节就立刻转向新章（新章同样单独先取），不必等旧窗口跑完。
 *
 * 用户操作优先：批量下载一开始就让位（见 runDownloadFetch），「重新加载本章」进行中的
 * 那一章跳过不取，用户随时可以发起这两个操作。
 */
async function runWindowFetch(bookId: string, center: number): Promise<void> {
  if (onlineRunBusy(bookId)) return;
  const initial = localBookById(bookId);
  if (!initial || !isOnlineBook(initial)) return;
  const sourceId = initial.bookSourceId!;
  const epoch = tocEpochOf(bookId);
  const concurrency = Math.max(1, currentSourceParallel());
  // 非当前章一批取多少：吃满书源并发即可（批越小，跳章之后转向越快）
  const bulk = Math.max(1, Math.min(BATCH_SIZE, concurrency * 2));
  // 本 run 已请求过的章节：失败 / 空正文的章节不在同一轮里反复重取（重试走 UI 入口）
  const attempted = new Set<number>();
  let focus = Math.max(0, Math.min(center, initial.chapters.length - 1));
  const targets = windowMissing(initial, focus, reloadSkipSet(bookId));
  const textWork = targets.length > 0;
  // 纯图片预取（正文早已就绪）不动已有的失败记录：那是「正文下载」的结论，不该被抹掉
  const token = startRun(
    bookId,
    "window",
    textWork ? "window" : "images",
    targets.length,
    targets,
    { resetFailures: textWork },
  );
  windowFocus.set(bookId, focus);
  let done = 0;
  let pending = targets;
  patchSlot(bookId, "window", { total: pending.length, pending });
  try {
    let focusFirst = true; // 本次焦点章还没单独取过
    for (;;) {
      if (token.cancelled) break;
      const bookNow = localBookById(bookId);
      if (!bookNow) break; // 书已被删除：停止拉取
      const skipped = reloadSkipSet(bookId);
      const skip = skipped ? new Set([...attempted, ...skipped]) : attempted;
      const missing = windowMissing(bookNow, focus, skip);
      if (missing.length === 0) {
        // 正文预取完毕 → 接着预取窗口内已下载章节的图片。
        // 图片预取期间用户可能跳到缺正文的章节：焦点一变就回来取正文（见下）
        const moved = await prefetchWindowImages(bookId, sourceId, token, focus);
        if (moved) {
          // 回到正文预取：阶段复位（图片进度下一轮重新统计）
          patchSlot(bookId, "window", { phase: "window", images: EMPTY_IMAGE_PROGRESS });
        } else {
          break;
        }
      } else {
        const slice = missing.slice(0, focusFirst && missing[0] === focus ? 1 : bulk);
        focusFirst = false;
        const plans = await fetchChapterPlans(bookId, sourceId, bookNow, slice, token);
        for (const idx of slice) attempted.add(idx);
        done += slice.length;
        // 逐章落盘：焦点章一落盘阅读器即可显示，其余章节随后陆续就位
        for (const plan of plans) {
          if (token.cancelled) break;
          const filled = fillChapterDraft(plan);
          const written = await persistChapters(
            bookId,
            [{ index: plan.chapterIndex, chapter: filled }],
            { epoch },
          );
          if (written > 0) clearFailures(bookId, [plan.chapterIndex]);
          if (plans.length > 1) await yieldToMain();
        }
      }
      const latest = localBookById(bookId);
      if (!latest) break; // 书已被删除：停止拉取
      const skippedNow = reloadSkipSet(bookId);
      pending = windowMissing(
        latest,
        focus,
        skippedNow ? new Set([...attempted, ...skippedNow]) : attempted,
      );
      patchSlot(bookId, "window", { total: done + pending.length, done, pending });
      // 阅读章变了（用户跳章 / 听书跨章）：立刻改以新章为中心，新章同样单独先取
      const want = windowFocus.get(bookId);
      if (want !== undefined && want !== focus) {
        focus = Math.max(0, Math.min(want, latest.chapters.length - 1));
        focusFirst = true;
      }
    }
  } catch (err) {
    // 意外中断（磁盘 I/O 等）：收尾清掉活动状态，避免该书永远卡在“获取中”
    console.error("[online] 窗口预取意外中断", err);
  } finally {
    // 焦点留给接手的批量下载继续用（它靠这个焦点优先取回正在读的章节）
    if (!onlineDownloadActive(bookId)) windowFocus.delete(bookId);
    finishRun(bookId, "window", { done, cancelled: token.cancelled });
  }
}

/** 一次批量下载的结果（调用方据此提示，不必去读可能已被下一轮拉取覆盖的全局状态） */
export interface OnlineDownloadSummary {
  /** 用户中途停止 */
  cancelled: boolean;
  /** 本次取回的章节数（含被其它任务抢先写回的章节） */
  done: number;
  /** 结束时仍失败的章节数 */
  failedChapters: number;
  /** 图片阶段进度 */
  images: OnlineImageProgress;
}

/**
 * 批量下载剩余全部正文（下载面板「下载剩余全部」）：一次算好缺正文章节，按批取回、按批落盘。
 *
 * 用户操作优先：开始时后台窗口预取立刻让位（它覆盖的窗口范围本就在本次目标里，且本次会按
 * 「阅读焦点」优先取回正在读的那一章），因此两者不会重复请求同一批章节；下载期间用户读到
 * 未缓存的章节时，那一章同样单独先取回，不按目录顺序排在后面。正文下完后再单独过一遍图片。
 * 已有同种任务在跑时返回 null（不重复发起）。
 */
async function runDownloadFetch(bookId: string): Promise<OnlineDownloadSummary | null> {
  if (onlineDownloadActive(bookId)) return null;
  const initial = localBookById(bookId);
  if (!initial || !isOnlineBook(initial)) return null;
  const sourceId = initial.bookSourceId!;
  const epoch = tocEpochOf(bookId);
  cancelBackgroundFetch(bookId); // 用户操作优先：后台窗口预取让位
  const token = startRun(bookId, "download", "download", 0, []);
  const targets: number[] = [];
  for (let i = 0; i < initial.chapters.length; i++) {
    if (!chapterHasContent(initial.chapters[i])) targets.push(i);
  }
  const targetSet = new Set(targets);
  const handled = new Set<number>();
  /** 目标里已有正文（本次取回 / 别的任务抢先写回 / 用户重载完成）的章节数 */
  let settled = 0;
  const syncRun = (): void => {
    const bookNow = localBookById(bookId) ?? initial;
    const pending: number[] = [];
    let done = 0;
    for (const i of targets) {
      if (!handled.has(i) && !chapterHasContentAt(bookNow, i)) pending.push(i);
      else done++;
    }
    settled = done;
    patchSlot(bookId, "download", { done, pending });
  };

  /** 这一章此刻是否还需要取（已由别的任务写回 / 正在被用户重载则跳过） */
  const needsFetch = (book: LocalBook, index: number): boolean => {
    if (handled.has(index) || !targetSet.has(index)) return false;
    if (runMap()[bookId]?.reload?.index === index) return false;
    return !chapterHasContentAt(book, index);
  };

  /** 阅读焦点章优先：正在阅读页上未缓存的那一章先单独取回并落盘 */
  const fetchFocused = async (): Promise<void> => {
    const idx = windowFocus.get(bookId);
    if (idx === undefined) return;
    const bookNow = localBookById(bookId);
    if (!bookNow) return; // 书已被删除：停止拉取
    if (!needsFetch(bookNow, idx)) return;
    handled.add(idx);
    const plans = await fetchChapterPlans(bookId, sourceId, bookNow, [idx], token);
    const plan = plans[0];
    if (plan) {
      const written = await persistChapters(
        bookId,
        [{ index: idx, chapter: fillChapterDraft(plan) }],
        { epoch },
      );
      if (written > 0) clearFailures(bookId, [idx]);
    }
    syncRun();
  };
  try {
    if (targets.length > 0) {
      patchSlot(bookId, "download", { total: targets.length, pending: [...targets] });
      for (let start = 0; start < targets.length; start += BATCH_SIZE) {
        if (token.cancelled) break;
        // 读到哪一章就先取哪一章：不必等下载按目录顺序排到它
        await fetchFocused();
        if (token.cancelled) break;
        const bookNow = localBookById(bookId);
        if (!bookNow) break; // 书已被删除：停止拉取
        const slice = targets
          .slice(start, start + BATCH_SIZE)
          .filter((i) => needsFetch(bookNow, i));
        if (slice.length === 0) continue;
        const plans = await fetchChapterPlans(bookId, sourceId, bookNow, slice, token);
        // 这一批的网络请求期间用户可能又读到了未缓存的章节：立即单独取回，
        // 不等本批的解析 / 写盘走完
        await fetchFocused();
        if (token.cancelled) break;
        const patches: Array<{ index: number; chapter: LocalBookChapter }> = [];
        for (const plan of plans) {
          patches.push({ index: plan.chapterIndex, chapter: fillChapterDraft(plan) });
        }
        for (const idx of slice) handled.add(idx);
        const writtenIndexes = patches.map((patch) => patch.index);
        if (patches.length > 0) await persistChapters(bookId, patches, { epoch });
        clearFailures(bookId, writtenIndexes);
        syncRun();
      }
    } else {
      // 正文都已缓存：只跑图片阶段，章节计数清零（下载面板按图片进度显示）
      patchSlot(bookId, "download", { total: 0, done: 0, pending: [] });
    }
    if (!token.cancelled) await runDownloadImages(bookId, sourceId, token);
  } catch (err) {
    // 意外中断（磁盘 I/O 等）：收尾清掉活动状态，避免该书永远卡在“下载中”
    console.error("[online] 章节下载意外中断", err);
  } finally {
    windowFocus.delete(bookId);
    finishRun(bookId, "download", { done: settled, cancelled: token.cancelled });
  }
  return {
    cancelled: token.cancelled,
    done: settled,
    failedChapters: runsOf(bookId).failures.size,
    images: runsOf(bookId).download?.images ?? EMPTY_IMAGE_PROGRESS,
  };
}

/**
 * 批量下载的图片阶段：正文全部就绪后，单独把各章尚未本地化的图片过一遍。
 * 与正文分两趟跑（不与获取章节同时取图片）：图片同样经书源会话下载并写回章节，
 * 失败不计入章节失败，之后阅读该章时按占位框的「重试」再取。
 */
async function runDownloadImages(
  bookId: string,
  sourceId: string,
  token: CancelToken,
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
    patchSlot(bookId, "download", {
      phase: "images",
      images: { total, done, failed: failedImages },
    });
  };
  // 注意：章节计数（total / done）此时保持正文阶段的结果，
  // 图片进度单独放在 images 里 —— 下载面板按阶段显示，完成后汇总两者；
  // 正文阶段已结束，目录徽标不再显示「下载中」（pending 清空）。
  patchSlot(bookId, "download", {
    phase: "images",
    pending: [],
    images: { total, done: 0, failed: 0 },
  });
  for (const job of jobs) {
    if (token.cancelled) return;
    const results = await ensureChapterImages({
      sourceId,
      bookId,
      referer: job.chapter.url ?? null,
      urls: job.urls,
      purpose: "prefetch",
      force: true,
      shouldStop: () => token.cancelled,
    });
    if (token.cancelled) return;
    const ready = new Map<string, ChapterImageFile>();
    for (const [url, file] of results) {
      if (file) ready.set(url, file);
      else failedImages++;
    }
    done += job.urls.length;
    await persistReadyImages(bookId, job.index, ready);
    sync();
  }
}

/** 阅读窗口预取：确保 [idx ± LAZY_WINDOW] 内章节有正文（当前章优先）；
 *  正文都已就绪时改为确保窗口内已下载章节的图片（见 prefetchWindowImages）。
 *  已有拉取任务在跑时不新起一轮，只把焦点换成新的阅读章：窗口预取会在下一批之后以本章
 *  为中心继续，批量下载也会把本章提前取回 —— 读到哪一章就先出哪一章，不必等别的章节。 */
export async function ensureReadingWindow(
  bookId: string,
  chapterIndex: number,
): Promise<void> {
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book)) return;
  if (onlineRunBusy(bookId)) {
    windowFocus.set(bookId, chapterIndex);
    return;
  }
  // 正文已就绪时不再只是为了「没正文」而跑：窗口内还有没试过的图片也要跑一轮
  if (
    windowMissing(book, chapterIndex, reloadSkipSet(bookId)).length === 0 &&
    windowImageIndexes(book, chapterIndex, reloadSkipSet(bookId)).length === 0
  ) {
    return;
  }
  await runWindowFetch(bookId, chapterIndex);
}

/** 批量下载剩余全部正文（下载面板「下载剩余全部」）。
 *  已有一轮批量下载在跑时返回 null（不重复发起）；后台窗口预取会被让位，不阻塞本次下载。 */
export async function downloadRemainingChapters(
  bookId: string,
): Promise<OnlineDownloadSummary | null> {
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book)) return null;
  return await runDownloadFetch(bookId);
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
 * 写入在写队列内按**最新章节内容**合并：与「重新加载本章」并发时，图片引用会合到新正文上，
 * 而不是拿下载前的旧正文覆盖它。
 */
async function persistReadyImages(
  bookId: string,
  chapterIndex: number,
  ready: ReadonlyMap<string, ChapterImageFile>,
): Promise<void> {
  if (ready.size === 0) return;
  await updateBookChapterInPlace(bookId, chapterIndex, (chapter) => {
    if (!chapter.blocks) return null;
    let changed = false;
    const blocks = chapter.blocks.map((block): ChapterBlock => {
      if (block.kind !== "img" || !block.remote) return block;
      const file = ready.get(block.remote);
      if (!file || block.local === file.local) return block;
      changed = true;
      return { ...block, local: file.local };
    });
    return changed ? { ...chapter, blocks } : null;
  });
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
    purpose: "read",
    ...(shouldStop ? { shouldStop } : {}),
  });
  const ready = new Map<string, ChapterImageFile>();
  for (const [url, file] of results) {
    if (file) ready.set(url, file);
  }
  await persistReadyImages(bookId, chapterIndex, ready);
  return results;
}

// ---------------------------------------------------------------------------
// 后台图片预取：正文预取结束后，把阅读窗口（当前章 ± LAZY_WINDOW）内**已下载章节**
// 尚未取过的图片顺手取回来（用户读到这一章时就已经在本地了）。
// 与「阅读时取图」共用同一个下载闸与同址去重（见 chapterImages.ts），因此不会重复请求。
// ---------------------------------------------------------------------------

/** 章节里「本会话还没试过」的图片地址：预取只取这些（失败过的等读到这一章再取，见 chapterImages） */
function prefetchableImageUrls(chapter: LocalBookChapter): string[] {
  return pendingImageUrls(chapter).filter((url) => chapterImagePrefetchable(url));
}

/**
 * 离 center 一个预取窗口之内、正文已就绪且还有「没试过的图片」的章节下标；近的先取。
 * 没有正文的章节连图片地址都还没有（等正文取回后自然会轮到它），因此不进这个列表；
 * skip 中的章节跳过（正在「重新加载本章」的那一章由用户独占，等它写完再取图）。
 */
function windowImageIndexes(
  book: Pick<LocalBook, "chapters">,
  center: number,
  skip?: ReadonlySet<number>,
): number[] {
  const lo = Math.max(0, center - LAZY_WINDOW);
  const hi = Math.min(book.chapters.length - 1, center + LAZY_WINDOW);
  const indexes: number[] = [];
  for (let i = lo; i <= hi; i++) {
    if (skip?.has(i)) continue;
    const chapter = book.chapters[i];
    if (!chapter || !chapterHasContent(chapter)) continue;
    if (prefetchableImageUrls(chapter).length === 0) continue;
    indexes.push(i);
  }
  indexes.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
  return indexes;
}

/** 阅读窗口内是否还有值得预取的图片（正文已就绪的章节里本会话还没试过的图） */
export function windowImagesPending(bookId: string, chapterIndex: number): boolean {
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book)) return false;
  return windowImageIndexes(book, chapterIndex, reloadSkipSet(bookId)).length > 0;
}

/**
 * 窗口图片预取：正文预取结束后，把窗口内**已下载章节**还没试过的图片逐章取回来
 * （当前章 ±LAZY_WINDOW；读到哪一章就先取哪一章）。
 *
 * - 只取正文已就绪的章节：连正文都没取回的章节谈不上图片地址（等正文到了再取）；
 * - 失败即放弃：单张失败只计一张失败，不在本轮重试、也不计作章节失败 ——
 *   用户读到该章时阅读路径会再取一次（预取失败不挡阅读时的重取，见 chapterImages.ts），
 *   页面上还有占位框的「重试」；
 * - 期间阅读焦点变了（用户跳章 / 听书跨章）：立刻放弃剩余图片（还没发出的请求不再发），
 *   交回正文预取按新焦点走 —— 新焦点章若缺正文就先取正文；
 * - 取消（下载面板「停止下载」/ 开始批量下载 / 失败页退回书架）→ 立即停下。
 *
 * 返回 true 表示焦点已变、外层应按新焦点继续；false 表示这一轮没有别的可做了（或已取消）。
 */
async function prefetchWindowImages(
  bookId: string,
  sourceId: string,
  token: CancelToken,
  center: number,
): Promise<boolean> {
  const book = localBookById(bookId);
  if (!book) return false;
  const jobs: Array<{ index: number; urls: string[]; referer: string | null }> = [];
  let total = 0;
  for (const index of windowImageIndexes(book, center, reloadSkipSet(bookId))) {
    const chapter = book.chapters[index];
    if (!chapter) continue;
    const urls = prefetchableImageUrls(chapter);
    if (urls.length === 0) continue;
    jobs.push({ index, urls, referer: chapter.url ?? null });
    total += urls.length;
  }
  if (jobs.length === 0) return false;
  /** 阅读焦点是否已经移开：移开就放弃剩余图片，交回正文预取（新焦点章优先） */
  const focusMoved = (): boolean => {
    const want = windowFocus.get(bookId);
    return want !== undefined && want !== center;
  };
  let done = 0;
  let failed = 0;
  patchSlot(bookId, "window", {
    phase: "images",
    pending: [],
    images: { total, done: 0, failed: 0 },
  });
  for (const job of jobs) {
    if (token.cancelled || focusMoved()) break;
    const results = await ensureChapterImages({
      sourceId,
      bookId,
      referer: job.referer,
      urls: job.urls,
      purpose: "prefetch",
      shouldStop: () => token.cancelled || focusMoved(),
    });
    const ready = new Map<string, ChapterImageFile>();
    let settled = 0;
    for (const [url, file] of results) {
      if (file) {
        ready.set(url, file);
        settled++;
        continue;
      }
      // 被放弃（还没发出请求）的图会回到 idle，不算失败、也不算完成；
      // 只有真的试过并失败的才计数（下一轮 / 阅读时还会再试）
      if (chapterImagePhase(url) === "failed") {
        failed++;
        settled++;
      }
    }
    done += settled;
    // 成功的那部分照常写回书库（即使随后要放弃这一轮：字节已经下下来了，不该白下）
    await persistReadyImages(bookId, job.index, ready);
    patchSlot(bookId, "window", { images: { total, done, failed } });
  }
  return focusMoved();
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
 * 强制重新获取单个章节正文（阅读页「重新加载本章」）：
 * - 先拉取最新正文并解析，期间不动书库（成功才覆盖，失败保留旧正文）；
 * - 新正文会替换本章书签锚定的文字：通过 options.confirmRisk 交调用方询问，
 *   用户选择放弃时既不覆盖正文也不改动书签；
 * - 与其余拉取并存（用户操作不排队等待）：期间窗口预取 / 批量下载跳过这一章，
 *   本方法写入时允许覆盖已有正文（正文回写的「先到先得」规则里唯一的例外）；
 *   同一章已在重载时不重复发起。
 */
export async function reloadChapterContent(
  bookId: string,
  chapterIndex: number,
  options?: ReloadChapterOptions,
): Promise<ReloadChapterOutcome> {
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book)) return { applied: false, cancelled: false };
  const chapter = book.chapters[chapterIndex];
  if (!chapter?.url) return { applied: false, cancelled: false };
  const inflight = runMap()[bookId]?.reload ?? null;
  if (inflight) {
    return {
      applied: false,
      cancelled: false,
      error: inflight.index === chapterIndex ? "本章正在重新加载" : "已有章节正在重新加载",
    };
  }
  const sourceId = book.bookSourceId!;
  const epoch = tocEpochOf(bookId);
  const token: CancelToken = { cancelled: false };
  // 占位：其余拉取跳过这一章，避免重复请求与互相覆盖（不阻塞它们继续取别的章节）
  patchRuns(bookId, (runs) => ({ ...runs, reload: { index: chapterIndex, token } }));
  const settle = (): void => {
    patchRuns(bookId, (runs) =>
      runs.reload?.token === token ? { ...runs, reload: null } : runs,
    );
  };

  try {
    const results = await fetchRemoteChapterContents(sourceId, toBookItem(book), [
      { chapterName: chapter.title, chapterUrl: chapter.url },
    ]);
    const res = results[0];
    if (!res?.ok) {
      const error = res?.error || "获取正文失败";
      markFailure(bookId, chapterIndex, error);
      return { applied: false, cancelled: false, error };
    }
    if (token.cancelled) return { applied: false, cancelled: true };
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
        if (!proceed) return { applied: false, cancelled: true };
      }
    }
    if (token.cancelled) return { applied: false, cancelled: true };

    // 拉取期间目录可能被覆盖更新（下标含义已变）：本次结果作废，不写到别的章节上
    if (tocEpochOf(bookId) !== epoch) {
      return { applied: false, cancelled: false, error: "目录已更新，未写入本章" };
    }
    const latest = localBookById(bookId);
    if (!latest) {
      return { applied: false, cancelled: false, error: "书籍已不在书库，未重新加载" };
    }
    const target = latest.chapters[chapterIndex];
    if (!target) {
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
    const written = await persistChapters(
      bookId,
      [{ index: chapterIndex, chapter: draft }],
      { epoch, overwrite: true },
    );
    if (written === 0) {
      return { applied: false, cancelled: false, error: "目录已更新，未写入本章" };
    }
    clearFailures(bookId, [chapterIndex]);
    return { applied: true, cancelled: false };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    markFailure(bookId, chapterIndex, error);
    return { applied: false, cancelled: false, error };
  } finally {
    settle();
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
 *  写入在本书写队列内基于最新缓存构建，不会丢掉并发拉取刚写回的正文；末尾追加不动既有
 *  章节下标，因此不必打断正在跑的窗口预取 / 批量下载。返回实际追加的章节数。 */
export async function applyOnlineTocAppend(
  bookId: string,
  added: ChapterItem[],
): Promise<number> {
  if (added.length === 0) return 0;
  const next = await updateBookContent(bookId, (latest) => {
    const start = latest.chapters.length;
    const chapters = [...latest.chapters];
    for (let i = 0; i < added.length; i++) {
      const item = added[i];
      chapters.push({
        cid: chapterCid(start + i),
        title: item.chapterName,
        paragraphs: [],
        url: item.chapterUrl,
      });
    }
    return { ...latest, chapters };
  });
  return next ? added.length : 0;
}

/** 执行覆盖更新：以最新目录整本替换章节列表。
 *  章节地址未变的旧章节保留已缓存正文，其余章节正文留空（阅读时按需重新获取）。
 *  目录整体重排会让在跑的拉取「下标含义」失效：用户操作优先 —— 先停掉这些拉取，并推进
 *  目录世代，让已经发出、随后才回来的正文回写被丢弃。返回覆盖后的章节总数。 */
export async function applyOnlineTocOverwrite(
  bookId: string,
  fresh: ChapterItem[],
): Promise<number> {
  stopChapterFetches(bookId);
  bumpTocEpoch(bookId);
  const next = await updateBookContent(bookId, (latest) => {
    const oldByUrl = new Map<string, LocalBookChapter>();
    for (const ch of latest.chapters) {
      const url = (ch.url ?? "").trim();
      if (url && !oldByUrl.has(url)) oldByUrl.set(url, ch);
    }
    return {
      ...latest,
      chapters: fresh.map((item, index) => {
        const carried = oldByUrl.get((item.chapterUrl ?? "").trim());
        const chapter: LocalBookChapter = {
          cid: chapterCid(index),
          title: item.chapterName,
          paragraphs: carried?.paragraphs ?? [],
          url: item.chapterUrl,
        };
        if (carried && carried.blocks !== undefined) chapter.blocks = carried.blocks;
        return chapter;
      }),
    };
  });
  return next?.chapters.length ?? 0;
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

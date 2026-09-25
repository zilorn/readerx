/**
 * 在线书会话与内容缓存：
 * - 书源搜索/发现命中的“待预览书”暂存（会话级）；
 * - 「加入书架」= 只落 toc 元数据的本地书（format: online），正文按需下载；
 * - 正文一律**逐章任务**：一章一个任务交给引擎，取回一章立刻落盘一章（不按 20 章打包、
 *   不等整批回来），慢章 / 失败章不拖住别的章节，进度也是逐章推进的（见 streamChapterTasks）；
 * - 阅读时按「当前章 ±5 章」窗口预取：正在读的那一章排在队首，其余按距离补齐；
 *   正文预取完毕后再单独过一遍窗口内**已下载章节**的图片（失败即放弃，读到该章时再取，
 *   见 prefetchWindowImages）；
 * - 显式批量下载正文（默认全书，可指定章节范围；并发可配、可停止）：正文下完后单独再过一遍图片；
 * - 以上三种拉取（窗口预取 / 批量下载 / 重新加载本章）可并存且互不阻塞，冲突时以用户操作为准：
 *   读到哪一章就把那一章**插到队首**（promote），批量下载开始时后台窗口预取让位，正文回写
 *   先到先得（只有「重新加载本章」能覆盖已有正文），目录覆盖更新推进「目录世代」让按旧
 *   下标在飞的回写作废。
 */
import { createSignal } from "solid-js";
import {
  callRemoteSource,
  cancelRemoteChapterRun,
  fetchRemoteChapterContents,
  fetchRemoteChapterTasks,
  promoteRemoteChapterRun,
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
  ChapterTaskItem,
  ChapterTaskResult,
} from "./bookSourcesTypes";
import { loadSourceCoverThumb } from "./sourceCover";
import {
  buildSourceChapterContent,
  type SourceContentBuild,
} from "./sourceContent";
import { createLogger } from "./logger";
import { t } from "./i18n";

/** 在线书的日志出口：逐章走 debug，聚合结果走 info / warn（正文一个字都不写） */
const log = createLogger("online");

/** 预取窗口半径（前后各 N 章，共 2N+1 章）：后台把这一圈章节的正文抓下来落盘，
 *  顺序阅读 / 听书跨章时下一章永远已经就绪；正在读的那一章永远最先取（见 runWindowFetch）。
 *  注意：这是「提前抓」的半径，与阅读视图实际读取的范围无关 ——
 *  渲染只读当前章 ±1 章（见 Reader 的 RENDER_WINDOW），窗口外章节的落盘不会惊动前端。 */
export const LAZY_WINDOW = 5;

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
  const started = performance.now();
  const result = await callRemoteSource(source.id, "bookToc", [item]);
  const ms = Math.round(performance.now() - started);
  if (!result.ok) {
    log.warn(
      "拉取目录失败",
      `source=${source.id}`,
      `sourceName=${source.name}`,
      `book=${item.bookName}`,
      `ms=${ms}`,
      result.error ?? "获取目录失败",
    );
    throw new Error(result.error ?? t("discover.error.tocFetchFailed"));
  }
  const value = result.value;
  if (!Array.isArray(value)) {
    log.warn(
      "书源 bookToc 未返回章节数组",
      `source=${source.id}`,
      `book=${item.bookName}`,
      `ms=${ms}`,
    );
    throw new Error(t("discover.error.tocNoArray"));
  }
  const chapters: ChapterItem[] = [];
  for (const raw of value as unknown[]) {
    const r = raw as Record<string, unknown>;
    const chapterName = typeof r.chapterName === "string" ? r.chapterName.trim() : "";
    const chapterUrl = typeof r.chapterUrl === "string" ? r.chapterUrl.trim() : "";
    if (chapterName && chapterUrl) chapters.push({ chapterName, chapterUrl });
  }
  if (chapters.length === 0) {
    log.warn(
      "目录为空（书源未解析出章节）",
      `source=${source.id}`,
      `book=${item.bookName}`,
      `raw=${value.length}`,
      `ms=${ms}`,
    );
    throw new Error(t("discover.error.tocEmpty"));
  }
  log.debug(
    "拉取目录完成",
    `source=${source.id}`,
    `book=${item.bookName}`,
    `chapters=${chapters.length}`,
    `ms=${ms}`,
  );
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
    ...(tags.length > 0 ? { tags, sourceTags: tags } : {}),
  };
  await addBookRecord(book);
  // 封面（可选）：书源返回 cover 时经书源会话下载缩略图并落盘，失败 / 无封面静默回退
  const coverUrl = (item.cover ?? "").trim();
  if (coverUrl) {
    void attachOnlineBookCover(source, book, coverUrl).catch((err) => {
      log.warn(
        "书源封面下载失败，书架回退程序化封面",
        `book=${book.id}`,
        `source=${source.id}`,
        err,
      );
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
  /** 引擎侧的运行 id（0 = 还没提交）：停止 / 插队按它定位这一轮运行 */
  runId: number;
}

interface BookRuns {
  /** 后台窗口预取（阅读时按需补齐） */
  window: RunSlot | null;
  /** 用户批量下载（下载面板「下载剩余全部」/ 指定章节范围） */
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
  // 引擎侧立刻停止领取新章节（已取回的照常交付）；缓冲的正文仍要落盘，已下的字节不白下
  void cancelRemoteChapterRun(slot.runId);
  void flushChapterWrites(bookId);
  log.debug(kind === "download" ? "用户停止批量下载" : "后台窗口预取被取消", `book=${bookId}`);
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
  log.debug("用户取消重新加载本章", `book=${bookId}`, `chapter=${reload.index}`);
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
      runId: 0,
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
// - **逐章任务**：一章一个任务交给引擎，取回一章立刻处理一章（不打包、不等整批），
//   慢章 / 失败章不拖住别的章节，进度与落盘都是逐章的；
// - 不对整本做 structuredClone / 整本 JSON 过 IPC —— 只把本次真正写好的章节增量交给后端
//   （updateBookChapters），避免含 data URL 图片的大书反复整本拷贝（下载卡顿 /
//   内存暴涨闪退的根因）；
// - 章节解析等 CPU 步骤之间让出主线程（yieldToMain），渲染与翻页不被阻塞；
// - 写入由 books.ts 按书排队串行，并在队列内以「最新缓存 + 最新目录」复核后套用补丁，
//   因此多路拉取并发时不会互相覆盖、也不会按旧下标写错章节；
// - 落盘按小批合并（见 bufferChapterWrite）：任务粒度是一章，合并的只是「整本 JSON 读改写」
//   这一次磁盘动作 —— 逐章各写一遍会把同一份文件反复读写成百上千遍。
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
 * 拉取任务的「阅读焦点」：当前正在读的章节下标。用户切章时由 ensureReadingWindow 更新。
 * 在跑的窗口预取 / 批量下载据此把这一章**提到队首**（见 promoteReadingChapter），读到哪一章
 * 就先取哪一章，不必等它把其余章节取完（焦点只换优先级，不改变「谁在写书」）。
 */
const windowFocus = new Map<string, number>();

/** 引擎侧运行 id（单调递增）：停止 / 插队按它定位具体某一轮运行 */
let runSeq = 0;

function nextRunId(): number {
  return ++runSeq;
}

/** 用解析结果做本章草稿（cid / title / url 取最新目录里的那一份；图片留到阅读时下载） */
function draftFromBuild(chapter: LocalBookChapter, build: SourceContentBuild): LocalBookChapter {
  const draft: LocalBookChapter = {
    cid: chapter.cid,
    title: chapter.title,
    paragraphs: [],
    blocks: undefined,
    url: chapter.url,
  };
  applyChapterBuild(draft, build);
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

// ---------------------------------------------------------------------------
// 逐章落盘的写入缓冲
//
// 书籍是一整份 JSON：每章各写一次 = 每次都把整本读回来、解析、再整本写出去（大书上
// 成千上万次，磁盘与内存都吃不消）。因此逐章取回的正文先缓冲一小会儿，攒够章数 /
// 等够时间再落一次盘；**正在读的那一章立即落盘**（阅读器马上要显示它）。
// ---------------------------------------------------------------------------

/** 攒够这么多章就落盘 */
const CHAPTER_WRITE_BATCH = 8;
/** 「下载中」章节数组的重建步长（进度逐章更新，这个数组不必每章重建） */
const PENDING_PUBLISH_STEP = 32;
/** 或者最多等这么久（毫秒） */
const CHAPTER_WRITE_DELAY_MS = 300;

interface ChapterWriteBuffer {
  /** 待落盘的章节（下标 → 章节对象；同章后来的覆盖先前的） */
  patches: Map<number, LocalBookChapter>;
  /** 目录世代：落盘时按它复核（目录已更新则丢弃，避免按旧下标写到别的章上） */
  epoch: number;
  timer: number | null;
  /** 串行化的落盘链 */
  flushing: Promise<void>;
}

const writeBuffers = new Map<string, ChapterWriteBuffer>();

/** 缓冲一章正文；focus=true（正在读的那一章）与攒满一批时立即落盘 */
function bufferChapterWrite(
  bookId: string,
  index: number,
  chapter: LocalBookChapter,
  epoch: number,
  focus: boolean,
): Promise<void> {
  let buffer = writeBuffers.get(bookId);
  if (!buffer || buffer.epoch !== epoch) {
    // 目录换代：旧世代的缓冲按旧下标已无意义（新缓冲照常继续收）
    buffer = { patches: new Map(), epoch, timer: null, flushing: Promise.resolve() };
    writeBuffers.set(bookId, buffer);
  }
  buffer.patches.set(index, chapter);
  if (focus || buffer.patches.size >= CHAPTER_WRITE_BATCH) return flushChapterWrites(bookId);
  if (buffer.timer === null) {
    buffer.timer = window.setTimeout(() => {
      const current = writeBuffers.get(bookId);
      if (current) current.timer = null;
      void flushChapterWrites(bookId);
    }, CHAPTER_WRITE_DELAY_MS);
  }
  return buffer.flushing;
}

/** 把该书缓冲的章节立刻落盘（一轮拉取收尾 / 图片回写之前 / 停止下载时都要走到） */
function flushChapterWrites(bookId: string): Promise<void> {
  const buffer = writeBuffers.get(bookId);
  if (!buffer) return Promise.resolve();
  if (buffer.timer !== null) {
    window.clearTimeout(buffer.timer);
    buffer.timer = null;
  }
  if (buffer.patches.size === 0) return buffer.flushing;
  const patches = [...buffer.patches].map(([index, chapter]) => ({ index, chapter }));
  buffer.patches.clear();
  const epoch = buffer.epoch;
  buffer.flushing = buffer.flushing
    .then(async () => {
      await persistChapters(bookId, patches, { epoch });
    })
    .catch((err) => {
      log.warn("章节正文落盘失败", `book=${bookId}`, `chapters=${patches.length}`, err);
    });
  return buffer.flushing;
}

/** 一轮逐章拉取的结果（失败明细记在本书的失败表里，调用方按需读取） */
interface ChapterStreamOutcome {
  /** 已处理（取到正文 / 记了失败）的章节数 */
  done: number;
}

interface ChapterStreamOptions {
  bookId: string;
  sourceId: string;
  book: LocalBook;
  kind: "window" | "download";
  token: CancelToken;
  epoch: number;
  /** 本次要逐章取回的章节下标：**顺序即优先级**，排在前面的先被 worker 领走 */
  indexes: number[];
}

/**
 * 把给定章节作为**逐章任务**交给引擎，并逐章处理回传结果（解析正文 → 落盘 → 推进度）。
 *
 * - 一章一个任务：引擎按「书源并发」起若干 worker 逐章领取，取回一章立刻回传一条，
 *   因此慢章 / 失败章不拖住别的章节（旧实现按 20 章打包，慢章会让整批一起等）；
 * - 到达的结果串行处理（解析 + 落盘判定），之间让出主线程；
 * - 停止 / 插队用的是本轮运行的 id：停止后引擎不再领取新章节，已取回的照常落盘。
 */
async function streamChapterTasks(options: ChapterStreamOptions): Promise<ChapterStreamOutcome> {
  const { bookId, sourceId, book, kind, token, epoch, indexes } = options;
  // 用户已经停止：一个任务都不提交（调用方随后照常收尾）
  if (token.cancelled) return { done: 0 };
  const items: ChapterTaskItem[] = [];
  for (const index of indexes) {
    const chapter = book.chapters[index];
    const url = (chapter?.url ?? "").trim();
    if (!chapter || !url) {
      markFailure(bookId, index, t("discover.error.chapterNoUrl"));
      log.debug(
        "章节缺少地址，无法拉取正文",
        `book=${bookId}`,
        `chapter=${index}`,
        `title=${chapter?.title ?? "未知"}`,
      );
      continue;
    }
    items.push({ index, chapter: { chapterName: chapter.title, chapterUrl: url } });
  }
  /** 本轮已处理的章节（取到正文或记了失败都算处理过：进度与「下载中」徽标按它推进） */
  const handled = new Set<number>();
  /** 还没处理的章节（目录里的「下载中」徽标用） */
  const pending = new Set(indexes);
  /** 书源返回空正文的章节：整轮结束汇总一条 warn（避免逐章刷屏） */
  const emptyChapters: number[] = [];
  /** 进度逐章更新，但「下载中」的章节数组按小步重建：两万章的大目录上不必每章扫一遍 */
  let pendingPublishedAt = 0;
  const syncProgress = (force = false): void => {
    const withList = force || handled.size - pendingPublishedAt >= PENDING_PUBLISH_STEP;
    if (withList) pendingPublishedAt = handled.size;
    patchSlot(
      bookId,
      kind,
      withList
        ? { total: indexes.length, done: handled.size, pending: [...pending] }
        : { total: indexes.length, done: handled.size },
    );
  };
  syncProgress(true);
  if (items.length === 0) return { done: handled.size };

  const runId = nextRunId();
  // 停止 / 插队按运行 id 定位这一轮（窗口预取与批量下载可能同时在跑，只看 kind 会认错）
  patchSlot(bookId, kind, { runId });
  const started = performance.now();
  let tail: Promise<void> = Promise.resolve();
  /** 逐章处理：解析成块 → 缓冲落盘 → 推进度；处理之间让出主线程 */
  const applyTask = async (result: ChapterTaskResult): Promise<void> => {
    handled.add(result.index);
    pending.delete(result.index);
    if (!result.ok) {
      markFailure(bookId, result.index, result.error || t("common.unknownError"));
      // 逐章失败按 debug 记（一轮下载可能几十章失败，汇总由调用方在收尾时记一条 warn）
      log.debug(
        "章节正文拉取失败",
        `book=${bookId}`,
        `chapter=${result.index}`,
        `title=${result.chapterName}`,
        result.error,
      );
      syncProgress();
      return;
    }
    const chapter = localBookById(bookId)?.chapters[result.index];
    if (!chapter) {
      syncProgress(); // 书已被删除 / 目录已更新：这一章不再有意义
      return;
    }
    const build = buildSourceChapterContent(result.text, chapter.url || undefined);
    const draft = draftFromBuild(chapter, build);
    const empty = build.paragraphs.length === 0 && !build.hasImages;
    if (empty) emptyChapters.push(result.index);
    clearFailures(bookId, [result.index]);
    // 正在读的那一章立即落盘（阅读器马上要显示），其余按小批合并写
    await bufferChapterWrite(bookId, result.index, draft, epoch, windowFocus.get(bookId) === result.index);
    // 逐章明细：只记「哪一章、拿到多少段落 / 有无图」，正文一个字都不写
    log.debug(
      "章节正文已取回",
      `book=${bookId}`,
      `chapter=${result.index}`,
      `title=${result.chapterName}`,
      `paragraphs=${build.paragraphs.length}`,
      `images=${build.hasImages}`,
      `empty=${empty}`,
    );
    syncProgress();
    await yieldToMain();
  };
  const { error } = await fetchRemoteChapterTasks(
    sourceId,
    toBookItem(book),
    items,
    runId,
    (result) => {
      // 回调是同步的：排进串行链，逐章处理（解析与落盘都不与下一章交错）
      tail = tail.then(() =>
        applyTask(result).catch((err) => {
          log.warn(
            "章节正文处理失败",
            `book=${bookId}`,
            `chapter=${result.index}`,
            err,
          );
        }),
      );
    },
  );
  await tail;
  const ms = Math.round(performance.now() - started);
  if (error) {
    // 这一轮调用本身失败（书源被删 / 停用 / 引擎异常）：还没处理的章节都记为失败
    for (const item of items) {
      if (handled.has(item.index)) continue;
      handled.add(item.index);
      pending.delete(item.index);
      markFailure(bookId, item.index, error);
    }
    log.warn("逐章拉取正文失败", `book=${bookId}`, `chapters=${items.length}`, `ms=${ms}`, error);
  }
  syncProgress(true);
  if (emptyChapters.length > 0) {
    log.warn(
      "书源返回空正文（已记为已拉取，可重新加载本章再试）",
      `book=${bookId}`,
      `n=${emptyChapters.length}`,
      `chapters=${emptyChapters.slice(0, 20).join(",")}`,
    );
  }
  return { done: handled.size };
}

/**
 * 阅读窗口预取：把 [center ± LAZY_WINDOW] 内缺正文的章节取回来；正文齐了之后接着
 * 预取窗口内**已下载章节**的图片（见 prefetchWindowImages）。
 *
 * 每一轮窗口就是一批**逐章任务**：这一章一个任务交给引擎，取回一章落盘一章 ——
 * 正在读的那一章排在队首（先出来），其余按距离补齐；一轮跑完若焦点已经变了，
 * 就按新焦点重算窗口再来一轮（旧窗口没取到的章节不再取）。
 *
 * 用户操作优先：批量下载一开始就让位（见 runDownloadFetch），「重新加载本章」进行中的
 * 那一章跳过不取；读到别的章节时由 ensureReadingWindow 把那一章插到队首。
 */
async function runWindowFetch(bookId: string, center: number): Promise<void> {
  if (onlineRunBusy(bookId)) return;
  const initial = localBookById(bookId);
  if (!initial || !isOnlineBook(initial)) return;
  const sourceId = initial.bookSourceId!;
  const epoch = tocEpochOf(bookId);
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
  const started = performance.now();
  /** 本次拉取开始前该书已有的失败章节数：收尾时用它算出「本次新增的失败」 */
  const failuresAtStart = runsOf(bookId).failures.size;
  log.info(
    "阅读窗口预取开始",
    `book=${bookId}`,
    `title=${initial.title}`,
    `chapter=${focus}`,
    `targets=${targets.length}`,
    `phase=${textWork ? "正文" : "图片"}`,
  );
  windowFocus.set(bookId, focus);
  let done = 0;
  try {
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
        // 窗口内缺正文的章节一次性交给引擎：一章一个任务，取回一章立刻落盘一章
        const outcome = await streamChapterTasks({
          bookId,
          sourceId,
          book: bookNow,
          kind: "window",
          token,
          epoch,
          indexes: missing,
        });
        done += outcome.done;
        for (const idx of missing) attempted.add(idx);
      }
      // 阅读章变了（用户跳章 / 听书跨章）：下一轮窗口改以新章为中心
      const want = windowFocus.get(bookId);
      if (want === undefined) break;
      const latest = localBookById(bookId);
      if (!latest) break; // 书已被删除：停止拉取
      focus = Math.max(0, Math.min(want, latest.chapters.length - 1));
    }
  } catch (err) {
    // 意外中断（磁盘 I/O 等）：收尾清掉活动状态，避免该书永远卡在“获取中”
    log.error("窗口预取意外中断", `book=${bookId}`, err);
  } finally {
    // 已取回的正文照常落盘（用户停止也不白下）
    await flushChapterWrites(bookId);
    // 焦点留给接手的批量下载继续用（它靠这个焦点优先取回正在读的章节）
    if (!onlineDownloadActive(bookId)) windowFocus.delete(bookId);
    finishRun(bookId, "window", { done, cancelled: token.cancelled });
    const failures = Math.max(0, runsOf(bookId).failures.size - failuresAtStart);
    log.info(
      "阅读窗口预取结束",
      `book=${bookId}`,
      `chapter=${focus}`,
      `targets=${targets.length}`,
      `done=${done}`,
      `failed=${failures}`,
      `cancelled=${token.cancelled}`,
      `ms=${Math.round(performance.now() - started)}`,
    );
    if (failures > 0 && !token.cancelled) {
      log.warn(
        "窗口预取有章节失败",
        `book=${bookId}`,
        `failed=${failures}`,
        `targets=${targets.length}`,
      );
    }
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

/** 批量下载的章节范围（目录下标，含两端；省略即整本） */
export interface OnlineDownloadRange {
  start: number;
  end: number;
}

/** 把请求的范围夹进目录下标区间（空目录给空范围） */
function clampDownloadRange(total: number, range?: OnlineDownloadRange): OnlineDownloadRange {
  if (total <= 0) return { start: 0, end: -1 };
  const start = Math.min(Math.max(range?.start ?? 0, 0), total - 1);
  const end = Math.min(Math.max(range?.end ?? total - 1, start), total - 1);
  return { start, end };
}

/** 逐章任务的提交顺序：正在读的那一章最前，其余按与它的距离（近的先取），同距按下标 */
function orderByReadingFocus(indexes: number[], focus?: number): number[] {
  if (focus === undefined) return [...indexes];
  return [...indexes].sort((a, b) => Math.abs(a - focus) - Math.abs(b - focus) || a - b);
}

/**
 * 批量下载剩余正文（下载面板「下载剩余全部」/ 选定章节范围）：
 * **每一章都是一个任务** —— 一次把范围内缺正文的章节全部交给引擎，引擎按「书源并发」
 * 起若干 worker 逐章领取，取回一章落盘一章（不打包、不等整批），进度也是逐章推进的。
 * 图片阶段同样只过这个范围，在正文都下完之后单独跑一趟。
 *
 * 用户操作优先：
 * - 开始时后台窗口预取让位（这一轮下载本就覆盖窗口内缺的章节）；
 * - 读到哪一章就把那一章**插到队首**（ensureReadingWindow → promote）：不必排在几百章后面，
 *   只下第 x–y 章时读到范围外的章节也一样单独优先取回；
 * - 「重新加载本章」进行中的那一章跳过不取。
 * 已有同种任务在跑时返回 null（不重复发起）。
 */
async function runDownloadFetch(
  bookId: string,
  range?: OnlineDownloadRange,
): Promise<OnlineDownloadSummary | null> {
  if (onlineDownloadActive(bookId)) return null;
  const initial = localBookById(bookId);
  if (!initial || !isOnlineBook(initial)) return null;
  const sourceId = initial.bookSourceId!;
  const epoch = tocEpochOf(bookId);
  cancelBackgroundFetch(bookId); // 用户操作优先：后台窗口预取让位
  const token = startRun(bookId, "download", "download", 0, []);
  const bounds = clampDownloadRange(initial.chapters.length, range);
  const skipReload = reloadSkipSet(bookId);
  const targets: number[] = [];
  for (let i = bounds.start; i <= bounds.end; i++) {
    if (skipReload?.has(i)) continue; // 正在被用户「重新加载本章」独占
    if (!chapterHasContent(initial.chapters[i])) targets.push(i);
  }
  const started = performance.now();
  /** 本次下载开始前该书已有的失败章节数：收尾时用它算出「本次新增的失败」 */
  const failuresAtStart = runsOf(bookId).failures.size;
  log.info(
    "批量下载开始",
    `book=${bookId}`,
    `title=${initial.title}`,
    `chapters=${initial.chapters.length}`,
    `range=${bounds.start + 1}-${bounds.end + 1}`,
    `targets=${targets.length}`,
    `source=${sourceId}`,
  );
  /** 本次已处理的章节数（取到正文 / 记了失败都算处理过） */
  let done = 0;
  try {
    if (targets.length > 0) {
      // 提交顺序 = 优先级：正在读的那一章排最前，其余按距离（读到哪一章就先取哪一章）
      const order = orderByReadingFocus(targets, windowFocus.get(bookId));
      const outcome = await streamChapterTasks({
        bookId,
        sourceId,
        book: initial,
        kind: "download",
        token,
        epoch,
        indexes: order,
      });
      done = outcome.done;
    } else {
      // 正文都已缓存：只跑图片阶段，章节计数清零（下载面板按图片进度显示）
      patchSlot(bookId, "download", { total: 0, done: 0, pending: [] });
    }
    // 已取回的正文先落盘：图片阶段要按最新章节内容回写图片引用
    await flushChapterWrites(bookId);
    if (!token.cancelled) {
      // 图片阶段可能很久：先确保正在读的那一章有正文（可能在所选范围外）
      await ensureFocusedChapter(bookId);
    }
    if (!token.cancelled) await runDownloadImages(bookId, sourceId, token, bounds);
  } catch (err) {
    // 意外中断（磁盘 I/O 等）：收尾清掉活动状态，避免该书永远卡在“下载中”
    log.error("批量下载意外中断", `book=${bookId}`, err);
  } finally {
    await flushChapterWrites(bookId);
    windowFocus.delete(bookId);
    finishRun(bookId, "download", { done, cancelled: token.cancelled });
  }
  // 返回给调用方的仍是「结束时该书仍失败的章节数」（与本次新增的失败分开记，语义不变）
  const failedChapters = runsOf(bookId).failures.size;
  const newFailures = Math.max(0, failedChapters - failuresAtStart);
  const images = runsOf(bookId).download?.images ?? EMPTY_IMAGE_PROGRESS;
  log.info(
    "批量下载结束",
    `book=${bookId}`,
    `title=${initial.title}`,
    `range=${bounds.start + 1}-${bounds.end + 1}`,
    `targets=${targets.length}`,
    `done=${done}`,
    `failedChapters=${failedChapters}`,
    `newFailed=${newFailures}`,
    `images=${images.done}/${images.total}`,
    `imagesFailed=${images.failed}`,
    `cancelled=${token.cancelled}`,
    `ms=${Math.round(performance.now() - started)}`,
  );
  if (newFailures > 0 && !token.cancelled) {
    log.warn(
      "批量下载有章节失败",
      `book=${bookId}`,
      `newFailed=${newFailures}`,
      `failedChapters=${failedChapters}`,
      `targets=${targets.length}`,
    );
  }
  return {
    cancelled: token.cancelled,
    done,
    failedChapters,
    images,
  };
}

/**
 * 批量下载的图片阶段：所选范围的正文都就绪后，单独把范围内各章尚未本地化的图片过一遍。
 * 与正文分两趟跑（不与获取章节同时取图片）：图片同样经书源会话下载并写回章节，
 * 失败不计入章节失败，之后阅读该章时按占位框的「重试」再取。
 */
async function runDownloadImages(
  bookId: string,
  sourceId: string,
  token: CancelToken,
  range: OnlineDownloadRange,
): Promise<void> {
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book)) return;
  // 正文阶段缓冲的章节先落盘：图片阶段按最新章节内容补引用
  await flushChapterWrites(bookId);
  const jobs = book.chapters
    .map((chapter, index) => ({ index, chapter, urls: pendingImageUrls(chapter) }))
    .filter((job) => job.index >= range.start && job.index <= range.end && job.urls.length > 0);
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
  const imagesStarted = performance.now();
  log.info(
    "批量下载进入图片阶段",
    `book=${bookId}`,
    `title=${book.title}`,
    `chapters=${jobs.length}`,
    `images=${total}`,
  );
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
    log.debug(
      "批量下载图片章节完成",
      `book=${bookId}`,
      `chapter=${job.index}`,
      `images=${job.urls.length}`,
      `ready=${ready.size}`,
      `ms=${Math.round(performance.now() - imagesStarted)}`,
    );
  }
  // 一批图片的聚合结果：失败张数 / 总张数（逐张失败已由 chapterImages 记 debug，
  // 有失败的一批在那里记 warn，这里不再重复一条）
  log.info(
    "批量下载图片阶段结束",
    `book=${bookId}`,
    `images=${total}`,
    `done=${done}`,
    `failed=${failedImages}`,
    `ms=${Math.round(performance.now() - imagesStarted)}`,
  );
}

/**
 * 把正在读的那一章提到在跑任务的**队首**（用户操作优先）。
 * 返回 true 表示那一轮运行里已经有这一章（插队成功或正在取），不必再单独发一份请求；
 * false 表示它不在那一轮的队列里（例如只下第 x–y 章时读到了范围外的一章）。
 */
async function promoteReadingChapter(bookId: string, chapterIndex: number): Promise<boolean> {
  const runs = runMap()[bookId];
  const slot = runs?.download?.active ? runs.download : runs.window?.active ? runs.window : null;
  const chapter = localBookById(bookId)?.chapters[chapterIndex];
  const url = (chapter?.url ?? "").trim();
  if (!slot || slot.runId <= 0 || !url) return false;
  const result = await promoteRemoteChapterRun(slot.runId, [url]);
  if (result.promoted > 0) {
    log.debug("章节已插到队首", `book=${bookId}`, `chapter=${chapterIndex}`, `run=${slot.runId}`);
  }
  return result.promoted + result.running > 0;
}

/** 同一章的即时取回只发一次（切换章节的效果可能连着触发几次） */
const focusFetches = new Map<string, Promise<void>>();

/**
 * 单独取一章（不在在跑队列里的当前章，例如只下第 x–y 章时读到范围外）：
 * 一份独立请求，不排在下载大队列后面，取回立即落盘。
 */
async function fetchChapterNow(bookId: string, chapterIndex: number): Promise<void> {
  const key = `${bookId}#${chapterIndex}`;
  const inflight = focusFetches.get(key);
  if (inflight) return await inflight;
  const task = (async (): Promise<void> => {
    const book = localBookById(bookId);
    if (!book || !isOnlineBook(book)) return;
    const chapter = book.chapters[chapterIndex];
    const url = (chapter?.url ?? "").trim();
    if (!chapter || !url) {
      markFailure(bookId, chapterIndex, t("discover.error.chapterNoUrl"));
      return;
    }
    if (chapterHasContent(chapter)) return; // 期间已被别的任务写回
    const epoch = tocEpochOf(bookId);
    const results = await fetchRemoteChapterContents(book.bookSourceId!, toBookItem(book), [
      { chapterName: chapter.title, chapterUrl: url },
    ]);
    const res = results[0];
    if (!res?.ok) {
      const error = res?.error || t("discover.error.chapterFetchFailed");
      markFailure(bookId, chapterIndex, error);
      log.debug("当前章单独取回失败", `book=${bookId}`, `chapter=${chapterIndex}`, error);
      return;
    }
    const latest = localBookById(bookId)?.chapters[chapterIndex];
    if (!latest) return; // 书已被删除 / 目录已更新
    const build = buildSourceChapterContent(res.text, latest.url || undefined);
    clearFailures(bookId, [chapterIndex]);
    await bufferChapterWrite(bookId, chapterIndex, draftFromBuild(latest, build), epoch, true);
    log.debug(
      "当前章单独取回完成",
      `book=${bookId}`,
      `chapter=${chapterIndex}`,
      `paragraphs=${build.paragraphs.length}`,
      `images=${build.hasImages}`,
    );
  })().finally(() => {
    focusFetches.delete(key);
  });
  focusFetches.set(key, task);
  return await task;
}

/** 正在读的那一章没正文就取回来（批量下载进入图片阶段之前用；范围外的章节也要有正文） */
async function ensureFocusedChapter(bookId: string): Promise<void> {
  const index = windowFocus.get(bookId);
  if (index === undefined) return;
  const book = localBookById(bookId);
  if (!book) return; // 书已被删除：停止拉取
  const chapter = book.chapters[index];
  if (!chapter || chapterHasContent(chapter)) return;
  if (runMap()[bookId]?.reload?.index === index) return; // 用户正在重载这一章
  if (await promoteReadingChapter(bookId, index)) return;
  await fetchChapterNow(bookId, index);
}

/**
 * 阅读窗口预取：确保 [idx ± LAZY_WINDOW] 内章节有正文（当前章优先）；
 * 正文都已就绪时改为确保窗口内已下载章节的图片（见 prefetchWindowImages）。
 *
 * 已有拉取任务在跑时不新起一轮，而是把「阅读焦点」交给它：
 * - 正在读的那一章**提到队首**（用户操作优先：不必排在几百章的下载队列后面），
 *   已经在取的任务不重复请求；它不在那一轮的队列里时（例如只下第 x–y 章）单独取一章；
 * - 本章正文就绪、只是窗口里还有没取过的图片时，只交焦点：在跑的图片预取会改以本章为中心。
 */
export async function ensureReadingWindow(
  bookId: string,
  chapterIndex: number,
): Promise<void> {
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book)) return;
  windowFocus.set(bookId, chapterIndex);
  if (onlineRunBusy(bookId)) {
    const chapter = book.chapters[chapterIndex];
    if (!chapter || chapterHasContent(chapter)) return;
    if (runMap()[bookId]?.reload?.index === chapterIndex) return; // 用户正在重载这一章
    if (await promoteReadingChapter(bookId, chapterIndex)) return;
    await fetchChapterNow(bookId, chapterIndex);
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

/** 批量下载剩余正文（下载面板「下载剩余全部」）。
 *  `range` 为目录下标区间（含两端），省略即整本；图片阶段同样只过这个范围。
 *  已有一轮批量下载在跑时返回 null（不重复发起）；后台窗口预取会被让位，不阻塞本次下载。 */
export async function downloadRemainingChapters(
  bookId: string,
  range?: OnlineDownloadRange,
): Promise<OnlineDownloadSummary | null> {
  const book = localBookById(bookId);
  if (!book || !isOnlineBook(book)) return null;
  return await runDownloadFetch(bookId, range);
}

// ---------------------------------------------------------------------------
// 阅读时按需下载正文图片（拉正文阶段只存地址，见 chapterImages.ts）
// ---------------------------------------------------------------------------

/**
 * 章节里还没本地化的图片地址（去重、保序）。
 * 整行图（img 块）与段内图（p 块的 imgs 锚点）都算：只认图片的 remote（在线图片身份），
 * 已经写好本地副本（`local`）的不再请求。
 */
function pendingImageUrls(chapter: LocalBookChapter): string[] {
  const blocks = chapter.blocks;
  if (!blocks || blocks.length === 0) return [];
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (remote: string | undefined, local: string | undefined): void => {
    if (!remote || local || seen.has(remote)) return;
    seen.add(remote);
    urls.push(remote);
  };
  for (const block of blocks) {
    if (block.kind === "img") {
      push(block.remote, block.local);
      continue;
    }
    if (block.kind === "p" && block.imgs) {
      for (const img of block.imgs) push(img.remote, img.local);
    }
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
  // 图片引用要合到**最新章节内容**上：先让缓冲的正文落盘，
  // 否则随后落盘的正文（那一份还没有图片引用）会把刚写好的引用盖掉
  await flushChapterWrites(bookId);
  await updateBookChapterInPlace(bookId, chapterIndex, (chapter) => {
    if (!chapter.blocks) return null;
    let changed = false;
    /** 补上一张图的本地副本引用；无变化时返回原对象（段内图据此判断数组是否要重建） */
    const fill = <T extends { remote?: string; local?: string }>(img: T): T => {
      const file = img.remote ? ready.get(img.remote) : undefined;
      if (!file || img.local === file.local) return img;
      changed = true;
      return { ...img, local: file.local };
    };
    const blocks = chapter.blocks.map((block): ChapterBlock => {
      if (block.kind === "img") return fill(block);
      if (block.kind === "p" && block.imgs) {
        let imgsChanged = false;
        const imgs = block.imgs.map((img) => {
          const next = fill(img);
          if (next !== img) imgsChanged = true;
          return next;
        });
        return imgsChanged ? { ...block, imgs } : block;
      }
      return block;
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
  const started = performance.now();
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
  log.debug(
    "阅读章节图片下载完成",
    `book=${bookId}`,
    `chapter=${chapterIndex}`,
    `images=${urls.length}`,
    `ready=${ready.size}`,
    `ms=${Math.round(performance.now() - started)}`,
  );
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
  const imagesStarted = performance.now();
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
    let chapterFailed = 0;
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
        chapterFailed++;
        settled++;
      }
    }
    done += settled;
    // 成功的那部分照常写回书库（即使随后要放弃这一轮：字节已经下下来了，不该白下）
    await persistReadyImages(bookId, job.index, ready);
    patchSlot(bookId, "window", { images: { total, done, failed } });
    log.debug(
      "窗口图片预取章节完成",
      `book=${bookId}`,
      `chapter=${job.index}`,
      `images=${job.urls.length}`,
      `ready=${ready.size}`,
      `failed=${chapterFailed}`,
      `ms=${Math.round(performance.now() - imagesStarted)}`,
    );
  }
  // 窗口图片预取的聚合结果：逐张失败已由 chapterImages 记 debug（有失败的一批在那里记 warn）
  if (total > 0) {
    log.info(
      "窗口图片预取结束",
      `book=${bookId}`,
      `chapter=${center}`,
      `images=${total}`,
      `done=${done}`,
      `failed=${failed}`,
      `ms=${Math.round(performance.now() - imagesStarted)}`,
    );
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
  const started = performance.now();
  const file = await retryChapterImage(book.bookSourceId!, bookId, url, chapter?.url ?? null);
  if (file) await persistReadyImages(bookId, chapterIndex, new Map([[url, file]]));
  log.debug(
    file ? "图片手动重试成功" : "图片手动重试仍失败",
    `book=${bookId}`,
    `chapter=${chapterIndex}`,
    `url=${url}`,
    `ms=${Math.round(performance.now() - started)}`,
  );
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
      error:
        inflight.index === chapterIndex
          ? t("discover.error.reloadBusy")
          : t("discover.error.reloadOtherBusy"),
    };
  }
  const sourceId = book.bookSourceId!;
  const epoch = tocEpochOf(bookId);
  const started = performance.now();
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
      const error = res?.error || t("discover.error.chapterFetchFailed");
      markFailure(bookId, chapterIndex, error);
      log.warn(
        "重新加载本章失败",
        `book=${bookId}`,
        `chapter=${chapterIndex}`,
        `title=${chapter.title}`,
        `ms=${Math.round(performance.now() - started)}`,
        error,
      );
      return { applied: false, cancelled: false, error };
    }
    if (token.cancelled) {
      log.debug("重新加载本章已取消", `book=${bookId}`, `chapter=${chapterIndex}`);
      return { applied: false, cancelled: true };
    }
    const build = buildSourceChapterContent(res.text, chapter.url);
    if (build.paragraphs.length === 0 && !build.hasImages) {
      // 用户主动重载却拿到空正文：这是要能从日志还原的失败（页面结构变了 / 正文选择器失效）
      log.warn(
        "重新加载本章拿到空正文（书源可能改了页面结构）",
        `book=${bookId}`,
        `chapter=${chapterIndex}`,
        `title=${chapter.title}`,
      );
    }

    // 新正文会替换本章书签锚定的文字：先预演，部分书签无法精确定位时交调用方询问
    if (options?.confirmRisk) {
      const nextChapter = draftFromBuild(chapter, build);
      const preview = await previewChapterBookmarkReplacement(
        book,
        chapterIndex,
        nextChapter,
      );
      if (preview.failedCount > 0) {
        const proceed = await options.confirmRisk(preview);
        if (!proceed) {
          log.info("用户放弃重新加载本章", `book=${bookId}`, `chapter=${chapterIndex}`);
          return { applied: false, cancelled: true };
        }
      }
    }
    if (token.cancelled) {
      log.debug("重新加载本章已取消", `book=${bookId}`, `chapter=${chapterIndex}`);
      return { applied: false, cancelled: true };
    }

    // 拉取期间目录可能被覆盖更新（下标含义已变）：本次结果作废，不写到别的章节上
    if (tocEpochOf(bookId) !== epoch) {
      log.warn("重新加载本章结果作废：期间目录已更新", `book=${bookId}`, `chapter=${chapterIndex}`);
      return { applied: false, cancelled: false, error: t("discover.error.tocChanged") };
    }
    const latest = localBookById(bookId);
    if (!latest) {
      log.warn(
        "重新加载本章结果作废：书籍已不在书库",
        `book=${bookId}`,
        `chapter=${chapterIndex}`,
      );
      return { applied: false, cancelled: false, error: t("discover.error.bookGone") };
    }
    const target = latest.chapters[chapterIndex];
    if (!target) {
      log.warn("重新加载本章结果作废：章节已变化", `book=${bookId}`, `chapter=${chapterIndex}`);
      return { applied: false, cancelled: false, error: t("discover.error.chapterChanged") };
    }
    // 只构建/回写本章的新对象（不整本深拷贝），大书含图时不再反复整本过 IPC
    const draft = draftFromBuild(target, build);
    const written = await persistChapters(
      bookId,
      [{ index: chapterIndex, chapter: draft }],
      { epoch, overwrite: true },
    );
    if (written === 0) {
      log.warn("重新加载本章结果作废：目录已更新", `book=${bookId}`, `chapter=${chapterIndex}`);
      return { applied: false, cancelled: false, error: t("discover.error.tocChanged") };
    }
    clearFailures(bookId, [chapterIndex]);
    log.info(
      "重新加载本章完成",
      `book=${bookId}`,
      `chapter=${chapterIndex}`,
      `title=${chapter.title}`,
      `paragraphs=${draft.paragraphs.length}`,
      `ms=${Math.round(performance.now() - started)}`,
    );
    return { applied: true, cancelled: false };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    markFailure(bookId, chapterIndex, error);
    log.warn(
      "重新加载本章异常",
      `book=${bookId}`,
      `chapter=${chapterIndex}`,
      `ms=${Math.round(performance.now() - started)}`,
      error,
    );
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
  if (!isOnlineBook(book)) throw new Error(t("discover.error.notOnlineBook"));
  if (!book.bookUrl) throw new Error(t("discover.error.missingBookUrl"));
  const sourceId = book.bookSourceId!;
  await ensureBookSourcesLoaded();
  const source = bookSourceSummaryById(sourceId);
  if (!source) throw new Error(t("discover.error.sourceDeleted"));
  if (!source.enabled) throw new Error(t("discover.error.sourceDisabled"));
  if (!source.capabilities.toc) {
    throw new Error(t("discover.error.tocCapability"));
  }
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
  log.info(
    "目录追加更新完成",
    `book=${bookId}`,
    `added=${next ? added.length : 0}`,
    `chapters=${next?.chapters.length ?? 0}`,
  );
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
  log.info(
    "目录覆盖更新完成",
    `book=${bookId}`,
    `fresh=${fresh.length}`,
    `chapters=${next?.chapters.length ?? 0}`,
  );
  return next?.chapters.length ?? 0;
}

// ---------------------------------------------------------------------------
// 在线书「重新拉取书籍信息」（书籍详情页）：
// 以书架里保存的标题 / 作者 / 书源地址为入参，重调书源「详情」（bookDetail），
// 把书源返回的非空简介 / 封面 / 标签重新写回书架（简介与当前一致时不写；
// 封面 URL 与「加入书架」同一套规则：经该书源会话下载压缩为缩略图 data URL）。
// 标签分「书源来源」与「手编」两部分维护（见 mergeSourceBookTags）：书源侧新增 / 删除的
// 标签都会同步，用户手编的标签始终保留。
// ---------------------------------------------------------------------------

export interface RefreshOnlineBookInfoResult {
  /** 简介是否被书源返回的新内容覆盖 */
  introUpdated: boolean;
  /** 封面是否被书源返回的新封面覆盖 */
  coverUpdated: boolean;
  /** 标签是否随书源返回的标签变化（新增 / 移除书源来源的标签） */
  tagsUpdated: boolean;
}

/** 从书源 `bookDetail` 原始返回值里取标签：没给 / 不是数组一律视为「这次没有标签信息」。 */
function detailTagsOf(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return normalizeBookTags((value as Record<string, unknown>)["tags"]);
}

/** 两个标签数组是否逐位相同（合并只做增删、不改顺序，故逐位比较即可） */
function sameTagList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

/** 刷新时把书源返回的标签并入现有标签：
 * - prevSourceTags 已知（上次书源写回的标签）：手编标签 = 现有标签里不属于书源的那部分，
 *   一律保留；书源侧新增的补上、已删除的去掉，现有标签的相对顺序不变；
 * - prevSourceTags 未知（本功能上线前入库的书，无从区分手编与书源）：退化为并集，
 *   只追加不删除，绝不丢已有标签。
 * freshTags 为空表示「书源这次没给标签」，调用方应整体跳过（不做任何标签改动）。 */
export function mergeSourceBookTags(
  prevTags: string[],
  prevSourceTags: string[] | undefined,
  freshTags: string[],
): string[] {
  const freshSet = new Set(freshTags);
  const prevSourceSet = prevSourceTags ? new Set(prevSourceTags) : null;
  const kept =
    prevSourceSet === null
      ? prevTags
      : prevTags.filter((tag) => !prevSourceSet.has(tag) || freshSet.has(tag));
  const keptSet = new Set(kept);
  const added = freshTags.filter((tag) => !keptSet.has(tag));
  return normalizeBookTags([...kept, ...added]);
}

/** 在线书重新拉取书籍信息（简介 / 封面 / 标签）；非在线书或书源不可用时抛可读错误 */
export async function refreshOnlineBookInfo(
  bookId: string,
): Promise<RefreshOnlineBookInfoResult> {
  const started = performance.now();
  const meta = bookMetaById(bookId);
  if (!meta || !isOnlineBook(meta) || !meta.bookSourceId || !meta.bookUrl) {
    throw new Error(t("discover.error.refreshOnlineOnly"));
  }
  await ensureBookSourcesLoaded();
  const source = bookSourceSummaryById(meta.bookSourceId);
  if (!source) throw new Error(t("discover.error.sourceDeletedForRefresh"));
  if (!source.enabled) throw new Error(t("discover.error.sourceDisabled"));
  if (!source.capabilities.detail) {
    throw new Error(t("discover.error.detailCapability"));
  }
  const tags = normalizeBookTags(meta.tags);
  const item: BookItem = {
    bookName: meta.title,
    ...(meta.author && meta.author !== "佚名" ? { author: meta.author } : {}),
    bookUrl: meta.bookUrl,
    ...(tags.length > 0 ? { tags } : {}),
  };
  const result = await callRemoteSource(source.id, "bookDetail", [item]);
  if (!result.ok) {
    log.warn(
      "重新拉取书籍信息失败",
      `book=${bookId}`,
      `source=${source.id}`,
      `ms=${Math.round(performance.now() - started)}`,
      result.error ?? "拉取书籍信息失败",
    );
    throw new Error(result.error ?? t("discover.error.refreshFailed"));
  }
  const merged = mergeBookDetail(item, result.value);

  let introUpdated = false;
  let coverUpdated = false;
  let tagsUpdated = false;
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
  // 标签：只认书源这次真正返回的那份（合并后的 merged.tags 会把现有标签带回来，
  // 用它会把「书源没给标签」误判成「书源给的标签就是这些」）
  const freshTags = detailTagsOf(result.value);
  if (freshTags.length > 0) {
    // 拉取期间用户可能刚改过标签：按最新记录重算一次，别用请求前的快照盖掉手编结果
    const latest = bookMetaById(bookId) ?? meta;
    const prevTags = normalizeBookTags(latest.tags);
    const prevSourceTags =
      latest.sourceTags === undefined ? undefined : normalizeBookTags(latest.sourceTags);
    const nextTags = mergeSourceBookTags(prevTags, prevSourceTags, freshTags);
    tagsUpdated = !sameTagList(prevTags, nextTags);
    // 标签没变也要更新书源标签标记（老数据首次刷新即由此建立），但能省则省
    if (tagsUpdated || !sameTagList(prevSourceTags ?? [], freshTags)) {
      await updateBookInfo(bookId, { tags: nextTags, sourceTags: freshTags });
    }
  }
  log.info(
    "重新拉取书籍信息完成",
    `book=${bookId}`,
    `title=${meta.title}`,
    `introUpdated=${introUpdated}`,
    `coverUpdated=${coverUpdated}`,
    `tagsUpdated=${tagsUpdated}`,
    `ms=${Math.round(performance.now() - started)}`,
  );
  return { introUpdated, coverUpdated, tagsUpdated };
}

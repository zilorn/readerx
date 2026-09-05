/**
 * 书签：持久化 + 精确定位。
 *
 * 定位思路（避免“同一章节多个相同文本”误跳）：
 * - 创建书签时记录【结构化指纹】：章节 cid / 起点正文单元序号 unitIndex / 章节镜像文本内的
 *   全局字符区间 [charStart, charEnd)，以及选中文本与前/后文锚（before/after）。
 *   区间可横跨多个段落/标题（“跨段落书签”）；镜像文本 = 章节内全部 p/h 正文按序拼接，
 *   图片不占字符，见 buildTextMirror。
 * - 渲染时正文元素带 data-u/data-c，因此任何字号、翻页、窗口宽度变化都不影响字符偏移；
 *   书签下划线、跳转高亮都只依赖偏移，与“搜重复文字”无关。
 * - resolveBookmarkTarget 定位时按多级方法兜底：
 *   1) 结构化：单元仍存在且偏移落在其文本内、首段文字与记录一致 → 直接命中（最可靠）；
 *   2) 全文匹配 + before/after 前后文锚定消除重复匹配；
 *   3) 仍多义时取与记录偏移最近的候选，并标记 uncertain，由调用方提示。
 *
 * 持久化走 Rust 后端 readState/writeState（WebView 不落盘）。
 */
import { createSignal } from "solid-js";
import { readState, writeState } from "./backend";
import { assignChapterCids, type LocalBook, type LocalBookChapter } from "./booksTypes";
import { chapterUnits, type ReaderBlock } from "./pagination";

const STORAGE_KEY = "readerx.bookmarks";

/** 书签记录的展示/锚定上下文长度 */
export const BOOKMARK_CONTEXT = 32;
/** 单条书签最大跨度（字符），超出则拒绝添加 */
export const BOOKMARK_MAX_LEN = 800;

export interface Bookmark {
  id: string;
  bookId: string;
  chapterCid: string;
  /** 章节序号（cid 失效时的回退） */
  chapterIndex: number;
  chapterTitle: string;
  /** 选中起点所在正文单元序号（chapterUnits 下标，p/h；跨段落时仍记起点单元） */
  unitIndex: number;
  /** 章节镜像文本中的全局字符区间（只含 p/h 文本；可横跨多个单元） */
  charStart: number;
  charEnd: number;
  /** 选中原文（完整保存以便展示与定位比对，一般 ≤ BOOKMARK_MAX_LEN） */
  text: string;
  /** 起点前的原文（镜像文本，长度 ≤ BOOKMARK_CONTEXT） */
  before: string;
  /** 终点后的原文（镜像文本，长度 ≤ BOOKMARK_CONTEXT） */
  after: string;
  createdAt: number;
}

type BookmarkMap = Record<string, Bookmark[]>;

// ---------------------------------------------------------------------------
// 章节文本镜像：单元文本按序拼接 + 每个单元在拼接串中的起始偏移
// ---------------------------------------------------------------------------

export interface TextMirror {
  /** 全部 p/h 文本按序拼接（无分隔符，与 DOM 文本节点顺序一致） */
  text: string;
  /** 每个单元（含图片）在其文本中的起始偏移；图片单元与相邻文本共享值 */
  unitStart: number[];
  /** 每个单元的文本长度（图片为 0） */
  unitLength: number[];
  units: ReaderBlock[];
}

export function buildTextMirror(units: ReaderBlock[]): TextMirror {
  const unitStart = new Array<number>(units.length);
  const unitLength = new Array<number>(units.length);
  const parts: string[] = [];
  let acc = 0;
  units.forEach((unit, index) => {
    const t = unit.kind === "p" || unit.kind === "h" ? unit.text : "";
    unitStart[index] = acc;
    unitLength[index] = t.length;
    if (t) {
      parts.push(t);
      acc += t.length;
    }
  });
  return { text: parts.join(""), unitStart, unitLength, units };
}

/** 镜像全局偏移 → (单元序号, 单元内偏移)；找不到文本单元返回 null */
export function unitAtGlobalOffset(
  mirror: TextMirror,
  global: number,
): { unit: number; local: number } | null {
  const { units, unitStart, unitLength } = mirror;
  for (let i = 0; i < units.length; i++) {
    if (units[i].kind !== "p" && units[i].kind !== "h") continue;
    const s = unitStart[i];
    const e = s + unitLength[i];
    if (global >= s && global < e) return { unit: i, local: global - s };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 响应式存储
// ---------------------------------------------------------------------------

const [bookmarkMap, setBookmarkMap] = createSignal<BookmarkMap>({});
let loadPromise: Promise<void> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

export function ensureBookmarksLoaded(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const stored = await readState<BookmarkMap>(STORAGE_KEY);
      if (stored && typeof stored === "object") setBookmarkMap(stored);
    } catch {
      /* 后端不可用时保持空书签 */
    }
  })().finally(() => {
    loadPromise = null;
  });
  return loadPromise;
}

function persist(): void {
  const snapshot = { ...bookmarkMap() };
  writeQueue = writeQueue.then(() => writeState(STORAGE_KEY, snapshot));
}

/** 某本书的全部书签（响应式，无序） */
export function bookmarksFor(bookId: string): Bookmark[] {
  return bookmarkMap()[bookId] ?? [];
}

/** 某本书按“章节 → 文本位置”排序的书签 */
export function sortedBookmarks(bookId: string): Bookmark[] {
  return bookmarksFor(bookId)
    .slice()
    .sort(
      (a, b) =>
        a.chapterIndex - b.chapterIndex || a.charStart - b.charStart || a.createdAt - b.createdAt,
    );
}

/** 是否已存在完全同区间的书签（用于“再次点书签=移除”） */
export function bookmarkAtExactRange(
  bookId: string,
  chapterCid: string,
  charStart: number,
  charEnd: number,
): Bookmark | undefined {
  return bookmarksFor(bookId).find(
    (bm) => bm.chapterCid === chapterCid && bm.charStart === charStart && bm.charEnd === charEnd,
  );
}

export function addBookmark(bookmark: Bookmark): void {
  const map = { ...bookmarkMap() };
  const list = map[bookmark.bookId] ?? [];
  map[bookmark.bookId] = [...list, bookmark];
  setBookmarkMap(map);
  persist();
}

export function removeBookmark(id: string): void {
  let changed = false;
  const map: BookmarkMap = {};
  for (const [bookId, list] of Object.entries(bookmarkMap())) {
    const next = list.filter((bm) => bm.id !== id);
    if (next.length !== list.length) changed = true;
    if (next.length > 0) map[bookId] = next;
  }
  if (!changed) return;
  setBookmarkMap(map);
  persist();
}

/** 删除一本书时清空其书签 */
export function removeBookmarksForBook(bookId: string): void {
  const map = { ...bookmarkMap() };
  if (!(bookId in map)) return;
  delete map[bookId];
  setBookmarkMap(map);
  persist();
}

/** 清空全部书签 */
export function clearAllBookmarks(): void {
  setBookmarkMap({});
  persist();
}

export function newBookmarkId(): string {
  return `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 组装一条书签记录。
 *
 * 支持跨段落/标题的书签：charStart/charEnd 是本章镜像文本（p/h 正文按序拼接）
 * 的全局区间，可横跨任意多个单元（图片不占字符）。unitIndex 只记录“起点所在
 * 单元”，作为定位时的结构化锚点之一。
 * mirror 需来自该书签所在章节的 buildTextMirror(章节单元)。
 */
export function makeBookmark(
  bookId: string,
  chapter: LocalBookChapter,
  chapterIndex: number,
  unitIndex: number,
  charStart: number,
  charEnd: number,
  mirror: TextMirror,
): Bookmark | null {
  if (!chapter || !Number.isFinite(charStart) || !Number.isFinite(charEnd)) return null;
  if (charEnd <= charStart) return null;
  if (charEnd - charStart > BOOKMARK_MAX_LEN) return null;
  if (charStart < 0 || charEnd > mirror.text.length) return null;
  // 起点必须落在某个 p/h 文本内（定位/渲染的锚定基础；终点允许在正文末尾）
  const startUnit = unitAtGlobalOffset(mirror, charStart);
  const effectiveUnit =
    startUnit?.unit ?? (Number.isFinite(unitIndex) && unitIndex >= 0 ? unitIndex : -1);
  if (effectiveUnit < 0) return null;
  const text = mirror.text.slice(charStart, charEnd);
  if (!text) return null;
  return {
    id: newBookmarkId(),
    bookId,
    chapterCid: chapter.cid,
    chapterIndex,
    chapterTitle: chapter.title,
    unitIndex: effectiveUnit,
    charStart,
    charEnd,
    text,
    before: mirror.text.slice(Math.max(0, charStart - BOOKMARK_CONTEXT), charStart),
    after: mirror.text.slice(charEnd, charEnd + BOOKMARK_CONTEXT),
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 定位
// ---------------------------------------------------------------------------

export interface ResolvedTarget {
  chapterIndex: number;
  unitIndex: number;
  charStart: number;
  charEnd: number;
  /** true = 结构化直接命中（可靠）；false = 靠文字+前后文锚定，可能有歧义 */
  certain: boolean;
}

function occurrencesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let from = 0;
  for (;;) {
    const hit = haystack.indexOf(needle, from);
    if (hit < 0) break;
    out.push(hit);
    from = hit + 1;
  }
  return out;
}

/** 在镜像文本里按“选中文本 + before/after 锚定”挑选最可信的起点 */
function bestMatchStart(mirror: TextMirror, bm: Bookmark): { start: number; certain: boolean } | null {
  const text = mirror.text;
  const needle = bm.text;
  const hits = occurrencesOf(text, needle);
  if (hits.length === 0) return null;
  if (hits.length === 1) return { start: hits[0], certain: true };

  const before = bm.before;
  const after = bm.after;
  const beforeHits = hits.filter((h) => !before || text.slice(h - before.length, h) === before);
  if (beforeHits.length === 1) return { start: beforeHits[0], certain: true };
  const afterHits = hits.filter(
    (h) => !after || text.slice(h + needle.length, h + needle.length + after.length) === after,
  );
  if (afterHits.length === 1) return { start: afterHits[0], certain: true };

  const candidates = beforeHits.length > 0 ? beforeHits : hits;
  let best = candidates[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const h of candidates) {
    const d = Math.abs(h - bm.charStart);
    if (d < bestDist) {
      bestDist = d;
      best = h;
    }
  }
  return { start: best, certain: false };
}

/**
 * 把书签解析为当前书籍内可落地的目标。
 * 优先结构化偏移（书签的字符区间本身就精确），内容漂移/重排后再退化到文字锚定。
 * 找不到返回 null。
 */
export function resolveBookmarkTarget(book: LocalBook, bm: Bookmark): ResolvedTarget | null {
  const chapters = book.chapters;
  if (chapters.length === 0) return null;
  let chapterIndex = chapters.findIndex((ch) => ch.cid === bm.chapterCid);
  if (chapterIndex < 0) chapterIndex = Math.min(chapters.length - 1, Math.max(0, bm.chapterIndex));
  const chapter = chapters[chapterIndex];
  const units = chapterUnits(chapter);
  const mirror = buildTextMirror(units);
  const length = bm.charEnd - bm.charStart;
  const base = bm.unitIndex >= 0 ? mirror.unitStart[bm.unitIndex] ?? -1 : -1;

  // 1) 结构化：起点单元仍存在、起点偏移落在其文本内，且起点文字未变。
  //    （书签可横跨多个单元，因此终点允许超出该单元、只要不越出镜像文本。）
  if (
    base >= 0 &&
    bm.unitIndex < units.length &&
    (units[bm.unitIndex].kind === "p" || units[bm.unitIndex].kind === "h") &&
    bm.charStart >= base &&
    bm.charStart < base + (mirror.unitLength[bm.unitIndex] ?? 0) &&
    bm.charEnd >= bm.charStart &&
    bm.charEnd <= mirror.text.length
  ) {
    const sample = mirror.text.slice(bm.charStart, bm.charStart + Math.min(length, 96));
    if (sample === bm.text.slice(0, sample.length)) {
      return {
        chapterIndex,
        unitIndex: bm.unitIndex,
        charStart: bm.charStart,
        charEnd: bm.charEnd,
        certain: true,
      };
    }
  }

  // 2) 文字 + before/after 锚定
  const match = bestMatchStart(mirror, bm);
  if (!match) return null;
  const placed = unitAtGlobalOffset(mirror, match.start);
  if (!placed) return null;
  return {
    chapterIndex,
    unitIndex: placed.unit,
    charStart: match.start,
    charEnd: match.start + length,
    certain: match.certain,
  };
}

// ---------------------------------------------------------------------------
// 书签继承预演（重新导入前）
// ---------------------------------------------------------------------------

export interface BookmarkInheritPreview {
  /** 该书现有的书签总数 */
  total: number;
  /** 无法在新内容中精确定位（重新导入后将失效/可能跳错）的书签数 */
  failedCount: number;
  /** 失效书签的展示节选（最多 3 条，供弹窗提示） */
  samples: { chapterTitle: string; text: string }[];
}

/**
 * 预演“书签继承”：在【即将替换成的新章节】上尝试重新定位该书全部现有书签。
 * 与阅读时 resolveBookmarkTarget 同一口径：
 * - 能明确命中（certain）的书签视为可继承（其余保持不变）；
 * - 找不到或只能就近猜测的计入 failedCount —— 重新导入后它们会失效或跳错。
 * 只做评估，不修改任何已存数据；导入前调用方可据此提示用户或放弃重新导入。
 */
export async function previewBookmarkInheritance(
  book: LocalBook,
  nextChapters: LocalBookChapter[],
): Promise<BookmarkInheritPreview> {
  await ensureBookmarksLoaded();
  const list = bookmarksFor(book.id);
  const total = list.length;
  if (total === 0) return { total, failedCount: 0, samples: [] };

  // 模拟重新导入写入后的书籍（cid 归一化与 replaceBookContent 落库一致）
  const virtual: LocalBook = { ...book, chapters: assignChapterCids(nextChapters) };

  let failedCount = 0;
  const samples: BookmarkInheritPreview["samples"] = [];
  for (const bm of list) {
    const target = resolveBookmarkTarget(virtual, bm);
    if (target?.certain) continue;
    failedCount++;
    if (samples.length < 3) {
      const snippet = bm.text.slice(0, 48);
      samples.push({
        chapterTitle: bm.chapterTitle || `第 ${bm.chapterIndex + 1} 章`,
        text: snippet.length < bm.text.length ? `${snippet}…` : snippet,
      });
    }
  }
  return { total, failedCount, samples };
}

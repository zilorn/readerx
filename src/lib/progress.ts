/**
 * 阅读进度的文本定位工具（与书签共用同一套“章节镜像文本”坐标体系）。
 *
 * 设计要点：
 * - 进度 = 章节稳定 cid + 该章节正文镜像文本内的全局字符偏移（结构偏移），
 *   与字号、窗口宽度、分页结果无关，**不记录页码**；
 * - 恢复位置时**不靠搜索一段文字**来定位（同一段话反复出现不会跳错），
 *   结构偏移直接命中；仅当偏移处原文与存档快照不一致（内容漂移）时才降级
 *   为「快照文字 + 就近唯一匹配」兜底；
 * - 整书百分比按“正文文本字符”计算：已读章节累计字符 + 当前章节内偏移。
 */
import type { BookMeta, LocalBook, LocalBookChapter } from "./booksTypes";
import { chapterMirrorCharsOf } from "./booksTypes";
import { buildTextMirror, type TextMirror } from "./bookmarks";
import { chapterUnits } from "./pagination";

/** 存档快照长度：记录偏移处往后的正文（字符） */
export const PROGRESS_POST = 48;

/** 一条进度记录里与定位相关的字段（ShelfEntry 的投影，结构匹配即可） */
export interface ProgressLocator {
  chapter: number;
  chapterCid?: string | null;
  charOffset?: number | null;
  context?: string | null;
}

export interface ResolvedReadingTarget {
  /** 章节下标（在 book.chapters 中的位置） */
  chapterIndex: number;
  /** 章节稳定 cid */
  chapterCid: string;
  /** 章节镜像文本内的全局字符偏移 */
  charOffset: number;
  /** true = 结构偏移直接命中（可靠）；false = 靠文字就近兜底，可能有歧义 */
  certain: boolean;
}

/** 取镜像文本在偏移处**往后**的一小段（≤48 字）作定位快照；章节末尾无后继时返回空 */
export function progressContextAt(text: string, offset: number): string {
  if (!text) return "";
  const o = Math.min(Math.max(0, Math.floor(offset) || 0), text.length);
  return text.slice(o, o + PROGRESS_POST);
}

/** 章节正文镜像文本长度（p/h 文本按序拼接；图片不占字符） */
export function chapterMirrorLength(chapter: LocalBookChapter): number {
  return chapterMirrorCharsOf(chapter);
}

interface Lengths {
  /** cum[i] = 第 i 章之前全部正文的字符数（cum[0]=0，cum[n]=total） */
  cum: number[];
  total: number;
}

// 书籍导入后内容不变，按 bookId 缓存累计字符数，避免书架反复全量统计。
// 阅读器的“显示副本”（应用文本替换后）与原书同 id 但内容可能不同：
// - id 缓存只对缓存的“那一本”对象有效（记录对象引用，副本对象不复用）；
// - 另按书籍对象做 WeakMap 缓存，同一显示副本对象只重算一次。
const lengthsCache = new Map<string, { book: LocalBook; lengths: Lengths }>();
const lengthsObjectCache = new WeakMap<LocalBook, Lengths>();

function lengthsOf(book: LocalBook): Lengths {
  const byObject = lengthsObjectCache.get(book);
  if (byObject) return byObject;
  const idEntry = lengthsCache.get(book.id);
  if (idEntry && idEntry.book === book) {
    lengthsObjectCache.set(book, idEntry.lengths);
    return idEntry.lengths;
  }
  const cum: number[] = new Array(book.chapters.length + 1);
  cum[0] = 0;
  for (let i = 0; i < book.chapters.length; i++) {
    cum[i + 1] = cum[i] + chapterMirrorLength(book.chapters[i]);
  }
  const entry: Lengths = { cum, total: cum[book.chapters.length] };
  lengthsCache.set(book.id, { book, lengths: entry });
  lengthsObjectCache.set(book, entry);
  return entry;
}

/** 书籍正文被替换（WebDAV 重新导入 / 内容更新）后失效其累计字符缓存 */
export function invalidateBookLengths(bookId: string): void {
  lengthsCache.delete(bookId);
}

/**
 * 整书阅读百分比（0–100，正文字符口径）。
 * charOffset 缺省（旧数据只记了章节）按“章节开头”计。
 */
export function readingPercent(
  book: LocalBook,
  chapterIndex: number,
  charOffset: number | null | undefined,
): number {
  const { cum, total } = lengthsOf(book);
  if (total <= 0) return 0;
  const ci = Math.min(book.chapters.length - 1, Math.max(0, Math.floor(chapterIndex) || 0));
  const chapterLen = cum[ci + 1] - cum[ci];
  const inside =
    Number.isFinite(charOffset as number) && (charOffset as number) > 0
      ? Math.min(chapterLen, Math.max(0, Math.floor(charOffset as number)))
      : 0;
  return Math.min(100, ((cum[ci] + inside) / total) * 100);
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

/**
 * 把进度记录解析为当前书籍内可落地的阅读目标。
 * 步骤：
 * 1) 用 chapterCid 定位章节（缺 cid / 找不到时回退 chapter 下标并钳制）；
 * 2) 偏移落在镜像文本范围内，且偏移处原文与存档快照一致 → 直接命中；
 * 3) 不一致（内容漂移）：在镜像文本里找快照的出现位置，唯一则命中；
 *    多个则取离原偏移最近的；找不到则按钳制后的偏移返回（不保证精确）。
 */
export function resolveReadingTarget(
  book: LocalBook,
  loc: ProgressLocator,
): ResolvedReadingTarget | null {
  const chapters = book.chapters;
  if (!loc || chapters.length === 0) return null;

  let chapterIndex = loc.chapterCid
    ? chapters.findIndex((chapter) => chapter.cid === loc.chapterCid)
    : -1;
  if (chapterIndex < 0) {
    chapterIndex = Math.min(chapters.length - 1, Math.max(0, Math.floor(loc.chapter) || 0));
  }
  const chapter = chapters[chapterIndex];

  const mirror: TextMirror = buildTextMirror(chapterUnits(chapter));
  const text = mirror.text;
  const rawOffset =
    Number.isFinite(loc.charOffset as number) && (loc.charOffset as number) >= 0
      ? Math.floor(loc.charOffset as number)
      : null;

  // 只记过章节（旧数据）：回到该章节开头
  if (rawOffset === null) {
    return { chapterIndex, chapterCid: chapter.cid, charOffset: 0, certain: true };
  }
  const clamped = Math.min(text.length, rawOffset);

  // 结构偏移校验：偏移处原文与存档快照一致即直接命中（最可靠，不搜重复文字）
  if (loc.context && text.length > 0) {
    const snapshot = text.slice(clamped, clamped + loc.context.length);
    if (snapshot === loc.context) {
      return { chapterIndex, chapterCid: chapter.cid, charOffset: clamped, certain: true };
    }
    // 内容漂移兜底：按快照文字匹配，唯一优先、就近消歧
    const hits = occurrencesOf(text, loc.context);
    if (hits.length === 1) {
      return { chapterIndex, chapterCid: chapter.cid, charOffset: hits[0], certain: false };
    }
    if (hits.length > 1) {
      let best = hits[0];
      let bestDist = Number.POSITIVE_INFINITY;
      for (const hit of hits) {
        const d = Math.abs(hit - clamped);
        if (d < bestDist) {
          bestDist = d;
          best = hit;
        }
      }
      return { chapterIndex, chapterCid: chapter.cid, charOffset: best, certain: false };
    }
  }
  return { chapterIndex, chapterCid: chapter.cid, charOffset: clamped, certain: true };
}

/** 判定一条进度是否“真正读过一点”（章节内偏移 > 0 或已翻过第 1 章） */
export function hasReadingProgress(loc: ProgressLocator): boolean {
  return (loc?.chapter ?? 0) > 0 || (loc?.charOffset ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// 基于「书库元数据」（章节轻量头，无正文）的进度计算。
// 书架 / 书架搜索等页面只拿得到 BookMeta，用不到正文：章节头自带每章字符数，
// 进度百分比与「是否读完」按同一套字符口径计算，无需物化整书。
// 正文有内容的完整书（阅读页）继续走上面的 lengthsOf / resolveReadingTarget。
// ---------------------------------------------------------------------------

interface MetaLengths {
  /** cum[i] = 第 i 章之前全部正文的字符数（cum[0]=0，cum[n]=total） */
  cum: number[];
  total: number;
}

const metaLengthsCache = new WeakMap<BookMeta, MetaLengths>();

function metaLengthsOf(meta: BookMeta): MetaLengths {
  const cached = metaLengthsCache.get(meta);
  if (cached) return cached;
  const chapters = meta.chapters;
  const cum: number[] = new Array(chapters.length + 1);
  cum[0] = 0;
  for (let i = 0; i < chapters.length; i++) {
    cum[i + 1] = cum[i] + (chapters[i].chars || 0);
  }
  const entry: MetaLengths = { cum, total: cum[chapters.length] };
  metaLengthsCache.set(meta, entry);
  return entry;
}

/** 元数据版整书阅读百分比（0–100，字符口径；与完整书 readingPercent 同公式） */
export function metaReadingPercent(
  meta: BookMeta,
  chapterIndex: number,
  charOffset: number | null | undefined,
): number {
  const chapters = meta.chapters;
  const { cum, total } = metaLengthsOf(meta);
  if (total <= 0 || chapters.length === 0) return 0;
  const ci = Math.min(chapters.length - 1, Math.max(0, Math.floor(chapterIndex) || 0));
  const chapterLen = cum[ci + 1] - cum[ci];
  const inside =
    Number.isFinite(charOffset as number) && (charOffset as number) > 0
      ? Math.min(chapterLen, Math.max(0, Math.floor(charOffset as number)))
      : 0;
  return Math.min(100, ((cum[ci] + inside) / total) * 100);
}

/**
 * 元数据版阅读目标解析（书架展示用）：
 * 只做「cid 或下标 → 章节 + 偏移钳制」，不做正文漂移校验（展示口径足够）。
 */
export function metaResolveReadingTarget(
  meta: BookMeta,
  loc: ProgressLocator,
): ResolvedReadingTarget | null {
  const chapters = meta.chapters;
  if (!loc || chapters.length === 0) return null;
  let chapterIndex = loc.chapterCid
    ? chapters.findIndex((chapter) => chapter.cid === loc.chapterCid)
    : -1;
  if (chapterIndex < 0) {
    chapterIndex = Math.min(chapters.length - 1, Math.max(0, Math.floor(loc.chapter) || 0));
  }
  const chapterChars = chapters[chapterIndex].chars || 0;
  const rawOffset =
    Number.isFinite(loc.charOffset as number) && (loc.charOffset as number) >= 0
      ? Math.floor(loc.charOffset as number)
      : null;
  if (rawOffset === null) {
    return {
      chapterIndex,
      chapterCid: chapters[chapterIndex].cid,
      charOffset: 0,
      certain: true,
    };
  }
  return {
    chapterIndex,
    chapterCid: chapters[chapterIndex].cid,
    charOffset: Math.min(chapterChars, rawOffset),
    certain: true,
  };
}

/**
 * 书架卡片进度（与旧整书版 cardProgress 同一口径）：
 * 返回「是否有进度 / 是否读完 / 百分比」；读完需读到末章且 >=99.5%。
 */
export function metaCardStatus(
  meta: BookMeta,
  loc: ProgressLocator,
): { hasRead: boolean; finished: boolean; percent: number } {
  const hasRead = hasReadingProgress(loc);
  const target = metaResolveReadingTarget(meta, loc);
  const percent = Math.round(
    metaReadingPercent(
      meta,
      target?.chapterIndex ?? loc.chapter,
      target?.charOffset ?? null,
    ),
  );
  const finished =
    hasRead &&
    target !== null &&
    target.chapterIndex + 1 >= meta.chapters.length &&
    percent >= 99.5;
  return { hasRead, finished, percent: Math.max(1, Math.min(100, percent)) };
}

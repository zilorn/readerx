/**
 * PDF 分章：优先跟随 PDF 自带书签（大纲），没有可用大纲时按页累计正文字数分章。
 *
 * 与 EPUB（按 spine 目录文件成章）不同，PDF 的「页」是排版的物理单位，
 * 一页往往是半段正文；因此这里产出的是**页区间**（`start` / `end`，0 基、含首含尾），
 * 正文由 [`buildChapters`] 按区间把页拼成章节 —— 大段中间空行落在哪里由页码决定。
 *
 * 本模块是纯计算（不碰 pdf.js、不碰 DOM），可直接单测。
 */
import { t } from "../i18n";

/** 一章的页区间（0 基，含首含尾）与该章的展示标题 */
export interface PdfChapterRange {
  title: string;
  /** 起始页下标（含） */
  start: number;
  /** 结束页下标（含） */
  end: number;
  /** 大纲层级（1 为最外层）；字数分章时为 1 */
  level: number;
}

/** 每页的正文字符数（分章权重；扫描页为 0） */
export type PdfPageWeights = readonly number[];

/** 上限：单页正文字数超过它就一定不再往下并页（避免「一章只有一页」的碎片章） */
const MIN_PAGE_CHARS = 600;
/** 单章正文字数上限：超过则按页切开（PDF 大纲经常只有一个根节点） */
const MAX_CHAPTER_CHARS = 12_000;
/** 无大纲时的目标章长 */
const DEFAULT_CHAPTER_CHARS = 9_000;
/** 无大纲且没有文字层（整本扫描件）时每章页数 */
const MAX_SCAN_PAGES_PER_CHAPTER = 10;
/** 章数上限：大纲条目过多（每页一个小节）时只取靠前的层级 */
const MAX_CHAPTERS = 400;
/** 单个层级的条目数上限：某层超过它就只保留上层（大纲按页生成时逐层退让） */
const MAX_LEVEL_ENTRIES = 150;

/** PDF 大纲条目（由 pdf.js 的 outline 归一化而来） */
export interface PdfOutlineEntry {
  title: string;
  level: number;
  /** 目标页下标；解析不出（外链 / 命名目标）时为 null */
  page: number | null;
}

/** 跳过封面 / 版权页：起始页落在前几页且标题像封面时不用它当章节 */
const COVER_TITLE = /^(封面|cover|title\s*page|front\s*cover)$/i;

/**
 * 大纲是否可用：至少两条能定位到页的条目。
 * 返回过滤后的条目（去掉无标题 / 无目标页的项）。
 * 条目过多（大纲是按「每页一个小节」生成的）时只保留上层：逐层加入，
 * 一旦某层把总数抬到上限之上就停手，避免整本书被拆成几百个碎片章。
 */
export function usableOutline(
  entries: readonly PdfOutlineEntry[],
  pageCount: number,
): PdfOutlineEntry[] | null {
  const located = entries.filter(
    (entry): entry is PdfOutlineEntry & { page: number } =>
      !!entry.title.trim() && entry.page !== null && entry.page >= 0 && entry.page < pageCount,
  );
  if (located.length < 2) return null;
  // 标题完全重复（同一页被拆成多个书签）时无意义
  const titles = new Set(located.map((entry) => entry.title.trim()));
  if (titles.size < 2) return null;

  const levels = [...new Set(located.map((entry) => entry.level))].sort((a, b) => a - b);
  let kept: PdfOutlineEntry[] = [];
  for (const level of levels) {
    const next = located.filter((entry) => entry.level <= level);
    if (next.length > MAX_CHAPTERS || next.length - kept.length > MAX_LEVEL_ENTRIES) break;
    kept = next;
  }
  // 第一层就超限：退回「没有可用大纲」，由字数分章接手
  return kept.length >= 2 ? kept : null;
}

/**
 * 区间按正文字数上限切开：返回若干页区间。
 * 单页本身就超过上限时该页独占一章（不硬塞给下一页）。
 */
function splitRangeByChars(
  start: number,
  end: number,
  weights: PdfPageWeights,
  maxChars: number,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let from = start;
  let acc = 0;
  for (let page = start; page <= end; page++) {
    const weight = weights[page] ?? 0;
    // 当前章已有实质内容再开新章：避免「一页只放了 200 字」的碎片章
    if (page > from && acc + weight > maxChars && acc >= MIN_PAGE_CHARS) {
      out.push({ start: from, end: page - 1 });
      from = page;
      acc = 0;
    }
    acc += weight;
  }
  out.push({ start: from, end });
  return out;
}

/** 大纲 → 页区间：每个条目从自身目标页到「下一个同级或更外层条目」的前一页 */
export function outlineRanges(
  outline: readonly PdfOutlineEntry[],
  pageCount: number,
  weights: PdfPageWeights,
  fallbackTitle = "",
): PdfChapterRange[] {
  const entries = outline.filter(
    (entry) => entry.title.trim() && entry.page !== null && entry.page >= 0,
  );
  const ranges: PdfChapterRange[] = [];

  // 大纲第一条之前的页（书名页 / 版权页 / 目录）：记为「无标题」区间，
  // 由 mergeEmptyTitles 并进第一章，避免正文被丢掉
  const firstPage = Math.max(0, Math.min(entries[0]?.page ?? 0, pageCount - 1));
  if (firstPage > 0) {
    ranges.push({ title: "", start: 0, end: firstPage - 1, level: 1 });
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const start = Math.max(0, Math.min(entry.page ?? 0, pageCount - 1));
    let end = pageCount - 1;
    for (let j = i + 1; j < entries.length; j++) {
      const next = entries[j];
      const nextPage = next.page ?? 0;
      if (nextPage <= start) continue;
      // 同级或更外层：本章在它之前结束；更深层的小节仍属于本章
      if (next.level <= entry.level) {
        end = Math.min(pageCount - 1, nextPage - 1);
        break;
      }
    }
    if (end < start) continue;

    const title = entry.title.replace(/\s+/g, " ").trim();
    const cover = start <= 1 && COVER_TITLE.test(title);
    // 封面条目整条并入下一章（它的页归下一章开头）；其余条目按字数上限切成若干章
    if (cover) {
      ranges.push({ title: "", start, end, level: entry.level });
      continue;
    }
    const pieces = splitRangeByChars(start, end, weights, MAX_CHAPTER_CHARS);
    pieces.forEach((piece, index) => {
      ranges.push({
        // 一个条目被切开时，只有第一片继承条目标题，后续片段由 chapterTitleOf 显示页码
        title: index === 0 ? title : "",
        start: piece.start,
        end: piece.end,
        level: entry.level,
      });
    });
  }

  return mergeEmptyTitles(ranges, pageCount, fallbackTitle);
}

/**
 * 标题为空的区间并入下一章（封面 / 版权页）：起点提前到本区间起点，
 * 其余字段沿用下一章。末尾没有下一章时，本区间单独成章并用书名兜底。
 */
function mergeEmptyTitles(
  ranges: readonly PdfChapterRange[],
  pageCount: number,
  fallbackTitle: string,
): PdfChapterRange[] {
  const out: PdfChapterRange[] = [];
  let pendingStart: number | null = null;
  for (const range of ranges) {
    if (!range.title) {
      pendingStart = pendingStart === null ? range.start : Math.min(pendingStart, range.start);
      continue;
    }
    out.push(pendingStart === null ? range : { ...range, start: pendingStart });
    pendingStart = null;
  }
  if (pendingStart !== null && pendingStart < pageCount) {
    out.push({ title: fallbackTitle, start: pendingStart, end: pageCount - 1, level: 1 });
  }
  // 区间非法（起止颠倒：前导区间与封面条目落在同一页时可能出现）直接丢弃，
  // 否则会多出一个空章
  return out.filter((range) => range.end >= range.start);
}

/** 无大纲：按累计正文字数分章；整本没有文字层时按固定页数分章（扫描件） */
export function chunkRanges(
  pageCount: number,
  weights: PdfPageWeights,
  targetChars = DEFAULT_CHAPTER_CHARS,
): PdfChapterRange[] {
  if (pageCount <= 0) return [];
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    const out: PdfChapterRange[] = [];
    for (let start = 0; start < pageCount; start += MAX_SCAN_PAGES_PER_CHAPTER) {
      out.push({
        title: "",
        start,
        end: Math.min(pageCount - 1, start + MAX_SCAN_PAGES_PER_CHAPTER - 1),
        level: 1,
      });
    }
    return out;
  }
  const pieces = splitRangeByChars(0, pageCount - 1, weights, targetChars);
  return pieces.map((piece) => ({ ...piece, title: "", level: 1 }));
}

/** 章节标题兜底：没有标题时用「第 N 页」「第 N–M 页」 */
function pageRangeTitle(range: PdfChapterRange): string {
  return range.start === range.end
    ? t("library.pdf.page", { page: range.start + 1 })
    : t("library.pdf.pageRange", { start: range.start + 1, end: range.end + 1 });
}

/** 章节标题：大纲标题 + 页码范围（同一标题跨多页时便于定位） */
export function chapterTitleOf(range: PdfChapterRange): string {
  const title = range.title.trim();
  const pages = pageRangeTitle(range);
  return title ? t("library.pdf.chapterTitle", { title, pages }) : pages;
}

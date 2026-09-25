/**
 * 书签搜索：在「书签所在章节名」与「书签正文」上做子串匹配，供书签面板筛选并高亮命中。
 *
 * - 章节名命中 ⇒ 该章全部书签都算命中（“按章节找书签”）；否则只留正文命中的条目；
 * - 正文命中时按命中位置开窗（命中前留少量上文），长书签不会因为命中落在开头预览之外
 *   而看起来“没高亮”；
 * - 只做子串匹配：命中区间可直接用于高亮，结果可预测（不做模糊 / 拼音匹配）。
 */
import { type Bookmark, bookmarkChapterLabel } from "./bookmarks";

/** 相对某段展示文本的命中区间 */
export interface BookmarkMark {
  from: number;
  to: number;
}

export interface BookmarkMatch {
  bookmark: Bookmark;
  /** 所属章节展示名（无标题时「第 N 章」） */
  label: string;
  /** 章节名内的命中区间 */
  labelMarks: BookmarkMark[];
  /** 章节名命中：本章书签全部入选，卡片正文可能没有高亮 */
  chapterHit: boolean;
  /** 正文展示窗口（有正文命中时是命中附近的一段，否则是开头预览） */
  windowText: string;
  /** 窗口文本内的命中区间 */
  textMarks: BookmarkMark[];
  /** 窗口首 / 尾被截断（省略号） */
  lead: boolean;
  trail: boolean;
}

/** 未搜索时的正文预览长度 */
const PREVIEW_CHARS = 64;
/** 正文命中窗口：命中前保留的字符数 */
const LEAD_CHARS = 12;
/** 正文命中窗口总长（够卡片两行展示） */
const WINDOW_CHARS = 88;

/** 收集 text 中 needle 的全部出现位置（非重叠，按先后顺序） */
function scanAll(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let from = 0;
  for (;;) {
    const hit = text.indexOf(needle, from);
    if (hit < 0) break;
    out.push(hit);
    from = hit + needle.length;
  }
  return out;
}

/** needle 是否含大小写字符（纯中文 / 数字 / 标点无需折叠文本即可比较） */
function hasCasedChars(needle: string): boolean {
  return needle.toLowerCase() !== needle.toUpperCase();
}

/**
 * 大小写不敏感地收集 needle 的全部出现位置。
 * 折叠大小写会改变长度时（个别 Unicode 字符）退回原样比较 —— 偏移必须始终能落回原文。
 */
export function indexOfAll(text: string, needle: string): number[] {
  if (!text || !needle) return [];
  if (!hasCasedChars(needle)) return scanAll(text, needle);
  const foldedText = text.toLowerCase();
  const foldedNeedle = needle.toLowerCase();
  if (foldedText.length !== text.length || foldedNeedle.length !== needle.length) {
    return scanAll(text, needle);
  }
  return scanAll(foldedText, foldedNeedle);
}

/** 正文展示窗口：有命中则围绕首个命中开窗，否则取开头预览 */
function textWindow(
  bookmark: Bookmark,
  textMarks: BookmarkMark[],
): Pick<BookmarkMatch, "windowText" | "textMarks" | "lead" | "trail"> {
  const text = bookmark.text;
  const first = textMarks[0];
  if (!first) {
    const windowText = text.slice(0, PREVIEW_CHARS);
    return { windowText, textMarks: [], lead: false, trail: windowText.length < text.length };
  }
  const start = Math.max(0, first.from - LEAD_CHARS);
  const end = Math.min(text.length, Math.max(start + WINDOW_CHARS, first.to));
  const windowText = text.slice(start, end);
  return {
    windowText,
    textMarks: indexOfAll(windowText, text.slice(first.from, first.to)).map((from) => ({
      from,
      to: from + (first.to - first.from),
    })),
    lead: start > 0,
    trail: end < text.length,
  };
}

/** needle 在 text 中的全部命中区间 */
function marksIn(text: string, needle: string): BookmarkMark[] {
  return indexOfAll(text, needle).map((from) => ({ from, to: from + needle.length }));
}

/**
 * 按关键词筛出书签条目。
 * 关键词为空时返回全部书签的预览条目（面板“未搜索”状态直接用同一份结构渲染）。
 * 顺序与传入的 bookmarks 一致，排序 / 分组由面板负责。
 */
export function matchBookmarks(bookmarks: Bookmark[], query: string): BookmarkMatch[] {
  const needle = query.trim();
  const out: BookmarkMatch[] = [];
  for (const bookmark of bookmarks) {
    const label = bookmarkChapterLabel(bookmark);
    if (!needle) {
      out.push({
        bookmark,
        label,
        labelMarks: [],
        chapterHit: false,
        ...textWindow(bookmark, []),
      });
      continue;
    }
    const labelMarks = marksIn(label, needle);
    const textMarks = marksIn(bookmark.text, needle);
    // 章节名命中 ⇒ 整章保留（正文里可能根本没有这个词）；否则只留正文命中的条目
    if (labelMarks.length === 0 && textMarks.length === 0) continue;
    out.push({
      bookmark,
      label,
      labelMarks,
      chapterHit: labelMarks.length > 0,
      ...textWindow(bookmark, textMarks),
    });
  }
  return out;
}

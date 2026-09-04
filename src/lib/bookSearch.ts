/**
 * 全书搜索：在「章节标题」与「章节正文镜像文本」上做精确子串匹配。
 *
 * 坐标约定与进度/书签一致：
 * - 标题命中 = 章节标题（chapter.title）内出现关键词；
 * - 正文命中 = 章节镜像文本（chapterUnits 里 p/h 按序拼接，见 buildTextMirror）
 *   内出现关键词，区间 [start, end) 可直接用于阅读页按字符高亮落位。
 *
 * 章节镜像按 book 对象做 WeakMap 缓存（书籍内容导入后不变；重新导入会换新对象，
 * 旧缓存自然失效），切换搜索范围时无需重新拼装文本。
 */
import type { LocalBook } from "./booksTypes";
import { buildTextMirror, type TextMirror } from "./bookmarks";
import { chapterUnits } from "./pagination";

/** 搜索范围：全部 / 仅标题 / 仅正文 */
export type BookSearchScope = "all" | "title" | "body";

export interface SearchMark {
  /** 相对展示窗口文本的区间 */
  from: number;
  to: number;
}

export interface BookSearchHit {
  kind: "title" | "body";
  chapterIndex: number;
  chapterCid: string;
  chapterTitle: string;
  /** 正文命中的镜像文本区间（标题命中为 0/0，仅作占位） */
  start: number;
  end: number;
  /** 展示窗口文本：标题命中=整条章标题；正文命中=命中附近的一段 */
  windowText: string;
  /** 窗口文本内所有命中区间（高亮绘制用） */
  marks: SearchMark[];
  /** 窗口文本首/尾是否被截断（正文命中省略号显示用） */
  lead: boolean;
  trail: boolean;
}

export interface BookSearchOutcome {
  hits: BookSearchHit[];
  /** 命中总数超过上限被截断 */
  truncated: boolean;
}

/** 单次搜索结果条数上限（超出即停止继续扫描，避免大书/常见词刷屏） */
const MAX_RESULTS = 200;
/** 正文命中窗口：命中前保留的字符数 */
const LEAD_CHARS = 16;
/** 正文命中窗口：命中后追加的字符数 */
const TRAIL_CHARS = 42;

const mirrorCache = new WeakMap<LocalBook, (TextMirror | undefined)[]>();

/** 取某章正文镜像（按需构建一次并缓存） */
function mirrorAt(book: LocalBook, chapterIndex: number): TextMirror {
  let list = mirrorCache.get(book);
  if (!list) {
    list = new Array<TextMirror | undefined>(book.chapters.length);
    mirrorCache.set(book, list);
  }
  let mirror = list[chapterIndex];
  if (!mirror) {
    mirror = buildTextMirror(chapterUnits(book.chapters[chapterIndex]));
    list[chapterIndex] = mirror;
  }
  return mirror;
}

/** 非重叠地收集 text 中全部 keyword 出现位置 */
function occurrencesIn(text: string, keyword: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const hit = text.indexOf(keyword, from);
    if (hit < 0) break;
    out.push(hit);
    from = hit + keyword.length;
  }
  return out;
}

/**
 * 全书搜索。
 * - 命中按章节序 + 章内位置排列；标题命中排在正文命中前；
 * - 命中总数达到上限即停止（truncated 置位），保证超大书/常见词可用。
 */
export function searchBookText(
  book: LocalBook,
  keyword: string,
  scope: BookSearchScope,
): BookSearchOutcome {
  const empty: BookSearchOutcome = { hits: [], truncated: false };
  const needle = keyword.trim();
  if (!book || !needle) return empty;

  const hits: BookSearchHit[] = [];
  const scanTitle = scope === "all" || scope === "title";
  const scanBody = scope === "all" || scope === "body";

  outer: for (let ci = 0; ci < book.chapters.length; ci++) {
    const chapter = book.chapters[ci];

    if (scanTitle) {
      if (chapter.title.includes(needle)) {
        const positions = occurrencesIn(chapter.title, needle);
        hits.push({
          kind: "title",
          chapterIndex: ci,
          chapterCid: chapter.cid,
          chapterTitle: chapter.title,
          start: 0,
          end: 0,
          windowText: chapter.title,
          marks: positions.map((p) => ({ from: p, to: p + needle.length })),
          lead: false,
          trail: false,
        });
        if (hits.length >= MAX_RESULTS) break outer;
      }
    }

    if (scanBody) {
      const text = mirrorAt(book, ci).text;
      if (!text) continue;
      let from = 0;
      for (;;) {
        const hit = text.indexOf(needle, from);
        if (hit < 0) break;
        const w0 = Math.max(0, hit - LEAD_CHARS);
        const w1 = Math.min(text.length, hit + needle.length + TRAIL_CHARS);
        const windowText = text.slice(w0, w1);
        hits.push({
          kind: "body",
          chapterIndex: ci,
          chapterCid: chapter.cid,
          chapterTitle: chapter.title,
          start: hit,
          end: hit + needle.length,
          windowText,
          marks: occurrencesIn(windowText, needle).map((p) => ({
            from: p,
            to: p + needle.length,
          })),
          lead: w0 > 0,
          trail: w1 < text.length,
        });
        if (hits.length >= MAX_RESULTS) {
          return { hits, truncated: true };
        }
        from = hit + needle.length;
      }
    }
  }
  return { hits, truncated: hits.length >= MAX_RESULTS };
}

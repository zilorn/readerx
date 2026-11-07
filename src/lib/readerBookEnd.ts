/**
 * 全书末尾的虚拟完结页。
 *
 * 它不是章节分页的一页：不进入 `pagination` 的页数组，也不改阅读进度的字符偏移。
 * 左右翻页在最后一章的最后一屏之后再翻一次才进入；双页模式一次翻一屏，完结页占整屏。
 * 再往后没有下一页。回翻回到进入前的那一屏正文。
 */

/** 翻页预览用的完结页标记。屏首下标从 0 起，不会和正文屏冲突。 */
export const BOOK_END_PREVIEW = -1;

export interface BookEndStepInput {
  dir: 1 | -1;
  /** 当前已经停在完结页 */
  atEnd: boolean;
  /** 当前屏首之后还有本章正文页 */
  hasNextContent: boolean;
  isLastChapter: boolean;
  /** 本章分页已就绪。未就绪时不能进入完结页 */
  hasPages: boolean;
}

/** 完结页上的一次翻页。null 表示这次仍属于正文屏或跨章，由调用方处理。 */
export interface BookEndStep {
  atEnd: boolean;
  /** false：已经在书末，这次向前翻页没有位移 */
  moved: boolean;
}

export function stepBookEnd(input: BookEndStepInput): BookEndStep | null {
  if (input.atEnd) {
    if (input.dir < 0) return { atEnd: false, moved: true };
    return { atEnd: true, moved: false };
  }
  if (!input.hasPages || input.dir < 0) return null;
  if (input.isLastChapter && !input.hasNextContent) return { atEnd: true, moved: true };
  return null;
}

export type BookEndDragTarget = "content" | "end" | "back" | "cross" | "none";

/**
 * 纸张拖动的目标。
 * `content` 是本章内的下一屏；`end` 是完结页；`back` 是从完结页回到当前正文屏；
 * `cross` 是跨章（目标正文可能还没排好）；`none` 是书的第一屏之前或完结页之后。
 */
export function bookEndDragTarget(input: {
  dir: 1 | -1;
  atEnd: boolean;
  nextSpread: number;
  totalPages: number;
  isLastChapter: boolean;
  isFirstChapter: boolean;
}): BookEndDragTarget {
  // 完结页的页码仍停在最后一屏，必须先于「下一屏是否落在本章」判断，
  // 否则回翻会跳过这屏正文、直接预览再上一屏。
  if (input.atEnd) return input.dir < 0 ? "back" : "none";
  if (input.nextSpread >= 0 && input.nextSpread < input.totalPages) return "content";
  if (input.dir > 0 && input.isLastChapter && input.totalPages > 0) return "end";
  if (input.dir > 0 ? input.isLastChapter : input.isFirstChapter) return "none";
  return "cross";
}

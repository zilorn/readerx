/**
 * 分页引擎：把“章节数据”切成适应一屏的“页片段”。
 *
 * 原理（引擎无关，不依赖 CSS 多栏在 WebKit/Blink 上的实现差异）：
 * 1. 用一个隐藏的测量容器，以与阅读器完全相同的行内样式排版待测文本；
 * 2. 读取真实布局高度：等行高纯文本块高度 = 行数 × 行高；
 * 3. 贪心填页；段落放不下时按“前缀高度 ≤ 剩余空间”二分求本页能容纳的字符数，
 *    段落在页边界处切开，续接片段从下一页顶部继续，全程不丢字。
 *
 * 测量与渲染共用本模块导出的版式构造器（inline style），保证两者排版一致。
 */
import type { LocalBookChapter } from "./booksTypes";

/** 章内内容单元（TXT 的 paragraphs 也会归一化成该结构） */
export type ReaderBlock =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "img"; src: string; alt?: string };

export const READING_LINE_HEIGHT = 1.95;
export const READING_LETTER_SPACING_EM = 0.01;
export const READING_INDENT_EM = 2;

/** 分页几何参数（px / em，由阅读页实测后传入） */
export interface PaginateLayout {
  /** 正文列宽（不含页面左右留白）px */
  textWidth: number;
  /** 单页正文可用高度 px */
  pageHeight: number;
  /** 正文字号 px */
  fontSize: number;
  /** 段落后间距 em */
  paraSpacingEm: number;
  /** 图片最大显示高度 px */
  imageCapHeight: number;
}

/** 一页上的展示片段 */
export type PageFragment =
  | { kind: "title"; title: string; author: string | null }
  | {
      kind: "p";
      text: string;
      indent: boolean;
      end: boolean;
      /** 所属正文单元在 chapterUnits 中的序号（书签/定位用） */
      unit: number;
      /** 该片段文本在单元原文中的起始字符偏移 */
      cstart: number;
    }
  | {
      kind: "h";
      level: number;
      text: string;
      unit: number;
      cstart: number;
    }
  | { kind: "img"; src: string; alt?: string; w: number; h: number };

export interface PaginatedChapter {
  /** 每页的片段序列（页 0 起始含章节标题） */
  pages: PageFragment[][];
}

/** 把章节内容归一化成统一单元序列（图片缺失也保留占位） */
export function chapterUnits(chapter: LocalBookChapter): ReaderBlock[] {
  const blocks = chapter.blocks;
  if (blocks && blocks.length > 0) {
    return blocks.map((block) => {
      if (block.kind === "img") {
        return { kind: "img", src: block.src, alt: block.alt };
      }
      if (block.kind === "h") {
        return { kind: "h", level: block.level ?? 3, text: block.text };
      }
      return { kind: "p", text: block.text };
    });
  }
  return chapter.paragraphs.map((text) => ({ kind: "p", text }));
}

/** 章节正文纯文本 */
export function chapterText(chapter: LocalBookChapter): string {
  return chapterUnits(chapter)
    .map((unit) => (unit.kind === "p" || unit.kind === "h" ? unit.text : ""))
    .join("");
}

// ---------------------------------------------------------------------------
// 图片尺寸解码（解码结果全局缓存，data URL 幂等）
// ---------------------------------------------------------------------------

const imageSizeCache = new Map<string, Promise<{ w: number; h: number } | null>>();

/** 取图片原始尺寸；解码失败/空地址返回 null */
export function decodeImageSize(src: string): Promise<{ w: number; h: number } | null> {
  if (!src) return Promise.resolve(null);
  const cached = imageSizeCache.get(src);
  if (cached) return cached;
  const task = new Promise<{ w: number; h: number } | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
  imageSizeCache.set(src, task);
  return task;
}

// ---------------------------------------------------------------------------
// 版式行内样式（阅读器渲染与本模块测量共用，避免两处样式漂移）
// ---------------------------------------------------------------------------

export type CssRecord = Record<string, string | number>;

function em(px: number, emValue: number): number {
  return px * emValue;
}

/** 正文包裹层（页面 / 滚动内容）的通用行内样式 */
export function readingBaseStyle(layout: PaginateLayout): CssRecord {
  return {
    "font-size": `${layout.fontSize}px`,
    "line-height": READING_LINE_HEIGHT,
    "font-family": `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`,
  };
}

/** 段落 <p> 行内样式（end=是否为本自然段的结尾片段） */
export function paragraphStyle(
  layout: PaginateLayout,
  indent: boolean,
  end: boolean,
): CssRecord {
  return {
    margin: `0 0 ${end ? `${layout.paraSpacingEm}em` : 0}`,
    "text-indent": indent ? `${READING_INDENT_EM}em` : "0",
    "text-align": "justify",
    "letter-spacing": `${READING_LETTER_SPACING_EM}em`,
  };
}

/** 章内副标题 <hN> 行内样式（自带尾部间距，参与分页记账） */
export function headingStyle(layout: PaginateLayout, level: number): CssRecord {
  const ratio = level <= 3 ? 1.15 : 1.05;
  return {
    margin: "0 0 0.95em",
    "font-weight": 600,
    "letter-spacing": "0.04em",
    "line-height": 1.5,
    "font-size": `${(ratio * layout.fontSize).toFixed(2)}px`,
  };
}

/** 章节标题外层容器（自带尾部间距，参与分页记账） */
export function titleWrapperStyle(): CssRecord {
  return { margin: "0 0 1.05em" };
}

/** 章节标题文本 */
export function titleTextStyle(layout: PaginateLayout): CssRecord {
  return {
    margin: "0",
    "text-align": "center",
    "font-weight": 700,
    "letter-spacing": "0.05em",
    "line-height": 1.45,
    "font-size": `${(1.35 * layout.fontSize).toFixed(2)}px`,
  };
}

/** 章节标题下的作者行 */
export function titleAuthorStyle(layout: PaginateLayout): CssRecord {
  return {
    margin: "0.4em 0 0",
    "text-align": "center",
    color: "var(--text-3)",
    "font-size": `${(0.62 * layout.fontSize).toFixed(2)}px`,
    "letter-spacing": "0.3em",
  };
}

/** 图片外框行内样式 */
export function figureStyle(): CssRecord {
  return {
    margin: "0 0 1em",
    "text-align": "center",
  };
}

/** 图片缺失占位高度 px（内容高；外框另加 1em 间距） */
export const MISSING_IMAGE_HEIGHT = 150;

// ---------------------------------------------------------------------------
// 测量
// ---------------------------------------------------------------------------

interface Measurer {
  /** 一段文本（按 indent 首行缩进）的高度 px */
  heightText(text: string, indent: boolean): number;
  /** 副标题块高度 px（不含尾部间距） */
  heightHeading(level: number, text: string): number;
  /** 章节标题块内容高度 px（含作者行，不含外框尾部间距） */
  heightTitle(title: string, author: string | null): number;
  dispose(): void;
}

function buildMeasurer(layout: PaginateLayout): Measurer {
  const root = document.createElement("div");
  Object.assign(root.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${layout.textWidth}px`,
    visibility: "hidden",
    "pointer-events": "none",
  });
  Object.assign(root.style, readingBaseStyle(layout));
  document.body.appendChild(root);

  const measureElement = (el: HTMLElement): number => {
    root.textContent = "";
    root.appendChild(el);
    return el.getBoundingClientRect().height;
  };

  return {
    heightText(text: string, indent: boolean) {
      const el = document.createElement("p");
      Object.assign(el.style, paragraphStyle(layout, indent, false));
      el.textContent = text;
      return measureElement(el);
    },
    heightHeading(level: number, text: string) {
      const el = document.createElement("h3");
      Object.assign(el.style, headingStyle(layout, level));
      el.textContent = text;
      return measureElement(el);
    },
    heightTitle(title: string, author: string | null) {
      const wrapper = document.createElement("div");
      Object.assign(wrapper.style, titleWrapperStyle());
      const titleEl = document.createElement("p");
      Object.assign(titleEl.style, titleTextStyle(layout));
      titleEl.textContent = title;
      wrapper.appendChild(titleEl);
      if (author) {
        const authorEl = document.createElement("p");
        Object.assign(authorEl.style, titleAuthorStyle(layout));
        authorEl.textContent = author;
        wrapper.appendChild(authorEl);
      }
      return measureElement(wrapper);
    },
    dispose() {
      root.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// 填页
// ---------------------------------------------------------------------------

/** 图片等比缩放后的展示尺寸；解码失败/无地址返回 missing */
function imageDisplaySize(
  layout: PaginateLayout,
  natural: { w: number; h: number } | null,
): { w: number; h: number; missing: boolean } {
  if (!natural || natural.w <= 0 || natural.h <= 0) {
    return { w: 0, h: 0, missing: true };
  }
  const scale = Math.min(
    layout.textWidth / natural.w,
    layout.imageCapHeight / natural.h,
    1,
  );
  return {
    w: Math.round(natural.w * scale),
    h: Math.round(natural.h * scale),
    missing: false,
  };
}

/**
 * 把章节切成页。
 * - layout 几何必须有效；
 * - 章节内图片需先经 decodeImageSize 解码并把结果放进 imageSizes，
 *   否则返回 null（调用方等图片就绪后重试）。
 */
export function paginateChapter(
  chapter: LocalBookChapter,
  author: string | null,
  layout: PaginateLayout,
  imageSizes: Map<string, { w: number; h: number } | null>,
): PaginatedChapter | null {
  const pageHeight = layout.pageHeight;
  if (pageHeight <= 0 || layout.textWidth <= 0) return null;

  const units = chapterUnits(chapter);
  for (const unit of units) {
    if (unit.kind === "img" && !imageSizes.has(unit.src)) return null;
  }

  const measurer = buildMeasurer(layout);
  const pages: PageFragment[][] = [];
  let current: PageFragment[] = [];
  let used = 0; // 下一页块将从该纵向位置开始（含此前尾部间距）

  const flush = (): void => {
    if (current.length > 0) pages.push(current);
    current = [];
    used = 0;
  };
  const lineHeightPx = layout.fontSize * READING_LINE_HEIGHT;

  /** 放置不可切分的原子块（contentHeight 为内容高，marginPx 为尾部间距） */
  const pushAtomic = (
    fragment: PageFragment,
    contentHeight: number,
    marginPx: number,
  ): void => {
    if (current.length > 0 && used + contentHeight + marginPx > pageHeight + 0.5) {
      flush();
    }
    current.push(fragment);
    used += contentHeight + marginPx;
  };

  /** 二分求 text 中高度不超过 availPx 的最长前缀字符数 */
  const fitPrefix = (text: string, indent: boolean, availPx: number): number => {
    if (text.length === 0) return 0;
    if (measurer.heightText(text, indent) <= availPx + 0.5) return text.length;
    let lo = 0;
    let hi = text.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (measurer.heightText(text.slice(0, mid), indent) <= availPx + 0.5) lo = mid;
      else hi = mid;
    }
    return lo;
  };

  /** 放置一段正文（必要时跨页切分；marginPx 为其结束后的段落间距） */
  const pushParagraph = (text: string, marginPx: number, unitIdx: number): void => {
    let rest = text;
    let first = true; // 是否源段落的第一段（决定首行缩进）
    while (rest.length > 0) {
      const remaining = pageHeight - used;
      // 本片段在源段落中的起始偏移（rest 恒为 text 的后缀）
      const cstart = text.length - rest.length;
      if (current.length === 0 && remaining < lineHeightPx) {
        // 保护：极小可用高度也不死循环（现实不会触发）
        current.push({ kind: "p", text: rest, indent: first, end: true, unit: unitIdx, cstart });
        used = pageHeight;
        return;
      }
      const fullHeight = measurer.heightText(rest, first);
      if (remaining >= fullHeight - 0.5) {
        // 整段（或该页能容纳其全部行）直接收尾；尾部间距随后续内容生效
        current.push({ kind: "p", text: rest, indent: first, end: true, unit: unitIdx, cstart });
        used += fullHeight + marginPx;
        return;
      }
      // 整段放不下：按剩余行高二分，把能放的前缀留本页
      const avail = Math.max(0, remaining);
      if (current.length > 0 && avail < lineHeightPx) {
        flush();
        continue;
      }
      const count = fitPrefix(rest, first, avail);
      if (count <= 0) {
        flush();
        continue;
      }
      if (count >= rest.length) {
        current.push({ kind: "p", text: rest, indent: first, end: true, unit: unitIdx, cstart });
        used += measurer.heightText(rest, first) + marginPx;
        return;
      }
      const prefix = rest.slice(0, count);
      current.push({ kind: "p", text: prefix, indent: first, end: false, unit: unitIdx, cstart });
      used += measurer.heightText(prefix, first);
      rest = rest.slice(count);
      first = false;
      flush();
    }
  };

  // 章节标题块（内容高含作者行；外框自带 1.05em 尾部间距）
  const authorDisplay =
    author && author !== "佚名" ? `${author} 著` : null;
  const titleHeight = measurer.heightTitle(chapter.title, authorDisplay);
  pushAtomic(
    { kind: "title", title: chapter.title, author: authorDisplay },
    titleHeight,
    em(layout.fontSize, 1.05),
  );

  const paraMarginPx = em(layout.fontSize, layout.paraSpacingEm);
  units.forEach((unit, idx) => {
    if (unit.kind === "p") {
      pushParagraph(unit.text, paraMarginPx, idx);
      return;
    }
    if (unit.kind === "h") {
      const h = measurer.heightHeading(unit.level, unit.text);
      pushAtomic(
        { kind: "h", level: unit.level, text: unit.text, unit: idx, cstart: 0 },
        h,
        em(layout.fontSize, 0.95),
      );
      return;
    }
    const natural = imageSizes.get(unit.src) ?? null;
    const disp = imageDisplaySize(layout, natural);
    if (disp.missing) {
      pushAtomic(
        { kind: "img", src: unit.src, alt: unit.alt, w: 0, h: 0 },
        MISSING_IMAGE_HEIGHT,
        em(layout.fontSize, 1),
      );
    } else {
      pushAtomic(
        { kind: "img", src: unit.src, alt: unit.alt, w: disp.w, h: disp.h },
        disp.h,
        em(layout.fontSize, 1),
      );
    }
  });

  flush();
  if (pages.length === 0) pages.push(current);
  measurer.dispose();
  return { pages };
}

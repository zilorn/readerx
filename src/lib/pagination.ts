/**
 * 分页引擎：把“章节数据”切成适应一屏的“页片段”。
 *
 * 原理（引擎无关，不依赖 CSS 多栏在 WebKit/Blink 上的实现差异）：
 * 1. 用一个隐藏的测量容器，以与阅读器完全相同的行内样式排版待测文本；
 * 2. 读取真实布局高度：等行高纯文本块高度 = 行数 × 行高；
 * 3. 贪心填页；段落放不下时按“前缀高度 ≤ 剩余空间”二分求本页能容纳的字符数，
 *    段落在页边界处切开，续接片段从下一页顶部继续，全程不丢字。
 *
 * 段落里的**段内插图**（`p` 块的 `imgs` 锚点）与文字同排：图片是行内的替换元素，
 * 前缀高度对字符数仍然单调（加字/加图只会更高），因此二分切分照旧成立 ——
 * 渲染侧按同一套行内样式（[`inlineImageStyle`]）摆放，测量与渲染保持一致。
 *
 * 测量与渲染共用本模块导出的版式构造器（inline style），保证两者排版一致。
 */
import { normalizeInlineImages, type LocalBookChapter } from "./booksTypes";
import { t } from "./i18n";
import { createLogger } from "./logger";

/** 分页排版的日志出口：只在排版异常退回未分页时留一条 warn */
const log = createLogger("pagination");

/** 章节单元里的图片引用（块级图 / 段内图共用） */
export interface ReaderImageRef {
  /** 可直接渲染的地址（在线书为网络地址）；老数据可能是 data URL */
  src: string;
  alt?: string;
  /** 在线书：图片原始网络地址（图片身份） */
  remote?: string;
  /** 已下载副本的文件名（应用数据目录 images/ 下） */
  local?: string;
}

/** 段内图片锚点（`at` 为段内文本的 UTF-16 偏移；图片本身不占字符） */
export type ReaderInlineImage = ReaderImageRef & { at: number };

/** 章内内容单元（TXT 的 paragraphs 也会归一化成该结构） */
export type ReaderBlock =
  | { kind: "p"; text: string; imgs?: ReaderInlineImage[] }
  | { kind: "h"; level: number; text: string }
  | ({ kind: "img" } & ReaderImageRef);

/** 单元里的全部图片（img 块自身 / p 块的段内锚点），按出现顺序 */
export function unitImages(unit: ReaderBlock): ReaderImageRef[] {
  if (unit.kind === "img") return [unit];
  if (unit.kind === "p") return unit.imgs ?? [];
  return [];
}

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

/** 页片段里的段内插图：`at` 相对**本片段**文本起点，尺寸为排版算好的展示尺寸 */
export type PageInlineImage = ReaderInlineImage & { w: number; h: number };

/** 段落内容里的一段：文字片段（带标记）或一张段内插图 */
export type ParagraphPiece =
  | { kind: "text"; text: string; at: number }
  | { kind: "img"; img: ReaderInlineImage & { w?: number; h?: number }; at: number };

/**
 * 段落文本按段内插图锚点切成「文字片段 / 图片」序列（图片不占字符）。
 * 渲染侧据此把文字与图片按原位交错摆放；`at` 为片段内相对偏移。
 */
export function splitParagraphPieces(
  text: string,
  imgs: readonly ReaderInlineImage[] | undefined,
): ParagraphPiece[] {
  if (!imgs || imgs.length === 0) return [{ kind: "text", text, at: 0 }];
  const pieces: ParagraphPiece[] = [];
  let cursor = 0;
  for (const img of imgs) {
    const at = Math.max(cursor, Math.min(img.at, text.length));
    if (at > cursor) pieces.push({ kind: "text", text: text.slice(cursor, at), at: cursor });
    pieces.push({ kind: "img", img, at });
    cursor = at;
  }
  if (cursor < text.length) pieces.push({ kind: "text", text: text.slice(cursor), at: cursor });
  return pieces;
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
      /** 本片段内联的段内插图（按 at 升序；`at` 相对本片段文本） */
      imgs?: readonly PageInlineImage[];
    }
  | {
      kind: "h";
      level: number;
      text: string;
      unit: number;
      cstart: number;
    }
  | ({
      kind: "img";
      w: number;
      h: number;
    } & ReaderImageRef);

export interface PaginatedChapter {
  /** 每页的片段序列（页 0 起始含章节标题） */
  pages: PageFragment[][];
}

/**
 * 图片尺寸表的键：优先**网络地址**（图片身份）—— 分页视图与「本会话刚下载好、块还没回写」
 * 的视图在这上面一致；其次是可渲染地址；只有连地址都没有的本地副本才退到文件名
 * （本地 / EPUB 图迁移后 `src` 可能为空，多张图会撞到同一个空串键）。
 */
export function readerImageKey(unit: { src: string; local?: string; remote?: string }): string {
  if (unit.remote) return unit.remote;
  if (unit.src) return unit.src;
  return unit.local ? `local:${unit.local}` : "";
}

/** 把章节内容归一化成统一单元序列（图片缺失也保留占位） */
export function chapterUnits(chapter: LocalBookChapter): ReaderBlock[] {
  const blocks = chapter.blocks;
  if (blocks && blocks.length > 0) {
    return blocks.map((block) => {
      if (block.kind === "img") {
        return {
          kind: "img",
          src: block.src ?? "",
          alt: block.alt,
          ...(block.remote ? { remote: block.remote } : {}),
          ...(block.local ? { local: block.local } : {}),
        };
      }
      if (block.kind === "h") {
        return { kind: "h", level: block.level ?? 3, text: block.text };
      }
      const imgs = normalizeInlineImages(block.text, block.imgs)?.map(
        (img): ReaderInlineImage => ({
          at: img.at,
          src: img.src ?? "",
          ...(img.alt ? { alt: img.alt } : {}),
          ...(img.remote ? { remote: img.remote } : {}),
          ...(img.local ? { local: img.local } : {}),
        }),
      );
      return {
        kind: "p",
        text: block.text,
        ...(imgs && imgs.length > 0 ? { imgs } : {}),
      };
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

/**
 * 段内插图的行内样式：图片与文字同排（行内替换元素），垂直方向按行中线对齐。
 * **渲染与测量共用这一份数值**（[`paginateChapter`] 的测量容器也走它），
 * 两处只要有一处改了宽高/对齐，分页高度就会与真实渲染对不上。
 */
export function inlineImageStyle(w: number, h: number): CssRecord {
  return {
    width: `${w}px`,
    height: `${h}px`,
    "vertical-align": "middle",
    margin: "0 0.12em",
  };
}

/**
 * 段内插图缺失 / 尺寸未知时的占位尺寸：小方框，不打断行内节奏
 * （整行图缺失仍用 [`MISSING_IMAGE_HEIGHT`] 的大占位框）。
 */
export function inlineImagePlaceholderSize(layout: PaginateLayout): { w: number; h: number } {
  return {
    w: Math.round(Math.min(layout.textWidth, Math.max(layout.fontSize * 3, 72))),
    h: Math.round(Math.max(layout.fontSize * 1.8, 26)),
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
  /** 一段含段内插图的文本的高度 px（imgs 的 at 相对该段文本） */
  heightParagraph(
    text: string,
    imgs: readonly SizedInlineImage[],
    indent: boolean,
  ): number;
  /** 副标题块高度 px（不含尾部间距） */
  heightHeading(level: number, text: string): number;
  /** 章节标题块内容高度 px（含作者行，不含外框尾部间距） */
  heightTitle(title: string, author: string | null): number;
  dispose(): void;
}

/** 段内插图 + 已算好的展示尺寸（测量与分页片段共用） */
interface SizedInlineImage extends ReaderInlineImage {
  w: number;
  h: number;
}

/**
 * 测量用的中性占位像素（1×1 透明 GIF）：测量容器里的 `<img>` 只需要一个确定的
 * 替换元素盒子，尺寸完全由行内样式给出 —— 这样量高度时既不触网、也不解码真实图片。
 */
const MEASURE_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** 按锚点把文本与段内插图填进段落元素（测量与分页切分共用同一顺序口径） */
function fillParagraph(
  el: HTMLElement,
  text: string,
  imgs: readonly SizedInlineImage[],
): void {
  let cursor = 0;
  for (const img of imgs) {
    const at = Math.max(cursor, Math.min(img.at, text.length));
    if (at > cursor) el.appendChild(document.createTextNode(text.slice(cursor, at)));
    const node = document.createElement("img");
    Object.assign(node.style, inlineImageStyle(img.w, img.h));
    node.src = MEASURE_PIXEL;
    node.alt = "";
    el.appendChild(node);
    cursor = at;
  }
  if (cursor < text.length) el.appendChild(document.createTextNode(text.slice(cursor)));
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

  const paragraphEl = (
    text: string,
    imgs: readonly SizedInlineImage[],
    indent: boolean,
  ): HTMLParagraphElement => {
    const el = document.createElement("p");
    Object.assign(el.style, paragraphStyle(layout, indent, false));
    fillParagraph(el, text, imgs);
    return el;
  };

  return {
    heightText(text: string, indent: boolean) {
      return measureElement(paragraphEl(text, [], indent));
    },
    heightParagraph(text: string, imgs: readonly SizedInlineImage[], indent: boolean) {
      return measureElement(paragraphEl(text, imgs, indent));
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
 * 段内插图的展示尺寸：与整行图同样按「栏宽 + 高度上限」等比缩小（不放大），
 * 但高度上限另受「一页至少留得下两行文字」约束 —— 否则一个极高的图会让它所在的
 * 整段永远排不进任何一页（分页只能把整段硬塞，页面被撑破）。
 */
function inlineImageDisplaySize(
  layout: PaginateLayout,
  natural: { w: number; h: number } | null,
): { w: number; h: number; missing: boolean } {
  if (!natural || natural.w <= 0 || natural.h <= 0) {
    return { w: 0, h: 0, missing: true };
  }
  const lineHeightPx = layout.fontSize * READING_LINE_HEIGHT;
  const capHeight = Math.max(
    lineHeightPx,
    Math.min(layout.imageCapHeight, layout.pageHeight - lineHeightPx * 2),
  );
  const scale = Math.min(layout.textWidth / natural.w, capHeight / natural.h, 1);
  return {
    w: Math.round(natural.w * scale),
    h: Math.round(natural.h * scale),
    missing: false,
  };
}

/**
 * 段落里的段内插图 → 带展示尺寸的锚点（尺寸未知的用占位小方框）。
 * `at` 已由 chapterUnits 收敛到 [0, text.length] 且升序。
 */
function sizedInlineImages(
  layout: PaginateLayout,
  text: string,
  imgs: readonly ReaderInlineImage[] | undefined,
  imageSizes: Map<string, { w: number; h: number } | null>,
): SizedInlineImage[] {
  if (!imgs || imgs.length === 0) return [];
  const placeholder = inlineImagePlaceholderSize(layout);
  return imgs.map((img) => {
    const natural = imageSizes.get(readerImageKey(img)) ?? null;
    const disp = inlineImageDisplaySize(layout, natural);
    return {
      ...img,
      at: Math.min(Math.max(0, img.at), text.length),
      ...(disp.missing ? { w: placeholder.w, h: placeholder.h } : { w: disp.w, h: disp.h }),
    };
  });
}

/** 取锚点数组里 at ≤ count 的前缀（含图片数量） */
function splitInlineImages(
  imgs: readonly SizedInlineImage[],
  count: number,
): [SizedInlineImage[], SizedInlineImage[]] {
  let split = 0;
  while (split < imgs.length && imgs[split].at <= count) split++;
  return [imgs.slice(0, split), imgs.slice(split)];
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
  const steps = paginateChapterSteps(chapter, author, layout, imageSizes);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * 章节填页的可挂起序列（生成器）。
 *
 * 分页要逐段对隐藏测量容器做真实排版（每段都要强制 layout），超大章节整段同步跑
 * 会长时间占用主线程、页面直接卡死。这里把填页拆成一段段可挂起的工作：
 * 每个单元处理完、每页切分完成后 yield 一次，驱动方据此让出主线程渲染/响应；
 * 同步驱动（paginateChapter）逐次 next 拉到结束，行为与原实现完全一致。
 */
export function* paginateChapterSteps(
  chapter: LocalBookChapter,
  author: string | null,
  layout: PaginateLayout,
  imageSizes: Map<string, { w: number; h: number } | null>,
): Generator<void, PaginatedChapter | null, void> {
  const pageHeight = layout.pageHeight;
  if (pageHeight <= 0 || layout.textWidth <= 0) return null;

  const units = chapterUnits(chapter);
  for (const unit of units) {
    // 图片尺寸未知（还没量出来）时先不排：调用方补齐 imageSizes 后再来
    for (const img of unitImages(unit)) {
      if (!imageSizes.has(readerImageKey(img))) return null;
    }
  }

  const measurer = buildMeasurer(layout);
  try {
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

    /**
     * 二分求「高度不超过 availPx 的最长前缀」：返回可容纳的字符数与图片数。
     * 前缀高度对字符数单调不减（加字、加图只会更高），因此二分仍然成立。
     */
    const fitPrefix = (
      text: string,
      imgs: readonly SizedInlineImage[],
      indent: boolean,
      availPx: number,
    ): { count: number; imgs: number } => {
      if (text.length === 0) {
        // 只剩图片：能放几张是几张
        if (imgs.length > 0 && measurer.heightParagraph("", [imgs[0]], indent) <= availPx + 0.5) {
          return { count: 0, imgs: 1 };
        }
        return { count: 0, imgs: 0 };
      }
      const fits = (count: number): boolean => {
        const [head] = splitInlineImages(imgs, count);
        return measurer.heightParagraph(text.slice(0, count), head, indent) <= availPx + 0.5;
      };
      if (fits(text.length)) return { count: text.length, imgs: imgs.length };
      let lo = 0;
      let hi = text.length;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      const [head] = splitInlineImages(imgs, lo);
      return { count: lo, imgs: head.length };
    };

    /**
     * 放置一段正文（含段内插图；必要时跨页切分；marginPx 为其结束后的段落间距）。
     * 每切出一页分片即 yield 一次，让单个超长段落（跨数十页）也能被驱动方分片执行。
     *
     * `rest` 恒为段落后缀、`restImgs` 的 `at` 恒**相对 rest 起点**（切分时按消费掉的
     * 字符数重定位过）。片段文本正是 rest 的前缀，因此片段里的锚点直接取 restImgs 的
     * 前若干项即可，不需要再做偏移换算。
     */
    const pushParagraph = function* pushParagraph(
      text: string,
      imgs: readonly SizedInlineImage[],
      marginPx: number,
      unitIdx: number,
    ): Generator<void, void, void> {
      let rest = text;
      let restImgs = imgs;
      let first = true; // 是否源段落的第一段（决定首行缩进）
      while (rest.length > 0 || restImgs.length > 0) {
        yield;
        const remaining = pageHeight - used;
        // 本片段在源段落中的起始偏移（rest 恒为 text 的后缀）
        const cstart = text.length - rest.length;
        if (current.length === 0 && remaining < lineHeightPx) {
          // 保护：极小可用高度也不死循环（现实不会触发）
          current.push({
            kind: "p",
            text: rest,
            indent: first,
            end: true,
            unit: unitIdx,
            cstart,
            ...(restImgs.length > 0 ? { imgs: restImgs } : {}),
          });
          used = pageHeight;
          return;
        }
        const fullHeight = measurer.heightParagraph(rest, restImgs, first);
        if (remaining >= fullHeight - 0.5) {
          // 整段（或该页能容纳其全部行）直接收尾；尾部间距随后续内容生效
          current.push({
            kind: "p",
            text: rest,
            indent: first,
            end: true,
            unit: unitIdx,
            cstart,
            ...(restImgs.length > 0 ? { imgs: restImgs } : {}),
          });
          used += fullHeight + marginPx;
          return;
        }
        // 整段放不下：按剩余空间二分，把能放的前缀留本页
        const avail = Math.max(0, remaining);
        if (current.length > 0 && avail < lineHeightPx) {
          flush();
          continue;
        }
        let fit = fitPrefix(rest, restImgs, first, avail);
        if (fit.count <= 0 && fit.imgs <= 0) {
          if (current.length > 0) {
            flush();
            continue;
          }
          // 空页也放不下（例如单张图比一页还高）：强制前进一个最小单位，避免死循环
          fit = rest.length > 0 ? { count: 1, imgs: splitInlineImages(restImgs, 1)[0].length } : { count: 0, imgs: 1 };
        }
        if (fit.count >= rest.length && fit.imgs >= restImgs.length) {
          // 兜底：二分已判定整段可容纳（正常在上面的整段分支就返回了）
          current.push({
            kind: "p",
            text: rest,
            indent: first,
            end: true,
            unit: unitIdx,
            cstart,
            ...(restImgs.length > 0 ? { imgs: restImgs } : {}),
          });
          used += measurer.heightParagraph(rest, restImgs, first) + marginPx;
          return;
        }
        const prefix = rest.slice(0, fit.count);
        // fit.imgs 恒为 restImgs 里锚点落在本片段内的前缀长度（见 fitPrefix）
        const headImgs = restImgs.slice(0, fit.imgs);
        const restTail = restImgs.slice(fit.imgs);
        current.push({
          kind: "p",
          text: prefix,
          indent: first,
          end: false,
          unit: unitIdx,
          cstart,
          ...(headImgs.length > 0 ? { imgs: headImgs } : {}),
        });
        used += measurer.heightParagraph(prefix, headImgs, first);
        rest = rest.slice(fit.count);
        // 剩余图片的锚点重定位到新片段起点
        restImgs = restTail.map((img) => ({ ...img, at: img.at - fit.count }));
        first = false;
        flush();
      }
    };

    // 章节标题块（内容高含作者行；外框自带 1.05em 尾部间距）
    const authorDisplay =
      author && author !== "佚名"
        ? t("readerChrome.page.authorBy", { author })
        : null;
    const titleHeight = measurer.heightTitle(chapter.title, authorDisplay);
    pushAtomic(
      { kind: "title", title: chapter.title, author: authorDisplay },
      titleHeight,
      em(layout.fontSize, 1.05),
    );

    const paraMarginPx = em(layout.fontSize, layout.paraSpacingEm);
    for (let idx = 0; idx < units.length; idx++) {
      const unit = units[idx];
      if (unit.kind === "p") {
        const imgs = sizedInlineImages(layout, unit.text, unit.imgs, imageSizes);
        yield* pushParagraph(unit.text, imgs, paraMarginPx, idx);
        continue;
      }
      if (unit.kind === "h") {
        const h = measurer.heightHeading(unit.level, unit.text);
        pushAtomic(
          { kind: "h", level: unit.level, text: unit.text, unit: idx, cstart: 0 },
          h,
          em(layout.fontSize, 0.95),
        );
        continue;
      }
      const natural = imageSizes.get(readerImageKey(unit)) ?? null;
      const disp = imageDisplaySize(layout, natural);
      if (disp.missing) {
        pushAtomic(
          {
            kind: "img",
            src: unit.src,
            alt: unit.alt,
            remote: unit.remote,
            local: unit.local,
            w: 0,
            h: 0,
          },
          MISSING_IMAGE_HEIGHT,
          em(layout.fontSize, 1),
        );
      } else {
        pushAtomic(
          {
            kind: "img",
            src: unit.src,
            alt: unit.alt,
            remote: unit.remote,
            local: unit.local,
            w: disp.w,
            h: disp.h,
          },
          disp.h,
          em(layout.fontSize, 1),
        );
      }
      yield;
    }

    flush();
    if (pages.length === 0) pages.push(current);
    return { pages };
  } finally {
    measurer.dispose();
  }
}

/** 一次进行中的异步分页任务（可放弃，释放隐藏测量容器） */
export interface PaginateTask {
  /** 最终分页结果；被 cancel 或排版无效时为 null */
  readonly promise: Promise<PaginatedChapter | null>;
  /** 放弃本次分页（取消后 promise 以 null 收尾），幂等 */
  cancel(): void;
}

/** 单片连续排版最长占用主线程的时间；超过后让出，浏览器可渲染/响应 */
const PAGINATE_SLICE_MS = 14;

/**
 * 以时间分片方式执行章节分页：
 * 排版按段落/页切分挂起点切成小片，每片超过 PAGINATE_SLICE_MS 就让出主线程
 * （setTimeout(0)），超大章节既不会一次性卡死页面，也能被 cancel 及时中止。
 */
export function startChapterPagination(
  chapter: LocalBookChapter,
  author: string | null,
  layout: PaginateLayout,
  imageSizes: Map<string, { w: number; h: number } | null>,
): PaginateTask {
  const steps = paginateChapterSteps(chapter, author, layout, imageSizes);
  let cancelled = false;
  let step = steps.next();
  const started = performance.now();
  const promise = (async () => {
    try {
      let lastSliced = performance.now();
      for (;;) {
        if (cancelled) {
          steps.return(null);
          return null;
        }
        if (step.done) return step.value;
        if (performance.now() - lastSliced >= PAGINATE_SLICE_MS) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          if (cancelled) {
            steps.return(null);
            return null;
          }
          lastSliced = performance.now();
        }
        step = steps.next();
      }
    } catch (err) {
      // 排版异常会让本章回退到「未分页」渲染：原因必须留痕，否则只剩一个空白页无从排查
      log.warn(
        "章节排版失败，退回未分页渲染",
        `chapter=${chapter.title}`,
        `paragraphs=${chapter.paragraphs?.length ?? 0}`,
        `fontSize=${layout.fontSize}`,
        `ms=${Math.round(performance.now() - started)}`,
        err,
      );
      return null;
    }
  })();
  return {
    promise,
    cancel() {
      cancelled = true;
    },
  };
}

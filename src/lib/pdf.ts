/**
 * PDF 导入解析（本地书）：
 *
 * 1. **文字层优先**：逐页取 pdf.js 的文字层，按坐标还原成段落（见 [`./pdf/pdfText`]）；
 * 2. **分章**：优先跟随 PDF 自带书签（大纲），没有可用大纲时按累计正文字数分章
 *    （整本扫描件按固定页数分章），见 [`./pdf/pdfChapters`]；
 * 3. **扫描页兜底**：整本几乎没有文字层时整页渲染成图片来读，文字层的稀疏绘图页
 *    （封面 / 影印页 / 插页）同样按图渲染，见 [`./pdf/pdfPageImage`]。
 *
 * 实现分两遍读文档：
 * - 第一遍只取每页的**行**：量出每页正文字数（分章权重），并从靠前的若干页采样
 *   上下边缘的行来识别跨页重复的页眉 / 页脚；
 * - 第二遍按分好的章节区间逐页重建段落并成块 —— 因此整本文本的中间产物不会被
 *   全部留在内存里（扫描件按图渲染的页在第二遍才解码）。
 *
 * 与 EPUB 的区别：PDF 的页是排版的物理单位，章节标题因此常带「第 N–M 页」后缀；
 * 这不影响阅读页的排版 / 进度 / 书签 —— 它们只认章节与字符偏移。
 */
import type { LocalBookChapter } from "./booksTypes";
import { chapterCid } from "./booksTypes";
import {
  chunkRanges,
  chapterTitleOf,
  outlineRanges,
  usableOutline,
  type PdfChapterRange,
  type PdfOutlineEntry,
} from "./pdf/pdfChapters";
import { renderPdfCover, renderPdfPageImage } from "./pdf/pdfPageImage";
import {
  buildParagraphs,
  buildLines,
  detectRunningHeads,
  edgeLinesOf,
  runningHeadBounds,
  runningHeadFilter,
  textMetricsOf,
  type PdfTextItem,
  type RunningHeadBounds,
} from "./pdf/pdfText";
import { loadPdfJs, type PdfDocument, type PdfOutlineNode, type PdfPage } from "./pdf/pdfjs";
import { createLogger } from "./logger";

const log = createLogger("pdf");

export interface ParsedPdf {
  title: string;
  author: string;
  chapters: LocalBookChapter[];
  /** 封面缩略图（第一页渲染而成）；渲染失败时为 undefined */
  cover?: string;
}

export interface ParsePdfOptions {
  /** 书籍 id：PDF 页面图按它命名落盘（与最终落库的书 id 一致，删除书籍时一并清理） */
  bookId: string;
  /** 每章正文字数目标（无大纲时生效） */
  charsPerChapter?: number;
}

/** 判定「整本扫描件」的正文密度下限（字符 / 页）：
 *  正文页动辄几百上千字，整本都是图片的扫描件则接近 0（只有页码 / 水印）；
 *  取 120 是为了让「文字很少但图很多」的杂志 / 画册也走页面图，
 *  同时不会把「有正文但每页字数偏少」的排版（大字号、图文书）误判成扫描件。 */
const SCANNED_CHARS_PER_PAGE = 120;
/** 单页正文少于这么多字符时，若该页有绘图就按扫描页渲染（封面 / 影印页 / 插页） */
const SPARSE_PAGE_CHARS = 40;
/** 采用大纲分章的条目数上限：超过它说明大纲是「一页一条」，改按字数分章 */
const MAX_OUTLINE_CHAPTERS = 400;
/** 页眉页脚采样的页数：靠前的这些页足以代表全书（避免整本行文本留在内存里） */
const STRIP_SAMPLE_PAGES = 200;
/**
 * 「这一页画了图片」的操作符（pdf.js 的 OPS 枚举值）：
 * 只认真正的位图绘制。文字页里常见的矢量插图 / 表格线不算 —— 那些页有文字层，
 * 照常当正文读；若把它们也渲染成图片，反而会把正常的图文混排页变成图片页。
 */
const IMAGE_OPS = new Set([
  85, // paintImageXObject
  86, // paintInlineImageXObject
  87, // paintInlineImageXObjectGroup
  88, // paintImageXObjectRepeat
  89, // paintImageMaskXObjectRepeat
  90, // paintSolidColorImageMask
]);

/** 第一遍采到的每页信息 */
interface PageScan {
  /** 正文字符数（分章权重） */
  chars: number;
  /** 页面高度（PDF 用户单位），用于页眉页脚定位 */
  height: number;
  /** 该页是否是「有图的稀疏页」（渲染成图片读） */
  sparseImage: boolean;
}

async function resolvePageIndex(
  doc: PdfDocument,
  pageRefs: readonly unknown[] | null,
): Promise<number | null> {
  if (!pageRefs) return null;
  for (const ref of pageRefs) {
    try {
      if (typeof ref === "object" && ref !== null) {
        const index = await doc.getPageIndex(ref);
        if (index >= 0) return index;
      } else if (typeof ref === "string") {
        const resolved = await doc.getDestination(ref);
        const first = resolved?.[0];
        if (typeof first === "object" && first !== null) {
          const index = await doc.getPageIndex(first);
          if (index >= 0) return index;
        }
      } else if (typeof ref === "number" && ref >= 0) {
        // 目标数组里直接写页下标（0 基）
        return ref;
      }
    } catch {
      /* 解析不出的目标（外链 / 命名目标）跳过，不影响其它书签 */
    }
  }
  return null;
}

/** pdf.js 大纲树 → 带页码的扁平条目（层级即树的深度） */
async function collectOutline(
  doc: PdfDocument,
  nodes: readonly PdfOutlineNode[],
  level = 1,
  out: PdfOutlineEntry[] = [],
): Promise<PdfOutlineEntry[]> {
  for (const node of nodes) {
    const page = await resolvePageIndex(doc, node.dest as readonly unknown[] | null);
    out.push({ title: node.title ?? "", level, page });
    if (node.items && node.items.length > 0) {
      await collectOutline(doc, node.items, level + 1, out);
    }
  }
  return out;
}

/** 该页是否绘制了位图（空白页 / 纯文字页返回 false） */
async function hasGraphics(page: PdfPage): Promise<boolean> {
  try {
    const ops = await page.getOperatorList();
    for (const fn of ops.fnArray) {
      if (IMAGE_OPS.has(fn)) return true;
    }
  } catch {
    /* 操作符列表读不出来时按无图处理：文字层仍在，照常当正文 */
  }
  return false;
}

/** 文字层里的片段（过滤掉 marked content 标记） */
function textItemsOf(items: readonly unknown[]): PdfTextItem[] {
  const out: PdfTextItem[] = [];
  for (const raw of items) {
    const item = raw as Partial<PdfTextItem>;
    if (typeof item?.str !== "string" || !Array.isArray(item.transform)) continue;
    out.push({
      str: item.str,
      transform: item.transform,
      width: item.width ?? 0,
      height: item.height ?? 0,
      hasEOL: item.hasEOL ?? false,
    });
  }
  return out;
}

/**
 * 第一遍：量出每页正文字数、挑出要按图渲染的稀疏页，并识别页眉 / 页脚。
 *
 * 页眉页脚只在靠前的若干页里**采样**（页边行，交给 [`detectRunningHeads`]），
 * 但可靠性体检要用全书的正文起点（[`runningHeadsReliable`]）—— 只要有一页的正文
 * 从页边开始，就整本放弃剔除，避免误删正文。
 * 采样只保留边缘行，整本的行文本不会驻留内存。
 */
async function scanPages(
  doc: PdfDocument,
  pageCount: number,
): Promise<{ pages: PageScan[]; strips: Set<string>; bounds: RunningHeadBounds }> {
  const pages: PageScan[] = [];
  const sample: Array<{ lines: ReturnType<typeof buildLines>; height: number }> = [];
  const full: Array<{ lines: ReturnType<typeof buildLines>; height: number }> = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = textItemsOf(content.items);
    const lines = buildLines(items, textMetricsOf(items));
    const chars = buildParagraphs(lines).reduce((sum, text) => sum + text.length, 0);
    let sparseImage = false;
    if (chars < SPARSE_PAGE_CHARS && (await hasGraphics(page))) sparseImage = true;
    page.cleanup?.();
    pages.push({ chars, height: viewport.height, sparseImage });
    if (viewport.height <= 0) continue;
    if (pageNumber <= STRIP_SAMPLE_PAGES) {
      sample.push({ lines: edgeLinesOf(lines, viewport.height), height: viewport.height });
    }
    full.push({ lines, height: viewport.height });
  }
  const candidates = detectRunningHeads(sample);
  // 正文起点的判定要用全书（每页只是一次「取最高」的比较，行文本不驻留）
  const bounds = runningHeadBounds(full);
  return { pages, strips: candidates, bounds };
}

/** 该页的段落：先按坐标剔掉页眉页脚片段，再拼行、按行距合并成段 */
function paragraphsOfPage(
  items: PdfTextItem[],
  bounds: RunningHeadBounds,
  strips: ReadonlySet<string>,
): string[] {
  const drop = runningHeadFilter(bounds, strips);
  const lines = buildLines(items, textMetricsOf(items), drop);
  return buildParagraphs(lines);
}

/**
 * 第二遍：把一段页区间拼成章节。
 * 文字页拼成段落块，按图渲染的页渲染后作为图片块追加（一章内先文后图）。
 */
async function buildChapter(
  doc: PdfDocument,
  range: PdfChapterRange,
  imagePages: ReadonlySet<number>,
  strips: ReadonlySet<string>,
  bounds: RunningHeadBounds,
  options: ParsePdfOptions,
): Promise<LocalBookChapter | null> {
  const paragraphs: string[] = [];
  const images: Array<{ local?: string; src?: string; alt: string }> = [];

  for (let pageNumber = range.start + 1; pageNumber <= range.end + 1; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    if (imagePages.has(pageNumber)) {
      const image = await renderPdfPageImage(page, options.bookId, pageNumber);
      page.cleanup?.();
      if (image) {
        images.push({
          ...(image.local ? { local: image.local } : {}),
          ...(image.src ? { src: image.src } : {}),
          alt: `第 ${pageNumber} 页`,
        });
      }
      continue;
    }
    const content = await page.getTextContent();
    const text = paragraphsOfPage(textItemsOf(content.items), bounds, strips);
    page.cleanup?.();
    if (text.length === 0) continue;
    if (paragraphs.length > 0) paragraphs.push("");
    paragraphs.push(...text);
  }

  const body = paragraphs.filter(Boolean);
  if (body.length === 0 && images.length === 0) return null;

  const blocks: NonNullable<LocalBookChapter["blocks"]> = body.map((text) => ({
    kind: "p" as const,
    text,
  }));
  for (const image of images) blocks.push({ kind: "img", ...image });

  return {
    cid: chapterCid(0), // 由 assignChapterCids 统一重排
    title: chapterTitleOf(range),
    paragraphs: body,
    ...(blocks.length > 0 ? { blocks } : {}),
  };
}

/**
 * 解析 PDF 文件为书籍草稿内容。
 * `file` 必须是 `.pdf`（调用方已按扩展名判定格式）。
 */
export async function parsePdfFile(file: File, options: ParsePdfOptions): Promise<ParsedPdf> {
  const started = performance.now();
  log.debug("开始解析 PDF", `file=${file.name}`, `bytes=${file.size}`, `book=${options.bookId}`);
  const pdfjs = await loadPdfJs();
  // 直接把 ArrayBuffer 交给 pdf.js：它会转移给 worker（不再复制一份），大文件省一半内存
  const bytes = await file.arrayBuffer();
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
  const doc = await task.promise;
  try {
    const pageCount = doc.numPages;
    if (pageCount <= 0) throw new Error("PDF 没有可阅读的页面");
    const fallbackTitle = file.name.replace(/\.pdf$/i, "").trim() || "未命名";

    // 元数据：标题 / 作者缺失时退回文件名 / 佚名（与 EPUB 解析同一口径）
    let info: Record<string, unknown> = {};
    try {
      info = (await doc.getMetadata()).info ?? {};
    } catch (err) {
      /* 元数据读不出来不影响导入 */
      log.warn("PDF 元数据读取失败，退回文件名作书名", `file=${file.name}`, err);
    }
    const metaText = (key: string): string => {
      const value = info[key];
      return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    };

    const { pages, strips, bounds } = await scanPages(doc, pageCount);
    const weights = pages.map((page) => page.chars);
    const totalChars = weights.reduce((sum, chars) => sum + chars, 0);

    // 整本几乎没有文字层 → 全书按页面图阅读；否则只渲染挑出来的稀疏绘图页
    const scanned = totalChars / pageCount < SCANNED_CHARS_PER_PAGE;
    const imagePages = new Set<number>();
    if (scanned) {
      for (let page = 1; page <= pageCount; page++) imagePages.add(page);
    } else {
      pages.forEach((page, index) => {
        if (page.sparseImage) imagePages.add(index + 1);
      });
    }

    const outline = await usableOutlineFrom(doc, pageCount);
    // 大纲条目数超出上限（一页一条的大纲）时退回字数分章：宁可章节粗一点，
    // 也不要让用户面对几百个碎片章
    const ranges =
      outline && outline.length <= MAX_OUTLINE_CHAPTERS
        ? outlineRanges(outline, pageCount, weights, fallbackTitle)
        : chunkRanges(pageCount, weights, options.charsPerChapter);
    if (outline && outline.length > MAX_OUTLINE_CHAPTERS) {
      log.warn(
        "PDF 大纲过于零碎，已退回按字数分章",
        `outline=${outline.length}`,
        `pages=${pageCount}`,
      );
    }

    const chapters: LocalBookChapter[] = [];
    for (const range of ranges) {
      const chapter = await buildChapter(doc, range, imagePages, strips, bounds, options);
      if (chapter) chapters.push(chapter);
    }
    if (chapters.length === 0) {
      log.warn("PDF 未解析出可读内容（文件可能已加密或损坏）", `pages=${pageCount}`);
      throw new Error("PDF 中没有解析出可读内容，请确认文件未加密且未损坏");
    }

    // 封面：第一页渲染成缩略图（扫描件的第一页本身就是章节图，无需重复渲染）
    let cover: string | undefined;
    if (!scanned) {
      const first = await doc.getPage(1);
      cover = await renderPdfCover(first);
      first.cleanup?.();
    }

    log.info(
      "PDF 解析完成",
      `file=${file.name}`,
      `pages=${pageCount}`,
      `chapters=${chapters.length}`,
      `chars=${totalChars}`,
      `scanned=${scanned}`,
      `imagePages=${imagePages.size}`,
      `ms=${Math.round(performance.now() - started)}`,
    );
    return {
      title: metaText("Title") || fallbackTitle,
      author: metaText("Author") || "佚名",
      chapters,
      ...(cover ? { cover } : {}),
    };
  } finally {
    // 释放文档与 worker 侧资源：导入大书时这一份内存不能留到下次导入
    await task.destroy().catch(() => undefined);
  }
}

/** 可用大纲（没有 / 不可用时返回 null） */
async function usableOutlineFrom(
  doc: PdfDocument,
  pageCount: number,
): Promise<PdfOutlineEntry[] | null> {
  try {
    const nodes = await doc.getOutline();
    if (!nodes || nodes.length === 0) {
      log.debug("PDF 没有自带大纲，按字数分章", `pages=${pageCount}`);
      return null;
    }
    return usableOutline(await collectOutline(doc, nodes), pageCount);
  } catch (err) {
    log.warn("PDF 大纲读取失败，退回按字数分章", err);
    return null;
  }
}

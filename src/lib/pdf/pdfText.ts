/**
 * PDF 文字层 → 段落（PDF 导入的排版还原）。
 *
 * PDF 没有「段落」概念，只有一串带坐标的文字片段（pdf.js 的 `TextItem`）：
 * 这里按坐标把它们重新拼成「行」，再按行距把行拼成「段落」，并去掉页眉 / 页脚 ——
 * 版面分析是启发式的，宁可多留一个空行，也不要把两段正文粘成一段。
 *
 * 与页面渲染、分章解耦：本模块只吃 `TextItem[]`（外加可选的 marked content 边界），
 * 因此可以脱离 WebView 在 Node 里直接单测。
 */

/** 与 pdf.js `TextItem` 结构兼容的最小入参（只取排版需要的字段） */
export interface PdfTextItem {
  str: string;
  /** 文本矩阵 [a, b, c, d, e, f]：e/f 为设备空间的基线原点 */
  transform: number[];
  /** 片段宽度（设备空间） */
  width: number;
  /** 片段高度：pdf.js 给出的是该字号的实际高度，用作行高基准 */
  height: number;
  /** 该片段之后是否换行 */
  hasEOL: boolean;
}

/** 整页的字号基准：片段高度中位数（同一页混排多种字号时，中位数比平均值稳） */
export interface PdfTextMetrics {
  /** 片段高度中位数（近似正文字号） */
  medianHeight: number;
}

export function textMetricsOf(items: readonly PdfTextItem[]): PdfTextMetrics {
  return { medianHeight: median(items.map((item) => item.height)) };
}

function median(values: readonly number[]): number {
  const usable = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (usable.length === 0) return 0;
  return usable[Math.floor(usable.length / 2)];
}

interface RawLine {
  text: string;
  /** 基线 y（PDF 坐标系，自下向上：y 越大越靠上） */
  y: number;
  /** 行内片段高度的最大值，作为该行的字号基准 */
  size: number;
}

/** 需要在其后补空格的「西文尾字符」：字母 / 数字 / 这些收尾符号 */
const WORD_TAIL = /[0-9A-Za-z\u00c0-\u024f)\]}>"'%‰°]/;
/** 需要在其前补空格的「西文首字符」 */
const WORD_HEAD = /[0-9A-Za-z\u00c0-\u024f([{<"'$€£¥]/;

/** 中日韩文字、假名与 CJK 标点：这些字符之间不插空格 */
function isCjk(ch: string): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x303f) || // CJK 部首 / 标点
    (code >= 0x3040 && code <= 0x30ff) || // 假名
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 基本区
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意
    (code >= 0xff00 && code <= 0xffef) // 全角标点 / 字母
  );
}

/**
 * 两段文字之间是否需要补一个空格。
 * pdf.js 会把空格作为独立片段返回（`str === " "`），因此这里只兜住
 * 「片段被空格切开但空格丢失」以及「西文单词被拆成两个片段」的情况；
 * 中文之间绝不插空格 —— 中文 PDF 的片段切分极碎，插空格会把整段读成「一 个 一 个 字」。
 */
function needsSpace(prev: string, next: string): boolean {
  if (!prev || !next) return false;
  const last = prev.charAt(prev.length - 1);
  const first = next.charAt(0);
  if (/\s/.test(last) || /\s/.test(first)) return false;
  if (isCjk(last) || isCjk(first)) return false;
  return WORD_TAIL.test(last) && WORD_HEAD.test(first);
}

/** 两个原文字符之间是否需要补空格（用于把行内的两行拼回一段） */
function needsSpaceBetween(prev: string, next: string): boolean {
  return needsSpace(prev, next);
}

/**
 * 把一页的文字片段按坐标拼成行。
 * - 换行判定：pdf.js 的 `hasEOL`、基线 y 变化、或同基线但水平位置明显回退（分栏 / 换行未标 EOL）；
 * - 空格：片段之间水平间距超过「本行一个字宽」的 0.4 倍（或西文单词被拆开）时补一个空格 ——
 *   中日韩文字的间隙本来就比西文词距大，用绝对阈值会把每个字都插上空格；
 * - `drop` 在拼行**之前**逐片段过滤：页眉页脚是按坐标剔除的，先删片段再拼行，
 *   才不会出现「页眉与正文首行被并成一行」而删不干净的情况。
 */
export function buildLines(
  items: readonly PdfTextItem[],
  metrics: PdfTextMetrics,
  drop?: (item: PdfTextItem) => boolean,
): RawLine[] {
  const lines: RawLine[] = [];
  let current: RawLine | null = null;
  /** 当前行已排到的右边界（设备空间 x） */
  let right = 0;

  const flush = (): void => {
    if (!current) return;
    const text = current.text.replace(/\s+/g, " ").trim();
    if (text) lines.push({ ...current, text });
    current = null;
  };

  for (const item of items) {
    const raw = item.str ?? "";
    if (!raw) continue;
    if (drop?.(item)) continue;
    const y = item.transform?.[5] ?? 0;
    // 纯空白片段：pdf.js 用它表达词间空格，保留一个空格即可（丢字比空格更糟）
    if (!raw.trim()) {
      if (current && !/\s$/.test(current.text)) current.text += " ";
      continue;
    }
    const x = item.transform?.[4] ?? 0;
    const size = item.height > 0 ? item.height : metrics.medianHeight;
    const lineTolerance = Math.max(1, size * 0.2);
    // 同一行的两个条件：基线基本一致，且没有明显往左回退（回退 = 换行 / 换栏）
    const sameLine =
      current !== null &&
      Math.abs(current.y - y) <= lineTolerance &&
      x + Math.max(1, size * 0.25) >= right;
    if (current && !sameLine) flush();

    if (!current) {
      current = { text: "", y, size };
      right = x;
    } else if (!/\s$/.test(current.text)) {
      // 片段之间水平间距过大（pdf.js 没给出空格片段）或西文单词被切开时补一个空格。
      // 阈值取「1/4 字号」：西文的词间距约 0.25–0.3 em，中日韩文字之间的间隙通常
      // 不到 0.15 em —— 用绝对宽度判断（而不是相对字宽）才不会给中文逐字插空格，
      // 但西文两边都是字母时一律不插（宁可粘连，也不要 "h ello" 这种断词）。
      const gapRatio = size > 0 ? (x - right) / size : 0;
      if (gapRatio > 0.25 || needsSpace(current.text, raw)) current.text += " ";
    }
    current.text += raw;
    current.size = Math.max(current.size, size);
    right = x + Math.max(item.width ?? 0, 0);

    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

/** 行距中位数（只用相邻行的正间距）：作为「行内换行」与「段落间距」的分界基准 */
function medianGap(lines: readonly RawLine[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    if (gap > 0.5) gaps.push(gap);
  }
  return median(gaps);
}

/** 把行尾与下一行行首拼起来：西文补空格、行尾连字符去掉、中文直接相接 */
function joinLines(prev: string, next: string): string {
  const trimmed = next.replace(/^\s+/, "");
  if (!trimmed) return prev;
  // 西文断词连字符：`inter-` + `national` → `international`
  if (/[A-Za-z]-$/.test(prev) && /^[a-z]/.test(trimmed)) {
    return prev.slice(0, -1) + trimmed;
  }
  if (needsSpaceBetween(prev, trimmed)) return `${prev} ${trimmed}`;
  return prev + trimmed;
}

/**
 * 行 → 段落：
 * - 行距明显大于本页正文行距（> 1.35 倍且超过 0.35 字号）视为段落边界；
 * - 行尾为句末标点**且**下一行有额外缩进时同样断段（中文 PDF 常见的「首行缩进两格」）；
 * - 行内换行按 CJK / 西文规则拼接，西文断词连字符合并。
 */
export function buildParagraphs(lines: readonly RawLine[]): string[] {
  const paragraphs: string[] = [];
  if (lines.length === 0) return paragraphs;
  const base = medianGap(lines);
  const size = median(lines.map((line) => line.size)) || 12;
  const gapLimit = base > 0 ? base * 1.35 : size * 1.5;
  const hardLimit = Math.max(gapLimit, size * 0.35);
  let current = lines[0].text;
  let prev = lines[0];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const gap = prev.y - line.y;
    const paragraphBreak = gap > hardLimit;
    if (paragraphBreak) {
      paragraphs.push(current);
      current = line.text;
    } else {
      current = joinLines(current, line.text);
    }
    prev = line;
  }
  paragraphs.push(current);
  return paragraphs.map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** 页眉页脚识别用的归一化：数字统一成 #，便于「第 12 页」这类页码跨页比对 */
function normalizeStripKey(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[0-9０-９]+/g, "#")
    .trim()
    .toLowerCase();
}

/**
 * 疑似页眉 / 页脚的行：位于页面上下边缘 15% 之内，且长度可控。
 * 这个「探测区」只用于找出候选行，真正剔除与否还要看全书的正文起点（见
 * [`runningHeadBoundary`]）—— 探测区偏大一点没关系，正文起点会兜住。
 */
const STRIP_ZONE = 0.15;
const MAX_STRIP_LEN = 80;

/** 该行是否落在页面上下的「页眉页脚探测区」 */
function inEdgeZone(line: RawLine, height: number): boolean {
  if (height <= 0) return false;
  const fromTop = height - line.y;
  return fromTop <= height * STRIP_ZONE || line.y <= height * STRIP_ZONE;
}

/**
 * 页眉页脚识别所需的「采样行」：只保留页面上下的边缘行。
 * 通用到整本的重复行检测不必把每一行都留在内存里 —— 调用方按页采样本函数的结果即可。
 */
export function edgeLinesOf(lines: readonly RawLine[], height: number): RawLine[] {
  return lines.filter((line) => inEdgeZone(line, height));
}

/**
 * 跨页重复的页眉 / 页脚（页码、书名、章节名…）：
 * 只有**在多数采样页同样位置重复出现**的行才算，正文里的短行不会被误删。
 * 返回归一化后的行文本集合。
 */
export function detectRunningHeads(
  pages: ReadonlyArray<{ lines: readonly RawLine[]; height: number }>,
  ratio = 0.3,
): Set<string> {
  const counts = new Map<string, number>();
  let usable = 0;
  for (const page of pages) {
    if (page.height <= 0) continue;
    usable += 1;
    const seen = new Set<string>();
    for (const line of page.lines) {
      if (line.text.length > MAX_STRIP_LEN) continue;
      if (!inEdgeZone(line, page.height)) continue;
      const key = normalizeStripKey(line.text);
      if (!key) continue;
      seen.add(key);
    }
    for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // 下限取 2 条而非 3 条：十页以内的小册子里，页眉页脚可能只出现在少数页面上。
  // 比例取 0.3 而不是「过半」：章首页往往没有页眉，页眉只在多数页面上重复。
  const threshold = Math.max(2, Math.ceil(usable * ratio));
  const out = new Set<string>();
  for (const [key, count] of counts) {
    if (count >= threshold) out.add(key);
  }
  return out;
}

/**
 * 页眉 / 页脚的剔除范围（PDF 坐标，y 越大越靠上）：
 * - `head`：全书**最高的那一行正文**的 y，比它更靠上的行是页眉；
 * - `foot`：全书**最低的那一行正文**的 y，比它更靠下的行是页脚。
 *
 * 版心（正文范围）在各页是一致的，因此一次判定、全书通用，不必逐页猜。
 * 取的是「最高 / 最低正文行」这种极端值：某页正文顶到最上面只会抬高 head、
 * 少剔几行页眉，绝不会把正文当页眉删掉 —— 正文丢字不可逆，页眉多一行只是不够干净。
 * 判定时排除页面上下 15% 的边缘行，避免把页眉本身也算成正文行。
 */
export interface RunningHeadBounds {
  head: number;
  foot: number;
}

export function runningHeadBounds(
  pages: ReadonlyArray<{ lines: readonly RawLine[]; height: number }>,
): RunningHeadBounds {
  let head = 0;
  let foot = Number.POSITIVE_INFINITY;
  for (const page of pages) {
    if (page.height <= 0) continue;
    const zone = page.height * STRIP_ZONE;
    for (const line of page.lines) {
      const fromTop = page.height - line.y;
      // 只看版心内的行：边缘行是页眉页脚的候选，不能用来定版心
      if (fromTop <= zone || line.y <= zone) continue;
      if (line.y > head) head = line.y;
      if (line.y < foot) foot = line.y;
    }
  }
  return { head, foot: Number.isFinite(foot) ? foot : 0 };
}

/**
 * 生成按坐标剔除页眉页脚的片段过滤器（传给 [`buildLines`] 的 `drop`）：
 * 片段落在版心之外（比版心最高行还高 / 比最低行还低）**且**文本跨页重复过，才丢弃。
 * 两个条件缺一不可：只看位置会误删顶格的正文首行，只看重复会误删正文里引用的书名。
 */
export function runningHeadFilter(
  bounds: RunningHeadBounds,
  strips: ReadonlySet<string>,
): (item: PdfTextItem) => boolean {
  return (item) => {
    if (strips.size === 0) return false;
    const y = item.transform?.[5] ?? 0;
    const outside = (bounds.head > 0 && y > bounds.head) || (bounds.foot > 0 && y < bounds.foot);
    if (!outside) return false;
    return strips.has(normalizeStripKey(item.str ?? ""));
  };
}

/* 一页文字层的组装由调用方完成：先 buildLines，再按需 stripRunningHeads，最后 buildParagraphs
   （见 src/lib/pdf.ts 的 scanPages / buildChapter） */

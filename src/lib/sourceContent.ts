/**
 * 书源正文中的图片识别与结构化（「图片正文」支持）。
 *
 * 兼容协议（前后兼容，schemaVersion 不变）：
 * - 老协议：bookContent 返回字符串（纯文本 / HTML）。纯文本行为与旧版完全一致；
 *   若 HTML 里含 `<img>`，则按出现顺序抽取图片并保留周围文字（图文混排 / 整章图），
 *   落在**段落中间**的图片保留为段内插图（`p` 块的 `imgs` 锚点），不再把段落切成
 *   「文字段 + 图片块 + 文字段」；整段只有图片时仍落成独占一行的 img 块。
 * - 新协议：bookContent 也可返回对象 `{ text?, images? }`（images 亦可写作 imgs），
 *   显式给出图片地址（相对地址按章节页 URL 解析）；对象协议沿用旧行为：
 *   text 作为正文段落，images 依次跟在其后（一组图 / 整章图）。
 *
 * 输出统一为「顺序 token」→ 章节 blocks（p / img）与段落文本；图片只保留地址：
 * 网络地址写入图片的 remote（图片身份），下载由阅读时的按需加载完成
 * （见 chapterImages.ts）—— 拉正文本身不下载图片。
 */
import type { ChapterBlock, ChapterImageRef, ParagraphPart } from "./booksTypes";
import { imageRefToBlock, paragraphFromParts } from "./booksTypes";

/** 正文顺序流中的一个内容片段 */
export type ContentToken =
  | { kind: "text"; raw: string }
  | { kind: "img"; src: string; alt?: string };

/** 解析结果：用于落盘 */
export interface SourceContentBuild {
  /** 全部段落文本（p 块文本按序；字数/镜像文本口径，图片不占字符） */
  paragraphs: string[];
  /** 章节顺序块；图片块 src 为绝对地址（data: 直给时即本地副本，网络地址待阅读时下载） */
  blocks: ChapterBlock[];
  /** 是否识别到可展示的图片 */
  hasImages: boolean;
}

/** 正文空段落判定：未产出任何段落与图片 */
export function buildIsEmpty(build: SourceContentBuild): boolean {
  return build.paragraphs.length === 0 && build.blocks.length === 0;
}

/**
 * 把引擎返回的原始正文清洗成保留换行的纯文本（分段 = 空行；HTML 先行剥标签）。
 * 与旧版 `normalizeContentText` 的前半段完全同口径，供段落切片复用。
 */
function contentPlainText(raw: string): string {
  let t = raw ?? "";
  t = t
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  if (t.includes("<")) {
    t = t
      .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|tr|table|ul|ol|section|article|blockquote|td|dd|dt)>/gi, "\n")
      .replace(/<[^>]*>/g, "");
  }
  return t
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const c = Number(code);
      return Number.isFinite(c) && c > 0 ? String.fromCodePoint(c) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => {
      const c = parseInt(code, 16);
      return Number.isFinite(c) && c > 0 ? String.fromCodePoint(c) : "";
    })
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n");
}

/**
 * 正文切片：一段文本 + 它紧邻的段落分隔与首尾空白信息。
 * - `breakBefore` / `breakAfter`：该段之前 / 之后有空行（段落分隔）；
 * - `leadingSpace` / `trailingSpace`：该段首 / 尾原本有空白（被 trim 掉的部分）——
 *   紧邻图片的空白要补回来（`hello <img> world` 的镜像文本仍是「hello world」），
 *   段首段尾的空白则由段落归一化统一去掉。
 */
interface ContentChunk {
  text: string;
  /** 未裁剪的原始切片（保留换行：图片前的块级收尾要靠它判断） */
  raw: string;
  leadingSpace: boolean;
  trailingSpace: boolean;
  breakBefore: boolean;
  breakAfter: boolean;
}

/**
 * 纯文本 → 段落切片。文本口径与旧版 `normalizeContentText` 逐字一致
 * （切分为空行，分隔符本身不进入文本）。
 */
function splitContentChunks(plain: string): ContentChunk[] {
  const pieces = plain.split(/(\n[ \t]*\n+)/);
  const chunks: ContentChunk[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const raw = pieces[i];
    const text = raw.replace(/\s*\n\s*/g, "").replace(/[ \t]+/g, " ").trim();
    if (!text) continue;
    chunks.push({
      text,
      raw,
      leadingSpace: /^\s/.test(raw),
      trailingSpace: /\s$/.test(raw),
      breakBefore: i > 0,
      breakAfter: i + 1 < pieces.length,
    });
  }
  return chunks;
}

/** 文本是否以「块级收尾」结束（闭合块标签换来的换行）：图片据此判定是否独占一行 */
function endsWithBlockBreak(text: string): boolean {
  return text.length > 0 && /\n[ \t]*$/.test(text);
}

/** 文本是否以「块级开头」开始（块标签换来的前导换行） */
function startsWithBlockBreak(text: string): boolean {
  return /^[ \t]*\n/.test(text);
}

/** 把引擎返回的原始正文清洗成段落数组（分段 = 空行；HTML 先行剥标签） */
export function normalizeContentText(raw: string): string[] {
  return splitContentChunks(contentPlainText(raw)).map((chunk) => chunk.text);
}

// ---------------------------------------------------------------------------
// HTML 实体解码（attr 值里常见 &amp; &#x…;）
// ---------------------------------------------------------------------------

function decodeHtmlEntities(input: string): string {
  if (!input.includes("&")) return input;
  const el = document.createElement("div");
  el.innerHTML = input;
  return el.textContent ?? "";
}

// ---------------------------------------------------------------------------
// `<img>` 标签扫描（不依赖 DOM，正文原始 HTML 由引擎原样带回）
// ---------------------------------------------------------------------------

function parseTagAttrs(inner: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const len = inner.length;
  let i = 0;
  const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
  while (i < len) {
    while (i < len && isSpace(inner[i])) i++;
    if (i >= len || inner[i] === "/" || inner[i] === ">") break;
    let name = "";
    while (i < len && !isSpace(inner[i]) && inner[i] !== "=" && inner[i] !== "/" && inner[i] !== ">") {
      name += inner[i++];
    }
    while (i < len && isSpace(inner[i])) i++;
    if (i < len && inner[i] === "=") {
      i++;
      while (i < len && isSpace(inner[i])) i++;
      let value = "";
      if (i < len && (inner[i] === '"' || inner[i] === "'")) {
        const quote = inner[i++];
        while (i < len && inner[i] !== quote) value += inner[i++];
        if (i < len) i++;
      } else {
        while (i < len && !isSpace(inner[i]) && inner[i] !== ">") value += inner[i++];
      }
      if (name) attrs[name.toLowerCase()] = decodeHtmlEntities(value);
    } else if (name) {
      attrs[name.toLowerCase()] = "";
    }
  }
  return attrs;
}

/** 懒加载图源常见 src 候选（按优先级） */
const SRC_ATTR_CANDIDATES = [
  "src",
  "data-src",
  "data-original",
  "original",
  "data-lazy-src",
  "lazy-src",
  "data-url",
  "data-echo",
];

function pickImageSrc(attrs: Record<string, string>): string | null {
  for (const key of SRC_ATTR_CANDIDATES) {
    const value = (attrs[key] ?? "").trim();
    if (value && value !== "about:blank") return value;
  }
  return null;
}

/**
 * 把 HTML 正文拆成顺序 token：文字片段与 `<img>` 图片（图片无可用 src 时丢弃该标签）。
 * script/style/注释内出现的 `<img` 不参与识别。
 */
function scanHtmlTokens(htmlRaw: string): ContentToken[] {
  const html = htmlRaw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const tokens: ContentToken[] = [];
  const imgRe = /<img\b/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = imgRe.exec(html))) {
    const start = match.index;
    // 找标签结束的 '>'（引号内不当作结束）
    let quote: string | null = null;
    let j = imgRe.lastIndex;
    for (; j < html.length; j++) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
    }
    const end = j < html.length ? j + 1 : html.length;
    const inner = html.slice(imgRe.lastIndex, j);
    const attrs = parseTagAttrs(inner);
    if (start > cursor) {
      tokens.push({ kind: "text", raw: html.slice(cursor, start) });
    }
    const src = pickImageSrc(attrs);
    if (src) {
      const alt = (attrs.alt ?? "").trim();
      tokens.push({ kind: "img", src, ...(alt ? { alt } : {}) });
    }
    imgRe.lastIndex = end;
    cursor = end;
  }
  if (cursor < html.length) {
    tokens.push({ kind: "text", raw: html.slice(cursor) });
  }
  return tokens;
}

/**
 * 结构协议判定：bookContent 返回对象 `{ text?, images? }`（images 亦可写 imgs）。
 * 仅当对象确实表达了正文结构（含 text 或 images/imgs 键）时才按新协议处理，
 * 其它以 `{` 开头的内容（如直接返回的 JSON 文本）保持旧行为。
 */
function structuredContent(raw: string): { text?: string; images: string[] } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const hasText = typeof o.text === "string";
  const imageList = Array.isArray(o.images) ? (o.images as unknown[]) : [];
  const imgsList = Array.isArray(o.imgs) ? (o.imgs as unknown[]) : [];
  if (!hasText && imageList.length === 0 && imgsList.length === 0) return null;
  const images = [...imageList, ...imgsList]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  return { ...(hasText ? { text: (o.text as string) } : {}), images };
}

/** 解析书源正文为顺序 token（自动识别对象协议与 HTML `<img>`） */
export function tokenizeSourceContent(raw: string): ContentToken[] {
  const structured = structuredContent(raw);
  if (structured) {
    const tokens: ContentToken[] = [];
    if (structured.text) tokens.push({ kind: "text", raw: structured.text });
    for (const src of structured.images) {
      tokens.push({ kind: "img", src });
    }
    return tokens;
  }
  return scanHtmlTokens(raw);
}

/** 把图片 src 解析为可直接展示的绝对地址：http(s) 或 data:image；相对地址按 baseUrl 解析 */
function resolveImageSrc(src: string, baseUrl: string | undefined): string | null {
  const value = src.trim();
  if (!value || value.length > 4096) return null;
  if (value.startsWith("data:image/")) return value;
  if (value.startsWith("//") && !baseUrl) return null;
  try {
    const url = new URL(value, baseUrl || undefined);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    return null;
  } catch {
    return null;
  }
}

/** 图片绝对地址 → 图片引用（网络地址同时作为图片身份 remote；data: 直给时只留 src） */
function contentImage(resolved: string, alt: string | undefined): ChapterImageRef {
  return resolved.startsWith("data:")
    ? { src: resolved, ...(alt ? { alt } : {}) }
    : { src: resolved, remote: resolved, ...(alt ? { alt } : {}) };
}

/**
 * 对象协议 `{ text?, images? }`：text 作为正文段落、images 依次跟在其后
 * （「这一章是一组图」的显式表达，与旧版行为一致）。
 */
function buildStructuredContent(
  structured: { text?: string; images: string[] },
  baseUrl: string | undefined,
): SourceContentBuild {
  const blocks: ChapterBlock[] = [];
  const paragraphs: string[] = [];
  if (structured.text) {
    for (const paragraph of normalizeContentText(structured.text)) {
      blocks.push({ kind: "p", text: paragraph });
      paragraphs.push(paragraph);
    }
  }
  let hasImages = false;
  for (const src of structured.images) {
    const resolved = resolveImageSrc(src, baseUrl);
    if (!resolved) continue;
    blocks.push(imageRefToBlock(contentImage(resolved, undefined)));
    hasImages = true;
  }
  return { paragraphs, blocks, hasImages };
}

/**
 * 把引擎返回的正文解析为可直接落盘的章节内容。
 * - baseUrl：正文页面地址（章节页），用于解析相对图片地址；
 * - HTML 里的图片按出现顺序抽取，**落在段落中间的图片留在该段的文字流里**
 *   （`p` 块的段内锚点），整段只有图时落成独占一行的 img 块；
 * - 网络图片保留绝对地址（src + remote），正文拉取阶段不下载，阅读时再按需获取。
 */
export function buildSourceChapterContent(
  raw: string,
  baseUrl: string | undefined,
): SourceContentBuild {
  const structured = structuredContent(raw);
  if (structured) return buildStructuredContent(structured, baseUrl);

  const tokens = tokenizeSourceContent(raw);
  // 每个文字 token 的纯文本（判图片前后的块级边界；只算一次）
  const plains = tokens.map((token) => (token.kind === "text" ? contentPlainText(token.raw) : ""));
  /** 图片之后的下一个文字 token 的纯文本（跳过中间的图片 token） */
  const nextPlainAfter = (index: number): string => {
    for (let i = index + 1; i < tokens.length; i++) {
      if (tokens[i].kind === "text") return plains[i];
    }
    return "";
  };

  const blocks: ChapterBlock[] = [];
  const paragraphs: string[] = [];
  let hasImages = false;

  /** 正在累积的段落：文字片段与段内插图按出现顺序收集，落块时统一归一化 */
  let parts: ParagraphPart[] = [];
  /** 本段已有可见文字（图片据此判定留在段内还是独占一行） */
  let hasText = false;
  /** 本段已累积原始文本的尾部（含换行；判「图片前是不是块级收尾」） */
  let rawTail = "";

  const flushParagraph = (): void => {
    const current = parts;
    parts = [];
    hasText = false;
    rawTail = "";
    if (current.length === 0) return;
    const { text, imgs } = paragraphFromParts(current);
    if (!text) {
      // 没有文字：图片各自独占一行（漫画 / 整章图）
      for (const img of imgs) blocks.push(imageRefToBlock(img));
    } else {
      paragraphs.push(text);
      blocks.push(imgs.length > 0 ? { kind: "p", text, imgs } : { kind: "p", text });
    }
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === "text") {
      for (const chunk of splitContentChunks(plains[index])) {
        if (chunk.breakBefore) flushParagraph();
        // 文本直接相接：与「没有图片时同一段文本」的口径一致。
        // 首尾空白补回来（紧邻图片时它是有意义的间隔），由段落归一化统一收尾。
        parts.push({
          text: `${chunk.leadingSpace ? " " : ""}${chunk.text}${chunk.trailingSpace ? " " : ""}`,
        });
        hasText = true;
        rawTail = `${rawTail}${chunk.raw}`.slice(-64);
        if (chunk.breakAfter) flushParagraph();
      }
      continue;
    }
    const resolved = resolveImageSrc(token.src, baseUrl);
    if (!resolved) continue;
    hasImages = true;
    // 图片独占一行的两种情形：
    // 1) 它前面是块级收尾（图片在上一段之外，如 `</p><img>` / `</div><img>`）；
    // 2) 本段还没有文字，且它后面紧跟块级开头或没有文字（整段只有图的漫画章）。
    // 其余情况（文字中间、段首紧跟文字）都留在段落的文字流里。
    const after = nextPlainAfter(index);
    const blockPositioned =
      endsWithBlockBreak(rawTail) ||
      (!hasText && (after.trim() === "" || startsWithBlockBreak(after)));
    if (blockPositioned) flushParagraph();
    parts.push({ img: contentImage(resolved, token.alt?.trim() || undefined) });
    if (blockPositioned) flushParagraph();
  }
  flushParagraph();
  return { paragraphs, blocks, hasImages };
}

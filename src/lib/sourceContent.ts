/**
 * 书源正文中的图片识别与结构化（「图片正文」支持）。
 *
 * 兼容协议（前后兼容，schemaVersion 不变）：
 * - 老协议：bookContent 返回字符串（纯文本 / HTML）。纯文本行为与旧版完全一致；
 *   若 HTML 里含 `<img>`，则按出现顺序抽取图片并保留周围文字（图文混排 / 整章图）。
 * - 新协议：bookContent 也可返回对象 `{ text?, images? }`（images 亦可写作 imgs），
 *   显式给出图片地址（相对地址按章节页 URL 解析）。
 *
 * 输出统一为「顺序 token」→ 章节 blocks（p / img）与段落文本；图片仍为网络地址时
 * 由调用方经书源会话下载成 data URL 再落盘（见 online.ts）。
 */
import type { ChapterBlock } from "./booksTypes";

/** 正文顺序流中的一个内容片段 */
export type ContentToken =
  | { kind: "text"; raw: string }
  | { kind: "img"; src: string; alt?: string };

/** 解析结果：用于落盘与图片下载 */
export interface SourceContentBuild {
  /** 全部段落文本（p 块文本按序；字数/镜像文本口径，图片不占字符） */
  paragraphs: string[];
  /** 章节顺序块；图片块的 src 可能仍是绝对网络地址（待下载）或 data: URL */
  blocks: ChapterBlock[];
  /** 是否识别到可展示的图片 */
  hasImages: boolean;
  /** 需要下载的图片（blocks 中对应 img 块下标 + 绝对地址） */
  imageRefs: { index: number; url: string }[];
}

/** 正文空段落判定：未产出任何段落与图片 */
export function buildIsEmpty(build: SourceContentBuild): boolean {
  return build.paragraphs.length === 0 && build.blocks.length === 0;
}

/** 把引擎返回的原始正文清洗成段落数组（分段 = 空行；HTML 先行剥标签） */
export function normalizeContentText(raw: string): string[] {
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
  t = t
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
  const paragraphs = t
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/\s*\n\s*/g, "").replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  if (paragraphs.length > 0) return paragraphs;
  const single = t.replace(/\s+/g, " ").trim();
  return single ? [single] : [];
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

/**
 * 把引擎返回的正文解析为可直接落盘的章节内容。
 * - baseUrl：正文页面地址（章节页），用于解析相对图片地址；
 * - 图片的 src 在网络地址时写入 imageRefs，等待调用方下载并替换为 data URL。
 */
export function buildSourceChapterContent(
  raw: string,
  baseUrl: string | undefined,
): SourceContentBuild {
  const blocks: ChapterBlock[] = [];
  const paragraphs: string[] = [];
  const imageRefs: { index: number; url: string }[] = [];
  let hasImages = false;

  const tokens = tokenizeSourceContent(raw);
  for (const token of tokens) {
    if (token.kind === "text") {
      for (const paragraph of normalizeContentText(token.raw)) {
        blocks.push({ kind: "p", text: paragraph });
        paragraphs.push(paragraph);
      }
      continue;
    }
    const resolved = resolveImageSrc(token.src, baseUrl);
    if (!resolved) continue;
    const block: ChapterBlock = {
      kind: "img",
      src: resolved,
      ...(token.alt?.trim() ? { alt: token.alt.trim() } : {}),
    };
    const index = blocks.length;
    blocks.push(block);
    hasImages = true;
    if (resolved.startsWith("http://") || resolved.startsWith("https://")) {
      imageRefs.push({ index, url: resolved });
    }
  }
  return { paragraphs, blocks, hasImages, imageRefs };
}

/**
 * 极简 EPUB 解析：
 * 1. 解压 ZIP，读取 META-INF/container.xml 定位 OPF；
 * 2. 从 OPF 的 metadata / manifest / spine 取书名、作者与阅读顺序；
 * 3. 逐 spine 读取 XHTML/HTML，用 DOM 遍历还原成“自然段 / 标题 / 插图”结构化块。
 *
 * 与旧版不同：不再用不可见字符标记 + 空行切分，避免正文丢字、标题重复、
 * 分段混乱；<img> 会被提取为 data URL 引用，保证图片正常显示。
 */
import { unzipSync } from "fflate";
import type { ChapterBlock, LocalBookChapter } from "./booksTypes";
import { chapterCid } from "./booksTypes";

export interface ParsedEpub {
  title: string;
  author: string;
  chapters: LocalBookChapter[];
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  let text = new TextDecoder("utf-8").decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (!doc.querySelector("parsererror")) return doc;
  // 个别 EPUB 的 XML 不严格，退回宽松解析
  return new DOMParser().parseFromString(text, "text/html");
}

function parseHtml(text: string): Document {
  try {
    const doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
    if (!doc.querySelector("parsererror")) return doc;
  } catch {
    /* 忽略非良构错误 */
  }
  return new DOMParser().parseFromString(text, "text/html");
}

function resolvePath(baseDir: string, href: string): string {
  const decoded = decodeURIComponent(href).replace(/\\/g, "/");
  if (decoded.startsWith("/")) return decoded.replace(/^\/+/, "");
  const parts = (baseDir ? baseDir.split("/") : [])
    .filter(Boolean)
    .concat(decoded.split("/").filter(Boolean));
  const stack: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function firstText(node: ParentNode | Document, tag: string): string {
  const el = node.querySelector(tag);
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function firstNamespaceText(doc: Document, tag: string): string {
  const el = Array.from(doc.getElementsByTagNameNS("*", tag))[0];
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[\t\r\n ]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// DOM -> 结构化块

const UNRENDERABLE = new Set([
  "SCRIPT",
  "STYLE",
  "HEAD",
  "LINK",
  "META",
  "TITLE",
  "NOSCRIPT",
  "TEMPLATE",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "SOURCE",
  "TRACK",
]);

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "BLOCKQUOTE",
  "SECTION",
  "ARTICLE",
  "FIGURE",
  "FIGCAPTION",
  "TR",
  "TD",
  "TH",
  "DT",
  "DD",
  "PRE",
  "UL",
  "OL",
  "TABLE",
  "HEADER",
  "FOOTER",
  "ASIDE",
  "MAIN",
  "NAV",
  "HR",
  "ADDRESS",
  "FORM",
  "FIELDSET",
  "DETAILS",
  "SUMMARY",
]);

const HEADING_RE = /^H([1-6])$/;

/** 过长段落的分段阈值（字数），超过则按句读切分为可读的较短段落 */
const PARA_SPLIT_MAX = 280;
const SENTENCE_END_CHARS = "。！？；…!?";

/** 把超长段落按句读标点切成 ≤PARA_SPLIT_MAX 的若干段 */
function splitParagraph(text: string): string[] {
  if (text.length <= PARA_SPLIT_MAX) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > PARA_SPLIT_MAX) {
    const floor = Math.floor(PARA_SPLIT_MAX * 0.55);
    let cut = PARA_SPLIT_MAX;
    for (let i = PARA_SPLIT_MAX; i > floor; i--) {
      if (SENTENCE_END_CHARS.includes(rest.charAt(i - 1))) {
        cut = i;
        break;
      }
    }
    out.push(normalizeWhitespace(rest.slice(0, cut)));
    rest = rest.slice(cut);
  }
  if (rest) out.push(normalizeWhitespace(rest));
  return out.filter(Boolean);
}

/** 把文本按句读标点切成句子（保留标点、去掉各句首尾空白） */
function splitSentences(text: string): string[] {
  const parts: string[] = [];
  let last = 0;
  const re = new RegExp(`[${SENTENCE_END_CHARS.replace(/[\\]/g, "\\\\")}]`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    parts.push(text.slice(last, m.index + 1));
    last = m.index + 1;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * 章节开篇若首句很短且复述了章节名（如“封面 1. 书名”），
 * 把它收掉，避免正文重复出现标题。
 */
function stripLeadingTitle(text: string, title: string): { rest: string; stripped: boolean } {
  const t = normalizeWhitespace(title);
  if (!t) return { rest: text, stripped: false };
  const sentences = splitSentences(text);
  if (sentences.length === 0) return { rest: text, stripped: false };
  const first = normalizeWhitespace(sentences[0]);
  if (first && first.length <= 40 && first.includes(t)) {
    const rest = sentences.slice(1).join("").trim();
    return { rest, stripped: true };
  }
  return { rest: text, stripped: false };
}

/**
 * 把容器内的 DOM 还原成顺序块。逐元素遍历，块级标签处换段，
 * 标题单独成块，<img> 生成图片块；h1-h2 之外的标题保留为章内副标题。
 */
function renderBlocks(
  root: Element,
  getImageSrc: (el: Element) => string | null,
): ChapterBlock[] {
  const blocks: ChapterBlock[] = [];
  let buf = "";

  const flush = () => {
    const text = normalizeWhitespace(buf);
    if (text) {
      for (const part of splitParagraph(text)) {
        blocks.push({ kind: "p", text: part });
      }
    }
    buf = "";
  };

  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        buf += child.nodeValue ?? "";
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      // XML(application/xhtml+xml) 解析下的 tagName 为小写，统一大写比较
      const tag = el.tagName.toUpperCase();

      if (UNRENDERABLE.has(tag)) continue;

      // 软换行：当作一个空格，避免把诗歌/短行硬拆成多个段落
      if (tag === "BR") {
        buf += " ";
        continue;
      }

      if (tag === "IMG") {
        flush();
        const src = getImageSrc(el);
        // 即使图片缺失也保留占位块，避免在段落中间静默丢图
        blocks.push({
          kind: "img",
          src: src ?? "",
          alt: el.getAttribute("alt") ?? "插图",
        });
        continue;
      }

      const heading = HEADING_RE.exec(tag);
      if (heading) {
        flush();
        const text = normalizeWhitespace(el.textContent ?? "");
        if (text) blocks.push({ kind: "h", level: Number(heading[1]), text });
        continue;
      }

      if (BLOCK_TAGS.has(tag)) {
        // 块级元素：先收掉当前段，再递归收集其子内容（内部会自管分段）
        flush();
        buf = "";
        walk(el);
        flush();
        continue;
      }

      // 行内元素：递归收集，可能包含 BR / IMG / 子标题
      walk(el);
    }
  };

  walk(root);
  flush();
  return blocks;
}

/**
 * 把单份 XHTML 内容块按章节切分：
 * - 首个标题（任意级）作为章节名，不再进入正文，避免重复；
 * - 之后 h1/h2 作为新章边界；h3+ 保留为章内副标题；
 * - 开篇与章节名重复的短句会被收掉（避免正文重复标题）。
 */
function buildDocumentChapters(
  blocks: ChapterBlock[],
  docTitle: string,
  fallbackTitle: string,
): LocalBookChapter[] {
  const chapters: LocalBookChapter[] = [];
  let title = "";
  let paragraphs: string[] = [];
  let body: ChapterBlock[] = [];

  const commit = () => {
    if (body.length === 0 && paragraphs.length === 0) return;
    chapters.push({
      cid: chapterCid(chapters.length),
      title: title || docTitle || fallbackTitle,
      paragraphs,
      blocks: body,
    });
    title = "";
    paragraphs = [];
    body = [];
  };

  for (const block of blocks) {
    if (block.kind === "h") {
      const isBoundary = block.level <= 2 || (body.length === 0 && paragraphs.length === 0);
      if (isBoundary) {
        commit();
        title = block.text;
      } else {
        body.push(block);
      }
      continue;
    }

    if (block.kind === "p") {
      const atStart = body.length === 0 && paragraphs.length === 0;
      const reference = title || docTitle || fallbackTitle;
      let text = block.text;
      if (atStart) {
        const { rest, stripped } = stripLeadingTitle(text, reference);
        if (stripped) {
          if (rest) {
            text = rest;
          } else if (!title) {
            // 整段都是章节名的复述，把它用作章节名，不再进入正文
            title = block.text;
            continue;
          } else {
            continue;
          }
        }
      }
      for (const part of splitParagraph(text)) {
        paragraphs.push(part);
        body.push({ kind: "p", text: part });
      }
      continue;
    }

    body.push(block);
  }
  commit();
  return chapters;
}

// ---------------------------------------------------------------------------
// 图片提取

function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// 入口

export async function parseEpubFile(file: File): Promise<ParsedEpub> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error("无法解压 EPUB（文件可能损坏或不是有效的 ZIP）");
  }

  const containerEntry = entries["META-INF/container.xml"];
  if (!containerEntry) throw new Error("EPUB 缺少 META-INF/container.xml，不是标准 EPUB");
  const containerDoc = parseXml(decodeText(containerEntry));
  const rootfile = containerDoc.querySelector("rootfile");
  const opfPath = rootfile?.getAttribute("full-path")?.trim();
  if (!opfPath) throw new Error("EPUB container.xml 中未找到 OPF 清单");

  const opfKey = resolvePath("", opfPath);
  const opfEntry = entries[opfKey];
  if (!opfEntry) throw new Error(`EPUB 清单不存在：${opfPath}`);
  const opfDoc = parseXml(decodeText(opfEntry));
  const opfDir = opfKey.includes("/") ? opfKey.slice(0, opfKey.lastIndexOf("/") + 1) : "";

  const title =
    firstNamespaceText(opfDoc, "title") ||
    (file.name.replace(/\.(epub|equb)$/i, "").trim() || "未命名");
  const author = firstNamespaceText(opfDoc, "creator") || "佚名";

  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>();
  const manifestByHref = new Map<string, string>();
  for (const item of Array.from(opfDoc.querySelectorAll("manifest > item"))) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href") ?? "";
    const mediaType = item.getAttribute("media-type") ?? "";
    const properties = item.getAttribute("properties") ?? "";
    if (id && href) {
      manifest.set(id, { href, mediaType, properties });
      manifestByHref.set(resolvePath(opfDir, href), mediaType);
    }
  }

  const spineOrder: string[] = [];
  for (const itemref of Array.from(opfDoc.querySelectorAll("spine > itemref"))) {
    const idref = itemref.getAttribute("idref");
    if (idref) spineOrder.push(idref);
  }

  const chapters: LocalBookChapter[] = [];
  let index = 0;
  for (const idref of spineOrder) {
    const item = manifest.get(idref);
    if (!item) throw new Error(`EPUB spine 引用了不存在的清单项：${idref}`);
    // 跳过导航文档 / NCX 等非正文项，避免把目录当正文
    if (item.properties.includes("nav") || item.mediaType === "application/x-dtbncx+xml") {
      continue;
    }
    const hrefKey = resolvePath(opfDir, item.href);
    const content = entries[hrefKey];
    if (!content) throw new Error(`EPUB 正文文件缺失：${item.href}`);
    index += 1;

    const itemDir = hrefKey.includes("/") ? hrefKey.slice(0, hrefKey.lastIndexOf("/") + 1) : "";
    const getImageSrc = (el: Element): string | null => {
      const rawSrc = el.getAttribute("src")?.trim();
      if (!rawSrc) return null;
      const key = resolvePath(itemDir, rawSrc);
      const imgBytes = entries[key];
      if (!imgBytes) return null;
      const mediaType = manifestByHref.get(key) ?? mimeFromPath(key);
      return `data:${mediaType};base64,${bytesToBase64(imgBytes)}`;
    };

    const doc = parseHtml(decodeText(content));
    const container = doc.body ?? doc.querySelector("body") ?? doc.documentElement;
    container.querySelectorAll("head, script, style, link, meta, title, noscript, template, iframe, object, embed, source, track")
      .forEach((el) => el.remove());
    const docTitle = firstText(doc, "title") || `第 ${index} 节`;
    const blocks = renderBlocks(container, getImageSrc);
    chapters.push(...buildDocumentChapters(blocks, docTitle, `第 ${index} 节`));
  }

  if (chapters.length === 0) {
    throw new Error("EPUB 中没有解析出可读章节，请确认文件未加密");
  }
  return { title, author, chapters };
}

/**
 * 极简 EPUB 解析（仅取正文文本，不处理字体/图片/样式）：
 * 1. 解压 ZIP，读取 META-INF/container.xml 定位 OPF；
 * 2. 从 OPF 的 metadata / manifest / spine 取书名、作者与阅读顺序；
 * 3. 逐个读取 spine 中的 XHTML/HTML，剥离标签并按块级元素切成自然段。
 */
import { unzipSync } from "fflate";
import type { LocalBookChapter } from "./booksTypes";

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
]);

const HEADING_RE = /^H([1-6])$/;

const HEADING_START = "\uE000";
const HEADING_SEP = "\uE001";
const HEADING_END = "\uE002";

/**
 * 渲染正文：块级元素间以空行分隔；
 * 标题段落用不可见字符包裹，便于之后按标题拆章而不丢正文。
 */
function renderNode(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent ?? "";
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const element = child as Element;
      if (element.tagName === "BR") {
        out += "\n";
        continue;
      }
      const heading = HEADING_RE.exec(element.tagName);
      if (heading) {
        const headingText = renderNode(child).replace(/\s+/g, " ").trim();
        if (headingText) {
          out += `${HEADING_START}${heading[1]}${HEADING_SEP}${headingText}${HEADING_END}`;
        }
        out += "\n\n";
        continue;
      }
      out += renderNode(child);
      if (BLOCK_TAGS.has(element.tagName)) out += "\n\n";
    }
  }
  return out;
}

interface ContentBlock {
  heading: boolean;
  level: number;
  text: string;
}

/** HTML 块级元素转“自然段 + 章节标题”列表，不丢弃任何正文 */
function extractContentBlocks(doc: Document): ContentBlock[] {
  // XML DOM 的 doc.body 可能为 null，此时显式找 <body> 以排除 <head> 元信息
  const container = doc.body ?? doc.querySelector("body") ?? doc.documentElement;
  // 只移除程序性节点；正文（含短页、页脚等）一律保留
  container.querySelectorAll("head, script, style, link, meta").forEach((el) => el.remove());
  let text = renderNode(container);
  text = text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((block) => {
      const marker = block.indexOf(HEADING_START);
      if (marker < 0) return { heading: false, level: 0, text: block };
      const head = block.indexOf(HEADING_SEP, marker);
      const tail = block.indexOf(HEADING_END, head);
      if (head < 0 || tail < 0) {
        return { heading: false, level: 0, text: block.replace(HEADING_START, "").trim() };
      }
      const level = Number(block.slice(marker + 1, head));
      return {
        heading: true,
        level,
        text: block.slice(head + 1, tail).trim().slice(0, 80),
      };
    })
    .filter((block) => block.heading || block.text.length > 0);
}

/** 单个 XHTML：把标题与正文分成若干章；正文段落不做任何长度过滤 */
function buildDocumentChapters(
  doc: Document,
  fallbackTitle: string,
): LocalBookChapter[] {
  const docTitle = firstText(doc, "title") || fallbackTitle;
  const blocks = extractContentBlocks(doc);

  const chapters: LocalBookChapter[] = [];
  let title = "";
  let paragraphs: string[] = [];

  const commit = () => {
    if (paragraphs.length === 0) return;
    chapters.push({ title: title || docTitle || fallbackTitle, paragraphs });
    paragraphs = [];
  };

  for (const block of blocks) {
    if (block.heading) {
      commit();
      title = block.text;
    } else {
      paragraphs.push(block.text);
    }
  }
  commit();
  return chapters;
}

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
  const author =
    firstNamespaceText(opfDoc, "creator") ||
    "佚名";

  const manifest = new Map<string, { href: string; mediaType: string }>();
  for (const item of Array.from(opfDoc.querySelectorAll("manifest > item"))) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href") ?? "";
    const mediaType = item.getAttribute("media-type") ?? "";
    if (id && href) manifest.set(id, { href, mediaType });
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
    const hrefKey = resolvePath(opfDir, item.href);
    const content = entries[hrefKey];
    if (!content) throw new Error(`EPUB 正文文件缺失：${item.href}`);
    index += 1;

    const doc = parseHtml(decodeText(content));
    chapters.push(...buildDocumentChapters(doc, `第 ${index} 节`));
  }

  if (chapters.length === 0) {
    throw new Error("EPUB 中没有解析出可读章节，请确认文件未加密");
  }
  return { title, author, chapters };
}

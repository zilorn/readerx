/**
 * 极简 EPUB 解析：
 * 1. 解压 ZIP，读取 META-INF/container.xml 定位 OPF；
 * 2. 从 OPF 的 metadata / manifest / spine 取书名、作者与阅读顺序；
 * 3. 逐 spine 读取 XHTML/HTML，用 DOM 遍历还原成“自然段 / 标题 / 插图”结构化块。
 *
 * 与旧版不同：不再用不可见字符标记 + 空行切分，避免正文丢字、标题重复、
 * 分段混乱；`<img>` 会被提取为 data URL 引用并**留在所在段落里**（段内插图，
 * 见 ChapterBlock.imgs），保证图文混排与图片正常显示。
 */
import { unzipSync } from "fflate";
import type { LocalBookChapter } from "./booksTypes";
import { renderBlocks, buildDocumentChapters } from "./ebookHtml";
import { makeCoverThumb } from "./coverImage";
import { t } from "./i18n";
import { createLogger } from "./logger";

const log = createLogger("epub");

export interface ParsedEpub {
  title: string;
  author: string;
  /** OPF metadata 中的内容简介（dc:description） */
  intro?: string;
  chapters: LocalBookChapter[];
  /** 封面缩略图（data URL）；OPF 未声明封面时为 undefined */
  cover?: string;
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
  log.debug("EPUB XML 非良构，退回宽松解析", `chars=${text.length}`);
  return new DOMParser().parseFromString(text, "text/html");
}

function parseHtml(text: string): Document {
  try {
    const doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
    if (!doc.querySelector("parsererror")) return doc;
  } catch {
    /* 忽略非良构错误 */
  }
  log.debug("EPUB XHTML 解析失败，退回 HTML 解析", `chars=${text.length}`);
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
// 封面提取
// ---------------------------------------------------------------------------

/**
 * 定位 EPUB 声明的封面清单项 id：
 * EPUB3 用 manifest item 的 properties="cover-image"；
 * EPUB2 用 metadata 里的 <meta name="cover" content="…">。
 */
function findCoverManifestId(opfDoc: Document): string | null {
  for (const item of Array.from(opfDoc.querySelectorAll("manifest > item"))) {
    const properties = item.getAttribute("properties") ?? "";
    if (properties.split(/\s+/).includes("cover-image")) {
      const id = item.getAttribute("id");
      if (id) return id;
    }
  }
  for (const meta of Array.from(opfDoc.getElementsByTagNameNS("*", "meta"))) {
    if ((meta.getAttribute("name") ?? "").toLowerCase() === "cover") {
      const content = meta.getAttribute("content");
      if (content) return content;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 入口

export async function parseEpubFile(file: File): Promise<ParsedEpub> {
  const started = performance.now();
  log.debug("开始解析 EPUB", `file=${file.name}`, `bytes=${file.size}`);
  try {
    const parsed = await parseEpubEntries(file);
    log.info(
      "EPUB 解析完成",
      `file=${file.name}`,
      `chapters=${parsed.chapters.length}`,
      `ms=${Math.round(performance.now() - started)}`,
    );
    return parsed;
  } catch (err) {
    // 原因（缺 container.xml / OPF / 正文文件、无章节等）由这里带出去，调用方只负责提示
    log.warn(
      "EPUB 解析失败",
      `file=${file.name}`,
      `bytes=${file.size}`,
      `ms=${Math.round(performance.now() - started)}`,
      err,
    );
    throw err;
  }
}

async function parseEpubEntries(file: File): Promise<ParsedEpub> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error(t("library.epub.unzipFailed"));
  }

  const containerEntry = entries["META-INF/container.xml"];
  if (!containerEntry) throw new Error(t("library.epub.noContainer"));
  const containerDoc = parseXml(decodeText(containerEntry));
  const rootfile = containerDoc.querySelector("rootfile");
  const opfPath = rootfile?.getAttribute("full-path")?.trim();
  if (!opfPath) throw new Error(t("library.epub.noOpfPath"));

  const opfKey = resolvePath("", opfPath);
  const opfEntry = entries[opfKey];
  if (!opfEntry) throw new Error(t("library.epub.opfMissing", { path: opfPath }));
  const opfDoc = parseXml(decodeText(opfEntry));
  const opfDir = opfKey.includes("/") ? opfKey.slice(0, opfKey.lastIndexOf("/") + 1) : "";

  const title =
    firstNamespaceText(opfDoc, "title") ||
    (file.name.replace(/\.(epub|equb)$/i, "").trim() || t("common.unnamed"));
  const author = firstNamespaceText(opfDoc, "creator") || t("common.anonymousAuthor");
  const intro = firstNamespaceText(opfDoc, "description") || undefined;

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
    if (!item) throw new Error(t("library.epub.spineItemMissing", { id: idref }));
    // 跳过导航文档 / NCX 等非正文项，避免把目录当正文
    if (item.properties.includes("nav") || item.mediaType === "application/x-dtbncx+xml") {
      continue;
    }
    const hrefKey = resolvePath(opfDir, item.href);
    const content = entries[hrefKey];
    if (!content) throw new Error(t("library.epub.contentMissing", { path: item.href }));
    index += 1;

    const itemDir = hrefKey.includes("/") ? hrefKey.slice(0, hrefKey.lastIndexOf("/") + 1) : "";
    const getImageSrc = (el: Element): string | null => {
      // 普通 <img src>；SVG 内联图写作 <image xlink:href>（也可省略命名空间前缀）
      const rawSrc = (
        el.getAttribute("src") ??
        el.getAttribute("xlink:href") ??
        el.getAttribute("href") ??
        ""
      ).trim();
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
    const sectionFallback = t("library.epub.sectionFallback", { index });
    const docTitle = firstText(doc, "title") || sectionFallback;
    const blocks = renderBlocks(container, getImageSrc);
    chapters.push(
      ...buildDocumentChapters(blocks, docTitle, sectionFallback, chapters.length),
    );
  }

  if (chapters.length === 0) {
    log.warn("EPUB 未解析出可读章节（文件可能已加密）", `spine=${spineOrder.length}`);
    throw new Error(t("library.epub.noChapters"));
  }

  // 封面：优先 EPUB3 manifest properties="cover-image"，其次 EPUB2 meta name="cover"
  // 仅接受真正的图片条目（个别 EPUB 会把 properties="cover-image" 标到 XHTML 上）
  const coverManifestId = findCoverManifestId(opfDoc);
  let cover: string | undefined;
  const coverItem = coverManifestId ? manifest.get(coverManifestId) : undefined;
  if (coverItem) {
    const coverKey = resolvePath(opfDir, coverItem.href);
    const mediaType =
      (manifestByHref.get(coverKey) || mimeFromPath(coverKey)) || "application/octet-stream";
    if (mediaType.startsWith("image/")) {
      const coverBytes = entries[coverKey];
      if (coverBytes) {
        const dataUrl = `data:${mediaType};base64,${bytesToBase64(coverBytes)}`;
        cover = await makeCoverThumb(dataUrl);
      }
    }
  }

  return {
    title,
    author,
    ...(intro ? { intro } : {}),
    chapters,
    ...(cover ? { cover } : {}),
  };
}

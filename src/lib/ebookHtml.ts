import type { ChapterBlock, LocalBookChapter, ParagraphPart } from "./booksTypes";
import { chapterCid, imageRefToBlock, paragraphFromParts } from "./booksTypes";
import { t } from "./i18n";

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
 * 标题单独成块；`<img>` 落在段落里时保留为该段的段内插图（图文混排），
 * 整段只有图片时仍生成独占一行的图片块；h1-h2 之外的标题保留为章内副标题。
 */
export function renderBlocks(
  root: Element,
  getImageSrc: (el: Element) => string | null,
): ChapterBlock[] {
  const blocks: ChapterBlock[] = [];
  let buf: ParagraphPart[] = [];

  const flush = () => {
    const parts = buf;
    buf = [];
    if (parts.length === 0) return;
    const { text, imgs } = paragraphFromParts(parts);
    if (!text) {
      // 没有文字：图片各自独占一行（漫画 / 整页插图的既有渲染口径）
      for (const img of imgs) blocks.push(imageRefToBlock(img));
      return;
    }
    if (imgs.length === 0) {
      // 长段落按句读切分成较短段落；含段内插图的段落不切（切分会让锚点错位）
      for (const part of splitParagraph(text)) {
        blocks.push({ kind: "p", text: part });
      }
      return;
    }
    blocks.push({ kind: "p", text, imgs });
  };

  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        buf.push({ text: child.nodeValue ?? "" });
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      // XML(application/xhtml+xml) 解析下的 tagName 为小写，统一大写比较
      const tag = el.tagName.toUpperCase();

      if (UNRENDERABLE.has(tag)) continue;

      // 软换行：当作一个空格，避免把诗歌/短行硬拆成多个段落
      if (tag === "BR") {
        buf.push({ text: " " });
        continue;
      }

      // IMG 与 SVG 内联图（<image xlink:href>）：作为段内插图留在文字流里
      if (tag === "IMG" || tag === "IMAGE") {
        const src = getImageSrc(el);
        // 即使图片缺失也保留占位，避免在段落中间静默丢图
        buf.push({ img: { src: src ?? "", alt: el.getAttribute("alt") ?? t("library.epub.imageAlt") } });
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
 *
 * cidStart 为本份文档之前整本书已产出的章节数：cid 按全书顺序编号，
 * 避免每个 spine 文档都从 c0001 重新开始导致 cid 重复。
 */
export function buildDocumentChapters(
  blocks: ChapterBlock[],
  docTitle: string,
  fallbackTitle: string,
  cidStart: number,
): LocalBookChapter[] {
  const chapters: LocalBookChapter[] = [];
  let title = "";
  let paragraphs: string[] = [];
  let body: ChapterBlock[] = [];

  const commit = () => {
    if (body.length === 0 && paragraphs.length === 0) return;
    chapters.push({
      cid: chapterCid(cidStart + chapters.length),
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
      // 段内插图的段落整体保留：剔标题句 / 再切分都会让图片锚点错位
      if (block.imgs?.length) {
        paragraphs.push(block.text);
        body.push(block);
        continue;
      }
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


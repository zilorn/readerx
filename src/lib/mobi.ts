import { extractMobi } from "./backend";
import { buildDocumentChapters, renderBlocks } from "./ebookHtml";
import { makeCoverThumb } from "./coverImage";
import { t } from "./i18n";
import type { ParsedEpub } from "./epub";

/** MOBI 的 HTML 只在离屏 DOM 中读取，图片只使用书内资源。 */
export async function parseMobiFile(file: File): Promise<ParsedEpub> {
  const parsed = await extractMobi(new Uint8Array(await file.arrayBuffer()));
  const doc = new DOMParser().parseFromString(parsed.html, "text/html");
  // 页分隔用来补足没有标题标签的旧 MOBI；有标题时沿用标题分章。
  if (!doc.body.querySelector("h1,h2")) {
    let index = 1;
    for (const el of Array.from(doc.body.getElementsByTagName("mbp:pagebreak"))) {
      const heading = doc.createElement("h2");
      heading.textContent = t("library.mobi.sectionFallback", { index: ++index });
      el.replaceWith(heading);
    }
  }
  const blocks = renderBlocks(doc.body, (el) => {
    const recindex = el.getAttribute("recindex");
    if (!recindex || !/^\d+$/.test(recindex)) return null;
    return parsed.images[Number(recindex)] ?? null;
  });
  const chapters = buildDocumentChapters(blocks, "", t("library.mobi.sectionFallback", { index: 1 }), 0);
  if (!chapters.length) throw new Error(t("shelf.import.errorNoContent"));
  const intro = parsed.intro
    ? new DOMParser().parseFromString(parsed.intro, "text/html").body.textContent?.trim()
    : undefined;
  return {
    title: parsed.title,
    author: parsed.author,
    intro,
    chapters,
    cover: parsed.cover ? await makeCoverThumb(parsed.cover) : undefined,
  };
}

import type { LocalBookChapter } from "../booksTypes";
import type { TranslationSource } from "./types";

/** 每章只构建一次完整段落索引；仅跨段选区需要连接文本镜像。 */
export function createTranslationSources(chapter: LocalBookChapter) {
  const units = chapter.blocks?.length
    ? chapter.blocks.flatMap((block) => block.kind === "p" || block.kind === "h"
      ? [{ kind: block.kind, text: block.text }] : [])
    : chapter.paragraphs.map((text) => ({ kind: "p", text }));
  const paragraphs = new Set(units.filter((unit) => unit.kind === "p").map((unit) => unit.text));
  let mirrors: string[] | undefined;
  const matches = (entry: TranslationSource): boolean => {
    if (!entry.source) return false;
    if (entry.kind === "paragraph") return paragraphs.has(entry.source);
    if (entry.kind !== "selection") return false;
    if (units.some((unit) => unit.text.includes(entry.source))) return true;
    mirrors ??= ["", "\n", "\n\n"].map((separator) => units.map((unit) => unit.text).join(separator));
    return mirrors.some((mirror) => mirror.includes(entry.source));
  };
  return {
    matches,
    source(text: string): TranslationSource | undefined {
      const paragraph: TranslationSource = { source: text, kind: "paragraph" };
      if (matches(paragraph)) return paragraph;
      const selection: TranslationSource = { source: text, kind: "selection" };
      return matches(selection) ? selection : undefined;
    },
  };
}
export function translationSourceMatches(chapter: LocalBookChapter, entry: TranslationSource): boolean {
  return createTranslationSources(chapter).matches(entry);
}
export function translationSource(chapter: LocalBookChapter, text: string): TranslationSource | undefined {
  return createTranslationSources(chapter).source(text);
}

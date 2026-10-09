import type { ChapterBlock, LocalBookChapter } from "./booksTypes";
import { updateBookChapters } from "./books";
import { chapterUnits } from "./pagination";

/** 编辑原文；每行对应一个文本块，图片不进入草稿。 */
export function chapterEditText(chapter: LocalBookChapter): string {
  return chapterUnits(chapter).filter((unit) => unit.kind !== "img")
    .map((unit) => unit.text).join("\n");
}

/** 将图片锚点映射到共同前后缀间的改动区；被删除的锚点收敛到改动起点。 */
export function editedChapter(chapter: LocalBookChapter, draft: string): LocalBookChapter {
  const before = chapterEditText(chapter);
  const after = draft.replace(/\r\n?/g, "\n");
  if (before === after) return chapter;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const mapOffset = (offset: number) => offset <= prefix ? offset
    : offset >= before.length - suffix ? after.length - (before.length - offset) : prefix;
  const lines = after.split("\n");
  const starts: number[] = [];
  let pos = 0;
  for (const line of lines) { starts.push(pos); pos += line.length + 1; }
  const blocks: ChapterBlock[] = lines.map((text) => ({ kind: "p", text }));
  const images = new Map<number, ChapterBlock[]>();
  const lineAt = (offset: number) => {
    let lo = 0, hi = starts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid;
    }
    return lo;
  };
  pos = 0;
  let textCount = 0;
  for (const unit of chapterUnits(chapter)) {
    if (unit.kind === "img") {
      // 块图保留在映射后的文本块之前；尾图仍在正文末尾。
      const index = textCount && pos > before.length ? blocks.length : lineAt(mapOffset(pos));
      const list = images.get(index) ?? [];
      list.push({ ...unit });
      images.set(index, list);
      continue;
    }
    const mapped = mapOffset(pos);
    const index = lineAt(mapped);
    // 未修改的小标题保留层级。
    if (unit.kind === "h" && lines[index] === unit.text) blocks[index] = { ...unit };
    if (unit.kind === "p" && unit.imgs?.length) {
      for (const img of unit.imgs) {
        const offset = mapOffset(pos + Math.min(Math.max(0, img.at), unit.text.length));
        const target = lineAt(offset);
        if (blocks[target].kind === "h") blocks[target] = { kind: "p", text: lines[target] };
        const block = blocks[target];
        if (block.kind === "p") (block.imgs ??= []).push({ ...img,
          at: Math.min(lines[target].length, Math.max(0, offset - starts[target])) });
      }
    }
    pos += unit.text.length + 1;
    textCount++;
  }
  const result: ChapterBlock[] = [];
  for (let index = 0; index <= blocks.length; index++) {
    result.push(...(images.get(index) ?? []));
    if (index < blocks.length) result.push(blocks[index]);
  }
  return { ...chapter, paragraphs: lines, blocks: result };
}

/** 队列内复核编辑快照，并从最新章节保留图片下载结果。 */
export async function saveChapterEdit(
  bookId: string, index: number, original: LocalBookChapter, draft: string,
): Promise<boolean> {
  const initial = chapterEditText(original);
  const update = { index, chapter: editedChapter(original, draft) };
  return (await updateBookChapters(bookId, [update], (_, latest) => {
    const current = latest.chapters[index];
    if (!current || current.cid !== original.cid || current.url !== original.url ||
      chapterEditText(current) !== initial) return false;
    update.chapter = editedChapter(current, draft);
    return true;
  })) > 0;
}

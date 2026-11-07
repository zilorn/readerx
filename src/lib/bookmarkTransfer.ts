/**
 * 书签 JSON 导出 / 导入。
 *
 * 文件顶层是一个数组，每条记录除了定位字段外，都带「书名 + 章节名 + 章节 ID + 卷名」：
 * 这四项让人工或其它工具在系统无法自动修复时重新对应章节；卷名为空时不写该字段。
 * `id` 用于再次导入时更新同一条书签；正文与字符偏移让书签能在当前目录里重新锚定。
 *
 * 导入按以下顺序认章节：章节 ID（标题相符或正文能找到原文时）→ 章节名 + 卷名 →
 * 章节名 → 已缓存正文中的唯一原文命中；标题对不上且无更可靠同名章节时，导入保留的
 * 章节 ID 作为兜底（便于手动改 ID）。找不到可靠章节的记录计入 skipped，不猜测落点。
 */
import type { LocalBook } from "./booksTypes";
import {
  BOOKMARK_MAX_LEN,
  bookmarksFor,
  bookmarksLoaded,
  ensureBookmarksLoaded,
  newBookmarkId,
  replaceBookmarksForBook,
  sortedBookmarks,
  type Bookmark,
  type BookmarkColor,
  type BookmarkStyle,
  normalizeBookmarkColor,
  normalizeBookmarkStyle,
} from "./bookmarks";
import {
  createBookmarkPlacementResolver,
  type BookmarkPlacementInput,
} from "./bookmarkMigration";
import { t } from "./i18n";

export interface BookmarkExportItem {
  bookName: string;
  chapterName: string;
  chapterId: string;
  /** 没有卷时省略（不用 null 占位） */
  volumeName?: string;
  chapterIndex: number;
  id?: string;
  text: string;
  before: string;
  after: string;
  unitIndex: number;
  charStart: number;
  charEnd: number;
  style?: BookmarkStyle;
  color?: BookmarkColor;
  createdAt: number;
}

/** 导出文件名：去掉文件系统不接受的字符，保留可读书名。 */
export function bookmarkExportFileName(bookTitle: string): string {
  const safe = Array.from(
    (bookTitle || "book")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, 60)
    .join("")
    .replace(/[. ]+$/g, "");
  return `readerx-bookmarks-${safe || "book"}.json`;
}

/** 当前书签 → 导出数组。卷名优先取书签创建时记录，旧记录再用同章目录补齐。 */
export function exportBookmarkItems(
  book: Pick<LocalBook, "title" | "chapters">,
  bookmarks: readonly Bookmark[],
): BookmarkExportItem[] {
  const byCid = new Map(book.chapters.map((chapter) => [chapter.cid, chapter]));
  return bookmarks.map((bookmark) => {
    const chapter = byCid.get(bookmark.chapterCid);
    // 旧记录可能没有章节名 / 卷名：只有 cid 指向的章节标题也能对上（或记录本身没标题）
    // 时才用当前目录补齐，避免把错位章节的卷名写进导出文件。
    const matchingChapter =
      chapter && (!bookmark.chapterTitle || chapter.title === bookmark.chapterTitle)
        ? chapter
        : undefined;
    const volume = bookmark.chapterVolume ?? matchingChapter?.volume;
    return {
      bookName: book.title,
      chapterName: bookmark.chapterTitle || matchingChapter?.title || "",
      chapterId: bookmark.chapterCid,
      ...(volume ? { volumeName: volume } : {}),
      chapterIndex: bookmark.chapterIndex,
      id: bookmark.id,
      text: bookmark.text,
      before: bookmark.before,
      after: bookmark.after,
      unitIndex: bookmark.unitIndex,
      charStart: bookmark.charStart,
      charEnd: bookmark.charEnd,
      ...(bookmark.style ? { style: bookmark.style } : {}),
      ...(bookmark.color ? { color: bookmark.color } : {}),
      createdAt: bookmark.createdAt,
    };
  });
}

/** 序列化为带缩进的数组，便于用户直接打开检查 / 修改。 */
export function serializeBookmarkExport(
  book: Pick<LocalBook, "title" | "chapters">,
  bookmarks: readonly Bookmark[],
): string {
  return JSON.stringify(exportBookmarkItems(book, bookmarks), null, 2);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function offsetOr(value: unknown, fallback: number): number {
  return Math.max(0, Math.floor(numberOr(value, fallback)));
}

function optionalString(value: unknown): string | undefined {
  const text = textOf(value).trim();
  return text ? text : undefined;
}

/**
 * 解析导出文件。接受用户手改过的字段别名（chapterCid / chapterTitle / volume），
 * 但缺少书签原文的记录无法定位，直接跳过。
 */
export function parseBookmarkExport(contents: string): BookmarkExportItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.trim().replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(t("readerChrome.bookmark.importInvalid"));
  }
  if (!Array.isArray(parsed)) throw new Error(t("readerChrome.bookmark.importInvalid"));
  const items: BookmarkExportItem[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Record<string, unknown>;
    const text = textOf(value.text);
    // 与新建书签同一上限：超长记录无法正常渲染，也不该从外部文件带进书库。
    if (!text || text.length > BOOKMARK_MAX_LEN) continue;
    const style = optionalString(value.style);
    const color = optionalString(value.color);
    const volume = optionalString(value.volumeName) ?? optionalString(value.volume);
    items.push({
      bookName: (textOf(value.bookName) || textOf(value.bookTitle)).trim(),
      chapterName: (textOf(value.chapterName) || textOf(value.chapterTitle)).trim(),
      chapterId: (textOf(value.chapterId) || textOf(value.chapterCid) || textOf(value.cid)).trim(),
      ...(volume ? { volumeName: volume } : {}),
      chapterIndex: offsetOr(value.chapterIndex, 0),
      ...(optionalString(value.id) ? { id: textOf(value.id).trim() } : {}),
      text,
      before: textOf(value.before),
      after: textOf(value.after),
      unitIndex: offsetOr(value.unitIndex, 0),
      charStart: offsetOr(value.charStart, 0),
      charEnd: offsetOr(value.charEnd, 0),
      ...(style ? { style: normalizeBookmarkStyle(style) } : {}),
      ...(color ? { color: normalizeBookmarkColor(color) } : {}),
      createdAt: numberOr(value.createdAt, Date.now()),
    });
  }
  if (items.length === 0) throw new Error(t("readerChrome.bookmark.importEmpty"));
  return items;
}

export interface BookmarkImportResult {
  bookmarks: Bookmark[];
  /** 新增的记录数 */
  imported: number;
  /** 命中已有 id / 同区间而更新的记录数 */
  updated: number;
  /** 找不到可靠章节而跳过的记录数 */
  skipped: number;
}

function placementInput(item: BookmarkExportItem): BookmarkPlacementInput {
  return {
    chapterCid: item.chapterId,
    chapterIndex: item.chapterIndex,
    chapterTitle: item.chapterName,
    chapterVolume: item.volumeName,
    unitIndex: item.unitIndex,
    charStart: item.charStart,
    charEnd: Math.max(item.charStart + 1, item.charEnd),
    text: item.text,
    before: item.before,
    after: item.after,
  };
}

/** 纯计算：把导入记录合并进现有书签，不写盘。 */
export function planBookmarkImport(
  book: Pick<LocalBook, "id" | "chapters">,
  existing: readonly Bookmark[],
  items: readonly BookmarkExportItem[],
): BookmarkImportResult {
  const next = existing.slice();
  const byId = new Map<string, number>();
  next.forEach((bookmark, index) => byId.set(bookmark.id, index));
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const resolver = createBookmarkPlacementResolver(book.chapters, { fallbackToCid: true });

  for (const item of items) {
    const placement = resolver.resolve(placementInput(item));
    if (!placement) {
      skipped++;
      continue;
    }
    const identity = item.id?.trim();
    let index = identity ? byId.get(identity) : undefined;
    if (index === undefined && !identity) {
      // 手写 / 无 id 的文件：同章同区间同原文视为同一条，避免重复导入。
      index = next.findIndex(
        (bookmark) =>
          bookmark.chapterCid === placement.chapter.cid &&
          bookmark.charStart === placement.charStart &&
          bookmark.charEnd === placement.charEnd &&
          bookmark.text === item.text,
      );
      if (index < 0) index = undefined;
    }

    const previous = index !== undefined ? next[index] : undefined;
    const style = item.style ? normalizeBookmarkStyle(item.style) : previous?.style;
    const color = item.color ? normalizeBookmarkColor(item.color) : previous?.color;
    const record: Bookmark = {
      id: previous?.id ?? identity ?? newBookmarkId(),
      bookId: book.id,
      chapterCid: placement.chapter.cid,
      chapterIndex: placement.chapterIndex,
      chapterTitle: placement.chapter.title,
      ...(placement.chapter.volume ? { chapterVolume: placement.chapter.volume } : {}),
      unitIndex: placement.unitIndex,
      charStart: placement.charStart,
      charEnd: placement.charEnd,
      text: item.text,
      before: placement.before,
      after: placement.after,
      ...(style ? { style } : {}),
      ...(color ? { color } : {}),
      createdAt: previous?.createdAt ?? item.createdAt,
    };
    if (index !== undefined) {
      next[index] = record;
      updated++;
    } else {
      byId.set(record.id, next.length);
      next.push(record);
      imported++;
    }
  }
  return { bookmarks: next, imported, updated, skipped };
}

/** 读取当前书签并序列化（供阅读器导出）。 */
export async function readBookmarksForExport(
  book: Pick<LocalBook, "id" | "title" | "chapters">,
): Promise<{ contents: string; count: number }> {
  await ensureBookmarksLoaded(book.id);
  // 读失败不能当成“这本书没有书签”导出一份空文件，更不能让随后的导入覆盖磁盘。
  if (!bookmarksLoaded(book.id)) throw new Error(t("library.bookmarks.readFailed"));
  const list = sortedBookmarks(book.id);
  return { contents: serializeBookmarkExport(book, list), count: list.length };
}

/** 解析并合并导入，成功后整表落盘。 */
export async function importBookmarks(
  book: Pick<LocalBook, "id" | "title" | "chapters">,
  items: readonly BookmarkExportItem[],
): Promise<BookmarkImportResult> {
  await ensureBookmarksLoaded(book.id);
  if (!bookmarksLoaded(book.id)) throw new Error(t("library.bookmarks.readFailed"));
  const result = planBookmarkImport(book, bookmarksFor(book.id), items);
  if (result.imported + result.updated > 0) {
    await replaceBookmarksForBook(book.id, result.bookmarks);
  }
  return result;
}

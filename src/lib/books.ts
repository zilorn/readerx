/**
 * 本地书籍仓库（两级加载）：
 * - 书库「元数据」由 Rust 后端按 id 存为 JSON 文件；书籍正文同样在文件里，
 *   但启动 / 书架只拉「章节头 + 字数」这份轻量数据（readerx_book_list_meta）；
 * - 单本书「全量（含正文）」只有在打开阅读页等真正需要内容时才按需取回
 *   （readerx_book_get）并进入本模块的响应式全量缓存；
 * - 提供 txt（正则/字数分章）与 epub（按目录结构）两种导入解析入口；
 * - 分组 / 元信息编辑走 Rust 侧就地打补丁（readerx_book_patch_meta），
 *   正文不整本经 IPC 传回 WebView。
 */
import { createSignal } from "solid-js";
import {
  clearRemoteBooks,
  deleteRemoteBook,
  getRemoteBook,
  listRemoteBookMetas,
  patchRemoteBookMeta,
  saveRemoteBook,
  saveRemoteBookChapters,
  type BookMetaPatchInput,
} from "./backend";
import {
  DEFAULT_CHARS_PER_CHAPTER,
  chapterRuleList,
  splitText,
  splitTextByChars,
} from "./chapterRules";
import type { ChapterRule, TextSplitResult } from "./chapterRules";
import type {
  BookFormat,
  BookMeta,
  BookSource,
  ChapterHead,
  LocalBook,
  LocalBookChapter,
} from "./booksTypes";
import {
  bookSourceOf,
  bookToMeta,
  assignChapterCids,
  chapterCid,
  normalizeBookTags,
  samePlainFields,
} from "./booksTypes";
import { parseEpubFile } from "./epub";
import { ensureShelfEntry } from "./store";
import { clearAllBookmarks, removeBookmarksForBook } from "./bookmarks";
import { invalidateBookLengths } from "./progress";

export type ImportSplitChoice =
  | { kind: "auto" }
  | { kind: "rule"; rule: ChapterRule }
  | { kind: "chars" };

export interface BookDraft {
  format: BookFormat;
  title: string;
  author: string;
  /** 简介（EPUB 的 dc:description / 在线书源附带；TXT 缺省，导入后可在详情页补录） */
  intro?: string;
  fileName: string;
  size: number;
  hue: number;
  splitDesc: string;
  chapters: LocalBookChapter[];
  totalChars: number;
  /** EPUB 封面缩略图（data URL）；TXT 或无封面时缺省 */
  cover?: string;
}

// ---------------------------------------------------------------------------
// 两级响应式状态：
// - metas：书库元数据（章节只有轻量头，无正文）——书架 / 搜索 / 详情等全部页面消费；
// - fulls：已物化的全量书（含正文）——只有打开阅读页等真正需要正文时才进入这里。
// null 表示元数据尚未从后端载入；两者由本模块的写路径保持同步。
// ---------------------------------------------------------------------------

const [metasState, setMetasState] = createSignal<BookMeta[] | null>(null);
const [fullsState, setFullsState] = createSignal<LocalBook[]>([]);
let ensureMetaPromise: Promise<void> | null = null;
const materializing = new Map<string, Promise<LocalBook | null>>();

function sortByImportedAt<T extends { importedAt: number }>(arr: T[]): T[] {
  return arr.sort((a, b) => b.importedAt - a.importedAt);
}

/** 把一本全量书 upsert 进「已物化」缓存（同 id 原位替换；导入时间变了才重排） */
function upsertFull(book: LocalBook): void {
  setFullsState((prev) => {
    const index = prev.findIndex((b) => b.id === book.id);
    if (index < 0) return sortByImportedAt([...prev, book]);
    if (prev[index] === book) return prev;
    // 正文回写（在线书逐批下载）不动导入时间：原位替换，避免整表过滤 + 重排
    if (prev[index].importedAt === book.importedAt) {
      const next = prev.slice();
      next[index] = book;
      return next;
    }
    return sortByImportedAt([...prev.filter((b) => b.id !== book.id), book]);
  });
}

/** 元数据里除章节头外的字段是否与书籍一致 */
function sameMetaFields(meta: BookMeta, book: LocalBook): boolean {
  return samePlainFields(meta, book, "chapters");
}

/** 两份章节头是否一致：未变章节由 chapterHeadOf 复用同一对象（指针比较即可命中），
 *  对象被重新读盘 / 重建时退回逐字段比较 —— 值没变就不该算作一次变化。 */
function sameChapterHeads(a: readonly ChapterHead[], b: readonly ChapterHead[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x.cid !== y.cid || x.title !== y.title || x.chars !== y.chars) return false;
    if ((x.url ?? "") !== (y.url ?? "")) return false;
  }
  return true;
}

/**
 * 把一本全量书（或另一个元数据对象）同步进书库元数据列表。
 * - insertIfMissing=false：只更新已存在的条目（合并发布期间书已被删除时不回填）；
 * - 章节头与其余字段都没有变化时不发布 —— 正文回写改不动书架可见数据时，
 *   前端（书架 / 详情 / 封面等消费方）不会收到一次无意义的更新。
 */
function commitMetaFromFull(book: LocalBook, insertIfMissing: boolean): void {
  const meta = bookToMeta(book);
  setMetasState((prev) => {
    if (prev === null) return null; // 元数据尚未载入时不提前建表
    const index = prev.findIndex((m) => m.id === book.id);
    if (index < 0) return insertIfMissing ? sortByImportedAt([...prev, meta]) : prev;
    const existing = prev[index];
    if (sameMetaFields(existing, book) && sameChapterHeads(existing.chapters, meta.chapters)) {
      return prev;
    }
    // 导入时间变了（重新导入等）按导入顺序重排；正文回写则原位替换
    if (existing.importedAt !== book.importedAt) {
      return sortByImportedAt([...prev.filter((m) => m.id !== book.id), meta]);
    }
    const next = prev.slice();
    next[index] = meta;
    return next;
  });
}

/** 立即把一本全量书同步进元数据清单（导入 / 物化 / 元信息编辑等一次性路径） */
function upsertMetaFromFull(book: LocalBook): void {
  commitMetaFromFull(book, true);
}

// ---------------------------------------------------------------------------
// 正文增量回写期间的元数据合并发布：
// 在线书逐批 / 逐章下载时，真正需要立刻看到新正文的是阅读器，而它读的是全量缓存
// （fulls，仍逐批即时发布）；消费元数据（章节头字符数）的书架 / 详情 / 搜索等页面
// 此时并不在屏幕上。因此这些正文回写对元数据的发布按 ~250ms 合并一次，
// 不再「落盘一章 → 重建并发布一次整本书架清单」。尾部定时保证最终一致。
// ---------------------------------------------------------------------------

const META_PUBLISH_DELAY_MS = 250;
const pendingMetaBookIds = new Set<string>();
let metaPublishTimer: number | undefined;

function flushDeferredMetas(): void {
  if (pendingMetaBookIds.size === 0) return;
  const ids = [...pendingMetaBookIds];
  pendingMetaBookIds.clear();
  const books = fullsState();
  for (const id of ids) {
    // 以全量缓存里的最新对象为准：等待期间可能又被写入 / 编辑 / 删除过
    const latest = books.find((b) => b.id === id);
    if (latest) commitMetaFromFull(latest, false);
  }
}

function deferMetaFromFull(book: LocalBook): void {
  pendingMetaBookIds.add(book.id);
  if (metaPublishTimer !== undefined) return;
  metaPublishTimer = window.setTimeout(() => {
    metaPublishTimer = undefined;
    flushDeferredMetas();
  }, META_PUBLISH_DELAY_MS);
}

function removeFromBoth(id: string): void {
  setMetasState((prev) => (prev === null ? prev : prev.filter((m) => m.id !== id)));
  setFullsState((prev) => prev.filter((b) => b.id !== id));
}

/** 元数据响应式清单（书架等页面直接消费） */
export function bookMetaList(): BookMeta[] {
  return metasState() ?? [];
}

/** 元数据是否已就绪（书架渲染的门闩） */
export function bookMetasReady(): boolean {
  return metasState() !== null;
}

/** 按 id 取书库元数据 */
export function bookMetaById(id: string): BookMeta | undefined {
  return bookMetaList().find((book) => book.id === id);
}

/** 已物化（含正文）的响应式书缓存；只读，写入请走下方带 save 的导出函数 */
export function localBookList(): LocalBook[] {
  return fullsState();
}

/** 按 id 取「已物化」的全量书；未打开过阅读页的书不在其中，请先用 ensureLocalBookContent */
export function localBookById(id: string): LocalBook | undefined {
  return fullsState().find((book) => book.id === id);
}

/**
 * 载入书库元数据（幂等，单飞）。启动 / 书架只拉轻量元数据，
 * 正文不在此处出现——需要时由 ensureLocalBookContent 单本取回。
 */
export function ensureLocalBooksLoaded(): Promise<void> {
  if (metasState() !== null) return Promise.resolve();
  if (!ensureMetaPromise) {
    ensureMetaPromise = (async () => {
      try {
        const metas = await listRemoteBookMetas();
        setMetasState(sortByImportedAt(metas));
      } catch {
        /* 后端暂不可用（如纯浏览器调试）时按空书库渲染 */
        setMetasState([]);
      } finally {
        ensureMetaPromise = null;
      }
    })();
  }
  return ensureMetaPromise;
}

/**
 * 把某本书的「全量内容（含正文）」按需取回并进入响应式缓存。
 * 返回该书的全量对象；书不存在 / 已被删除时返回 null。
 * 同 id 并发调用共享同一次后端读取。
 */
export function ensureLocalBookContent(id: string): Promise<LocalBook | null> {
  const cached = localBookById(id);
  if (cached) return Promise.resolve(cached);
  const pending = materializing.get(id);
  if (pending) return pending;
  const task = (async (): Promise<LocalBook | null> => {
    await ensureLocalBooksLoaded();
    if (!bookMetaById(id)) return null; // 元数据里已没有该书
    try {
      const full = await getRemoteBook(id);
      if (!full) return null;
      upsertFull(full);
      upsertMetaFromFull(full);
      return full;
    } finally {
      materializing.delete(id);
    }
  })();
  materializing.set(id, task);
  return task;
}

// ---------------------------------------------------------------------------
// 元信息补丁的本地同步（patchRemoteBookMeta 成功后，把改动落到两级状态）
// ---------------------------------------------------------------------------

function applyMetaPatchLocal<T extends {
  title: string;
  author: string;
  intro?: string;
  cover?: string;
  tags?: string[];
  groupId?: string | null;
}>(obj: T, patch: BookMetaPatchInput): T {
  const next = { ...obj };
  if (patch.title !== undefined) next.title = patch.title.trim() || "未命名书籍";
  if (patch.author !== undefined) next.author = patch.author.trim() || "佚名";
  if (patch.intro !== undefined) {
    const intro = patch.intro?.trim();
    next.intro = intro ? intro : undefined;
  }
  if (patch.cover !== undefined) next.cover = patch.cover ?? undefined;
  if (patch.tags !== undefined) {
    const tags = patch.tags ?? [];
    next.tags = tags.length > 0 ? tags : undefined;
  }
  if (patch.groupId !== undefined) next.groupId = patch.groupId;
  return next;
}

/** 书架分组 id 写入（磁盘就地打补丁 + 本地状态同步） */
async function setBookGroupLocal(id: string, groupId: string | null): Promise<void> {
  const meta = bookMetaById(id);
  if (!meta) return;
  await patchRemoteBookMeta(id, { groupId: groupId ?? null });
  setMetasState((prev) =>
    prev ? prev.map((m) => (m.id === id ? { ...m, groupId } : m)) : prev,
  );
  setFullsState((prev) =>
    prev.map((b) => (b.id === id ? { ...b, groupId } : b)),
  );
}

// ---------------------------------------------------------------------------
// 书籍写入路径：磁盘操作成功后同步两级状态
// ---------------------------------------------------------------------------

function newBookId(): string {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function hueFromTitle(title: string): number {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (Math.imul(hash, 31) + title.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

// ---------------------------------------------------------------------------
// 文件读取与导入
// ---------------------------------------------------------------------------

function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function decodeTxtBytes(bytes: Uint8Array): string {
  const hasBom = bytes.length >= 2;
  if (hasBom && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return stripControlChars(new TextDecoder("utf-16le").decode(bytes.subarray(2)));
  }
  if (hasBom && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return stripControlChars(new TextDecoder("utf-16be").decode(bytes.subarray(2)));
  }
  if (hasBom && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return stripControlChars(new TextDecoder("utf-8").decode(bytes.subarray(3)));
  }

  const utf8 = new TextDecoder("utf-8").decode(bytes);
  let replacementRatio = 0;
  if (utf8.includes("\uFFFD")) {
    let count = 0;
    for (let i = 0; i < utf8.length; i++) {
      if (utf8.charCodeAt(i) === 0xfffd) count++;
    }
    replacementRatio = count / Math.max(1, utf8.length);
  }
  if (replacementRatio < 0.002) return stripControlChars(utf8);

  // GBK/GB18030 是中文 TXT 常见编码（WebView 不支持时退回首段结果）
  try {
    const gbk = new TextDecoder("gb18030").decode(bytes);
    return stripControlChars(gbk);
  } catch {
    return stripControlChars(utf8);
  }
}

export function detectBookFormat(fileName: string): BookFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".txt")) return "txt";
  if (lower.endsWith(".epub") || lower.endsWith(".equb")) return "epub";
  return null;
}

function titleFromFileName(fileName: string): string {
  const name = fileName
    .replace(/\.(txt|epub|equb)$/i, "")
    .trim();
  return name || "未命名书籍";
}

function toDraft(
  file: File,
  format: BookFormat,
  title: string,
  author: string,
  splitDesc: string,
  chapters: LocalBookChapter[],
  cover?: string,
  intro?: string,
): BookDraft {
  const totalChars = chapters.reduce(
    (sum, chapter) =>
      sum + chapter.paragraphs.reduce((paraSum, paragraph) => paraSum + paragraph.length, 0),
    0,
  );
  const hasImage = chapters.some((chapter) =>
    chapter.blocks?.some((block) => block.kind === "img"),
  );
  if (totalChars === 0 && !hasImage) {
    throw new Error("没有读取到可阅读的正文内容");
  }
  const trimmedIntro = intro?.trim();
  return {
    format,
    title: title.trim() || titleFromFileName(file.name),
    author: author.trim() || "佚名",
    ...(trimmedIntro ? { intro: trimmedIntro } : {}),
    fileName: file.name,
    size: file.size,
    hue: hueFromTitle(title.trim() || file.name),
    splitDesc,
    chapters,
    totalChars,
    ...(cover ? { cover } : {}),
  };
}

/**
 * 解析 TXT：按选择的方式分章。
 * kind = auto 时按规则列表顺序尝试；rule 指定单条规则；chars 强制按字数。
 */
export async function parseTxtFile(
  file: File,
  choice: ImportSplitChoice,
  overrides?: { title?: string; author?: string },
): Promise<BookDraft> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = decodeTxtBytes(bytes);
  if (!text.trim()) throw new Error("TXT 文件内容为空，无法导入");

  const result: TextSplitResult =
    choice.kind === "chars"
      ? {
          mode: "chars",
          ruleName: `按字数分章（每章约 ${DEFAULT_CHARS_PER_CHAPTER} 字）`,
          chapters: splitTextByChars(text),
        }
      : splitText(text, choice.kind === "rule" ? [choice.rule] : chapterRuleList());

  const localChapters: LocalBookChapter[] = result.chapters.map((chapter, index) => ({
    cid: chapterCid(index),
    title: chapter.title,
    paragraphs: chapter.paragraphs,
  }));

  const splitDesc =
    result.mode === "regex"
      ? `正则匹配「${result.ruleName}」`
      : choice.kind === "chars"
        ? "按字数分章"
        : `未匹配到章节标题，${result.ruleName}`;

  return toDraft(
    file,
    "txt",
    overrides?.title ?? titleFromFileName(file.name),
    overrides?.author ?? "",
    splitDesc,
    localChapters,
  );
}

/** 解析 EPUB：沿用 EPUB 自带的目录结构（spine）逐文件成章 */
export async function parseEpubFileDraft(
  file: File,
  overrides?: { title?: string; author?: string },
): Promise<BookDraft> {
  const parsed = await parseEpubFile(file);
  return toDraft(
    file,
    "epub",
    overrides?.title ?? parsed.title,
    overrides?.author ?? parsed.author,
    `按 EPUB 目录结构（${parsed.chapters.length} 章）`,
    parsed.chapters,
    parsed.cover,
    parsed.intro,
  );
}

/** 将确认后的草稿交给 Rust 后端持久化并同步到两级响应式清单 */
export async function persistBookDraft(
  draft: BookDraft,
  source: BookSource = "local",
): Promise<LocalBook> {
  const book: LocalBook = {
    id: newBookId(),
    title: draft.title.trim() || titleFromFileName(draft.fileName),
    author: draft.author.trim() || "佚名",
    ...(draft.intro ? { intro: draft.intro } : {}),
    format: draft.format,
    fileName: draft.fileName,
    size: draft.size,
    importedAt: Date.now(),
    hue: draft.hue,
    splitDesc: draft.splitDesc,
    chapters: assignChapterCids(draft.chapters),
    cover: draft.cover,
    // 只有 WebDAV 导入需要落盘来源标记；本地导入不写字段（读取时缺省为本地）
    ...(source === "webdav" ? { source: "webdav" as const } : {}),
  };
  await saveRemoteBook(book);
  upsertMetaFromFull(book);
  upsertFull(book);
  return book;
}

/**
 * 把一本已组装完整的书直接加入书架（在线书「加入书架」用）。
 * 与 persistBookDraft 不同：不经过分章/文件导入流程，作者/格式/章节由调用方给出。
 */
export async function addBookRecord(book: LocalBook): Promise<void> {
  await saveRemoteBook(book);
  ensureShelfEntry(book.id);
  upsertMetaFromFull(book);
  upsertFull(book);
}

// ---------------------------------------------------------------------------
// 单本写入串行化：
// 同一本书的正文回写在并发拉取下会同时发生（阅读窗口预取 / 批量下载 / 重新加载本章 /
// 目录更新），而后端每条写命令都是「读文件 → 改 → 整本写回」。并发执行时读改写会交错，
// 后写入的一方会把另一方刚写好的章节丢掉。这里按书 id 把写操作排队串行执行，并让每笔写
// 在排队时基于**最新缓存**套用补丁，读改写不再互相覆盖。
// ---------------------------------------------------------------------------

const writeQueues = new Map<string, Promise<void>>();

/** 把一次写操作排进该书的写队列（队内串行；前一笔失败不影响后一笔） */
function enqueueBookWrite<T>(bookId: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(bookId) ?? Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(bookId, tail);
  void tail.then(() => {
    if (writeQueues.get(bookId) === tail) writeQueues.delete(bookId);
  });
  return run;
}

/** 按补丁原位替换若干章节（其余章节对象原样复用，不做整本深拷贝） */
function withPatchedChapters(
  book: LocalBook,
  updates: Array<{ index: number; chapter: LocalBookChapter }>,
): LocalBook {
  const byIndex = new Map<number, LocalBookChapter>();
  for (const update of updates) byIndex.set(update.index, update.chapter);
  return { ...book, chapters: book.chapters.map((ch, i) => byIndex.get(i) ?? ch) };
}

/**
 * 保存单本的内容/元信息更新并响应式替换书架中的同一本（整书 JSON 覆盖写）。
 * 仍走本书的写队列，避免与逐章回写交错；新代码请优先用 updateBookContent。
 */
export async function commitBookContentUpdate(book: LocalBook): Promise<void> {
  await enqueueBookWrite(book.id, async () => {
    await saveRemoteBook(book);
    upsertMetaFromFull(book);
    upsertFull(book);
  });
}

/**
 * 在线书「只回写部分章节」的内容更新（逐批 / 逐章下载正文用）：
 * - 后端只接收本次变动的章节（saveRemoteBookChapters），不再整本 JSON 过 IPC；
 * - 写入在本书写队列内执行：以排队时刻的**最新缓存**为基底套用补丁，不会用调用方
 *   手里的旧快照覆盖并发任务刚写好的章节（元数据同样按该最新基底合并发布）；
 * - filter 在队列内逐个补丁复核（目录世代已变 / 该章正文已被别的任务写回时丢弃），
 *   并发拉取因此既不会互相覆盖，也不会按旧下标写错章节。
 * 返回实际写入的章节数。
 */
export async function updateBookChapters(
  bookId: string,
  updates: Array<{ index: number; chapter: LocalBookChapter }>,
  filter?: (
    update: { index: number; chapter: LocalBookChapter },
    latest: LocalBook,
  ) => boolean,
): Promise<number> {
  if (updates.length === 0) return 0;
  return await enqueueBookWrite(bookId, async (): Promise<number> => {
    const latest = localBookById(bookId);
    if (!latest) return 0; // 书已被删除 / 未物化：不再写回
    const usable = filter ? updates.filter((update) => filter(update, latest)) : updates;
    if (usable.length === 0) return 0;
    await saveRemoteBookChapters(bookId, usable);
    const next = withPatchedChapters(latest, usable);
    upsertFull(next);
    deferMetaFromFull(next);
    return usable.length;
  });
}

/**
 * 单章「读改写」：在本书写队列内按**最新章节内容**应用 updater（返回 null 表示不改动）。
 * 供图片本地副本回写这类必须与并发正文更新合并的写入使用 —— 「重新加载本章」与图片
 * 下载同时发生时，图片引用要合到新正文上，而不是拿旧正文覆盖它。
 */
export async function updateBookChapterInPlace(
  bookId: string,
  index: number,
  updater: (chapter: LocalBookChapter) => LocalBookChapter | null,
): Promise<void> {
  await enqueueBookWrite(bookId, async () => {
    const latest = localBookById(bookId);
    const chapter = latest?.chapters[index];
    if (!latest || !chapter) return;
    const next = updater(chapter);
    if (!next || next === chapter) return;
    const updates = [{ index, chapter: next }];
    await saveRemoteBookChapters(bookId, updates);
    const patched = withPatchedChapters(latest, updates);
    upsertFull(patched);
    deferMetaFromFull(patched);
  });
}

/**
 * 整本内容更新（目录追加 / 覆盖更新等）：在本书写队列内基于最新缓存构建新书再落盘。
 * updater 返回 null / 原对象表示维持现状（不写盘）。
 */
export async function updateBookContent(
  bookId: string,
  updater: (latest: LocalBook) => LocalBook | null,
): Promise<LocalBook | null> {
  return await enqueueBookWrite(bookId, async () => {
    const latest = localBookById(bookId);
    if (!latest) return null;
    const next = updater(latest);
    if (!next || next === latest) return latest;
    await saveRemoteBook(next);
    upsertMetaFromFull(next);
    upsertFull(next);
    return next;
  });
}

/**
 * 书籍元信息补丁（书籍详情页「编辑」用）：
 * - title / author / intro：缺省字段表示不改动；
 * - cover：undefined 不改动，null 清除自定义封面（回退程序化封面），
 *   data URL 则替换封面。书名 / 作者留空时回落默认值，保持全库一致；
 * - tags：undefined 不改动，空数组清除现有标签，非空数组替换标签。
 * 磁盘侧由 Rust 就地打补丁，正文不整本传回。
 */
export interface BookInfoPatch {
  title?: string;
  author?: string;
  intro?: string;
  cover?: string | null;
  tags?: string[];
}

export async function updateBookInfo(id: string, patch: BookInfoPatch): Promise<void> {
  const meta = bookMetaById(id);
  if (!meta) return;
  const remote: BookMetaPatchInput = {};
  if (patch.title !== undefined) remote.title = patch.title;
  if (patch.author !== undefined) remote.author = patch.author;
  if (patch.intro !== undefined) {
    const intro = patch.intro.trim();
    remote.intro = intro ? intro : null;
  }
  if (patch.cover !== undefined) remote.cover = patch.cover ?? null;
  if (patch.tags !== undefined) {
    const tags = normalizeBookTags(patch.tags);
    remote.tags = tags.length > 0 ? tags : null;
  }
  // 元信息补丁同样是「读文件 → 打补丁 → 写回」：与逐章正文回写排队串行，避免互相覆盖
  await enqueueBookWrite(id, async () => {
    await patchRemoteBookMeta(id, remote);
    // 本地两级状态同步（磁盘已经落定）
    const apply = <T,>(obj: T): T => applyMetaPatchLocal(obj as never, remote) as never as T;
    setMetasState((prev) => (prev ? prev.map((m) => (m.id === id ? apply(m) : m)) : prev));
    setFullsState((prev) => prev.map((b) => (b.id === id ? apply(b) : b)));
  });
}

/** 用一份新解析出的草稿**原位替换**某本已导入书（同一 id 与书架记录）。
 * 用于「重新导入」（本地同名文件 / WebDAV 长按）：保留来源标记、分组与阅读进度，
 * 仅正文/元信息随新文件更新；书签记录因同 id 保留，由阅读时按新内容重新定位。
 * 调用方如需“书签继承”提示，可先用 previewBookmarkInheritance 预演再决定是否落库。
 * 参数 existing 为书库元数据即可（正文整本被草稿替换，无需先物化）。
 */
export async function replaceBookContent(
  existing: LocalBook | BookMeta,
  draft: BookDraft,
): Promise<LocalBook> {
  const base = existing as LocalBook;
  const next: LocalBook = {
    ...base,
    title: draft.title.trim() || titleFromFileName(draft.fileName),
    author: draft.author.trim() || "佚名",
    // 文件自身不带简介（如 TXT）时保留原书简介，避免「重新导入」丢字
    ...(draft.intro ? { intro: draft.intro } : {}),
    format: draft.format,
    fileName: draft.fileName,
    size: draft.size,
    hue: draft.hue,
    splitDesc: draft.splitDesc,
    chapters: assignChapterCids(draft.chapters),
    cover: draft.cover,
    importedAt: Date.now(),
  };
  invalidateBookLengths(next.id);
  // 整本替换同样排队：重新导入期间可能有章节回写在飞，避免互相覆盖
  await enqueueBookWrite(next.id, async () => {
    await saveRemoteBook(next);
    upsertMetaFromFull(next);
    upsertFull(next);
  });
  return next;
}

/**
 * 解析本地书文件为待导入草稿（不落库）。
 * 供「先解析 → 检测同名 → 再决定新增/重新导入」的流程使用。
 */
export async function parseBookFile(file: File): Promise<BookDraft> {
  const format = detectBookFormat(file.name);
  if (!format) throw new Error("仅支持导入 .txt / .epub 文件");
  return format === "txt"
    ? await parseTxtFile(file, { kind: "auto" })
    : await parseEpubFileDraft(file);
}

/**
 * 书架中与本次导入“同名”的本地书：
 * 优先 fileName 完全一致，未命中再按书名一致兜底（排除在线书，避免误匹配网络书籍）。
 * 候选均按书架现有顺序（最近导入在前）取第一本。返回值为元数据。
 */
export function findSameNameImportedBook(draft: BookDraft): BookMeta | undefined {
  const candidates = bookMetaList().filter(
    (book) => bookSourceOf(book) !== "online",
  );
  const byFile = candidates.find((book) => book.fileName === draft.fileName);
  if (byFile) return byFile;
  const title = draft.title.trim();
  if (title) return candidates.find((book) => book.title.trim() === title);
  return undefined;
}

/** 把一份已解析草稿作为一本新书落库（本地来源，自动建书架记录） */
export async function importLocalDraftAsNew(draft: BookDraft): Promise<LocalBook> {
  const book = await persistBookDraft(draft);
  ensureShelfEntry(book.id);
  return book;
}

/**
 * 直接选择文件后一键导入：TXT 按当前规则自动分章，EPUB 保留全部正文。
 * 不再打开确认页/抽屉，导入结果立即出现在书架。
 */
export async function importLocalBookFile(file: File): Promise<LocalBook> {
  const draft = await parseBookFile(file);
  return importLocalDraftAsNew(draft);
}

/** 删除一本本地书（内容 + 清单 + 书签） */
export async function removeLocalBook(id: string): Promise<void> {
  await deleteRemoteBook(id);
  removeBookmarksForBook(id);
  removeFromBoth(id);
}

/** 设置本地书所属书架分组（磁盘就地打补丁，正文不整本传回） */
export async function setLocalBookGroup(
  id: string,
  groupId: string | null,
): Promise<void> {
  await setBookGroupLocal(id, groupId);
}

/** 分组删除后，把该书架内本地书退回未分组 */
export async function clearLocalGroup(groupId: string): Promise<void> {
  const affected = bookMetaList().filter((book) => book.groupId === groupId);
  await Promise.all(affected.map((book) => setBookGroupLocal(book.id, null)));
}

/** 清空全部本地书籍（不可恢复，书签一并清空） */
export async function clearLocalBooks(): Promise<void> {
  await clearRemoteBooks();
  clearAllBookmarks();
  setMetasState([]);
  setFullsState([]);
}

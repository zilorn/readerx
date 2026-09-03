/**
 * 本地书籍仓库：
 * - 书籍数据由 Rust 后端按 id 存为 JSON 文件（应用数据目录）；
 * - 前端维护一份模块级响应式 signal，供页面同步渲染；
 * - 提供 txt（正则/字数分章）与 epub（按目录结构）两种导入解析入口。
 */
import { createSignal } from "solid-js";
import {
  clearRemoteBooks,
  deleteRemoteBook,
  listRemoteBooks,
  saveRemoteBook,
} from "./backend";
import {
  DEFAULT_CHARS_PER_CHAPTER,
  chapterRuleList,
  splitText,
  splitTextByChars,
} from "./chapterRules";
import type { ChapterRule, TextSplitResult } from "./chapterRules";
import type { BookFormat, LocalBook, LocalBookChapter } from "./booksTypes";
import { parseEpubFile } from "./epub";
import { ensureShelfEntry } from "./store";

export type ImportSplitChoice =
  | { kind: "auto" }
  | { kind: "rule"; rule: ChapterRule }
  | { kind: "chars" };

export interface BookDraft {
  format: BookFormat;
  title: string;
  author: string;
  fileName: string;
  size: number;
  hue: number;
  splitDesc: string;
  chapters: LocalBookChapter[];
  totalChars: number;
}

// ---------------------------------------------------------------------------
// 响应式书籍清单（null 表示尚未从后端载入）

const [booksState, setBooksState] = createSignal<LocalBook[] | null>(null);
let ensurePromise: Promise<void> | null = null;

export function localBookList(): LocalBook[] {
  return booksState() ?? [];
}

export function localBooksReady(): boolean {
  return booksState() !== null;
}

export function localBookById(id: string): LocalBook | undefined {
  return localBookList().find((book) => book.id === id);
}

/** 应用启动 / 页面首次需要书籍数据时调用（幂等） */
export function ensureLocalBooksLoaded(): Promise<void> {
  if (booksState() !== null) return Promise.resolve();
  if (!ensurePromise) {
    ensurePromise = (async () => {
      try {
        const all = await listRemoteBooks();
        all.sort((a, b) => b.importedAt - a.importedAt);
        setBooksState(all);
      } catch {
        /* 后端暂不可用（如纯浏览器调试）时按空书库渲染 */
        setBooksState([]);
      } finally {
        ensurePromise = null;
      }
    })();
  }
  return ensurePromise;
}

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
): BookDraft {
  const totalChars = chapters.reduce(
    (sum, chapter) =>
      sum + chapter.paragraphs.reduce((paraSum, paragraph) => paraSum + paragraph.length, 0),
    0,
  );
  if (totalChars === 0) throw new Error("没有读取到可阅读的正文内容");
  return {
    format,
    title: title.trim() || titleFromFileName(file.name),
    author: author.trim() || "佚名",
    fileName: file.name,
    size: file.size,
    hue: hueFromTitle(title.trim() || file.name),
    splitDesc,
    chapters,
    totalChars,
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
    result.chapters,
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
  );
}

/** 将确认后的草稿交给 Rust 后端持久化并同步到响应式清单 */
export async function persistBookDraft(draft: BookDraft): Promise<LocalBook> {
  const book: LocalBook = {
    id: newBookId(),
    title: draft.title.trim() || titleFromFileName(draft.fileName),
    author: draft.author.trim() || "佚名",
    format: draft.format,
    fileName: draft.fileName,
    size: draft.size,
    importedAt: Date.now(),
    hue: draft.hue,
    splitDesc: draft.splitDesc,
    chapters: draft.chapters,
  };
  await saveRemoteBook(book);
  setBooksState((prev) => {
    const next = [...(prev ?? []), book];
    next.sort((a, b) => b.importedAt - a.importedAt);
    return next;
  });
  return book;
}

/**
 * 直接选择文件后一键导入：TXT 按当前规则自动分章，EPUB 保留全部正文。
 * 不再打开确认页/抽屉，导入结果立即出现在书架。
 */
export async function importLocalBookFile(file: File): Promise<LocalBook> {
  const format = detectBookFormat(file.name);
  if (!format) throw new Error("仅支持导入 .txt / .epub 文件");
  const draft =
    format === "txt"
      ? await parseTxtFile(file, { kind: "auto" })
      : await parseEpubFileDraft(file);
  const book = await persistBookDraft(draft);
  ensureShelfEntry(book.id);
  return book;
}

/** 删除一本本地书（内容 + 清单） */
export async function removeLocalBook(id: string): Promise<void> {
  await deleteRemoteBook(id);
  setBooksState((prev) => prev?.filter((book) => book.id !== id) ?? prev);
}

/** 清空全部本地书籍（不可恢复） */
export async function clearLocalBooks(): Promise<void> {
  await clearRemoteBooks();
  setBooksState([]);
}

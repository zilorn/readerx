/**
 * 浏览器 / HarmonyOS PWA 的本地持久化。
 *
 * Tauri 宿主把书库、偏好和书签交给 Rust 落盘；HarmonyOS 的浏览器与安装后的
 * PWA 没有 Tauri 后端，改用标准 IndexedDB（不引入任何第三方存储库）：
 * - 仍保持「偏好 / 书籍元数据 / 单本正文」分层读取，避免启动时把整库正文搬进内存；
 * - 数据按 store 分表，书籍删除时一并清理书签、注释与译文缓存；
 * - IndexedDB 不可用（隐私模式、测试环境）时退化为进程内 Map，界面仍可运行，
 *   只是刷新后丢失，调用方不需要区分两种模式。
 *
 * 写入使用结构化克隆，调用方后续修改原对象不会绕过落盘；这与 Rust 侧的
 * 「写盘即快照」保持一致。
 */
import {
  bookToMeta,
  type BookMeta,
  type LocalBook,
  type LocalBookChapter,
} from "./booksTypes";
import type { BookSource } from "./bookSourcesTypes";
import type {
  TranslationBookState,
  TranslationWriteEntry,
} from "./translation/types";

const DB_NAME = "readerx";
const DB_VERSION = 1;

const STATE_STORE = "state";
const BOOK_STORE = "books";
const BOOKMARK_STORE = "bookmarks";
const ANNOTATION_STORE = "annotations";
const SOURCE_STORE = "sources";
const TRANSLATION_BOOK_STORE = "translationBooks";
const TRANSLATION_CACHE_STORE = "translationCaches";
const TRANSLATION_EPOCH_STORE = "translationEpochs";

const STORES = [
  STATE_STORE,
  BOOK_STORE,
  BOOKMARK_STORE,
  ANNOTATION_STORE,
  SOURCE_STORE,
  TRANSLATION_BOOK_STORE,
  TRANSLATION_CACHE_STORE,
  TRANSLATION_EPOCH_STORE,
] as const;

type StoreName = (typeof STORES)[number];

const memory = new Map<StoreName, Map<string, unknown>>();

function memoryOf(store: StoreName): Map<string, unknown> {
  let values = memory.get(store);
  if (!values) {
    values = new Map();
    memory.set(store, values);
  }
  return values;
}

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

let database: Promise<IDBDatabase | null> | null = null;

/** 打开数据库；不可用（无 IndexedDB / 被浏览器拒绝）时返回 null，统一走内存降级 */
function openDatabase(): Promise<IDBDatabase | null> {
  if (database) return database;
  database = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return database;
}

async function readValue<T>(store: StoreName, key: string): Promise<T | null> {
  const db = await openDatabase();
  if (!db) {
    const value = memoryOf(store).get(key);
    return value === undefined ? null : clone(value as T);
  }
  return new Promise<T | null>((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).get(key);
    request.onsuccess = () => {
      resolve(request.result === undefined ? null : (request.result as T));
    };
    request.onerror = () => reject(request.error ?? new Error("读取本地数据失败"));
  });
}

async function readAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDatabase();
  if (!db) return [...memoryOf(store).values()].map((value) => clone(value as T));
  return new Promise<T[]>((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).getAll();
    request.onsuccess = () => resolve((request.result ?? []) as T[]);
    request.onerror = () => reject(request.error ?? new Error("读取本地数据失败"));
  });
}

async function writeValue(store: StoreName, key: string, value: unknown): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    memoryOf(store).set(key, clone(value));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite");
    transaction.objectStore(store).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("写入本地数据失败"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("写入本地数据失败"));
  });
}

async function deleteValue(store: StoreName, key: string): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    memoryOf(store).delete(key);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite");
    transaction.objectStore(store).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("删除本地数据失败"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("删除本地数据失败"));
  });
}

async function clearStore(store: StoreName): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    memoryOf(store).clear();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite");
    transaction.objectStore(store).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("清空本地数据失败"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("清空本地数据失败"));
  });
}

// ---------------------------------------------------------------------------
// 偏好（readerx.* 键值）
// ---------------------------------------------------------------------------

export async function readState<T>(key: string): Promise<T | null> {
  return readValue<T>(STATE_STORE, key);
}

export async function writeState(key: string, value: unknown): Promise<void> {
  await writeValue(STATE_STORE, key, value);
}

export async function removeState(key: string): Promise<void> {
  await deleteValue(STATE_STORE, key);
}

/** 与 Rust 的 readerx_shelf_patch 同语义：ensure 只补缺、update 覆盖、reset 重建。 */
export async function patchShelf(
  entries: Record<string, unknown>,
  mode: "ensure" | "update" | "reset",
): Promise<void> {
  const current = (await readState<Record<string, unknown>>("readerx.shelf")) ?? {};
  if (mode === "reset") {
    for (const id of Object.keys(current)) {
      current[id] = { bookId: id, chapter: 0, updatedAt: Date.now() };
    }
  } else {
    for (const [id, entry] of Object.entries(entries)) {
      if (mode === "ensure" && id in current) continue;
      if (entry === null) delete current[id];
      else current[id] = entry;
    }
  }
  await writeState("readerx.shelf", current);
}

// ---------------------------------------------------------------------------
// 书籍：元数据列表与单本正文分开读
// ---------------------------------------------------------------------------

export async function listBookMetas(): Promise<BookMeta[]> {
  const books = await readAll<LocalBook>(BOOK_STORE);
  return books
    .map(bookToMeta)
    .sort((a, b) => b.importedAt - a.importedAt);
}

export async function getBook(id: string): Promise<LocalBook | null> {
  return readValue<LocalBook>(BOOK_STORE, id);
}

export async function putBook(book: LocalBook): Promise<void> {
  await writeValue(BOOK_STORE, book.id, book);
}

/** 只回写指定章节的正文，避免在线书下载时反复整体读写。 */
export async function putBookChapters(
  bookId: string,
  updates: Array<{ index: number; chapter: LocalBookChapter }>,
): Promise<void> {
  const book = await getBook(bookId);
  if (!book) throw new Error("书籍不存在");
  for (const update of updates) {
    const matches = book.chapters.filter((chapter) => chapter.cid === update.chapter.cid);
    if (!update.chapter.cid || matches.length !== 1) throw new Error("章节目录已变化");
    matches[0].paragraphs = update.chapter.paragraphs;
    matches[0].blocks = update.chapter.blocks;
  }
  await putBook(book);
}

export async function deleteBook(id: string): Promise<void> {
  await Promise.all([
    deleteValue(BOOK_STORE, id),
    deleteValue(BOOKMARK_STORE, id),
    deleteValue(ANNOTATION_STORE, id),
    deleteValue(TRANSLATION_BOOK_STORE, id),
  ]);
  const cacheKeys = (await readAllKeys(TRANSLATION_CACHE_STORE)).filter((key) =>
    key.startsWith(`${id}|`),
  );
  await Promise.all(cacheKeys.map((key) => deleteValue(TRANSLATION_CACHE_STORE, key)));
  const epochKeys = (await readAllKeys(TRANSLATION_EPOCH_STORE)).filter((key) =>
    key.startsWith(`${id}|`),
  );
  await Promise.all(epochKeys.map((key) => deleteValue(TRANSLATION_EPOCH_STORE, key)));
}

async function readAllKeys(store: StoreName): Promise<string[]> {
  const db = await openDatabase();
  if (!db) return [...memoryOf(store).keys()];
  return new Promise<string[]>((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).getAllKeys();
    request.onsuccess = () =>
      resolve((request.result ?? []).map((key) => String(key)));
    request.onerror = () => reject(request.error ?? new Error("读取本地数据失败"));
  });
}

export async function clearBooks(): Promise<void> {
  await Promise.all([
    clearStore(BOOK_STORE),
    clearStore(BOOKMARK_STORE),
    clearStore(ANNOTATION_STORE),
    clearStore(TRANSLATION_BOOK_STORE),
    clearStore(TRANSLATION_CACHE_STORE),
    clearStore(TRANSLATION_EPOCH_STORE),
  ]);
}

// ---------------------------------------------------------------------------
// 书签 / 注释
// ---------------------------------------------------------------------------

export async function getBookmarks<T>(bookId: string): Promise<T[]> {
  return (await readValue<T[]>(BOOKMARK_STORE, bookId)) ?? [];
}

export async function putBookmarks(bookId: string, bookmarks: readonly unknown[]): Promise<void> {
  await writeValue(BOOKMARK_STORE, bookId, bookmarks);
}

export async function getAnnotations<T>(bookId: string): Promise<T[]> {
  return (await readValue<T[]>(ANNOTATION_STORE, bookId)) ?? [];
}

export async function putAnnotations(bookId: string, annotations: readonly unknown[]): Promise<void> {
  await writeValue(ANNOTATION_STORE, bookId, annotations);
}

// ---------------------------------------------------------------------------
// 书源
// ---------------------------------------------------------------------------

export async function listSources(): Promise<BookSource[]> {
  return readAll<BookSource>(SOURCE_STORE);
}

export async function getSource(id: string): Promise<BookSource | null> {
  return readValue<BookSource>(SOURCE_STORE, id);
}

export async function putSource(source: BookSource): Promise<void> {
  await writeValue(SOURCE_STORE, source.id, source);
}

export async function deleteSource(id: string): Promise<void> {
  await deleteValue(SOURCE_STORE, id);
}

export async function clearSourceGroup(groupId: string): Promise<number> {
  const sources = await listSources();
  const affected = sources.filter((source) => source.groupId === groupId);
  await Promise.all(
    affected.map((source) => putSource({ ...source, groupId: undefined })),
  );
  return affected.length;
}

// ---------------------------------------------------------------------------
// 翻译：按书保存词表 / 覆盖项，按章节缓存译文
// ---------------------------------------------------------------------------

export interface StoredTranslationCache {
  revision: string;
  entries: Record<string, TranslationWriteEntry>;
}

export async function getTranslationBook(
  bookId: string,
): Promise<TranslationBookState | null> {
  return readValue<TranslationBookState>(TRANSLATION_BOOK_STORE, bookId);
}

export async function putTranslationBook(
  bookId: string,
  value: TranslationBookState,
): Promise<void> {
  await writeValue(TRANSLATION_BOOK_STORE, bookId, value);
}

function translationKey(bookId: string, cid: string): string {
  return `${bookId}|${cid}`;
}

export async function getTranslationCache(
  bookId: string,
  cid: string,
): Promise<StoredTranslationCache | null> {
  return readValue<StoredTranslationCache>(
    TRANSLATION_CACHE_STORE,
    translationKey(bookId, cid),
  );
}

export async function putTranslationCache(
  bookId: string,
  cid: string,
  cache: StoredTranslationCache,
): Promise<void> {
  await writeValue(
    TRANSLATION_CACHE_STORE,
    translationKey(bookId, cid),
    cache,
  );
}

export async function deleteTranslationCache(bookId: string, cid: string): Promise<void> {
  await deleteValue(TRANSLATION_CACHE_STORE, translationKey(bookId, cid));
}

export async function translationEpoch(bookId: string, cid: string): Promise<number> {
  return (
    (await readValue<number>(TRANSLATION_EPOCH_STORE, translationKey(bookId, cid))) ?? 0
  );
}

export async function bumpTranslationEpoch(
  bookId: string,
  cid: string,
): Promise<number> {
  const key = translationKey(bookId, cid);
  const next = ((await readValue<number>(TRANSLATION_EPOCH_STORE, key)) ?? 0) + 1;
  await writeValue(TRANSLATION_EPOCH_STORE, key, next);
  return next;
}

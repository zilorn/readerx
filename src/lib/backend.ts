/**
 * 前端与 Rust 后端的唯一通道。
 * - Tauri 环境：通过 invoke 读写 Rust 管理的 JSON 文件；
 * - 纯浏览器开发环境：只使用内存 Map 降级，不写任何 WebView 持久化存储。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { LocalBook } from "./booksTypes";
import type {
  BookItem,
  BookSource,
  BookSourceSummary,
  ChapterContentResult,
  ChapterItem,
  SourceCallResult,
  SourceLoginResult,
} from "./bookSourcesTypes";

const tauri = isTauri();

const memoryState = new Map<string, unknown>();
const memoryBooks = new Map<string, LocalBook>();
const memorySources = new Map<string, BookSource>();

/** 读取一条状态（readerx.* 前缀）；不存在或纯浏览器环境返回 null */
export async function readState<T>(key: string): Promise<T | null> {
  if (!tauri) {
    return (memoryState.get(key) as T | undefined) ?? null;
  }
  try {
    const value = await invoke<T | null>("readerx_state_get", { key });
    return value ?? null;
  } catch (err) {
    console.error(`[backend] 读取状态 ${key} 失败`, err);
    return null;
  }
}

/** 写入一条状态；Tauri 环境失败时降级为日志，不打断当前操作 */
export async function writeState(key: string, value: unknown): Promise<void> {
  if (!tauri) {
    memoryState.set(key, value);
    return;
  }
  try {
    await invoke("readerx_state_set", { key, value });
  } catch (err) {
    console.error(`[backend] 写入状态 ${key} 失败`, err);
  }
}

export async function removeState(key: string): Promise<void> {
  if (!tauri) {
    memoryState.delete(key);
    return;
  }
  try {
    await invoke("readerx_state_remove", { key });
  } catch (err) {
    console.error(`[backend] 删除状态 ${key} 失败`, err);
  }
}

export async function listRemoteBooks(): Promise<LocalBook[]> {
  if (!tauri) {
    return [...memoryBooks.values()];
  }
  return invoke<LocalBook[]>("readerx_book_list");
}

export async function saveRemoteBook(book: LocalBook): Promise<void> {
  if (!tauri) {
    memoryBooks.set(book.id, book);
    return;
  }
  await invoke("readerx_book_put", { book });
}

export async function deleteRemoteBook(id: string): Promise<void> {
  if (!tauri) {
    memoryBooks.delete(id);
    return;
  }
  await invoke("readerx_book_delete", { id });
}

export async function clearRemoteBooks(): Promise<void> {
  if (!tauri) {
    memoryBooks.clear();
    return;
  }
  const books = await listRemoteBooks();
  await Promise.all(books.map((book) => deleteRemoteBook(book.id)));
}

/** 读取随应用打包的 LICENSE 全文；仅 Tauri 环境可用，浏览器开发环境返回 null */
export async function readLicenseText(): Promise<string | null> {
  if (!tauri) return null;
  try {
    return await invoke<string>("readerx_license_text");
  } catch (err) {
    console.error("[backend] 读取开源许可失败", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 书源（Book Source）
// ---------------------------------------------------------------------------

export async function listRemoteSources(): Promise<BookSourceSummary[]> {
  if (!tauri) return [...memorySources.values()].map((s) => toSummary(s));
  try {
    return await invoke<BookSourceSummary[]>("readerx_sources_list");
  } catch (err) {
    console.error("[backend] 读取书源列表失败", err);
    return [];
  }
}

export async function getRemoteSource(id: string): Promise<BookSource | null> {
  if (!tauri) return memorySources.get(id) ?? null;
  try {
    return await invoke<BookSource | null>("readerx_source_get", { id });
  } catch (err) {
    console.error(`[backend] 读取书源 ${id} 失败`, err);
    return null;
  }
}

export async function saveRemoteSource(source: BookSource): Promise<void> {
  if (!tauri) {
    memorySources.set(source.id, source);
    return;
  }
  await invoke("readerx_source_put", { source });
}

export async function deleteRemoteSource(id: string): Promise<void> {
  if (!tauri) {
    memorySources.delete(id);
    return;
  }
  await invoke("readerx_source_delete", { id });
}

/** 执行一次书源入口函数；浏览器开发环境返回错误结果 */
export async function callRemoteSource(
  sourceId: string,
  fnName: string,
  args: unknown,
): Promise<SourceCallResult> {
  if (!tauri) {
    return { ok: false, error: "书源功能仅在应用内可用", logs: [], elapsedMs: 0 };
  }
  try {
    return await invoke<SourceCallResult>("readerx_source_call", {
      sourceId,
      fnName,
      args,
    });
  } catch (err) {
    return { ok: false, error: String(err), logs: [], elapsedMs: 0 };
  }
}

/** 批量拉取正文（内部并行上限由用户全局“书源并发”设置决定） */
export async function fetchRemoteChapterContents(
  sourceId: string,
  book: BookItem,
  chapters: ChapterItem[],
): Promise<ChapterContentResult[]> {
  if (!tauri) return [];
  try {
    return await invoke<ChapterContentResult[]>("readerx_source_fetch_contents", {
      sourceId,
      book,
      chapters,
    });
  } catch (err) {
    console.error("[backend] 拉取正文失败", err);
    return [];
  }
}

function toSummary(source: BookSource): BookSourceSummary {
  return {
    schemaVersion: source.schemaVersion,
    id: source.id,
    name: source.name,
    bookSourceUrl: source.bookSourceUrl,
    author: source.author,
    version: source.version,
    enabled: source.enabled,
    capabilities: source.capabilities,
    updateTime: source.updateTime,
    jsLength: source.js.length,
  };
}

// ---------------------------------------------------------------------------
// 网页登录（WebView，仅 Android；登录 Cookie 由 Rust 按书源持久化并注入会话）
// ---------------------------------------------------------------------------

/** 平台是否支持网页登录 */
export async function isSourceLoginSupported(): Promise<boolean> {
  if (!tauri) return false;
  try {
    return await invoke<boolean>("readerx_source_login_supported");
  } catch (err) {
    console.error("[backend] 查询网页登录支持失败", err);
    return false;
  }
}

/**
 * 打开网页登录浮层并等待用户完成/取消。
 * 成功后 Cookie 已持久化并注入该书源会话（本次运行后续 http.* 自动携带）。
 */
export async function loginSourceWebview(
  sourceId: string,
  url: string,
): Promise<SourceLoginResult> {
  if (!tauri) {
    return {
      ok: false,
      url,
      cookies: "",
      count: 0,
      message: "网页登录仅在 Android 应用内可用",
    };
  }
  try {
    return await invoke<SourceLoginResult>("readerx_source_login_webview", {
      sourceId,
      url,
    });
  } catch (err) {
    return { ok: false, url, cookies: "", count: 0, message: String(err) };
  }
}

/** 清空某个书源已保存的网页登录 Cookie（持久化 + 当前会话）；返回移除的行数 */
export async function clearSourceLogin(sourceId: string): Promise<number> {
  if (!tauri) return 0;
  try {
    return await invoke<number>("readerx_source_login_clear", { sourceId });
  } catch (err) {
    console.error(`[backend] 清除书源 ${sourceId} 登录 Cookie 失败`, err);
    return 0;
  }
}

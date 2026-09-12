/**
 * 前端与 Rust 后端的唯一通道。
 * - Tauri 环境：通过 invoke 读写 Rust 管理的 JSON 文件；
 * - 纯浏览器开发环境：只使用内存 Map 降级，不写任何 WebView 持久化存储。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { bookToMeta, type BookMeta, type LocalBook, type LocalBookChapter } from "./booksTypes";
import { reportFailure } from "./errorReport";
import type {
  BookItem,
  BookSource,
  BookSourceSummary,
  ChapterContentResult,
  ChapterItem,
  FetchedImage,
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
    reportFailure("读取本地设置失败", err);
    return null;
  }
}

/** 写入一条状态；Tauri 环境失败时降级为内存值，但要让用户知道没存下来 */
export async function writeState(key: string, value: unknown): Promise<void> {
  if (!tauri) {
    memoryState.set(key, value);
    return;
  }
  try {
    await invoke("readerx_state_set", { key, value });
  } catch (err) {
    reportFailure("保存本地设置失败", err);
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
    reportFailure("清除本地设置失败", err);
  }
}

/** 书库元数据列表（章节无正文）：启动 / 书架渲染用，避免把整库正文搬进 WebView */
export async function listRemoteBookMetas(): Promise<BookMeta[]> {
  if (!tauri) {
    return [...memoryBooks.values()].map((book) => bookToMeta(book));
  }
  return invoke<BookMeta[]>("readerx_book_list_meta");
}

/** 读取单本书全文（阅读页打开时按需调用）；不存在返回 null */
export async function getRemoteBook(id: string): Promise<LocalBook | null> {
  if (!tauri) {
    return memoryBooks.get(id) ?? null;
  }
  try {
    return await invoke<LocalBook | null>("readerx_book_get", { id });
  } catch (err) {
    reportFailure("读取书籍失败", err);
    return null;
  }
}

export async function saveRemoteBook(book: LocalBook): Promise<void> {
  if (!tauri) {
    memoryBooks.set(book.id, book);
    return;
  }
  await invoke("readerx_book_put", { book });
}

/**
 * 只回写一本书的若干章节（按下标）——在线书逐批下载正文用。
 * 相比每次整本 JSON 经 IPC 传一遍（图片章节会把整本 data URL 反复拷贝，
 * 大书会明显卡 UI 甚至内存暴涨闪退），这里只传本次真正变动的章节；
 * Rust 侧读回书文件、原位替换后再落盘（I/O 在 blocking 线程池）。
 */
export async function saveRemoteBookChapters(
  bookId: string,
  updates: Array<{ index: number; chapter: LocalBookChapter }>,
): Promise<void> {
  if (!tauri) {
    const book = memoryBooks.get(bookId);
    if (book) {
      for (const update of updates) {
        book.chapters[update.index] = update.chapter;
      }
    }
    return;
  }
  await invoke("readerx_book_chapters_put", { bookId, updates });
}

export async function deleteRemoteBook(id: string): Promise<void> {
  if (!tauri) {
    memoryBooks.delete(id);
    return;
  }
  await invoke("readerx_book_delete", { id });
}

/** 单本元信息补丁入参：外层 undefined = 不改动；null = 清除（intro/cover/tags/groupId） */
export interface BookMetaPatchInput {
  title?: string;
  author?: string;
  intro?: string | null;
  cover?: string | null;
  tags?: string[] | null;
  groupId?: string | null;
}

/** 只改一本书的元信息（分组 / 书名 / 封面 / 标签…）；正文留在 Rust 侧磁盘，不整本回传 */
export async function patchRemoteBookMeta(
  id: string,
  patch: BookMetaPatchInput,
): Promise<void> {
  if (!tauri) {
    const book = memoryBooks.get(id);
    if (!book) return;
    if (patch.title !== undefined) book.title = patch.title.trim() || "未命名书籍";
    if (patch.author !== undefined) book.author = patch.author.trim() || "佚名";
    if (patch.intro !== undefined) {
      const intro = patch.intro?.trim();
      book.intro = intro ? intro : undefined;
    }
    if (patch.cover !== undefined) book.cover = patch.cover ?? undefined;
    if (patch.tags !== undefined) {
      const tags = patch.tags ?? [];
      book.tags = tags.length > 0 ? tags : undefined;
    }
    if (patch.groupId !== undefined) book.groupId = patch.groupId;
    return;
  }
  await invoke("readerx_book_patch_meta", { id, patch });
}

export async function clearRemoteBooks(): Promise<void> {
  if (!tauri) {
    memoryBooks.clear();
    return;
  }
  const metas = await listRemoteBookMetas();
  await Promise.all(metas.map((meta) => deleteRemoteBook(meta.id)));
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
    reportFailure("读取书源列表失败", err);
    return [];
  }
}

export async function getRemoteSource(id: string): Promise<BookSource | null> {
  if (!tauri) return memorySources.get(id) ?? null;
  try {
    return await invoke<BookSource | null>("readerx_source_get", { id });
  } catch (err) {
    reportFailure("读取书源失败", err);
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
    reportFailure("拉取章节正文失败", err);
    return [];
  }
}

/** 书源会话下载图片的结果：成功给 data URL，失败给可读原因（供占位框 / 重试提示） */
export interface SourceImageResult {
  /** 图片 data URL；失败为空串 */
  data: string;
  /** 失败原因；成功为空串 */
  error: string;
}

/**
 * 用书源会话下载一张图片（正文插图 / 书源封面），返回 data URL 或失败原因。
 * 图片请求自动携带该书源的默认头/Cookie/UA，Referer 可单独指定（正文页面 / 书页地址）。
 */
export async function fetchRemoteSourceImage(
  sourceId: string,
  url: string,
  referer: string | null,
): Promise<SourceImageResult> {
  if (!tauri) return { data: "", error: "书源图片仅应用内可用" };
  try {
    const r = await invoke<FetchedImage>("readerx_source_fetch_image", {
      sourceId,
      url,
      referer: referer || null,
    });
    if (!r.ok || !r.data) return { data: "", error: r.error || "图片下载失败" };
    return { data: `data:${r.mime || "image/jpeg"};base64,${r.data}`, error: "" };
  } catch (err) {
    console.error("[backend] 图片下载失败", err);
    return { data: "", error: err instanceof Error ? err.message : String(err) };
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
    reportFailure("清除登录状态失败", err);
    return 0;
  }
}

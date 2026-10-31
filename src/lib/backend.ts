import { sourceId, stableId } from "./dataIds";
/**
 * 前端与 Rust 后端的唯一通道。
 * - Tauri 环境：通过 invoke 读写 Rust 管理的数据库与文件；
 * - HarmonyOS / 浏览器（PWA）：用 IndexedDB（见 `webStore.ts`）持久化同一批数据，
 *   没有任何第三方存储依赖；IndexedDB 不可用时才退化为内存。
 */
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { BookMeta, LocalBook, LocalBookChapter } from "./booksTypes";
import { reportFailure } from "./errorReport";
import { openExternal } from "./external";
import { t } from "./i18n";
import { createLogger } from "./logger";
import { createTranslationSources } from "./translation/sources";
import type {
  TranslationBookState,
  TranslationCache,
  TranslationWriteEntry,
} from "./translation/types";
import * as webStore from "./webStore";
import type {
  BookImageFile,
  BookImageInfo,
  BookItem,
  BookSource,
  BookSourceSummary,
  ChapterContentResult,
  ChapterItem,
  ChapterPromoteResult,
  ChapterRunSummary,
  ChapterTaskEvent,
  ChapterTaskItem,
  ChapterTaskResult,
  FetchedImage,
  SourceCallResult,
  SourceLoginResult,
} from "./bookSourcesTypes";

const tauri = isTauri();

const log = createLogger("backend");

/** 读取一条状态（readerx.* 前缀）；不存在时返回 null */
export async function readState<T>(key: string): Promise<T | null> {
  if (!tauri) {
    try {
      return await webStore.readState<T>(key);
    } catch (err) {
      reportFailure(t("library.state.readFailed"), err);
      return null;
    }
  }
  try {
    const value = await invoke<T | null>("readerx_state_get", { key });
    return value ?? null;
  } catch (err) {
    reportFailure(t("library.state.readFailed"), err);
    return null;
  }
}

/** 写入一条状态；失败时让用户知道没存下来 */
export async function writeState(key: string, value: unknown): Promise<void> {
  if (!tauri) {
    try {
      await webStore.writeState(key, value);
    } catch (err) {
      reportFailure(t("library.state.writeFailed"), err);
    }
    return;
  }
  try {
    await invoke("readerx_state_set", { key, value });
  } catch (err) {
    reportFailure(t("library.state.writeFailed"), err);
  }
}

/** 后端在事务中应用书架增量，避免旧快照覆盖同步来的其它书进度。 */
export async function patchShelf(entries: Record<string, unknown>, mode: "ensure" | "update" | "reset"): Promise<void> {
  if (!tauri) {
    try {
      await webStore.patchShelf(entries, mode);
    } catch (err) {
      reportFailure(t("library.state.writeFailed"), err);
    }
    return;
  }
  try {
    await invoke("readerx_shelf_patch", { entries, mode });
  } catch (err) {
    reportFailure(t("library.state.writeFailed"), err);
  }
}

export async function removeState(key: string): Promise<void> {
  if (!tauri) {
    try {
      await webStore.removeState(key);
    } catch (err) {
      reportFailure(t("library.state.removeFailed"), err);
    }
    return;
  }
  try {
    await invoke("readerx_state_remove", { key });
  } catch (err) {
    reportFailure(t("library.state.removeFailed"), err);
  }
}

/** 书库元数据列表（章节无正文）：启动 / 书架渲染用，避免把整库正文搬进 WebView */
export async function listRemoteBookMetas(): Promise<BookMeta[]> {
  if (!tauri) return webStore.listBookMetas();
  return invoke<BookMeta[]>("readerx_book_list_meta");
}

/** 读取单本书全文（阅读页打开时按需调用）；不存在返回 null */
export async function getRemoteBook(id: string): Promise<LocalBook | null> {
  if (!tauri) return webStore.getBook(id);
  try {
    return await invoke<LocalBook | null>("readerx_book_get", { id });
  } catch (err) {
    reportFailure(t("library.book.readFailed"), err);
    return null;
  }
}

export async function saveRemoteBook(book: LocalBook): Promise<void> {
  if (!tauri) {
    await webStore.putBook(book);
    return;
  }
  book.id = await invoke<string>("readerx_book_put", { book });
}

/**
 * 只回写一本书的若干章节（按 cid）——在线书逐章下载正文用（写盘按小批合并）。
 * 相比每次整本 JSON 经 IPC 传一遍（图片章节会把整本 data URL 反复拷贝，
 * 大书会明显卡 UI 甚至内存暴涨闪退），这里只传本次真正变动的章节；
 * Rust 侧读回书文件、原位替换后再落盘（I/O 在 blocking 线程池）。
 */
export async function saveRemoteBookChapters(
  bookId: string,
  updates: Array<{ index: number; chapter: LocalBookChapter }>,
): Promise<void> {
  if (!tauri) {
    await webStore.putBookChapters(bookId, updates);
    return;
  }
  await invoke("readerx_book_chapters_put", { bookId, updates });
}

export async function deleteRemoteBook(id: string): Promise<void> {
  if (!tauri) {
    await webStore.deleteBook(id);
    return;
  }
  await invoke("readerx_book_delete", { id });
}

// ---------------------------------------------------------------------------
// 书签：按书独立文件（books/<id>/bookmarks.json），与正文、其它书的书签互不相干
// ---------------------------------------------------------------------------

/**
 * 读取一本书的书签；读失败返回 null（调用方据此区分「没有书签」与「读不出来」，
 * 后者不能当成空列表写回去，否则会把已存的书签覆盖掉）。
 */
export async function readRemoteBookmarks<T>(bookId: string): Promise<T[] | null> {
  if (!tauri) {
    try {
      return await webStore.getBookmarks<T>(bookId);
    } catch (err) {
      reportFailure(t("library.bookmarks.readFailed"), err);
      return null;
    }
  }
  try {
    return await invoke<T[]>("readerx_bookmarks_get", { bookId });
  } catch (err) {
    reportFailure(t("library.bookmarks.readFailed"), err);
    return null;
  }
}

/** 覆盖式保存一本书的书签；失败时已提示用户（内存里的书签仍可见，但没落盘） */
export async function saveRemoteBookmarks(
  bookId: string,
  bookmarks: readonly unknown[],
): Promise<void> {
  if (!tauri) {
    try {
      await webStore.putBookmarks(bookId, bookmarks);
    } catch (err) {
      reportFailure(t("library.bookmarks.writeFailed"), err);
    }
    return;
  }
  try {
    await invoke("readerx_bookmarks_put", { bookId, bookmarks });
  } catch (err) {
    reportFailure(t("library.bookmarks.writeFailed"), err);
  }
}

/** 注释按书单独存储；读取失败不能当作空数据覆盖。 */
export async function readRemoteAnnotations<T>(bookId: string): Promise<T[] | null> {
  if (!tauri) {
    try {
      return await webStore.getAnnotations<T>(bookId);
    } catch (err) {
      reportFailure(t("readerChrome.annotation.readFailed"), err);
      return null;
    }
  }
  try {
    return await invoke<T[]>("readerx_annotations_get", { bookId });
  } catch (err) {
    reportFailure(t("readerChrome.annotation.readFailed"), err);
    return null;
  }
}
export async function saveRemoteAnnotations<T>(bookId: string, annotations: readonly T[], previous: readonly T[]): Promise<T[] | null> {
  if (!tauri) {
    try {
      await webStore.putAnnotations(bookId, annotations);
      return [...annotations];
    } catch (err) {
      reportFailure(t("readerChrome.annotation.writeFailed"), err);
      return null;
    }
  }
  try {
    return await invoke<T[]>("readerx_annotations_put", { bookId, annotations, previous });
  } catch (err) {
    reportFailure(t("readerChrome.annotation.writeFailed"), err);
    return null;
  }
}

/** 单本元信息补丁入参：外层 undefined = 不改动；null = 清除（intro/cover/tags/sourceTags/groupId） */
export interface BookMetaPatchInput {
  title?: string;
  author?: string;
  intro?: string | null;
  cover?: string | null;
  tags?: string[] | null;
  sourceTags?: string[] | null;
  groupId?: string | null;
}

/** 只改一本书的元信息（分组 / 书名 / 封面 / 标签…）；正文留在 Rust 侧磁盘，不整本回传 */
export async function patchRemoteBookMeta(
  id: string,
  patch: BookMetaPatchInput,
): Promise<void> {
  if (!tauri) {
    const book = await webStore.getBook(id);
    if (!book) return;
    if (patch.title !== undefined) {
      book.title = patch.title.trim() || t("common.unnamedBook");
    }
    if (patch.author !== undefined) {
      book.author = patch.author.trim() || t("common.anonymousAuthor");
    }
    if (patch.intro !== undefined) {
      const intro = patch.intro?.trim();
      book.intro = intro ? intro : undefined;
    }
    if (patch.cover !== undefined) book.cover = patch.cover ?? undefined;
    if (patch.tags !== undefined) {
      const tags = patch.tags ?? [];
      book.tags = tags.length > 0 ? tags : undefined;
    }
    if (patch.sourceTags !== undefined) {
      const sourceTags = patch.sourceTags ?? [];
      book.sourceTags = sourceTags.length > 0 ? sourceTags : undefined;
    }
    if (patch.groupId !== undefined) book.groupId = patch.groupId;
    await webStore.putBook(book);
    return;
  }
  await invoke("readerx_book_patch_meta", { id, patch });
}

export async function clearRemoteBooks(): Promise<void> {
  if (!tauri) {
    await webStore.clearBooks();
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
    // 降级：阅读器少一段许可文本，不影响读书（warn 而非 error）
    log.warn("读取开源许可失败，返回空内容", err);
    return null;
  }
}

/** 读取随应用打包的第三方开源库使用声明全文；仅 Tauri 环境可用，浏览器开发环境返回 null */
export async function readThirdPartyNotices(): Promise<string | null> {
  if (!tauri) return null;
  try {
    return await invoke<string>("readerx_third_party_notices");
  } catch (err) {
    // 降级：阅读器少一段声明文本，不影响读书
    log.warn("读取第三方开源库声明失败，返回空内容", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 书源（Book Source）
// ---------------------------------------------------------------------------

export async function listRemoteSources(): Promise<BookSourceSummary[]> {
  if (!tauri) {
    try {
      return (await webStore.listSources()).map((source) => toSummary(source));
    } catch (err) {
      reportFailure(t("library.source.listFailed"), err);
      return [];
    }
  }
  try {
    return await invoke<BookSourceSummary[]>("readerx_sources_list");
  } catch (err) {
    reportFailure(t("library.source.listFailed"), err);
    return [];
  }
}

export async function getRemoteSource(id: string): Promise<BookSource | null> {
  if (!tauri) {
    try {
      return await webStore.getSource(id);
    } catch (err) {
      reportFailure(t("library.source.readFailed"), err);
      return null;
    }
  }
  try {
    return await invoke<BookSource | null>("readerx_source_get", { id });
  } catch (err) {
    reportFailure(t("library.source.readFailed"), err);
    return null;
  }
}

export async function saveRemoteSource(source: BookSource): Promise<void> {
  if (!tauri) {
    const old = source.id;
    source.id = stableId(old, "s-") ? old : sourceId(source.bookSourceUrl);
    if (old && old !== source.id) await webStore.deleteSource(old);
    await webStore.putSource(source);
    return;
  }
  const saved = await invoke<BookSource>("readerx_source_put", { source });
  source.id = saved.id;
}

export async function deleteRemoteSource(id: string): Promise<void> {
  if (!tauri) {
    await webStore.deleteSource(id);
    return;
  }
  await invoke("readerx_source_delete", { id });
}

/**
 * 书源分组被删除：清空全部书源上该分组的归属，返回受影响的书源数量。
 * Tauri 侧由 Rust 整批改写；Web 端在 IndexedDB 中逐源更新。
 */
export async function clearRemoteSourceGroup(groupId: string): Promise<number> {
  if (!tauri) return webStore.clearSourceGroup(groupId);
  return await invoke<number>("readerx_source_group_clear", { groupId });
}

/** 执行一次书源入口函数；浏览器开发环境返回错误结果 */
export async function callRemoteSource(
  sourceId: string,
  fnName: string,
  args: unknown,
): Promise<SourceCallResult> {
  if (!tauri) {
    return { ok: false, error: t("library.source.appOnly"), logs: [], elapsedMs: 0 };
  }
  try {
    log.debug("调用书源函数", `sourceId=${sourceId}`, `fn=${fnName}`);
    return await invoke<SourceCallResult>("readerx_source_call", {
      sourceId,
      fnName,
      args,
    });
  } catch (err) {
    // 失败以结果对象交给调用方展示，不走 reportFailure —— 在这里留一条日志
    log.warn("调用书源函数失败", `sourceId=${sourceId}`, `fn=${fnName}`, err);
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
    reportFailure(t("library.source.fetchContentsFailed"), err);
    return [];
  }
}

/** 逐章拉取的返回：summary 为空表示这次调用本身失败了（原因见 error） */
export interface ChapterTaskRunOutcome {
  summary: ChapterRunSummary | null;
  error: string;
}

/** 收尾标记最多等这么久（毫秒）：命令已经返回，通道消息只可能「还在路上」 */
const CHANNEL_SETTLE_TIMEOUT_MS = 5_000;

/** 等「本轮结果已全部发出」的收尾标记；超时也放行，绝不把下载卡死在这里 */
async function waitChannelSettled(settled: Promise<void>): Promise<void> {
  await Promise.race([
    settled,
    new Promise<void>((resolve) => window.setTimeout(resolve, CHANNEL_SETTLE_TIMEOUT_MS)),
  ]);
}

/**
 * 逐章拉取正文（**每章一个任务**）：把整批章节交给引擎，引擎按「书源并发」起若干 worker
 * 逐章领取，**取回一章立刻经 onTask 回传一条** —— 不打包、不等整批回来。
 *
 * - `runId`：本轮运行的标识，配合 [`cancelRemoteChapterRun`]（停止）与
 *   [`promoteRemoteChapterRun`]（把正在读的那一章插到队首）使用；
 * - `onTask` 在 WebView 主线程上按到达顺序同步回调，耗时工作请自行排队 / 让出主线程；
 * - 返回时本轮运行**所有逐章结果都已回调完毕**（全部取完 / 用户停止 / 出错），
 *   summary 里带成功失败计数。
 */
export async function fetchRemoteChapterTasks(
  sourceId: string,
  book: BookItem,
  tasks: ChapterTaskItem[],
  runId: number,
  onTask: (result: ChapterTaskResult) => void,
): Promise<ChapterTaskRunOutcome> {
  if (!tauri) return { summary: null, error: t("library.source.appOnly") };
  if (tasks.length === 0) {
    return {
      summary: {
        requested: 0,
        ok: 0,
        failed: 0,
        cancelled: false,
        missing: 0,
        elapsedMs: 0,
      },
      error: "",
    };
  }
  let markSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  const channel = new Channel<ChapterTaskEvent>();
  channel.onmessage = (event) => {
    if (event.kind === "done") {
      markSettled();
      return;
    }
    onTask(event);
  };
  try {
    const summary = await invoke<ChapterRunSummary>("readerx_source_fetch_contents_stream", {
      sourceId,
      book,
      tasks,
      runId,
      onTask: channel,
    });
    // 命令返回 ≠ 结果都到了：等收尾标记，保证调用方收尾时「逐章结果已全部落定」
    await waitChannelSettled(settled);
    return { summary, error: "" };
  } catch (err) {
    // 失败以结果对象交给调用方（逐章记失败 / 展示），这里只留一条日志
    log.warn("逐章拉取正文失败", `sourceId=${sourceId}`, `tasks=${tasks.length}`, err);
    return { summary: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 停止一轮逐章拉取（引擎侧立刻不再领取新章节；已取回的照常交付） */
export async function cancelRemoteChapterRun(runId: number): Promise<void> {
  if (!tauri || runId <= 0) return;
  try {
    await invoke<boolean>("readerx_source_chapter_run_cancel", { runId });
  } catch (err) {
    // 停止失败不影响用户看到的「已停止」：那只说明这一轮已经跑完了
    log.debug("停止逐章拉取失败", `runId=${runId}`, err);
  }
}

/** 把章节地址对应的任务提到队首（读到哪一章就先取哪一章）；不在队列里返回全 0 */
export async function promoteRemoteChapterRun(
  runId: number,
  urls: string[],
): Promise<ChapterPromoteResult> {
  if (!tauri || runId <= 0 || urls.length === 0) return { promoted: 0, running: 0 };
  try {
    return await invoke<ChapterPromoteResult>("readerx_source_chapter_run_promote", {
      runId,
      urls,
    });
  } catch (err) {
    log.debug("章节插队失败", `runId=${runId}`, err);
    return { promoted: 0, running: 0 };
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
 * 用书源会话下载一张图片（**书源封面**用），返回 data URL 或失败原因。
 * 封面会在 WebView 内压成几百 px 的缩略图再随书保存，体积可控；
 * 章节插图请用 [`fetchRemoteChapterImageFile`]：图片落 Rust 侧文件，不过 IPC。
 */
export async function fetchRemoteSourceImage(
  sourceId: string,
  url: string,
  referer: string | null,
): Promise<SourceImageResult> {
  if (!tauri) return { data: "", error: t("library.source.imageAppOnly") };
  try {
    // 不记图片字节，只记哪本书源、哪张图
    log.debug("下载书源封面图片", `sourceId=${sourceId}`, url);
    const r = await invoke<FetchedImage>("readerx_source_fetch_image", {
      sourceId,
      url,
      referer: referer || null,
    });
    if (!r.ok || !r.data) {
      log.warn("书源封面图片下载失败", `sourceId=${sourceId}`, url, r.error);
      return { data: "", error: r.error || t("library.source.imageDownloadFailed") };
    }
    return { data: `data:${r.mime || "image/jpeg"};base64,${r.data}`, error: "" };
  } catch (err) {
    log.warn("书源封面图片下载失败", `sourceId=${sourceId}`, url, err);
    return { data: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 用书源会话下载一张**章节插图**并落盘（Rust 侧文件，不经 IPC 回传字节）。
 * 返回本地引用与原始尺寸；失败返回 error（由调用方显示可重试占位）。
 * 大量图片时这一步的内存开销与图片数量无关，不会再把应用撑崩。
 */
export async function fetchRemoteChapterImageFile(
  sourceId: string,
  bookId: string,
  url: string,
  referer: string | null,
): Promise<BookImageFile> {
  const failed = (error: string): BookImageFile => ({
    ok: false,
    local: "",
    width: 0,
    height: 0,
    bytes: 0,
    error,
  });
  if (!tauri) return failed(t("library.source.imageAppOnly"));
  try {
    // 不记图片字节，只记哪本书源、哪本书、哪张图
    log.debug("下载章节插图", `sourceId=${sourceId}`, `bookId=${bookId}`, url);
    const r = await invoke<BookImageFile>("readerx_book_image_fetch", {
      sourceId,
      bookId,
      url,
      referer: referer || null,
    });
    if (!r.ok || !r.local) {
      log.warn("章节插图下载失败", `sourceId=${sourceId}`, `bookId=${bookId}`, url, r.error);
      return failed(r.error || t("library.source.imageDownloadFailed"));
    }
    return r;
  } catch (err) {
    log.warn("章节插图下载失败", `sourceId=${sourceId}`, `bookId=${bookId}`, url, err);
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/** 取若干张已落盘章节插图的尺寸 / 体积（Rust 读文件头，不解码整张图） */
export async function readChapterImageInfo(
  locals: readonly string[],
): Promise<BookImageInfo[]> {
  if (!tauri || locals.length === 0) return [];
  try {
    // 只记这一批的条目数，不记具体文件名
    log.debug("读取章节插图信息", `n=${locals.length}`);
    return await invoke<BookImageInfo[]>("readerx_book_image_info", {
      locals: [...locals],
    });
  } catch (err) {
    // 降级：这一批图片按未知尺寸排版（不影响图片显示）
    log.warn("读取章节插图信息失败，改用未知尺寸", `n=${locals.length}`, err);
    return [];
  }
}

/**
 * 把 WebView 渲染好的 **PDF 页面图**落盘（扫描版 PDF 没有文字层，整页当图读）。
 * 只在这一刻经 IPC 传一次字节：落盘后书籍里只留文件名，渲染走 `readerx-img` 协议。
 * 纯浏览器调试环境没有该 command，调用方据此退回内嵌 data URL。
 */
export async function putBookPdfPageImage(
  bookId: string,
  pageNumber: number,
  dataUrl: string,
): Promise<BookImageFile> {
  if (!tauri) throw new Error(t("library.pdf.pageImageAppOnly"));
  return invoke<BookImageFile>("readerx_book_pdf_page", {
    bookId,
    pageNumber,
    dataUrl,
  });
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
    groupId: source.groupId,
    updateTime: source.updateTime,
    jsLength: source.js.length,
  };
}

// ---------------------------------------------------------------------------
// 桌面端：原生文件选择导入
// ---------------------------------------------------------------------------

/** 原生文件选择器的结果：文件名 + 字节（base64） */
export interface PickedBookFile {
  fileName: string;
  dataBase64: string;
}

/**
 * 桌面端导入本地书：弹系统文件选择器并读回所选文件。
 *
 * 原生对话框给出的是**文件路径**，WebView 读不了，所以由 Rust 读成字节经 IPC 传回来
 * （与 PDF 页面图落盘同一套 base64 约定）；手机端不走这里（SAF 的 `input[type=file]`
 * 直接就能拿到 `File`）。用户取消时返回 `null`。
 */
export async function pickBookFile(): Promise<PickedBookFile | null> {
  if (!tauri) throw new Error(t("library.file.appOnly"));
  const picked = await invoke<PickedBookFile | null>("readerx_pick_book_file");
  if (!picked) return null;
  // 字段名与后端对不上时（后端序列化口径改了、内核里还是旧二进制）必须在这里报出原因：
  // 放过去只会变成 atob(undefined)，用户看到的是内核那句 InvalidCharacterError，无从下手
  if (!picked.dataBase64) {
    // 只记文件名与「内容为空」这个事实，不记文件内容
    log.warn("原生文件选择未返回文件内容", `fileName=${picked.fileName}`);
    throw new Error(t("library.file.noContent"));
  }
  return picked;
}

// ---------------------------------------------------------------------------
// 桌面端：开发者工具
// ---------------------------------------------------------------------------

/**
 * 打开当前界面的开发者工具（Web Inspector）。
 * 仅桌面端可用（Android 的 WebView 不提供该 API），失败原因经提示告知用户。
 */
export async function openDevTools(): Promise<void> {
  if (!tauri) {
    reportFailure(t("library.devTools.failed"), t("library.app.onlyInApp"));
    return;
  }
  try {
    await invoke("readerx_open_devtools");
  } catch (err) {
    reportFailure(t("library.devTools.failed"), err);
  }
}

// ---------------------------------------------------------------------------
// 网页登录（WebView；登录 Cookie 由 Rust 按书源持久化并注入会话）
// ---------------------------------------------------------------------------

/** 平台是否支持网页登录 */
export async function isSourceLoginSupported(): Promise<boolean> {
  if (!tauri) return false;
  try {
    const supported = await invoke<boolean>("readerx_source_login_supported");
    log.debug("查询网页登录支持", `supported=${supported}`);
    return supported;
  } catch (err) {
    // 降级：按「不支持」处理，用户仍可用账号密码类书源
    log.warn("查询网页登录支持失败，按不支持处理", err);
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
      message: t("library.login.appOnly"),
    };
  }
  try {
    // 只记书源与登录页地址，不记 Cookie（Cookie 由 Rust 落盘，不经过前端日志）
    log.debug("打开网页登录", `sourceId=${sourceId}`, url);
    return await invoke<SourceLoginResult>("readerx_source_login_webview", {
      sourceId,
      url,
    });
  } catch (err) {
    // 失败以结果对象交给调用方展示，不走 reportFailure —— 在这里留一条日志
    log.warn("网页登录失败", `sourceId=${sourceId}`, err);
    return { ok: false, url, cookies: "", count: 0, message: String(err) };
  }
}

/** 清空某个书源已保存的网页登录 Cookie（持久化 + 当前会话）；返回移除的行数 */
export async function clearSourceLogin(sourceId: string): Promise<number> {
  if (!tauri) return 0;
  try {
    return await invoke<number>("readerx_source_login_clear", { sourceId });
  } catch (err) {
    reportFailure(t("library.login.clearFailed"), err);
    return 0;
  }
}

/**
 * 用应用内 WebView 打开一个网页（Android 原生浮层 / 桌面独立窗口），用户关窗后返回。
 *
 * 浏览模式：只把页面显示出来，**不采集也不保存登录态**（与 `loginSourceWebview` 是两回事）；
 * `title` 是窗口标题用的显示名（阅读页传章节名），站点 Cookie 沿用内核自己那份。
 * 失败直接抛出，由调用方按自己的场景提示（这里只留一条尝试日志）。
 */
export async function openWebviewPage(url: string, title: string): Promise<void> {
  if (!tauri) {
    // 纯浏览器开发环境没有应用内 WebView：退化成新标签页（与 openExternal 口径一致）
    await openExternal(url);
    return;
  }
  log.debug("打开应用内网页", title);
  await invoke("readerx_webview_open", { url, title });
}

interface MobiContent {
  title: string;
  author: string;
  intro?: string;
  html: string;
  images: Record<number, string>;
  cover?: string;
}

/** 解压 MOBI 由 Rust 负责；浏览器预览没有该宿主能力。 */
export async function extractMobi(bytes: Uint8Array): Promise<MobiContent> {
  if (!tauri) throw new Error(t("library.mobi.appOnly"));
  let binary = "";
  for (let at = 0; at < bytes.length; at += 32768) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
  }
  try {
    return await invoke<MobiContent>("readerx_parse_mobi", { dataBase64: btoa(binary) });
  } catch (error) {
    const key = error === "encrypted" ? "library.mobi.encrypted"
      : error === "unsupported" ? "library.mobi.unsupported" : "library.mobi.invalid";
    throw new Error(t(key));
  }
}

// 智能翻译：按章读取、按批追加；失败直接交给业务层处理，不能降级成可写空缓存。
//
// Web 端的 revision 与 Rust 一样由「正文快照 + 失效计数」组成：
// 正文被编辑 / 重新导入后 revision 变化，旧译文自然不会命中；
// 手动失效再叠加一个 epoch，正文不变也能让缓存作废。

async function webTranslationContext(
  bookId: string,
  cid: string,
): Promise<{ revision: string; chapter: LocalBookChapter }> {
  const book = await webStore.getBook(bookId);
  const chapter = book?.chapters.find((item) => item.cid === cid);
  if (!chapter) throw new Error(t("translation.stale"));
  const epoch = await webStore.translationEpoch(bookId, cid);
  return {
    revision: JSON.stringify([epoch, chapter.paragraphs, chapter.blocks]),
    chapter,
  };
}

export async function readTranslationBook(bookId: string): Promise<TranslationBookState> {
  if (!tauri) {
    return (await webStore.getTranslationBook(bookId)) ?? { overrides: {}, terms: [] };
  }
  return invoke("readerx_translations_get", { bookId, cid: null });
}

export async function putTranslationBook(bookId: string, value: TranslationBookState): Promise<void> {
  if (!tauri) {
    await webStore.putTranslationBook(bookId, value);
    return;
  }
  await invoke("readerx_translations_put", { bookId, cid: null, revision: "", value });
}

export async function readTranslationCache(bookId: string, cid: string): Promise<TranslationCache> {
  if (tauri) return invoke("readerx_translations_get", { bookId, cid });
  const { revision, chapter } = await webTranslationContext(bookId, cid);
  const cached = await webStore.getTranslationCache(bookId, cid);
  // 只返回仍能对应到当前段落 / 选区的译文，避免正文变化后残留旧句子。
  const sources = createTranslationSources(chapter);
  const entries = Object.fromEntries(
    Object.entries(cached?.entries ?? {})
      .filter(([, entry]) => sources.matches(entry))
      .map(([key, entry]) => [key, entry.text]),
  );
  return { revision, entries };
}

export async function putTranslationCache(bookId: string, cid: string, revision: string, value: Record<string, TranslationWriteEntry>): Promise<boolean> {
  if (tauri) return invoke("readerx_translations_put", { bookId, cid, revision, value });
  const { revision: current, chapter } = await webTranslationContext(bookId, cid);
  if (current !== revision) return false;
  const sources = createTranslationSources(chapter);
  if (Object.keys(value).length > 15 || Object.values(value).some((entry) => !sources.matches(entry))) return false;
  const cached = await webStore.getTranslationCache(bookId, cid);
  // revision 变了就不再继承旧条目，否则会把上一版正文的译文混进来。
  const base = cached?.revision === revision ? cached.entries : {};
  await webStore.putTranslationCache(bookId, cid, {
    revision,
    entries: { ...base, ...structuredClone(value) },
  });
  return true;
}

export async function invalidateRemoteTranslations(bookId: string, cid: string): Promise<void> {
  if (tauri) { await invoke("readerx_translations_invalidate", { bookId, cid }); return; }
  await webStore.bumpTranslationEpoch(bookId, cid);
  await webStore.deleteTranslationCache(bookId, cid);
}

export async function readTranslationSettings<T>(): Promise<T | null> {
  if (!tauri) return webStore.readState<T>("readerx.translation");
  return invoke<T | null>("readerx_state_get", { key: "readerx.translation" });
}
export async function putTranslationSettings(value: unknown): Promise<void> {
  if (!tauri) { await webStore.writeState("readerx.translation", value); return; }
  await invoke("readerx_state_set", { key: "readerx.translation", value });
}

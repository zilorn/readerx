/**
 * 前端与 Rust 后端的唯一通道。
 * - Tauri 环境：通过 invoke 读写 Rust 管理的 JSON 文件；
 * - 纯浏览器开发环境：只使用内存 Map 降级，不写任何 WebView 持久化存储。
 */
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { bookToMeta, type BookMeta, type LocalBook, type LocalBookChapter } from "./booksTypes";
import { reportFailure } from "./errorReport";
import { createLogger } from "./logger";
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
 * 只回写一本书的若干章节（按下标）——在线书逐章下载正文用（写盘按小批合并）。
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
    if (patch.sourceTags !== undefined) {
      const sourceTags = patch.sourceTags ?? [];
      book.sourceTags = sourceTags.length > 0 ? sourceTags : undefined;
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

/**
 * 书源分组被删除：清空全部书源上该分组的归属，返回受影响的书源数量。
 * 源文件里的 groupId 由 Rust 侧整批改写，避免前端逐源读写。
 */
export async function clearRemoteSourceGroup(groupId: string): Promise<number> {
  if (!tauri) return 0;
  return await invoke<number>("readerx_source_group_clear", { groupId });
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
    reportFailure("拉取章节正文失败", err);
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
  if (!tauri) return { summary: null, error: "书源功能仅在应用内可用" };
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
  if (!tauri) return { data: "", error: "书源图片仅应用内可用" };
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
      return { data: "", error: r.error || "图片下载失败" };
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
  if (!tauri) return failed("书源图片仅应用内可用");
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
      return failed(r.error || "图片下载失败");
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
  if (!tauri) throw new Error("PDF 页面图仅应用内可落盘");
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
  if (!tauri) throw new Error("原生文件选择仅在应用内可用");
  const picked = await invoke<PickedBookFile | null>("readerx_pick_book_file");
  if (!picked) return null;
  // 字段名与后端对不上时（后端序列化口径改了、内核里还是旧二进制）必须在这里报出原因：
  // 放过去只会变成 atob(undefined)，用户看到的是内核那句 InvalidCharacterError，无从下手
  if (!picked.dataBase64) {
    // 只记文件名与「内容为空」这个事实，不记文件内容
    log.warn("原生文件选择未返回文件内容", `fileName=${picked.fileName}`);
    throw new Error("读取所选文件失败：没有拿到文件内容");
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
    reportFailure("打开开发者工具失败", "仅在应用内可用");
    return;
  }
  try {
    await invoke("readerx_open_devtools");
  } catch (err) {
    reportFailure("打开开发者工具失败", err);
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
      message: "网页登录仅在应用内可用",
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
    reportFailure("清除登录状态失败", err);
    return 0;
  }
}

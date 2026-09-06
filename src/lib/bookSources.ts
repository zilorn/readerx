/**
 * 书源仓库：
 * - 列表信号由 Rust 后端管理（booksource 文件）；
 * - 提供新建模板 / 能力与启停更新 / JSON 导入导出归一化。
 */
import { createSignal } from "solid-js";
import { httpFetch } from "./http";
import {
  deleteRemoteSource,
  getRemoteSource,
  listRemoteSources,
  saveRemoteSource,
} from "./backend";
import type {
  BookSource,
  BookSourceCapabilities,
  BookSourceSummary,
} from "./bookSourcesTypes";

// ---------------------------------------------------------------------------
// 响应式书源清单（null = 尚未载入）
// ---------------------------------------------------------------------------

const [sourcesState, setSourcesState] = createSignal<BookSourceSummary[] | null>(null);
let ensurePromise: Promise<void> | null = null;

export function bookSourceList(): BookSourceSummary[] {
  return sourcesState() ?? [];
}

export function bookSourcesReady(): boolean {
  return sourcesState() !== null;
}

export function bookSourceSummaryById(id: string): BookSourceSummary | undefined {
  return bookSourceList().find((s) => s.id === id);
}

async function loadBookSourceList(): Promise<void> {
  const list = await listRemoteSources();
  list.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  setSourcesState(list);
}

/** 首次进入相关页面时调用（幂等） */
export function ensureBookSourcesLoaded(): Promise<void> {
  if (sourcesState() !== null) return Promise.resolve();
  if (!ensurePromise) {
    ensurePromise = (async () => {
      try {
        await loadBookSourceList();
      } catch {
        setSourcesState([]);
      } finally {
        ensurePromise = null;
      }
    })();
  }
  return ensurePromise;
}

/**
 * 强制从后端重新拉取书源清单。
 * 书源管理页的启停 / JSON 导入等直接写盘的操作会绕过本模块的持久化入口，
 * 只调 ensureBookSourcesLoaded() 不会刷新（清单已载入即短路）——这里无条件重拉，
 * 保证新增 / 覆盖 / 停用的书源在本进程内立即生效，无需重启软件。
 */
export async function refreshBookSources(): Promise<void> {
  try {
    await loadBookSourceList();
  } catch (err) {
    console.error("[bookSources] 刷新书源清单失败", err);
    // 刷新失败保留旧清单，避免清空可用书源
  }
}

function applySummary(source: BookSource): BookSourceSummary {
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

/** 保存（新建或覆盖）并即时刷新列表 */
export async function persistBookSource(source: BookSource): Promise<void> {
  const next = { ...source, updateTime: Date.now() };
  await saveRemoteSource(next);
  setSourcesState((prev) => {
    const rest = (prev ?? []).filter((s) => s.id !== next.id);
    return [...rest, applySummary(next)].sort((a, b) =>
      a.name.localeCompare(b.name, "zh"),
    );
  });
}

export async function removeBookSource(id: string): Promise<void> {
  await deleteRemoteSource(id);
  setSourcesState((prev) => prev?.filter((s) => s.id !== id) ?? prev);
}

/** 整源替换（从 /source-editor 返回时使用；也用于导入冲突覆盖） */
export async function replaceBookSource(source: BookSource): Promise<void> {
  await persistBookSource(source);
}

// ---------------------------------------------------------------------------
// id / 模板
// ---------------------------------------------------------------------------

export function newBookSourceId(): string {
  return `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function blankCapabilities(): BookSourceCapabilities {
  return { search: true, discover: false, detail: false, toc: true, content: true };
}

export function blankBookSource(partial?: Partial<BookSource>): BookSource {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: newBookSourceId(),
    name: "新书源",
    bookSourceUrl: "https://",
    author: "",
    version: "1.0.0",
    comment: "",
    enabled: true,
    capabilities: blankCapabilities(),
    userAgent: "",
    headers: {},
    autoAuth: true,
    updateTime: now,
    js: "",
    ...partial,
  };
}

/** 内置示例模板（教程见 docs/book-source-guide.md） */
export const TEMPLATE_JS = `// 入口函数：searchBook / discoverCategories / discoverBooks / bookDetail / bookToc / bookContent
// 宿主 API：http / html / util / base64 / cryptoUtil / console / webview(登录，Android)（详见 docs/book-source-api.md）
const BASE = "https://example.com";

async function searchBook(keyword) {
  // 例：请求 JSON API
  const resp = await http.get(BASE + "/search?q=" + encodeURIComponent(keyword), {
    headers: { Referer: BASE },
    timeoutMs: 15000,
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const list = JSON.parse(resp.body);
  return list.map(function (it) {
    return {
      bookName: it.title,
      author: it.author,
      cover: it.cover,
      intro: it.intro,
      latest: it.latest,
      updateTime: it.update,
      tags: it.tags, // 可选：作品标签数组，如 ["玄幻", "热血"]
      bookUrl: util.urlJoin(BASE, it.url),
    };
  });
}

async function bookToc(book) {
  const resp = await http.get(book.bookUrl);
  const items = html.queryAll(resp.body, "div.catalog a");
  return items.map(function (el) {
    return { chapterName: el.text, chapterUrl: util.urlJoin(book.bookUrl, el.attrs.href) };
  });
}

async function bookContent(chapter, book) {
  const resp = await http.get(chapter.chapterUrl, { headers: { Referer: book.bookUrl } });
  const el = html.query(resp.body, "div#content");
  return el ? html.text(el.html) : "";
}
`;

/** 更新单个开关（启停 / 某能力）后落盘 */
export async function patchBookSourceField(
  id: string,
  patch: (source: BookSource) => void,
): Promise<boolean> {
  const source = await getRemoteSource(id);
  if (!source) return false;
  patch(source);
  await persistBookSource(source);
  return true;
}

// ---------------------------------------------------------------------------
// 编辑会话（SourceEditor 路由与列表页之间传递；null 表示新建）
// ---------------------------------------------------------------------------

const [editorSession, setEditorSession] = createSignal<BookSource | null>(null);

/** 打开编辑器（null = 新建空书源） */
export function openSourceEditor(source: BookSource | null): void {
  setEditorSession(source);
}

export function currentEditorSource(): BookSource | null {
  return editorSession();
}

export function setEditorSourceDraft(source: BookSource): void {
  setEditorSession(source);
}

export function clearSourceEditor(): void {
  setEditorSession(null);
}

// ---------------------------------------------------------------------------
// JSON 导入 / 导出
// ---------------------------------------------------------------------------

export interface ImportIssue {
  index: number;
  message: string;
}

export interface ImportPlan {
  /** 需要新建的书源（已生成新 id） */
  create: BookSource[];
  /** 与本机已有书源同 id 或同名同站，需覆盖（value 为已有 id） */
  overwrite: { id: string; source: BookSource }[];
  issues: ImportIssue[];
}

function normalizeEntry(raw: unknown): { source: BookSource | null; issue?: string } {
  if (!raw || typeof raw !== "object") {
    return { source: null, issue: "不是对象" };
  }
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const bookSourceUrl = typeof r.bookSourceUrl === "string" ? r.bookSourceUrl.trim() : "";
  const js = typeof r.js === "string" ? r.js : "";
  if (!name) return { source: null, issue: "缺少名称 name" };
  if (!bookSourceUrl) return { source: null, issue: "缺少站点地址 bookSourceUrl" };
  if (!js.trim()) return { source: null, issue: "缺少 JS 代码 js" };
  const capsRaw =
    r.capabilities && typeof r.capabilities === "object"
      ? (r.capabilities as Record<string, unknown>)
      : {};
  const bool = (v: unknown, fallback: boolean) =>
    typeof v === "boolean" ? v : fallback;
  const capabilities: BookSourceCapabilities = {
    search: bool(capsRaw.search, true),
    discover: bool(capsRaw.discover, true),
    detail: bool(capsRaw.detail, true),
    toc: bool(capsRaw.toc, true),
    content: bool(capsRaw.content, true),
  };
  const headers: Record<string, string> = {};
  if (r.headers && typeof r.headers === "object") {
    for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v;
    }
  }
  const rawId = typeof r.id === "string" ? r.id.trim() : "";
  const source: BookSource = {
    schemaVersion: 1,
    id: rawId || newBookSourceId(),
    name: name.slice(0, 60),
    bookSourceUrl,
    author: typeof r.author === "string" ? r.author : "",
    version: typeof r.version === "string" ? r.version : "1.0.0",
    comment: typeof r.comment === "string" ? r.comment : "",
    enabled: bool(r.enabled, true),
    capabilities,
    userAgent: typeof r.userAgent === "string" ? r.userAgent : "",
    headers,
    autoAuth: bool(r.autoAuth, true),
    updateTime: typeof r.updateTime === "number" ? r.updateTime : Date.now(),
    js,
  };
  return { source };
}

/** 解析导入文本（支持单个对象或数组），返回需要落地/覆盖/错误 */
export function planBookSourceImport(text: string): ImportPlan {
  const plan: ImportPlan = { create: [], overwrite: [], issues: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...plan, issues: [{ index: 0, message: "JSON 解析失败" }] };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const existing = bookSourceList();
  list.forEach((entry, index) => {
    const { source, issue } = normalizeEntry(entry);
    if (issue || !source) {
      plan.issues.push({ index: index + 1, message: issue ?? "无法解析" });
      return;
    }
    const dup =
      existing.find((s) => s.id === source.id) ??
      existing.find(
        (s) =>
          s.name === source.name &&
          (s.bookSourceUrl === source.bookSourceUrl ||
            s.bookSourceUrl.replace(/\/+$/, "") ===
              source.bookSourceUrl.replace(/\/+$/, "")),
      );
    if (dup) {
      plan.overwrite.push({ id: dup.id, source: { ...source, id: dup.id } });
    } else {
      plan.create.push(source);
    }
  });
  return plan;
}

/** 导出 JSON 文本（单条或数组） */
export function buildBookSourceExportText(sources: BookSource[]): string {
  const list = sources.map(({ js, ...rest }) => ({ ...rest, js }));
  return JSON.stringify(list.length === 1 ? list[0] : list, null, 2);
}

// ---------------------------------------------------------------------------
// 网络导入
// ---------------------------------------------------------------------------

const URL_PREFIX_RE = /^https?:\/\//i;

/**
 * 从网址拉取书源 JSON（单条或数组）并归一化为导入计划。
 * - 仅接受 http(s) 网址；请求走统一 HTTP 通道（Tauri 内 Rust 原生请求，可绕过跨域）；
 * - 非 2xx / 无内容 / JSON 无法解析都会以可读错误抛出，交由调用方展示。
 */
export async function planBookSourceNetworkImport(url: string): Promise<ImportPlan> {
  const target = url.trim();
  if (!URL_PREFIX_RE.test(target)) {
    throw new Error("请输入以 http(s):// 开头的书源网址");
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 30000);
  try {
    const res = await httpFetch(target, {
      headers: { Accept: "application/json,text/plain;charset=utf-8" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`拉取失败：HTTP ${res.status}`);
    }
    const body = await res.text();
    const text = body.replace(/^\uFEFF/, "").trim();
    if (!text) throw new Error("该网址没有返回可导入的内容");
    return planBookSourceImport(text);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error("请求超时（30 秒），请检查网址与网络后重试");
    }
    throw new Error(
      `无法访问该网址：${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    window.clearTimeout(timer);
  }
}

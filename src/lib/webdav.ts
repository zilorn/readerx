/**
 * WebDAV 书库：
 * - 服务器配置（可多台，其中一台激活）作为状态由 Rust 后端持久化（readerx.webdav.*）；
 * - 目录浏览走 PROPFIND，文件下载走 GET；Tauri 环境经 tauri-plugin-http，浏览器开发环境回退原生 fetch；
 * - 导入复用本地书解析链路（TXT 自动分章 / EPUB 目录结构 / PDF 书签或页），结果直接入书架。
 */
import { createSignal } from "solid-js";
import { readState, writeState } from "./backend";
import { httpFetch } from "./http";
import {
  detectBookFormat,
  parseEpubFileDraft,
  parsePdfFileDraft,
  parseTxtFile,
  persistBookDraft,
  type BookDraft,
} from "./books";
import type { BookFormat, BookMeta, LocalBook } from "./booksTypes";
import { ensureShelfEntry } from "./store";
import { createLogger } from "./logger";
import { t, type MessageKey } from "./i18n";

/** WebDAV 的日志出口：只记服务器地址与路径，绝不记密码 / Authorization 头 */
const log = createLogger("webdav");

export interface DavServer {
  id: string;
  name: string;
  /** 服务器基地址（含可能的前缀路径，如 https://dav.example.com/remote.php/dav/files/user） */
  url: string;
  username: string;
  password: string;
  createdAt: number;
}

export interface DavServerInput {
  name: string;
  url: string;
  username: string;
  password: string;
}

/** WebDAV 目录条目（path 为相对激活服务器基地址的解码路径，根目录为 ""） */
export interface DavEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

const SERVERS_KEY = "readerx.webdavServers";
const ACTIVE_KEY = "readerx.webdavActive";

// ---------------------------------------------------------------------------
// 响应式配置

const [servers, setServersSignal] = createSignal<DavServer[]>([]);
const [activeId, setActiveIdSignal] = createSignal<string | null>(null);
/** 配置是否已从后端读完（响应式：就绪后 UI 才从“读取配置…”切到内容） */
const [loadedSignal, setLoaded] = createSignal(false);
let loadingPromise: Promise<void> | null = null;

export function davServers(): DavServer[] {
  return servers();
}

export function davReady(): boolean {
  return loadedSignal();
}

export function davActiveId(): string | null {
  return activeId();
}

export function activeDavServer(): DavServer | undefined {
  const id = activeId();
  return id ? servers().find((s) => s.id === id) : undefined;
}

export function davServerById(id: string): DavServer | undefined {
  return servers().find((s) => s.id === id);
}

/**
 * 页面首次需要配置时调用（幂等）。
 * 全部读完后才置 loadedSignal，且它本身是响应式的：
 * 首次进入页面时“读取配置…”屏会因信号翻转被替换为真实内容。
 */
export function ensureWebDavLoaded(): Promise<void> {
  if (loadedSignal()) return Promise.resolve();
  loadingPromise ??= (async () => {
    const [stored, storedActive] = await Promise.all([
      readState<DavServer[]>(SERVERS_KEY),
      readState<string>(ACTIVE_KEY),
    ]);
    if (Array.isArray(stored)) {
      setServersSignal(
        stored
          .filter((s) => s && typeof s.id === "string" && typeof s.url === "string")
          .sort((a, b) => a.createdAt - b.createdAt),
      );
    }
    if (
      typeof storedActive === "string" &&
      servers().some((s) => s.id === storedActive)
    ) {
      setActiveIdSignal(storedActive);
    }
    setLoaded(true);
  })();
  return loadingPromise;
}

function persistServers(): void {
  void writeState(SERVERS_KEY, servers());
}

function persistActive(): void {
  void writeState(ACTIVE_KEY, activeId());
}

function newServerId(): string {
  return `dav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, "");
}

/** 新增服务器；若当前没有激活的服务器则自动激活新添加的一台 */
export function createDavServer(input: DavServerInput): DavServer {
  const server: DavServer = {
    id: newServerId(),
    name: input.name.trim() || input.url,
    url: normalizeUrl(input.url),
    username: input.username.trim(),
    password: input.password,
    createdAt: Date.now(),
  };
  if (!server.url) throw new Error(t("webdav.error.urlRequired"));
  setServersSignal((prev) => [...prev, server]);
  persistServers();
  if (!activeId()) {
    setActiveIdSignal(server.id);
    persistActive();
  }
  // 只记地址与用户名，密码绝不进日志
  log.info(
    "新增 WebDAV 服务器",
    `id=${server.id}`,
    `name=${server.name}`,
    `url=${server.url}`,
  );
  return server;
}

export function updateDavServer(id: string, input: DavServerInput): void {
  const url = normalizeUrl(input.url);
  if (!url) throw new Error(t("webdav.error.urlRequired"));
  setServersSignal((prev) =>
    prev.map((s) =>
      s.id === id
        ? {
            ...s,
            name: input.name.trim() || url,
            url,
            username: input.username.trim(),
            password: input.password,
          }
        : s,
    ),
  );
  persistServers();
  log.info("更新 WebDAV 服务器", { id, url });
}

export function deleteDavServer(id: string): void {
  setServersSignal((prev) => prev.filter((s) => s.id !== id));
  if (activeId() === id) {
    setActiveIdSignal(null);
    persistActive();
  }
  persistServers();
  log.info("删除 WebDAV 服务器", { id });
}

export function activateDavServer(id: string): void {
  if (!servers().some((s) => s.id === id)) return;
  setActiveIdSignal(id);
  persistActive();
  log.info("切换激活 WebDAV 服务器", { id, url: davServerById(id)?.url });
}

// ---------------------------------------------------------------------------
// WebDAV 网络层

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function authHeaders(server: DavServer): Record<string, string> {
  if (!server.username && !server.password) return {};
  return {
    Authorization: `Basic ${utf8ToBase64(`${server.username}:${server.password}`)}`,
  };
}

/** 拼接远程文件的绝对地址（path 为解码后的相对路径） */
export function davFileUrl(server: DavServer, path: string): string {
  const base = server.url.trim().replace(/\/+$/, "");
  if (!path) return base;
  const rel = path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${base}/${rel}`;
}

/** 目录 PROPFIND 请求地址：目录一律补尾斜杠（兼容要求目录尾斜杠的服务器） */
function davListUrl(server: DavServer, path: string): string {
  const url = davFileUrl(server, path);
  return url.endsWith("/") ? url : `${url}/`;
}

function httpErrorLabel(status: number): string {
  if (status === 401 || status === 403) return t("webdav.error.auth");
  if (status === 404) return t("webdav.error.notFound");
  if (status >= 500) return t("webdav.error.serverError");
  return `HTTP ${status}`;
}

async function assertOk(res: Response, actionKey: MessageKey): Promise<void> {
  if (res.ok) return;
  const action = t(actionKey);
  const reason = httpErrorLabel(res.status);
  log.warn(
    "WebDAV 请求失败",
    `status=${res.status}`,
    `reason=${reason}`,
    `action=${action}`,
  );
  throw new Error(t("webdav.error.withReason", { action, reason }));
}

/** 当前目录下的直接子条目（文件夹 + 支持的书），PROPFIND Depth:1 只取一层 */
export async function listDavDirectory(
  server: DavServer,
  path: string,
): Promise<DavEntry[]> {
  const started = performance.now();
  const url = davListUrl(server, path);
  let res: Response;
  try {
    res = await httpFetch(url, {
      method: "PROPFIND",
      headers: {
        ...authHeaders(server),
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<d:propfind xmlns:d="DAV:">' +
        "<d:prop><d:resourcetype/><d:getcontentlength/></d:prop>" +
        "</d:propfind>",
    });
  } catch (err) {
    log.warn(
      "WebDAV 连接失败",
      `server=${server.url}`,
      `path=${path}`,
      `ms=${Math.round(performance.now() - started)}`,
      err,
    );
    throw new Error(t("webdav.error.connectFailed"));
  }
  await assertOk(res, "webdav.error.listFailed");
  const xml = await res.text();
  const entries = parseMultiStatus(xml, url, path);
  log.info(
    "WebDAV 列目录完成",
    `server=${server.url}`,
    `path=${path}`,
    `entries=${entries.length}`,
    `ms=${Math.round(performance.now() - started)}`,
  );
  return entries;
}

/**
 * 解析 PROPFIND 的 207 multistatus。
 * 以「请求目录自身的 pathname」为基准剥离前缀（兼容服务器返回绝对/相对、
 * 带不带尾斜杠、编码形式差异），仅保留比请求目录恰好深一层的直接子项。
 * 前缀比较统一在解码后的路径上进行，规避 %hex 大小写 / 原始 UTF-8 的差异。
 */
function parseMultiStatus(
  xml: string,
  requestUrl: string,
  currentPath: string,
): DavEntry[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error(t("webdav.error.parseFailed"));
  }
  const entries: DavEntry[] = [];
  const base = new URL(requestUrl);
  const reqPath = decodePathname(base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`);
  const reqPathNoSlash = reqPath.slice(0, -1);
  const responses = doc.getElementsByTagNameNS("*", "response");
  for (let i = 0; i < responses.length; i++) {
    const node = responses[i];
    const hrefEl = node.getElementsByTagNameNS("*", "href")[0];
    if (!hrefEl?.textContent) continue;
    let rel: string;
    try {
      const target = new URL(hrefEl.textContent.trim(), requestUrl);
      if (target.origin !== base.origin) continue;
      const pathname = decodePathname(target.pathname);
      if (pathname === reqPathNoSlash) continue; // 请求目录自身
      if (pathname.startsWith(reqPath)) {
        rel = pathname.slice(reqPath.length);
      } else if (pathname.startsWith(`${reqPathNoSlash}/`)) {
        rel = pathname.slice(reqPathNoSlash.length + 1);
      } else {
        continue;
      }
    } catch {
      continue;
    }
    rel = rel.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!rel) continue;
    const segments = rel.split("/").filter(Boolean);
    // Depth:1 期望恰好一层；服务端越级返回的深层条目忽略
    if (segments.length !== 1) continue;
    const name = segments[0];
    if (!name || name === "." || name === ".." || name.startsWith(".")) continue;
    if (name.includes("/")) continue; // 避免解码出的斜杠破坏路径
    const isDir = node.getElementsByTagNameNS("*", "collection").length > 0;
    let size = 0;
    const lenEl = node.getElementsByTagNameNS("*", "getcontentlength")[0];
    if (lenEl?.textContent) size = parseInt(lenEl.textContent.trim(), 10) || 0;
    entries.push({
      name,
      path: currentPath ? `${currentPath}/${name}` : name,
      isDir,
      size,
    });
  }
  return entries;
}

/** 逐段解码 URL pathname（容忍个别段非法编码，解码失败时保留原段） */
function decodePathname(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join("/");
}

// ---------------------------------------------------------------------------
// 下载与导入

export function isBookFileName(name: string): boolean {
  return /\.(txt|epub|equb|pdf)$/i.test(name);
}

export function bookExtOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".txt")) return "txt";
  if (lower.endsWith(".pdf")) return "pdf";
  return "epub";
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export async function downloadDavFile(
  server: DavServer,
  path: string,
): Promise<{ bytes: ArrayBuffer; fileName: string }> {
  const started = performance.now();
  const url = davFileUrl(server, path);
  let res: Response;
  try {
    res = await httpFetch(url, {
      method: "GET",
      headers: { ...authHeaders(server) },
    });
  } catch (err) {
    log.warn(
      "WebDAV 下载失败：无法连接服务器",
      `server=${server.url}`,
      `path=${path}`,
      `ms=${Math.round(performance.now() - started)}`,
      err,
    );
    throw new Error(t("webdav.error.downloadFailed"));
  }
  await assertOk(res, "webdav.error.downloadBookFailed");
  const bytes = await res.arrayBuffer();
  const fileName = path.split("/").filter(Boolean).pop() ?? path;
  log.debug(
    "WebDAV 文件下载完成",
    `server=${server.url}`,
    `path=${path}`,
    `file=${fileName}`,
    `bytes=${bytes.byteLength}`,
    `ms=${Math.round(performance.now() - started)}`,
  );
  return { bytes, fileName };
}

/**
 * 下载并解析一本远程书（不落库）。
 * 供“重新导入”流程先取到新内容、预演书签继承后再决定是否替换。
 */
export async function fetchDavBookDraft(
  server: DavServer,
  path: string,
): Promise<BookDraft> {
  const started = performance.now();
  const { bytes, fileName } = await downloadDavFile(server, path);
  const format = detectBookFormat(fileName);
  if (!format)
    throw new Error(t("webdav.error.unsupportedFormat", { name: fileName }));
  const file = new File([bytes], fileName, { type: mimeOfFormat(format) });
  const draft =
    format === "txt"
      ? await parseTxtFile(file, { kind: "auto" })
      : format === "pdf"
        ? await parsePdfFileDraft(file)
        : await parseEpubFileDraft(file);
  log.debug(
    "WebDAV 书籍解析完成",
    `server=${server.url}`,
    `path=${path}`,
    `file=${fileName}`,
    `format=${format}`,
    `chapters=${draft.chapters.length}`,
    `ms=${Math.round(performance.now() - started)}`,
  );
  return draft;
}

/** 交给解析器的文件 MIME（TXT 需带编码提示，PDF / EPUB 用各自的正式类型） */
function mimeOfFormat(format: BookFormat): string {
  if (format === "pdf") return "application/pdf";
  if (format === "epub") return "application/epub+zip";
  return "text/plain;charset=utf-8";
}

/** 下载并解析一本远程书，作为一本新书直接进入书架 */
export async function importDavFile(
  server: DavServer,
  path: string,
): Promise<LocalBook> {
  const started = performance.now();
  const draft = await fetchDavBookDraft(server, path);
  const book = await persistBookDraft(draft, "webdav");
  ensureShelfEntry(book.id);
  log.info(
    "WebDAV 导入完成",
    `server=${server.url}`,
    `path=${path}`,
    `book=${book.id}`,
    `title=${book.title}`,
    `chapters=${book.chapters.length}`,
    `ms=${Math.round(performance.now() - started)}`,
  );
  return book;
}

/**
 * 判定某远程书文件是否已在本地书架。
 * 按文件名匹配即可：远端文件更新（大小/内容变化）也应识别为已导入，
 * 以便点击阅读 / 长按重新导入，而不是当作新书重复导入。
 */
export function davEntryImportedBook(
  entry: DavEntry,
  books: BookMeta[],
): BookMeta | undefined {
  return books.find((book) => book.fileName === entry.name);
}

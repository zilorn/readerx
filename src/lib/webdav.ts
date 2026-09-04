/**
 * WebDAV 书库：
 * - 服务器配置（可多台，其中一台激活）作为状态由 Rust 后端持久化（readerx.webdav.*）；
 * - 目录浏览走 PROPFIND，文件下载走 GET；Tauri 环境经 tauri-plugin-http，浏览器开发环境回退原生 fetch；
 * - 导入复用本地书解析链路（TXT 自动分章 / EPUB 目录结构），结果直接入书架。
 */
import { createSignal } from "solid-js";
import { readState, writeState } from "./backend";
import { httpFetch } from "./http";
import {
  detectBookFormat,
  parseEpubFileDraft,
  parseTxtFile,
  persistBookDraft,
  replaceBookContent,
} from "./books";
import type { LocalBook } from "./booksTypes";
import { ensureShelfEntry } from "./store";

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
let loaded = false;

export function davServers(): DavServer[] {
  return servers();
}

export function davReady(): boolean {
  return loaded;
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

/** 页面首次需要配置时调用（幂等） */
export async function ensureWebDavLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
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
  if (!server.url) throw new Error("请填写服务器地址");
  setServersSignal((prev) => [...prev, server]);
  persistServers();
  if (!activeId()) {
    setActiveIdSignal(server.id);
    persistActive();
  }
  return server;
}

export function updateDavServer(id: string, input: DavServerInput): void {
  const url = normalizeUrl(input.url);
  if (!url) throw new Error("请填写服务器地址");
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
}

export function deleteDavServer(id: string): void {
  setServersSignal((prev) => prev.filter((s) => s.id !== id));
  if (activeId() === id) {
    setActiveIdSignal(null);
    persistActive();
  }
  persistServers();
}

export function activateDavServer(id: string): void {
  if (!servers().some((s) => s.id === id)) return;
  setActiveIdSignal(id);
  persistActive();
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
  if (status === 401 || status === 403)
    return "认证失败，请检查服务器账号密码与权限";
  if (status === 404) return "目录不存在或地址配置有误";
  if (status >= 500) return "服务器出错";
  return `HTTP ${status}`;
}

async function assertOk(res: Response, fallback: string): Promise<void> {
  if (res.ok) return;
  throw new Error(`${fallback}（${httpErrorLabel(res.status)}）`);
}

/** 当前目录下的直接子条目（文件夹 + 支持的书），PROPFIND Depth:1 只取一层 */
export async function listDavDirectory(
  server: DavServer,
  path: string,
): Promise<DavEntry[]> {
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
  } catch {
    throw new Error("无法连接服务器，请检查地址与网络");
  }
  await assertOk(res, "读取目录失败");
  const xml = await res.text();
  return parseMultiStatus(xml, url, path);
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
    throw new Error("服务器返回了无法解析的目录数据");
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
  return /\.(txt|epub|equb)$/i.test(name);
}

export function bookExtOf(name: string): string {
  return name.toLowerCase().endsWith(".txt") ? "txt" : "epub";
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
  const url = davFileUrl(server, path);
  let res: Response;
  try {
    res = await httpFetch(url, {
      method: "GET",
      headers: { ...authHeaders(server) },
    });
  } catch {
    throw new Error("下载失败，无法连接服务器");
  }
  await assertOk(res, "下载书籍失败");
  const bytes = await res.arrayBuffer();
  const fileName = path.split("/").filter(Boolean).pop() ?? path;
  return { bytes, fileName };
}

/**
 * 下载并解析一本远程书，直接进入书架。
 * existing 传入时表示“重新导入”：原位替换该书内容（同 id，保留进度与分组）。
 */
export async function importDavFile(
  server: DavServer,
  path: string,
  existing?: LocalBook,
): Promise<LocalBook> {
  const { bytes, fileName } = await downloadDavFile(server, path);
  const format = detectBookFormat(fileName);
  if (!format) throw new Error(`不支持的书籍格式：${fileName}`);
  const file = new File([bytes], fileName, {
    type: format === "epub" ? "application/epub+zip" : "text/plain;charset=utf-8",
  });
  const draft =
    format === "txt"
      ? await parseTxtFile(file, { kind: "auto" })
      : await parseEpubFileDraft(file);
  if (existing) return replaceBookContent(existing, draft);
  const book = await persistBookDraft(draft, "webdav");
  ensureShelfEntry(book.id);
  return book;
}

/**
 * 判定某远程书文件是否已在本地书架。
 * 按文件名匹配即可：远端文件更新（大小/内容变化）也应识别为已导入，
 * 以便点击阅读 / 长按重新导入，而不是当作新书重复导入。
 */
export function davEntryImportedBook(
  entry: DavEntry,
  books: LocalBook[],
): LocalBook | undefined {
  return books.find((book) => book.fileName === entry.name);
}

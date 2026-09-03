/**
 * TransBook 书源连接（只读浏览，不落盘 WebView）。
 * - 服务器地址作为偏好存于 Rust 后端（readerx.transbookUrl）；
 * - 目录（书架分组）与书籍清单每次拉取实时展示。
 */
import { currentTransbookUrl } from "./store";
import { httpFetch } from "./http";

// 服务器地址等跨页偏好统一放在 store.ts，这里仅做再导出方便消费方引用
export {
  clearTransbookUrl,
  currentTransbookUrl,
  initTransbookConfig,
  normalizeTransbookUrl,
  saveTransbookUrl,
  transbookReady,
} from "./store";

export interface TransGroup {
  id: string;
  name: string;
  created_at?: number;
  count: number;
}

export interface TransBook {
  id: string;
  title: string;
  title_translated?: string;
  author: string;
  format?: string;
  status?: string;
  created_at?: number;
  /** 章节总数 */
  chapters: number;
  /** 已翻译完成的章节数 */
  done?: number;
  glossary_count?: number;
  no_translate?: boolean;
  group_id?: string | null;
  read_progress?: { index: number; title: string } | null;
  last_read_at?: number | null;
  source?: { site?: string } | null;
}

export interface TransChapter {
  id: string;
  title: string;
  title_translated?: string | null;
  status?: string;
  error?: string | null;
  format?: string;
  file?: string;
}

export interface TransBookDetail {
  id: string;
  title: string;
  title_translated?: string;
  author: string;
  format?: string;
  status?: string;
  created_at?: number;
  group_id?: string | null;
  running?: boolean;
  chapters: TransChapter[];
  source?: { site?: string } | null;
}

/** 由标题派生程序化封面色相（与本地书架一致） */
export function transHue(title: string): number {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (Math.imul(hash, 31) + title.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

// ---------------------------------------------------------------------------
// 拉取接口

async function requestJson<T>(
  path: string,
  opts?: { base?: string; timeoutMs?: number },
): Promise<T> {
  const base = opts?.base || currentTransbookUrl();
  if (!base) throw new Error("未配置 TransBook 服务器");
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), opts?.timeoutMs ?? 8000);
  try {
    const res = await httpFetch(`${base}${path}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`请求失败（HTTP ${res.status}）`);
    return (await res.json()) as T;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("连接超时，请检查服务器地址");
    }
    if (err instanceof TypeError) {
      throw new Error("无法连接到 TransBook 服务器");
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

/** 书架目录（分组） */
export function fetchTransGroups(): Promise<TransGroup[]> {
  return requestJson<TransGroup[]>("/api/groups");
}

/** 书架书籍清单 */
export function fetchTransBooks(): Promise<TransBook[]> {
  return requestJson<TransBook[]>("/api/books");
}

/** 单本详情（含章节目录） */
export function fetchTransBookDetail(
  id: string,
  base?: string,
): Promise<TransBookDetail> {
  return requestJson<TransBookDetail>(`/api/books/${encodeURIComponent(id)}`, {
    base,
  });
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!body) return "";
  // 块级元素、<br> 转行，避免正文全挤成一行
  body.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  const text = (body.textContent ?? "")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
  return text;
}

/** 章节正文（txt 为纯文本，epub/html 章节转为可读文本） */
export async function fetchTransChapterContent(
  bookId: string,
  chapter: TransChapter,
  base?: string,
): Promise<string> {
  const server = base || currentTransbookUrl();
  if (!server) throw new Error("未配置 TransBook 服务器");
  const translated = chapter.status === "done" || chapter.status === "translated";
  try {
    const res = await httpFetch(
      `${server}/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapter.id)}/content?translated=${translated}`,
      { headers: { Accept: "text/plain" } },
    );
    if (!res.ok) throw new Error(`章节读取失败（HTTP ${res.status}）`);
    const raw = await res.text();
    const fmt = chapter.format ?? "";
    return fmt === "epub" || fmt === "html" ? htmlToText(raw) : raw;
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error("无法连接到 TransBook 服务器");
    }
    throw err;
  }
}

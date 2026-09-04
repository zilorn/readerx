/**
 * 书源（Book Source）相关共享类型。
 * 与 Rust 侧 `src-tauri/src/models.rs` 中同名字段保持一一对应（camelCase）。
 */

/** 书源能力开关（可按能力单独禁用） */
export interface BookSourceCapabilities {
  search: boolean;
  discover: boolean;
  detail: boolean;
  toc: boolean;
  content: boolean;
}

/** 完整书源（含 JS 代码），JSON 导出/导入的载体 */
export interface BookSource {
  schemaVersion: number;
  id: string;
  name: string;
  bookSourceUrl: string;
  author: string;
  version: string;
  comment: string;
  enabled: boolean;
  capabilities: BookSourceCapabilities;
  /** 缺省请求 UA（空 = 引擎默认） */
  userAgent: string;
  /** 每请求合并的默认请求头（可含 Cookie） */
  headers: Record<string, string>;
  updateTime: number;
  js: string;
}

/** 列表页摘要（不含 js 正文与请求头细节） */
export interface BookSourceSummary {
  schemaVersion: number;
  id: string;
  name: string;
  bookSourceUrl: string;
  author: string;
  version: string;
  enabled: boolean;
  capabilities: BookSourceCapabilities;
  updateTime: number;
  jsLength: number;
}

/** 书源入口函数之间传递的“书”对象 */
export interface BookItem {
  bookName: string;
  author?: string;
  cover?: string;
  intro?: string;
  latest?: string;
  updateTime?: string;
  bookUrl: string;
  /** 发现列表所属分类（翻页时回传） */
  categoryUrl?: string;
}

/** bookToc 返回的章节 */
export interface ChapterItem {
  chapterName: string;
  chapterUrl: string;
}

/** 批量拉正文的单章结果 */
export interface ChapterContentResult {
  ok: boolean;
  chapterName: string;
  /** 正文原始文本（未做段落规范化） */
  text: string;
  error: string;
}

/** 一次书源函数调用的结果 */
export interface SourceCallResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  logs: string[];
  elapsedMs: number;
}

export interface SourceCallMeta {
  sourceId: string;
  fnName: string;
}

/** 入口函数元信息（白名单；来源与 models/engine 同步） */
export const ENTRY_FUNCTION_META: {
  fnName: string;
  label: string;
  capability: keyof BookSourceCapabilities;
  desc: string;
  /** 测试面板是否需要输入 */
  test?: boolean;
}[] = [
  { fnName: "searchBook", label: "搜索", capability: "search", desc: "按关键词搜索", test: true },
  { fnName: "discoverBooks", label: "发现", capability: "discover", desc: "按分类发现书籍", test: true },
  { fnName: "bookDetail", label: "详情", capability: "detail", desc: "富化书籍信息", test: true },
  { fnName: "bookToc", label: "目录", capability: "toc", desc: "获取章节列表", test: true },
  { fnName: "bookContent", label: "正文", capability: "content", desc: "获取单章正文", test: true },
];

export const CAPABILITY_LABELS: Record<keyof BookSourceCapabilities, string> = {
  search: "搜索",
  discover: "发现",
  detail: "详情",
  toc: "目录",
  content: "正文",
};

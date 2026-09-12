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
  /**
   * 是否允许自动网页认证（登录 / Cloudflare 挑战，仅 Android）：
   * 请求命中 CF 挑战时自动拉起应用内 WebView 认证并重试；书源代码 `webview.login`
   * 也受此开关约束。编辑页手动「网页登录」不受影响。默认开启。
   */
  autoAuth: boolean;
  /**
   * 所属书源分组 id（分组清单见 lib/sourceGroups.ts，存 readerx.sourceGroups）。
   * 纯本机归属：导出时丢掉该 id，改带可读的 `groupName`（换设备 / 分享后仍能还原分组）。
   */
  groupId?: string;
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
  /** 所属书源分组 id；未分组 / 分组已被删除时缺省 */
  groupId?: string;
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
  /** 作品标签（字符串数组，如 ["玄幻","热血"]；搜索/发现/详情可返回） */
  tags?: string[];
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

/** 经书源会话下载一张图片（书源封面用）的结果：图片可能带防盗链，必须走书源 Cookie/头 */
export interface FetchedImage {
  ok: boolean;
  /** 图片 MIME（如 image/jpeg）；失败时为空 */
  mime: string;
  /** 图片字节（base64）；失败时为空 */
  data: string;
  error: string;
}

/** 章节插图下载并落盘的结果（图片字节留在 Rust 侧文件里，不回传 base64） */
export interface BookImageFile {
  ok: boolean;
  /** 本地副本文件名（应用数据目录 images/ 下）；失败时为空 */
  local: string;
  /** 原始像素宽 / 高（由 Rust 读文件头解析，不解码；解析不出为 0） */
  width: number;
  height: number;
  /** 图片字节数 */
  bytes: number;
  error: string;
}

/** 已落盘章节插图的尺寸 / 体积 */
export interface BookImageInfo {
  local: string;
  width: number;
  height: number;
  bytes: number;
}

/** 一次书源函数调用的结果 */
export interface SourceCallResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  logs: string[];
  elapsedMs: number;
}

/** 网页登录（WebView）结果：cookies 为捕获到的 Cookie 文本（含 httpOnly） */
export interface SourceLoginResult {
  ok: boolean;
  /** 最终停留的页面 URL */
  url: string;
  /** `k=v; k2=v2` 形式的 Cookie 文本 */
  cookies: string;
  /** Cookie 条数 */
  count: number;
  /** 可读消息（取消 / 平台不支持 / 错误原因） */
  message: string;
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

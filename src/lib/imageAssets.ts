/**
 * 章节插图的「本地副本」基础设施：渲染地址与尺寸缓存。
 *
 * 图片字节由 Rust 存成应用数据目录下的文件（见 src-tauri/src/book_images.rs），
 * 章节块里只有文件名（`ChapterBlock.local`）。渲染时经 **Tauri 自定义协议**
 * `readerx-img` 直接从文件读取 —— 图片既不过 IPC、也不进 WebView 的 JS 字符串，
 * 因此「一章几百张图」不会再因为 base64 副本堆积而闪退。
 *
 * 尺寸走「读文件头」而不是「在 WebView 里解码」：Rust 下载时已返回原始宽高，
 * 老数据（本会话才知道的文件）在这里按文件名批量补一次，整章图片不再需要解码。
 */
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { readChapterImageInfo } from "./backend";

/** 章节插图自定义协议名（与 src-tauri/src/lib.rs 的 BOOK_IMAGE_PROTOCOL 一致） */
const IMAGE_PROTOCOL = "readerx-img";

let protocolReady = false;
let urlPrefix = "";

/**
 * 自定义协议 URL 前缀（如 `readerx-img://localhost/` / `http://readerx-img.localhost/`）。
 * 平台差异交给 Tauri 的 convertFileSrc 决定；纯浏览器开发环境没有该协议，返回 null。
 */
function imageUrlPrefix(): string | null {
  if (!isTauri()) return null;
  if (!protocolReady) {
    try {
      // 空路径即前缀：convertFileSrc 会补上结尾的 `/`
      urlPrefix = convertFileSrc("", IMAGE_PROTOCOL);
      protocolReady = true;
    } catch (err) {
      console.error("[imageAssets] 无法构造图片协议地址", err);
      return null;
    }
  }
  return urlPrefix || null;
}

/**
 * 本地副本的失效版本号：同一文件名被**重新下载**（占位框「重试」）后 +1。
 * 文件名由图片地址哈希决定，重下不会改名 —— 不加这个版本号，`<img>` 的地址不变、
 * WebView 不会重新请求，用户点了重试也看不到图（地址变化同时驱动组件重渲染）。
 */
const revisions = new Map<string, number>();
const [assetRevision, setAssetRevision] = createSignal(0);

/** 标记某个本地副本已重新下载：地址带上新的版本参数，强制 WebView 重新请求 */
export function invalidateImageAsset(local: string | undefined | null): void {
  if (!local) return;
  revisions.set(local, (revisions.get(local) ?? 0) + 1);
  setAssetRevision((value) => value + 1);
}

/**
 * 本地副本文件名 → 可直接放进 `<img src>` 的地址；无引用 / 非 Tauri 环境返回 null。
 * 文件名由 Rust 生成（`<bookId>_<sha1>.<ext>`，全为 URL 安全字符），可直接拼接。
 */
export function chapterImageUrl(local: string | undefined | null): string | null {
  if (!local) return null;
  const prefix = imageUrlPrefix();
  if (!prefix) return null;
  assetRevision(); // 建立响应式依赖：重下后地址变化，图片重新请求
  const revision = revisions.get(local);
  return revision ? `${prefix}${local}?r=${revision}` : `${prefix}${local}`;
}

/** 本地副本的原始像素尺寸（宽高为 0 表示还没读到 / 解析不出） */
export interface ChapterImageSize {
  w: number;
  h: number;
}

/** 尺寸缓存：文件名 → 尺寸（下载结果与本模块补查共同填充；同名文件内容不变） */
const sizeCache = new Map<string, ChapterImageSize>();
const inflight = new Set<string>();

/** 记下已知尺寸（下载成功时由 chapterImages 调用） */
export function rememberImageSize(local: string, width: number, height: number): void {
  if (!local || width <= 0 || height <= 0) return;
  sizeCache.set(local, { w: width, h: height });
}

/** 取已缓存的尺寸；未知返回 null（调用方应先 await ensureImageSizes） */
export function cachedImageSize(local: string | undefined | null): ChapterImageSize | null {
  if (!local) return null;
  return sizeCache.get(local) ?? null;
}

/**
 * 批量补齐若干本地副本的尺寸（Rust 读文件头，不解码；一次 IPC 拿回整章）。
 * 已有缓存 / 正在查询的条目会跳过，重复调用不会重复请求。
 */
export async function ensureImageSizes(locals: readonly string[]): Promise<void> {
  const missing: string[] = [];
  for (const local of locals) {
    if (!local || sizeCache.has(local) || inflight.has(local)) continue;
    missing.push(local);
  }
  if (missing.length === 0) return;
  for (const local of missing) inflight.add(local);
  try {
    const info = await readChapterImageInfo(missing);
    for (const item of info) {
      inflight.delete(item.local);
      rememberImageSize(item.local, item.width, item.height);
      // 解析不出尺寸（SVG / 畸形数据）也记一条 0：避免每次排版都重查
      if (!sizeCache.has(item.local)) sizeCache.set(item.local, { w: 0, h: 0 });
    }
  } finally {
    for (const local of missing) inflight.delete(local);
  }
}

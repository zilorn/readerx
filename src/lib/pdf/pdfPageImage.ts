/**
 * PDF 页面渲染：把 PDF 的某一页画到 canvas 上，输出 JPEG。
 *
 * 用途有两个：
 * - **扫描页 / 图片页**（没有可用文字层）：整页渲染成图片章节，保证「扫描版 PDF 也能读」；
 * - **封面**：用第一页生成缩略图。
 *
 * 图片字节一律**落盘**（`readerx_book_pdf_page` → `images/<bookId>_<sha1>.jpg`），
 * 书籍 JSON 里只留文件名，渲染经 `readerx-img` 协议直读 —— 与章节插图同一套基础设施。
 * 纯浏览器调试环境没有该 command，退化成把 data URL 写进章节（仅本地调试会走到）。
 */
import { putBookPdfPageImage } from "../backend";
import { makeCoverThumb } from "../coverImage";

/** 本模块对 pdf.js 页面对象的最小要求（只用到取视口与渲染两件事） */
export interface RenderablePdfPage {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: unknown;
  }): { promise: Promise<void> };
}

/** 一页的渲染结果 */
export interface RenderedPdfPage {
  /** 已落盘的本地副本文件名；落盘失败（纯浏览器调试）时为空 */
  local?: string;
  /** 可渲染地址：落盘成功时为空（由 local 经 readerx-img 提供），否则是 data URL */
  src?: string;
  width: number;
  height: number;
}

/** 扫描页渲染倍率：2 倍足够在手机上放大看清文字，又能把单页 JPEG 控制在几百 KB */
const PAGE_SCALE = 2;
/** 页面画面的像素长边上限：大幅面图纸 / 广告页不至于撑爆 canvas */
const MAX_PAGE_EDGE = 2000;
/** 书籍封面渲染倍率（封面只需要缩略图，画大了纯属浪费内存） */
const COVER_SCALE = 1.4;
const COVER_MAX_EDGE = 1400;
const JPEG_QUALITY = 0.78;

interface RenderResult {
  dataUrl: string;
  width: number;
  height: number;
}

/** 把一页画到 canvas 并导出 JPEG data URL；canvas 不可用 / 渲染失败返回 null */
function drawPageToJpeg(
  page: RenderablePdfPage,
  scale: number,
  maxEdge: number,
): Promise<RenderResult | null> {
  const base = page.getViewport({ scale: 1 });
  const longEdge = Math.max(base.width, base.height);
  const fit = longEdge > 0 ? Math.min(1, maxEdge / (longEdge * scale)) : 1;
  const viewport = page.getViewport({ scale: scale * fit });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  // 白底：PDF 页面本身透明，直接导 JPEG 会变成黑底
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  return page
    .render({ canvasContext: ctx, viewport })
    .promise.then(() => {
      const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
      if (!dataUrl.startsWith("data:image/jpeg")) return null;
      return { dataUrl, width, height };
    })
    .catch(() => null);
}

/** 扫描页：渲染 → 落盘 → 返回章节可用的图片引用（渲染失败返回 null，由调用方跳过该页） */
export async function renderPdfPageImage(
  page: RenderablePdfPage,
  bookId: string,
  pageNumber: number,
): Promise<RenderedPdfPage | null> {
  const rendered = await drawPageToJpeg(page, PAGE_SCALE, MAX_PAGE_EDGE);
  if (!rendered) return null;
  try {
    // 落盘走 Rust 的 readerx_book_pdf_page：图片存文件，章节里只留文件名
    const file = await putBookPdfPageImage(bookId, pageNumber, rendered.dataUrl);
    if (file.local) {
      return {
        local: file.local,
        width: file.width || rendered.width,
        height: file.height || rendered.height,
      };
    }
  } catch (err) {
    // 落盘失败（纯浏览器调试 / 磁盘异常）：退回 data URL，至少这一页能读
    console.error("[pdf] 页面图片落盘失败，改用内嵌图片", err);
  }
  return { src: rendered.dataUrl, width: rendered.width, height: rendered.height };
}

/** 封面：渲染第一页并压成缩略图 data URL；失败返回 undefined（不影响导入） */
export async function renderPdfCover(page: RenderablePdfPage): Promise<string | undefined> {
  try {
    const rendered = await drawPageToJpeg(page, COVER_SCALE, COVER_MAX_EDGE);
    if (!rendered) return undefined;
    const thumb = await makeCoverThumb(rendered.dataUrl);
    return thumb.startsWith("data:image/") ? thumb : undefined;
  } catch {
    return undefined;
  }
}

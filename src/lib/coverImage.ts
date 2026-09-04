/**
 * 封面缩略图工具：
 * - makeCoverThumb：把图片 data URL 等比缩小到 600px 以内并统一输出 JPEG，
 *   控制存入书籍 JSON 的体积（EPUB 导入与详情页「更换封面」共用同一套规则）；
 * - fileToCoverThumb：读取本地图片文件生成封面缩略图，供详情页更换封面。
 */

/** 封面缩略图的长边像素上限（避免把整张原图塞进书籍 JSON） */
export const COVER_MAX_EDGE = 600;

function dataUrlMime(dataUrl: string): string {
  const match = /^data:([^;,]+)/.exec(dataUrl);
  return match ? match[1] : "";
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("封面图片解码失败"));
    img.src = src;
  });
}

/** 是否能安全重采样为位图的封面格式（JPEG / PNG / WebP） */
function isRasterCover(dataUrl: string): boolean {
  const mime = dataUrlMime(dataUrl);
  return mime === "image/jpeg" || mime === "image/png" || mime === "image/webp";
}

/**
 * 把封面图等比缩小为 COVER_MAX_EDGE 以内的 JPEG 缩略图 data URL。
 * SVG / GIF 等无法安全重采样为位图的格式直接原样返回；
 * 任何解码失败都退回原图，绝不因封面问题中断导入。
 */
export async function makeCoverThumb(dataUrl: string): Promise<string> {
  if (!isRasterCover(dataUrl)) return dataUrl;
  try {
    const img = await loadImageElement(dataUrl);
    const { naturalWidth: width, naturalHeight: height } = img;
    if (!width || !height) return dataUrl;
    const scale = Math.min(1, COVER_MAX_EDGE / Math.max(width, height));
    if (scale === 1) return dataUrl;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    // 半透明 PNG 先垫白底再统一 JPEG 输出，控制书籍 JSON 体积
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const thumb = canvas.toDataURL("image/jpeg", 0.82);
    return thumb.startsWith("data:image/jpeg") ? thumb : dataUrl;
  } catch {
    return dataUrl;
  }
}

/** 把本地图片文件读成封面缩略图 data URL；非图片或解码失败返回 null（由调用方提示） */
export async function fileToCoverThumb(file: File): Promise<string | null> {
  if (!file.type.startsWith("image/")) return null;
  const dataUrl = await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
  if (!dataUrl) return null;
  return makeCoverThumb(dataUrl).catch(() => null);
}

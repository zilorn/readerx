/**
 * 生成 PWA / HAP 需要的 PNG 图标。
 *
 * 仓库不提交二进制图片：图标由这里在 dev / build 启动时按固定几何形状绘制，
 * 只依赖 Node 内置的 zlib 与 fs。样式与 public/favicon.svg 保持一致：
 * 橙色渐变圆角底 + 白色打开书本轮廓。
 *
 * 输出：
 * - public/icons/icon-192.png、icon-512.png、icon-maskable-512.png（PWA）
 * - harmonyos/AppScope/resources/base/media/app_icon.png（HAP 应用图标）
 * - harmonyos/entry/src/main/resources/base/media/app_icon.png（模块图标）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const COLOR_TOP = [0xf7, 0x67, 0x07];
const COLOR_BOTTOM = [0xc2, 0x41, 0x0c];

// ---------------------------------------------------------------------------
// 极简 PNG 编码：8-bit RGBA、无交错、每行 filter=0
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 几何绘制
// ---------------------------------------------------------------------------

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const hw = (right - left) / 2;
  const hh = (bottom - top) / 2;
  const qx = Math.abs(x - cx) - (hw - radius);
  const qy = Math.abs(y - cy) - (hh - radius);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
      Math.min(Math.max(qx, qy), 0) -
      radius <
    0
  );
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function background(x, y) {
  const t = Math.min(1, Math.max(0, (x + y) / 2));
  return [
    Math.round(lerp(COLOR_TOP[0], COLOR_BOTTOM[0], t)),
    Math.round(lerp(COLOR_TOP[1], COLOR_BOTTOM[1], t)),
    Math.round(lerp(COLOR_TOP[2], COLOR_BOTTOM[2], t)),
  ];
}

/** 白色开书轮廓：两页外框，挖掉内层，再补一条中间书脊。 */
function isBookInk(x, y) {
  const pageRadius = 0.028;
  const leftOuter = insideRoundedRect(x, y, 0.255, 0.325, 0.492, 0.695, pageRadius);
  const rightOuter = insideRoundedRect(x, y, 0.508, 0.325, 0.745, 0.695, pageRadius);
  if (!leftOuter && !rightOuter) return false;

  const leftInner = insideRoundedRect(x, y, 0.292, 0.362, 0.455, 0.658, 0.012);
  const rightInner = insideRoundedRect(x, y, 0.545, 0.362, 0.708, 0.658, 0.012);
  if (leftInner || rightInner) return false;

  const spine = insideRoundedRect(x, y, 0.482, 0.39, 0.518, 0.678, 0.016);
  return spine || leftOuter || rightOuter;
}

/**
 * 采样一个点。maskable 图标铺满整块画布并把书本缩到安全区；
 * 普通图标保留透明圆角。
 */
function sample(x, y, maskable) {
  const scale = maskable ? 0.78 : 1;
  const u = (x - 0.5) / scale + 0.5;
  const v = (y - 0.5) / scale + 0.5;

  const inBackground = maskable
    ? x >= 0 && x <= 1 && y >= 0 && y <= 1
    : insideRoundedRect(x, y, 0, 0, 1, 1, 0.22);
  if (!inBackground) return [0, 0, 0, 0];

  const [r, g, b] = background(x, y);
  if (u >= 0 && u <= 1 && v >= 0 && v <= 1 && isBookInk(u, v)) {
    return [255, 255, 255, 255];
  }
  return [r, g, b, 255];
}

function render(size, maskable) {
  const supersample = 4;
  const rgba = Buffer.alloc(size * size * 4);
  const samples = supersample * supersample;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          const [r, g, b, a] = sample(
            (x + (sx + 0.5) / supersample) / size,
            (y + (sy + 0.5) / supersample) / size,
            maskable,
          );
          alpha += a;
          red += r * a;
          green += g * a;
          blue += b * a;
        }
      }
      const offset = (y * size + x) * 4;
      if (alpha === 0) {
        rgba[offset] = 0;
        rgba[offset + 1] = 0;
        rgba[offset + 2] = 0;
        rgba[offset + 3] = 0;
      } else {
        rgba[offset] = Math.round(red / alpha);
        rgba[offset + 1] = Math.round(green / alpha);
        rgba[offset + 2] = Math.round(blue / alpha);
        rgba[offset + 3] = Math.round(alpha / samples);
      }
    }
  }
  return encodePng(size, rgba);
}

function writeIcon(path, buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
}

const icons = new Map();

function icon(size, maskable) {
  const key = `${size}:${maskable ? "maskable" : "any"}`;
  if (!icons.has(key)) icons.set(key, render(size, maskable));
  return icons.get(key);
}

export function ensurePwaIcons() {
  const dir = join(ROOT, "public", "icons");
  writeIcon(join(dir, "icon-192.png"), icon(192, false));
  writeIcon(join(dir, "icon-512.png"), icon(512, false));
  writeIcon(join(dir, "icon-maskable-512.png"), icon(512, true));
}

export function ensureHapIcons() {
  const appIcon = icon(512, true);
  writeIcon(
    join(ROOT, "harmonyos", "AppScope", "resources", "base", "media", "app_icon.png"),
    appIcon,
  );
  writeIcon(
    join(
      ROOT,
      "harmonyos",
      "entry",
      "src",
      "main",
      "resources",
      "base",
      "media",
      "app_icon.png",
    ),
    appIcon,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  ensurePwaIcons();
  ensureHapIcons();
  console.log("PWA / HAP 图标已生成");
}

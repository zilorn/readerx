/**
 * 构建 HarmonyOS HAP 使用的 Web 资源。
 *
 * HAP 的外壳（harmonyos/entry/src/main/ets/pages/Index.ets）通过 onInterceptRequest
 * 把 `https://readerx.local/` 映射到安装包里的 `rawfile/www/`。因此这里必须用相对
 * base 构建，保证 index.html 与动态 chunk 都按相对路径加载，不依赖站点根目录。
 *
 * 用法：pnpm build:hap
 * 产物：harmonyos/entry/src/main/resources/rawfile/www/（构建产物，不入库）
 */
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { ensureHapIcons, ensurePwaIcons } from "./pwa-icons.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const target = join(root, "harmonyos", "entry", "src", "main", "resources", "rawfile", "www");

console.log("==> 生成 PWA / HAP 图标");
ensurePwaIcons();
ensureHapIcons();

console.log("==> 构建 Web 资源（base=./）");
await build({ root, base: "./", logLevel: "info" });

const html = await readFile(join(dist, "index.html"), "utf8");
if (/<(?:script|link)[^>]+(?:src|href)="\/(?!\/)/.test(html)) {
  throw new Error("index.html 仍含根路径资源；HAP 只能用相对路径加载 assets");
}
if (!html.includes('src="./assets/')) {
  throw new Error("index.html 未按相对路径引用构建产物，请检查 Vite base");
}

console.log("==> 复制到 HAP rawfile");
await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
await cp(dist, target, { recursive: true });

console.log(`HAP Web 资源已就绪：${target}`);
console.log("用 DevEco Studio 打开 harmonyos/ 后 Build Hap(s)/APP(s)。");

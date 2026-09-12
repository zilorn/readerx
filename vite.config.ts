import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { ensureHanDictAssets } from "./scripts/han-dict.mjs";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

const host = process.env.TAURI_DEV_HOST;
// 单一版本来源：package.json（scripts/bump-version.mjs 会同步其余各处）
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

/**
 * 简繁转换词典资源（src/generated/han-dict-*.bin，gzip）。
 * 同步生成，dev / build 启动时各跑一次，词典未变则不写盘；
 * 生成逻辑见 scripts/han-dict.mjs，运行时装载见 src/lib/hanDict.ts。
 */
function hanDict(): Plugin {
  return {
    name: "readerx:han-dict",
    buildStart() {
      ensureHanDictAssets();
    },
    configureServer() {
      ensureHanDictAssets();
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [hanDict(), solid(), tailwindcss()],

  // 注入构建期版本号，前端通过 src/lib/version.ts 读取（Tauri 内运行时覆盖为真实打包版本）
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

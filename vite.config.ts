import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

const host = process.env.TAURI_DEV_HOST;
// 单一版本来源：package.json（scripts/bump-version.mjs 会同步其余各处）
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [solid(), tailwindcss()],

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

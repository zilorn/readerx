import { createSignal } from "solid-js";
import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

// 构建期常量，由 vite.config.ts 从 package.json 注入（define 替换）。
// 纯类型声明，运行时不产生真实标识符。
declare const __APP_VERSION__: string;

const [appVersion, setAppVersion] = createSignal<string>(__APP_VERSION__);

let loaded = false;

/**
 * 在 Tauri 环境中把版本号刷新为运行中二进制的真实版本
 * （源自 src-tauri 的 Cargo.toml / tauri.conf.json，无需手工维护）；
 * 纯浏览器模式（无 Tauri IPC）保持 package.json 的构建期版本作为兜底。
 * 幂等，可安全地在任意组件挂载时调用。
 */
export async function loadAppVersion(): Promise<void> {
  if (loaded) return;
  loaded = true;
  if (!isTauri()) return;
  try {
    setAppVersion(await getVersion());
  } catch {
    // IPC 异常时沿用构建期版本，不阻塞页面渲染
  }
}

export { appVersion };

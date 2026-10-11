import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** 原生应用走系统剪贴板，避免 Android WebView 拒绝网页写入权限。 */
export async function writeClipboardText(text: string): Promise<void> {
  if (isTauri()) {
    await writeText(text);
    return;
  }
  // 浏览器开发环境保留网页剪贴板接口；失败由调用方显示给用户。
  await navigator.clipboard.writeText(text);
}

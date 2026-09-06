/**
 * 打开外部链接：
 * - Tauri 环境走系统默认应用（opener 插件，Android 为系统浏览器 / 应用选择器）；
 * - 纯浏览器开发/预览环境退化为新标签页（noopener）。
 */
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

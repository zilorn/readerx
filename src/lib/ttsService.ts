/**
 * 听书后台服务（Android 前台服务）的前端开关。
 * 朗读中保持服务运行，停止或暂停时关闭；同样参数不重复调用。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { createLogger } from "./logger";

const log = createLogger("tts");
let lastKey = "";

export function syncTtsForegroundService(active: boolean, title: string, text: string): void {
  if (!isTauri()) return;
  const key = `${active}\u0000${title}\u0000${text}`;
  if (key === lastKey) return;
  lastKey = key;
  invoke("readerx_tts_service_set_active", { active, title, text }).catch((error: unknown) => {
    log.warn("听书后台服务同步失败", String(error));
  });
}

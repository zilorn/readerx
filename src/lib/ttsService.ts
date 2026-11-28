/**
 * 听书后台服务（Android 前台服务）的前端开关。
 * 听书会话未停止时保持服务（通知栏可暂停 / 继续），停止时关闭；同样参数不重复调用。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { createLogger } from "./logger";

const log = createLogger("tts");
let lastKey = "";

export interface TtsServiceState {
  active: boolean;
  playing: boolean;
  title: string;
  text: string;
}

export function syncTtsForegroundService(state: TtsServiceState): void {
  if (!isTauri()) return;
  const key = [state.active, state.playing, state.title, state.text].join("\u0000");
  if (key === lastKey) return;
  lastKey = key;
  invoke("readerx_tts_service_set_active", { ...state }).catch((error: unknown) => {
    log.warn("听书后台服务同步失败", String(error));
  });
}

/**
 * 异常提示兜底：**处理不了的异常必须让用户看到原因**，而不是只写进控制台。
 *
 * 三条入口都汇到这里：
 * - Rust 后端命令失败（`invoke` reject，含内部异常兜底文案）；
 * - 后端主动推来的「内部异常」事件（panic hook，见 src-tauri/src/lib.rs）；
 * - 未捕获的 JS 异常 / 未处理的 Promise 拒绝。
 *
 * 相同文案短时间内只提示一次：批量下载 / 逐章落盘这类循环失败时不会刷屏。
 */
import { isTauri } from "@tauri-apps/api/core";
import { showToast } from "./toast";

/** 后端内部异常事件名（与 src-tauri/src/lib.rs 的 panic hook 保持一致） */
export const BACKEND_ERROR_EVENT = "readerx-internal-error";

/** 相同提示的基础去重窗口（毫秒）；重复出现时窗口逐次拉长，最多到 MAX_DEDUPE_MS */
const DEDUPE_MS = 5_000;
const MAX_DEDUPE_MS = 60_000;
/** 提示文案上限，避免把整段调用栈糊到屏幕上 */
const MAX_TEXT_LEN = 160;

/** 文案 → 上次提示时间与已提示次数（次数用于退避，持续失败不会每 5 秒刷一次） */
const recent = new Map<string, { at: number; count: number }>();

/** 把任意异常值描述成一句可读文本 */
export function describeError(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error.trim();
  if (error instanceof Error) return (error.message || error.name || "未知错误").trim();
  if (typeof error === "object") {
    try {
      const text = JSON.stringify(error);
      return text && text !== "{}" ? text : String(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/** 提示一次失败（带去重与退避）：`what` 说明失败的操作，`error` 为原始异常 */
export function reportFailure(what: string, error: unknown, durationMs = 4_200): void {
  console.error(`[readerx] ${what}`, error);
  const reason = describeError(error);
  const text = (reason ? `${what}：${reason}` : what).slice(0, MAX_TEXT_LEN);
  const now = Date.now();
  const previous = recent.get(text);
  if (previous) {
    const window = Math.min(DEDUPE_MS * previous.count, MAX_DEDUPE_MS);
    if (now - previous.at < window) {
      previous.at = now;
      return;
    }
  }
  recent.set(text, { at: now, count: (previous?.count ?? 0) + 1 });
  if (recent.size > 40) recent.clear();
  showToast(text, true, durationMs);
}

/** 安装全局兜底：未捕获异常与未处理的 Promise 拒绝也要提示用户 */
export function installGlobalErrorReporting(): void {
  window.addEventListener("error", (event) => {
    // 图片等资源加载失败由各自组件兜底（占位 / 重试），这里只处理脚本异常
    if (event.error || event.message) {
      reportFailure("发生未预期的错误", event.error ?? event.message);
    }
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportFailure("操作未能完成", event.reason);
  });
}

/**
 * 订阅 Rust 侧推来的「内部异常」事件（panic 兜底）：
 * 这类异常已经无法在逻辑上补救，但必须让用户知道发生了什么。
 */
export async function listenBackendErrors(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<string>(BACKEND_ERROR_EVENT, (event) => {
      // 无法补救的内部异常：停留久一点，确保用户看得到
      reportFailure("应用内部异常", event.payload, 8_000);
    });
  } catch (error) {
    // 订阅本身失败也不该再抛：退化成控制台日志
    console.error("[readerx] 订阅后端异常事件失败", error);
  }
}

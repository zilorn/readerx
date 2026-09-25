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
import { t } from "./i18n";
import { createLogger, type LogLevel } from "./logger";
import { showToast } from "./toast";

const log = createLogger("error-report");

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
  if (error instanceof Error) return (error.message || error.name || t("common.unknownError")).trim();
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

/**
 * 提示一次失败（带去重与退避）：`what` 说明失败的操作，`error` 为原始异常。
 *
 * 这里同时是这些失败的**日志点**：调用方只调这一个函数就够了，不要再自己补一条
 * `log.error` —— 同一个事件在日志里出现两次，只会让人怀疑是不是真的发生了两次。
 * `level` 默认 warn（可恢复的失败 / 降级）；未捕获异常这类用 error。
 */
export function reportFailure(
  what: string,
  error: unknown,
  durationMs = 4_200,
  level: LogLevel = "warn",
): void {
  if (level === "error") log.error(what, error);
  else log.warn(what, error);
  const reason = describeError(error);
  const separator = t("common.failureSeparator");
  const text = (reason ? `${what}${separator}${reason}` : what).slice(0, MAX_TEXT_LEN);
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
      reportFailure(t("misc.error.unexpected"), event.error ?? event.message, 4_200, "error");
    }
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportFailure(t("misc.error.incomplete"), event.reason, 4_200, "error");
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
      // 无法补救的内部异常：按 error 记日志，提示也停留久一点，确保用户看得到
      reportFailure(t("misc.error.internal"), event.payload, 8_000, "error");
    });
  } catch (error) {
    // 订阅本身失败也不该再抛：退化成一条 error 日志（此时也没有别的出口了）
    log.error("订阅后端内部异常事件失败", error);
  }
}

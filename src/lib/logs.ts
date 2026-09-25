/**
 * 「应用日志」查看器与 Rust 后端之间的通道（设置 → 调试 → 应用日志）。
 *
 * 日志本体由 Rust 写在 `<应用数据目录>/logs/<日期>/readerx-<时刻>.log`
 * （见 `src-tauri/src/logging.rs` 与 `src-tauri/crates/readerx-log`），这里只做三件事：
 * 读尾巴（可选读某一次运行）、清空、切换级别。刻意不放进 `backend.ts` ——
 * 那是「书籍 / 书源 / 状态」的通道，日志查看器自成一块。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { createLogger, flushLogs, setLogMinLevel, type LogLevel } from "./logger";
import { readState } from "./backend";
import { t } from "./i18n";

const log = createLogger("logs");

/** Rust 侧保存日志级别的状态键（与 src-tauri/src/logging.rs 的 LOG_LEVEL_KEY 一致） */
const LEVEL_KEY = "readerx.logLevel";

/** 日志设施状态 */
export interface LogInfo {
  /** 本次运行的日志文件路径；未启用文件日志为空串 */
  path: string;
  /** 当前生效的级别规格 */
  level: string;
  /** 是否在写文件日志 */
  fileEnabled: boolean;
  /** 文件日志不可用时的原因 */
  fileError: string;
}

/** 一次运行写下的日志（界面上的文件选择器按它列出） */
export interface LogRun {
  /** 本地日期 `2026-09-25` */
  date: string;
  /** 这一份文件开始写的时刻 `150405` */
  time: string;
  /** 该次运行的日志文件路径 */
  path: string;
  /** 是不是当前正在写的这一次运行 */
  current: boolean;
}

/** 一次日志读取结果 */
export interface LogTail extends LogInfo {
  /** 按时间从旧到新的日志文本 */
  text: string;
  /** 最近若干次运行（新 → 旧） */
  runs: LogRun[];
  /** `text` 来自哪一次运行（它的文件路径） */
  selected: string;
}

/** 界面上的级别筛选项：`null` = 全部 */
export type LogFilter = "info" | "warn" | "error" | null;

/**
 * 纯浏览器开发环境没有后端日志，明确告知而不是显示空列表。
 * 文案要等词典载入后才知道，所以每次调用时取（不能放模块顶层常量）。
 */
function noBackend(): LogTail {
  return {
    text: "",
    runs: [],
    selected: "",
    path: "",
    level: "info",
    fileEnabled: false,
    fileError: t("settings.logs.browserOnly"),
  };
}

/**
 * 读取日志尾巴。`maxLines` 默认 2000 行，`minLevel` 为 `null` 时不过滤级别
 * （前端的「全部」= 连 debug 一起看，所以这里传 `null`）。
 * `runPath` 为空读本次运行，否则读那一次运行（后端只认自己目录下的日志文件）。
 */
export async function readLogTail(
  maxLines = 2_000,
  minLevel: LogFilter = null,
  runPath = "",
): Promise<LogTail> {
  if (!isTauri()) return noBackend();
  // 先把前端攒着的那批送出去：否则刚发生的事（日志里最该看到的那几条）还在待发队列里
  await flushLogs();
  try {
    return await invoke<LogTail>("readerx_log_tail", {
      maxLines,
      minLevel: minLevel ?? "",
      path: runPath,
    });
  } catch (error) {
    log.warn("读取日志失败", error);
    return {
      ...noBackend(),
      fileError: t("settings.logs.readFailed", { reason: String(error) }),
    };
  }
}

/** 清空日志文件（所有日期 + 历史文件）；失败抛出可读原因，由界面提示 */
export async function clearLogs(): Promise<void> {
  if (!isTauri()) throw new Error(t("settings.logs.inAppOnly"));
  await invoke("readerx_log_clear");
  log.info("日志已清空");
}

/** 切换日志级别（`info` = 常规，`debug` = 详细）并记住，返回最新的设施状态 */
export async function setLogLevel(level: LogLevel): Promise<LogInfo> {
  if (!isTauri()) throw new Error(t("settings.logs.levelInAppOnly"));
  const info = await invoke<LogInfo>("readerx_log_set_level", { level });
  // 前端也要跟着放开：否则切到「详细」后，WebView 侧的 debug 记录根本不会回传
  setLogMinLevel(level);
  return info;
}

/**
 * 启动时把用户保存的日志级别同步到前端。
 *
 * 后端在启动时已按同一份偏好设置过级别，这里补上前端这一半 ——
 * 否则「上次开了详细日志」的情况下，后端有 debug、前端却没有。
 */
export async function initFrontendLogLevel(): Promise<void> {
  if (!isTauri()) return;
  try {
    const saved = await readState<string>(LEVEL_KEY);
    const spec = typeof saved === "string" ? saved.trim().toLowerCase() : "";
    if (spec.startsWith("debug") || spec.startsWith("trace")) {
      setLogMinLevel("debug");
    }
  } catch {
    // 读不到偏好不是问题：沿用内置默认级别
  }
}

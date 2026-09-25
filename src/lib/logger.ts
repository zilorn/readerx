/**
 * 前端统一日志入口。
 *
 * 设计口径与后端一致（见 `src-tauri/crates/readerx-log`）：
 *
 * - **一个出口**：业务代码只写 `log.info(...)` / `log.warn(...)`，不再散落 `console.*`；
 * - **落同一个文件**：每条记录经 `readerx_log_write` 回传 Rust，与后端日志按时间交织在
 *   `<应用数据目录>/logs/<日期>/readerx-<启动时刻>.log` 里 —— 用户报问题时一份文件就能看全前后端；
 * - **不阻塞界面**：回传是「攒一批、异步发、发不出去就丢」的，日志永远不该拖慢或卡住业务；
 *   纯浏览器开发环境没有后端，退回控制台输出。
 *
 * 级别：`error` / `warn` / `info` / `debug`。默认只发 `info` 以上，避免把每章正文下载的
 * 细枝末节都写进日志；需要详单时在「设置 → 调试 → 应用日志」里切到「详细」。
 *
 * **不要写进日志的东西**：书籍正文、Cookie / token / 密码、localStorage 快照。
 * 日志会被导出、会被贴进 issue，泄了收不回来。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 级别高低（数值越大越严重），用于与最低级别比较 */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 每条回传消息的长度上限：日志不该因为一条超长错误把 IPC 报文撑大 */
const MAX_MESSAGE_LEN = 4_000;
/** 攒批间隔与批大小：既不让 IPC 调用跟着每条日志走，也不让日志在内存里积压 */
const FLUSH_INTERVAL_MS = 400;
const MAX_BATCH = 40;
/** 待发队列上限：后端挂了 / 疯狂报错时宁可丢日志，也不能把 WebView 内存吃光 */
const MAX_PENDING = 200;

const tauri = isTauri();

interface PendingRecord {
  level: LogLevel;
  scope: string;
  message: string;
}

let pending: PendingRecord[] = [];
let timer: number | undefined;
/** 最低输出级别（Rust 侧还有一份服务端过滤，这里先挡住大部分） */
let minLevel: LogLevel = import.meta.env.DEV ? "debug" : "info";
/** 回传连续失败时暂停一段时间，避免后端不可用时每条日志都触发一次失败的 invoke */
let suspendedUntil = 0;

/** 当前生效的最低级别 */
export function currentLogLevel(): LogLevel {
  return minLevel;
}

/** 设置最低级别（与 Rust 侧 `readerx_log_set_level` 配套使用） */
export function setLogMinLevel(level: LogLevel): void {
  minLevel = level;
}

/** 把任意值描述成一行可读文本（错误对象取消息 + 名称，其余走 JSON） */
export function describe(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || value.name || "未知错误";
  if (typeof value === "object") {
    try {
      const text = JSON.stringify(value);
      return text && text !== "{}" ? text : String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** 把「消息 + 附加参数」拼成一行 */
function format(parts: unknown[]): string {
  return parts
    .map((part) => describe(part))
    .filter((text) => text.length > 0)
    .join(" ")
    .slice(0, MAX_MESSAGE_LEN);
}

function write(level: LogLevel, scope: string, parts: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const message = format(parts);
  // 开发期控制台留一份：浏览器里没有 Rust 后端，控制台是唯一出口
  if (import.meta.env.DEV) {
    const line = `[${scope}] ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
  if (!tauri || Date.now() < suspendedUntil) return;
  if (pending.length >= MAX_PENDING) pending.shift();
  pending.push({ level, scope, message });
  schedule();
}

function schedule(): void {
  if (timer !== undefined) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    void flush();
  }, FLUSH_INTERVAL_MS);
}

/** 把攒下的记录一次性发给 Rust；失败即暂停回传（日志不该反过来制造错误提示） */
async function flush(): Promise<void> {
  if (pending.length === 0) return;
  const batch = pending.slice(0, MAX_BATCH);
  pending = pending.slice(batch.length);
  try {
    // 一次 IPC 写完一批：每条日志一次 invoke 会让高频路径付出不必要的序列化开销
    await invoke("readerx_log_write", { records: batch });
  } catch {
    pending = [];
    suspendedUntil = Date.now() + 60_000;
  }
  if (pending.length > 0) schedule();
}

/** 页面关闭前尽力把剩下的日志发出去（sendBeacon 在 Tauri 里没有对应物，只能同步尽力） */
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (pending.length > 0) void flush();
  });
}

export interface Logger {
  debug(...parts: unknown[]): void;
  info(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  error(...parts: unknown[]): void;
}

/**
 * 取一个带模块名的 logger：`const log = createLogger("books")`。
 * 模块名会写进每条记录（`[books] …`），排错时一眼看出是谁记的。
 */
export function createLogger(scope: string): Logger {
  return {
    debug: (...parts: unknown[]) => write("debug", scope, parts),
    info: (...parts: unknown[]) => write("info", scope, parts),
    warn: (...parts: unknown[]) => write("warn", scope, parts),
    error: (...parts: unknown[]) => write("error", scope, parts),
  };
}

/** 立刻把待发日志送出去（退出前 / 关键节点需要日志先落盘时用） */
export async function flushLogs(): Promise<void> {
  await flush();
}

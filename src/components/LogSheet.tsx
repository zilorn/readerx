/**
 * 「设置 → 调试 → 应用日志」查看器。
 *
 * 日志本体是 Rust 写的 `<应用数据目录>/logs/readerx.log`（见 src-tauri/crates/readerx-log）。
 * 为什么要在应用里看而不是让用户去翻文件：Android 上应用数据目录对用户是不可见的，
 * 出了问题没有这个入口就只能靠连电脑抓 logcat —— 而绝大多数反馈发生在手机上。
 *
 * 三个动作：按级别筛（全部 / 信息 / 警告 / 错误）、刷新、清空（连点两次确认）。
 * 级别「详细」会把用户偏好写成 debug 并立即生效（前后端一起放开），
 * 排障时让用户复现一次，日志里就能看到每一步。
 */
import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { CloseIcon, CopyIcon, RefreshIcon, TerminalIcon, TrashIcon } from "./icons";
import { ScrollArea } from "./ScrollArea";
import { showToast } from "../lib/toast";
import { reportFailure } from "../lib/errorReport";
import {
  clearLogs,
  readLogTail,
  setLogLevel,
  type LogFilter,
  type LogTail,
} from "../lib/logs";
import type { LogLevel } from "../lib/logger";
import { t, type MessageKey } from "../lib/i18n";

/** 一次读取的行数上限（后端也会截断） */
const TAIL_LINES = 2_000;
/** 清空的二次确认时限（与设置页「重置进度」同一手感） */
const CONFIRM_MS = 3_000;

const FILTERS: { value: LogFilter; labelKey: MessageKey }[] = [
  { value: null, labelKey: "common.all" },
  { value: "info", labelKey: "settings.logs.filterInfo" },
  { value: "warn", labelKey: "settings.logs.filterWarn" },
  { value: "error", labelKey: "settings.logs.filterError" },
];

/** 后端级别规格 → 界面上的「常规 / 详细」 */
function levelMode(spec: string): "info" | "debug" {
  const normalized = spec.trim().toLowerCase();
  return normalized.startsWith("debug") || normalized.startsWith("trace")
    ? "debug"
    : "info";
}

export interface LogSheetProps {
  open: boolean;
  onClose: () => void;
}

export function LogSheet(props: LogSheetProps) {
  const [tail, setTail] = createSignal<LogTail | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [filter, setFilter] = createSignal<LogFilter>(null);
  const [detail, setDetail] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  let scrollEl: HTMLDivElement | undefined;
  let confirmTimer: number | undefined;

  onCleanup(() => window.clearTimeout(confirmTimer));

  async function reload(selectFilter: LogFilter = filter()): Promise<void> {
    setLoading(true);
    try {
      const next = await readLogTail(TAIL_LINES, selectFilter);
      setTail(next);
      setDetail(levelMode(next.level) === "debug");
      // 最新一条在末尾：打开就落在末尾，不必手动往下滚
      queueMicrotask(() => {
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
      });
    } finally {
      setLoading(false);
    }
  }

  // 打开时读一次；打开期间切换筛选也重读（级别过滤在后端做，前端只有这一份尾巴）
  createEffect(() => {
    if (props.open) void reload(filter());
  });

  async function copyAll(): Promise<void> {
    const text = tail()?.text ?? "";
    if (!text) {
      showToast(t("settings.logs.copyEmpty"), true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast(t("settings.logs.copied"));
    } catch (error) {
      reportFailure(t("settings.logs.copyFailed"), error);
    }
  }

  function onClear(): void {
    if (!confirming()) {
      setConfirming(true);
      window.clearTimeout(confirmTimer);
      confirmTimer = window.setTimeout(() => setConfirming(false), CONFIRM_MS);
      return;
    }
    window.clearTimeout(confirmTimer);
    setConfirming(false);
    void clearLogs()
      .then(() => {
        showToast(t("settings.logs.cleared"));
        return reload();
      })
      .catch((error) => reportFailure(t("settings.logs.clearFailed"), error));
  }

  async function onDetailChange(level: LogLevel): Promise<void> {
    if (loading()) return;
    try {
      const info = await setLogLevel(level);
      setDetail(levelMode(info.level) === "debug");
      showToast(
        level === "debug"
          ? t("settings.logs.verboseOn")
          : t("settings.logs.verboseOff"),
      );
      await reload();
    } catch (error) {
      reportFailure(t("settings.logs.levelFailed"), error);
    }
  }

  const chipClass = (active: boolean) =>
    `rounded-full px-2.5 py-1 text-[11.5px] transition-colors duration-150 ${
      active ? "bg-accent text-on-accent" : "bg-surface-2 text-text-2"
    }`;

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[70] animate-page-in-right bg-bg">
        <div class="mx-auto flex h-full w-full max-w-[var(--app-column)] flex-col overflow-hidden bg-bg min-[521px]:border-x min-[521px]:border-border min-[521px]:shadow-[0_0_44px_rgb(0_0_0/0.16)]">
          <header class="flex flex-none items-center gap-2.5 border-b border-border px-[18px] pb-2.5 pt-[max(env(safe-area-inset-top),12px)]">
            <span class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-accent-weak text-accent">
              <TerminalIcon size={18} />
            </span>
            <div class="flex min-w-0 flex-1 flex-col">
              <h1 class="text-[16px] font-bold leading-tight tracking-[0.02em]">{t("settings.logs.title")}</h1>
              <span class="truncate text-[11px] text-text-3">
                {tail()?.path || tail()?.fileError || t("common.loadingDots")}
              </span>
            </div>
            <button
              class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
              type="button"
              aria-label={t("settings.logs.close")}
              onClick={props.onClose}
            >
              <CloseIcon />
            </button>
          </header>

          <div class="flex flex-none items-center gap-1.5 border-b border-border px-[18px] py-2.5">
            {FILTERS.map((item) => (
              <button
                class={chipClass(filter() === item.value)}
                type="button"
                onClick={() => setFilter(item.value)}
              >
                {t(item.labelKey)}
              </button>
            ))}
            <span class="ml-auto flex items-center gap-1">
              <button
                class="grid h-8 w-8 place-items-center rounded-lg text-text-2 transition-colors duration-150 active:bg-surface-2"
                type="button"
                aria-label={t("settings.logs.copy")}
                onClick={() => void copyAll()}
              >
                <CopyIcon size={16} />
              </button>
              <button
                class="grid h-8 w-8 place-items-center rounded-lg text-text-2 transition-colors duration-150 active:bg-surface-2"
                type="button"
                aria-label={t("settings.logs.refresh")}
                onClick={() => void reload()}
              >
                <RefreshIcon size={16} />
              </button>
            </span>
          </div>

          <div class="flex flex-none items-center gap-1.5 border-b border-border px-[18px] py-2">
            <span class="text-[11.5px] text-text-3">{t("settings.logs.level")}</span>
            <button
              class={chipClass(!detail())}
              type="button"
              onClick={() => void onDetailChange("info")}
            >
              {t("settings.logs.levelNormal")}
            </button>
            <button
              class={chipClass(detail())}
              type="button"
              onClick={() => void onDetailChange("debug")}
            >
              {t("settings.logs.levelVerbose")}
            </button>
            <button
              class="ml-auto flex items-center gap-1 rounded-lg px-2 py-1 text-[11.5px] text-danger transition-colors duration-150 active:bg-danger-weak"
              type="button"
              onClick={onClear}
            >
              <TrashIcon size={14} />
              {confirming()
                ? t("settings.action.clearConfirm")
                : t("common.clear")}
            </button>
          </div>

          <ScrollArea
            class="min-h-0 flex-1"
            contentClass="px-[14px] pb-[calc(24px+env(safe-area-inset-bottom))] pt-3"
            onEl={(el) => {
              scrollEl = el;
            }}
          >
            <Show
              when={tail()?.text}
              fallback={
                <div class="grid h-full place-items-center px-6 text-center text-[12.5px] text-text-3">
                  {loading()
                    ? t("common.loadingDots")
                    : tail()?.fileError
                      ? tail()!.fileError
                      : filter() === null
                        ? t("settings.logs.empty")
                        : t("settings.logs.emptyAtLevel")}
                </div>
              }
            >
              <pre class="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.7] text-text-2">
                {tail()!.text}
              </pre>
            </Show>
          </ScrollArea>

          <Show when={detail()}>
            <p class="flex flex-none items-center border-t border-border px-[18px] py-2 text-[11px] text-text-3">
              {t("settings.logs.verboseNote")}
            </p>
          </Show>
        </div>
      </div>
    </Show>
  );
}

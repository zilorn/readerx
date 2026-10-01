import { Show } from "solid-js";
import { syncProgress } from "../lib/store";
import { t, type MessageKey } from "../lib/i18n";
import { syncErrorText } from "../lib/sync";

const PHASE_KEYS: Record<string, MessageKey> = {
  connecting: "sync.progress.connecting",
  metadata: "sync.progress.metadata",
  content: "sync.progress.content",
  assets: "sync.progress.assets",
  applying: "sync.progress.applying",
  continuing: "sync.progress.continuing",
  done: "sync.progress.done",
  failed: "sync.progress.failed",
};

/** 当前书籍按通道显示真实计数；对账 / 落地时不编造百分比。 */
export function SyncProgressPanel() {
  return (
    <Show when={syncProgress()}>
      {(progress) => {
        const determinate = () => (progress().phase === "content" || progress().phase === "assets")
          && progress().total !== null && progress().total! > 0;
        const percent = () => Math.min(100, Math.round(progress().completed / Math.max(1, progress().total ?? 0) * 100));
        return (
          <div class="mx-4 mb-3 flex flex-col gap-2 rounded-xl bg-surface-2 p-3" aria-live="polite">
            <div class="flex items-center justify-between gap-2 text-[12px]">
              <span class="font-medium">{t(PHASE_KEYS[progress().phase] ?? "sync.status.syncing")}</span>
              <span class="shrink-0 text-text-3">{t("sync.progress.batch", { count: progress().batch })}</span>
            </div>
            <Show when={progress().peerName}>
              <div class="truncate text-[11.5px] text-text-2">{progress().peerName}</div>
            </Show>
            <Show when={progress().phase === "content" || progress().phase === "assets"}>
              <div class="flex items-center justify-between gap-2 text-[11.5px] text-text-2">
                <span class="truncate">{progress().bookTitle}</span>
                <span class="shrink-0 tabular-nums">{progress().bookIndex} / {progress().bookCount}</span>
              </div>
            </Show>
            <Show when={progress().phase !== "failed"}>
              <Show when={progress().phase === "done" || determinate()} fallback={
                <progress class="h-2 w-full overflow-hidden rounded-full accent-accent" aria-label={t("sync.progress.bar")} />
              }>
              <progress
                class="h-2 w-full overflow-hidden rounded-full accent-accent [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-border [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-accent"
                aria-label={t("sync.progress.bar")}
                max={100}
                value={progress().phase === "done" ? 100 : percent()}
              />
              </Show>
            </Show>
            <Show when={determinate()}>
              <div class="flex justify-between text-[11.5px] text-text-2 tabular-nums">
                <span>{t(progress().phase === "content" ? "sync.progress.chapters" : "sync.progress.resources", {
                  done: progress().completed, total: progress().total!,
                })}</span>
                <span>{percent()}%</span>
              </div>
            </Show>
            <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px] text-text-2 tabular-nums">
              <span>{t("sync.progress.sentChapters", { count: progress().contentPushed })}</span>
              <span>{t("sync.progress.receivedChapters", { count: progress().contentPulled })}</span>
              <span>{t("sync.progress.sentImages", { count: progress().assetsPushed })}</span>
              <span>{t("sync.progress.receivedImages", { count: progress().assetsPulled })}</span>
            </div>
            <div class="text-[11.5px] text-text-2">{t("sync.progress.bytes", { size: (progress().bytes / 1024 / 1024).toFixed(2) })}</div>
            <Show when={progress().error}>
              {(error) => <div class="break-words text-[11.5px] text-danger">{syncErrorText(error())}</div>}
            </Show>
          </div>
        );
      }}
    </Show>
  );
}

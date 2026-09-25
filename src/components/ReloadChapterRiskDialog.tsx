import { For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { BookmarkInheritPreview } from "../lib/bookmarks";
import { t } from "../lib/i18n";

interface ReloadChapterRiskDialogProps {
  /** 将被重新加载的章节名（在线书当前章） */
  chapterTitle: string;
  /** 本章书签在“新正文”上的预演结果（failedCount > 0 时展示） */
  preview: BookmarkInheritPreview;
  /** 取消本次重新加载（保留本章现有正文与书签） */
  onCancel: () => void;
  /** 无视失效书签，仍要重新加载本章 */
  onProceed: () => void;
}

/** 「重新加载本章」前弹窗：提示重载可能使本章部分书签失效，用户可放弃重载 */
export function ReloadChapterRiskDialog(props: ReloadChapterRiskDialogProps) {
  const allFailed = () =>
    props.preview.total > 0 && props.preview.failedCount === props.preview.total;
  const summary = () =>
    allFailed()
      ? t("sourceEditor.reload.allFailed", { count: props.preview.total })
      : t("sourceEditor.reload.partialFailed", {
          total: props.preview.total,
          failed: props.preview.failedCount,
        });

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[85] grid place-items-center px-8"
        role="dialog"
        aria-modal="true"
        aria-label={t("sourceEditor.reload.ariaLabel", { chapterTitle: props.chapterTitle })}
      >
        <div
          class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
          onClick={props.onCancel}
        />
        <div class="relative w-full max-w-[340px] animate-pop-in overflow-hidden rounded-[18px] border border-border bg-surface p-4 shadow-[0_18px_50px_rgb(0_0_0/0.3)]">
          <p class="text-[15px] font-bold leading-snug">{t("sourceEditor.reload.title")}</p>
          <p class="mt-2 text-[12.5px] leading-[1.7] text-text-2">
            {summary()}
            <Show when={props.preview.failedCount < props.preview.total}>
              <span>{t("sourceEditor.reload.restKept")}</span>
            </Show>
          </p>
          <Show when={props.preview.samples.length > 0}>
            <ul class="mt-2.5 space-y-1.5 overflow-hidden rounded-[12px] bg-bg p-2.5">
              <For each={props.preview.samples}>
                {(sample) => (
                  <li class="truncate text-[11.5px] text-text-3">{sample.text}</li>
                )}
              </For>
            </ul>
          </Show>
          <p class="mt-2 text-[12px] leading-[1.6] text-text-3">
            {t("sourceEditor.reload.keepHint")}
          </p>
          <div class="mt-3.5 flex items-center gap-2.5">
            <button
              class="flex-1 rounded-xl border border-border bg-bg px-4 py-[10px] text-[13.5px] font-medium text-text-2 transition-colors active:bg-surface-2"
              type="button"
              onClick={props.onCancel}
            >
              {t("common.cancel")}
            </button>
            <button
              class="flex-1 rounded-xl bg-accent px-4 py-[10px] text-[13.5px] font-semibold text-on-accent shadow-lg shadow-accent/25 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
              type="button"
              onClick={props.onProceed}
            >
              {t("sourceEditor.reload.proceed")}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

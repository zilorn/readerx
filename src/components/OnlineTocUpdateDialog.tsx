/**
 * 在线书「检查书籍更新」的目录变化确认框（Portal 居中弹层）：
 * 目录有删除或重排时无法静默处理（会改变阅读顺序、可能影响书签），
 * 先说明本次增删改数量，再执行增量更新；未变化章节的 cid、正文与书签都会保留。
 */
import { Show } from "solid-js";
import { Portal } from "solid-js/web";
import { t } from "../lib/i18n";
import type { OnlineTocSummary } from "../lib/online";

export interface OnlineTocUpdateDialogProps {
  bookTitle: string;
  summary: Pick<OnlineTocSummary, "newCount" | "added" | "removed" | "changed">;
  /** 正在执行更新（按钮禁用 + 转圈） */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function OnlineTocUpdateDialog(props: OnlineTocUpdateDialogProps) {
  return (
    <Portal>
      <div
        class="fixed inset-0 z-[85] grid place-items-center px-8"
        role="dialog"
        aria-modal="true"
        aria-label={t("sourceEditor.toc.ariaLabel", { bookTitle: props.bookTitle })}
      >
        <div
          class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
          onClick={props.busy ? undefined : props.onCancel}
        />
        <div class="relative w-full max-w-[340px] animate-pop-in overflow-hidden rounded-[18px] border border-border bg-surface p-4 shadow-[0_18px_50px_rgb(0_0_0/0.3)]">
          <p class="text-[15px] font-bold leading-snug">{t("sourceEditor.toc.title")}</p>
          <p class="mt-2 text-[12.5px] leading-[1.7] text-text-2">
            {t("sourceEditor.toc.desc", {
              bookTitle: props.bookTitle,
              newCount: props.summary.newCount,
              added: props.summary.added,
              removed: props.summary.removed,
              changed: props.summary.changed,
            })}
          </p>
          <p class="mt-2 text-[12px] leading-[1.6] text-text-3">
            {t("sourceEditor.toc.effect")}
          </p>
          <div class="mt-3.5 flex items-center gap-2.5">
            <button
              type="button"
              class="flex-1 rounded-xl border border-border bg-bg px-4 py-[10px] text-[13.5px] font-medium text-text-2 transition-colors active:bg-surface-2 disabled:opacity-50"
              disabled={props.busy}
              onClick={props.onCancel}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-[10px] text-[13.5px] font-semibold text-on-accent shadow-lg shadow-accent/25 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90 disabled:opacity-60"
              disabled={props.busy}
              onClick={props.onConfirm}
            >
              <Show when={props.busy} fallback={t("sourceEditor.toc.confirm")}>
                <span
                  class="size-3.5 flex-none animate-spin rounded-full border-2 border-on-accent/40 border-t-on-accent"
                  aria-hidden="true"
                />
                {t("sourceEditor.toc.applying")}
              </Show>
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/**
 * 在线书「检查书籍更新」的目录冲突确认框（Portal 居中弹层）：
 * 书源返回的最新目录与书架现有目录不一致（不是单纯的末尾追加，例如中段被
 * 新增 / 删除 / 重排或章节地址变动），无法安全自动追加，询问用户是否覆盖。
 */
import { Show } from "solid-js";
import { Portal } from "solid-js/web";
import { t } from "../lib/i18n";

export interface OnlineTocOverwriteDialogProps {
  bookTitle: string;
  /** 书架现有章节数 */
  oldCount: number;
  /** 书源最新目录章节数 */
  newCount: number;
  /** 正在执行覆盖（按钮禁用 + 转圈） */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function OnlineTocOverwriteDialog(props: OnlineTocOverwriteDialogProps) {
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
              oldCount: props.oldCount,
              newCount: props.newCount,
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

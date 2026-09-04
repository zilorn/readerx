import { For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { BookmarkInheritPreview } from "../lib/bookmarks";

interface BookmarkRiskDialogProps {
  bookTitle: string;
  /** 书签继承预演结果（failedCount > 0 时展示） */
  preview: BookmarkInheritPreview;
  busy?: boolean;
  /** 取消本次重新导入（保留现有内容与书签） */
  onCancel: () => void;
  /** 无视失效书签，仍要重新导入 */
  onProceed: () => void;
}

/** 重新导入前弹窗：提示部分书签无法随新内容继承，用户可放弃重新导入 */
export function BookmarkRiskDialog(props: BookmarkRiskDialogProps) {
  const allFailed = () =>
    props.preview.total > 0 && props.preview.failedCount === props.preview.total;
  const summary = () =>
    allFailed()
      ? `重新导入《${props.bookTitle}》后，原有的 ${props.preview.total} 条书签将全部无法在新内容中定位`
      : `重新导入《${props.bookTitle}》后，原有的 ${props.preview.total} 条书签中有 ${props.preview.failedCount} 条无法在新内容中精确定位`;

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[85] grid place-items-center px-8"
        role="dialog"
        aria-modal="true"
        aria-label={`重新导入《${props.bookTitle}》可能导致书签失效`}
      >
        <div
          class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
          onClick={props.onCancel}
        />
        <div class="relative w-full max-w-[340px] animate-pop-in overflow-hidden rounded-[18px] border border-border bg-surface p-4 shadow-[0_18px_50px_rgb(0_0_0/0.3)]">
          <p class="text-[15px] font-bold leading-snug">部分书签可能失效</p>
          <p class="mt-2 text-[12.5px] leading-[1.7] text-text-2">
            {summary()}：正文可能被修改或章节变动，重新导入后这些书签将无法跳转或可能跳错。
            <Show when={props.preview.failedCount < props.preview.total}>
              <span>其余书签会按原样保留。</span>
            </Show>
          </p>
          <Show when={props.preview.samples.length > 0}>
            <ul class="mt-2.5 space-y-1.5 overflow-hidden rounded-[12px] bg-bg p-2.5">
              <For each={props.preview.samples}>
                {(sample) => (
                  <li class="flex flex-col gap-0.5">
                    <span class="truncate text-[11.5px] font-medium text-accent">
                      {sample.chapterTitle}
                    </span>
                    <span class="truncate text-[11.5px] text-text-3">{sample.text}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <p class="mt-2 text-[12px] leading-[1.6] text-text-3">
            取消本次重新导入即可保留现有内容与书签。
          </p>
          <div class="mt-3.5 flex items-center gap-2.5">
            <button
              class="flex-1 rounded-xl border border-border bg-bg px-4 py-[10px] text-[13.5px] font-medium text-text-2 transition-colors active:bg-surface-2 disabled:opacity-50"
              type="button"
              disabled={props.busy}
              onClick={props.onCancel}
            >
              取消
            </button>
            <button
              class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-[10px] text-[13.5px] font-semibold text-on-accent shadow-lg shadow-accent/25 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90 disabled:opacity-60"
              type="button"
              disabled={props.busy}
              onClick={props.onProceed}
            >
              <Show
                when={props.busy}
                fallback="仍要重新导入"
              >
                <span
                  class="size-3.5 flex-none animate-spin rounded-full border-2 border-on-accent/40 border-t-on-accent"
                  aria-hidden="true"
                />
                正在导入…
              </Show>
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/**
 * 标签胶囊（书籍标签展示 / 编辑共用）：
 * - 只读时渲染为普通胶囊；
 * - 传入 onRemove 时每枚标签带移除按钮（编辑表单内使用）。
 */
import { For, Show } from "solid-js";
import { CloseIcon } from "./icons";

interface TagChipsProps {
  tags: readonly string[];
  /** 提供后每枚标签右侧出现移除按钮（编辑态） */
  onRemove?: (tag: string) => void;
}

export function TagChips(props: TagChipsProps) {
  return (
    <For each={props.tags}>
      {(tag) => (
        <span
          class={
            props.onRemove
              ? "inline-flex max-w-full items-center gap-0.5 rounded-full bg-accent-weak py-[3px] pl-2.5 pr-1.5 text-[11.5px] font-medium text-accent"
              : "inline-flex max-w-full items-center rounded-full bg-accent-weak px-2.5 py-[3px] text-[11.5px] font-medium text-accent"
          }
        >
          <span class="truncate">{tag}</span>
          <Show when={props.onRemove}>
            <button
              type="button"
              aria-label={`移除标签 ${tag}`}
              class="grid h-[18px] w-[18px] flex-none place-items-center rounded-full text-accent/70 transition-[background-color,scale] duration-150 active:scale-90 active:bg-accent/15"
              onClick={() => props.onRemove?.(tag)}
            >
              <CloseIcon size={12} />
            </button>
          </Show>
        </span>
      )}
    </For>
  );
}

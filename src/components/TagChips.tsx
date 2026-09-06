/**
 * 标签胶囊（书籍标签展示 / 编辑共用）：
 * - 只读时渲染为普通胶囊；传入 onTagClick 时胶囊变为可点击按钮（如触发发现页快速搜索）；
 * - 传入 onRemove 时每枚标签带移除按钮（编辑表单内使用）。
 */
import { For } from "solid-js";
import { CloseIcon } from "./icons";

interface TagChipsProps {
  tags: readonly string[];
  /** 提供后每枚标签右侧出现移除按钮（编辑态） */
  onRemove?: (tag: string) => void;
  /** 只读态提供后每枚标签变为可点击按钮，点击回调该标签 */
  onTagClick?: (tag: string) => void;
}

export function TagChips(props: TagChipsProps) {
  return (
    <For each={props.tags}>
      {(tag) => {
        if (props.onRemove) {
          return (
            <span class="inline-flex max-w-full items-center gap-0.5 rounded-full bg-accent-weak py-[3px] pl-2.5 pr-1.5 text-[11.5px] font-medium text-accent">
              <span class="truncate">{tag}</span>
              <button
                type="button"
                aria-label={`移除标签 ${tag}`}
                class="grid h-[18px] w-[18px] flex-none place-items-center rounded-full text-accent/70 transition-[background-color,scale] duration-150 active:scale-90 active:bg-accent/15"
                onClick={() => props.onRemove?.(tag)}
              >
                <CloseIcon size={12} />
              </button>
            </span>
          );
        }
        if (props.onTagClick) {
          return (
            <button
              type="button"
              class="inline-flex max-w-full items-center rounded-full bg-accent-weak px-2.5 py-[3px] text-[11.5px] font-medium text-accent transition-[background-color,scale] duration-150 active:scale-95 active:bg-accent/20"
              onClick={() => props.onTagClick?.(tag)}
            >
              <span class="truncate">{tag}</span>
            </button>
          );
        }
        return (
          <span class="inline-flex max-w-full items-center rounded-full bg-accent-weak px-2.5 py-[3px] text-[11.5px] font-medium text-accent">
            <span class="truncate">{tag}</span>
          </span>
        );
      }}
    </For>
  );
}

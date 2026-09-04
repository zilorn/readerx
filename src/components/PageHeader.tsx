import { Show, type JSX } from "solid-js";
import { ChevronLeftIcon } from "./icons";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** 次级页返回键；提供后标题左侧显示返回箭头 */
  onBack?: () => void;
  /** 返回键的无障碍标签 */
  backLabel?: string;
  /** 标题右侧操作区 */
  right?: JSX.Element;
  /** 标题下方内容（如搜索框、分类筛选） */
  children?: JSX.Element;
}

/** 通用页头（吸顶；次级页传入 onBack 显示返回键） */
export function PageHeader(props: PageHeaderProps) {
  return (
    <header class="sticky top-0 z-20 bg-topbar-bg pt-[max(env(safe-area-inset-top),8px)] backdrop-blur-[14px] select-none">
      <div class="flex items-center justify-between gap-3 px-[18px] pb-0.5 pt-2">
        <Show when={props.onBack}>
          <button
            class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            type="button"
            aria-label={props.backLabel ?? "返回"}
            onClick={props.onBack}
          >
            <ChevronLeftIcon />
          </button>
        </Show>
        <div class="flex min-w-0 flex-1 items-baseline gap-2">
          <h1 class="text-[22px] font-bold tracking-[0.02em]">{props.title}</h1>
          {props.subtitle && (
            <span class="whitespace-nowrap text-xs text-text-3">
              {props.subtitle}
            </span>
          )}
        </div>
        {props.right}
      </div>
      {props.children}
    </header>
  );
}

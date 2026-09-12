/**
 * 页面内常驻 Tab 栏（非路由 Tab）
 * ------------------------------------------------
 * 用于「同一个页面里的几块内容」之间切换，例如书源编辑页的
 * 书源信息 / JS 代码 / 测试。放在页头下方、内容区之外，切换内容时自身不动。
 */
import { For } from "solid-js";

export interface PageTab<T extends string> {
  key: T;
  label: string;
}

export interface PageTabsProps<T extends string> {
  tabs: readonly PageTab<T>[];
  value: T;
  onChange: (key: T) => void;
  /** 无障碍标签（如「书源编辑」） */
  label: string;
}

export function PageTabs<T extends string>(props: PageTabsProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={props.label}
      class="flex flex-none items-stretch gap-1 border-b border-border px-[18px] select-none"
    >
      <For each={props.tabs}>
        {(tab) => {
          const active = () => props.value === tab.key;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={active()}
              class="relative flex-1 whitespace-nowrap py-2.5 text-[13.5px] transition-colors duration-150"
              classList={{
                "font-semibold text-text": active(),
                "text-text-3": !active(),
              }}
              onClick={() => props.onChange(tab.key)}
            >
              {tab.label}
              <span
                class="absolute inset-x-[16%] -bottom-px h-[2px] rounded-full bg-accent transition-opacity duration-150"
                classList={{ "opacity-100": active(), "opacity-0": !active() }}
              />
            </button>
          );
        }}
      </For>
    </div>
  );
}

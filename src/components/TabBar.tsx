import { A } from "@solidjs/router";
import { BookIcon, CompassIcon, SettingsIcon } from "./icons";

/** 底部主导航（书架 / 发现 / 设置） */
export function TabBar() {
  return (
    <nav
      class="z-30 flex flex-none border-t border-border bg-surface px-1.5 pb-[calc(6px+max(env(safe-area-inset-bottom),20px))] pt-1 text-text-3 select-none"
      aria-label="主导航"
    >
      <A
        href="/"
        end
        class="flex flex-1 flex-col items-center gap-0.5 pb-0.5 pt-1 no-underline transition-colors duration-150"
        activeClass="text-accent"
        inactiveClass=""
      >
        <span class="leading-none">
          <BookIcon size={23} />
        </span>
        <span class="text-[10.5px] font-medium tracking-[0.02em]">书架</span>
      </A>
      <A
        href="/discover"
        end
        class="flex flex-1 flex-col items-center gap-0.5 pb-0.5 pt-1 no-underline transition-colors duration-150"
        activeClass="text-accent"
        inactiveClass=""
      >
        <span class="leading-none">
          <CompassIcon size={23} />
        </span>
        <span class="text-[10.5px] font-medium tracking-[0.02em]">发现</span>
      </A>
      <A
        href="/settings"
        end
        class="flex flex-1 flex-col items-center gap-0.5 pb-0.5 pt-1 no-underline transition-colors duration-150"
        activeClass="text-accent"
        inactiveClass=""
      >
        <span class="leading-none">
          <SettingsIcon size={23} />
        </span>
        <span class="text-[10.5px] font-medium tracking-[0.02em]">设置</span>
      </A>
    </nav>
  );
}

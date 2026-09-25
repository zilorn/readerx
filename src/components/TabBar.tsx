import { For } from "solid-js";
import { A } from "@solidjs/router";
import { TAB_ROUTES } from "../shell/routes";
import { tabIcon } from "../shell/tabIcons";
import { t } from "../lib/i18n";

/** 底部主导航（书架 / 发现 / 设置）；图标与桌面端侧边栏共用 `shell/tabIcons` */
export function TabBar() {
  return (
    <nav
      class="z-30 flex flex-none border-t border-border bg-surface px-1.5 pb-[calc(6px+max(env(safe-area-inset-bottom),20px))] pt-1 text-text-3 select-none"
      aria-label={t("shell.nav.main")}
    >
      <For each={TAB_ROUTES}>
        {(item) => (
          <A
            href={item.path}
            end
            class="flex flex-1 flex-col items-center gap-0.5 pb-0.5 pt-1 no-underline transition-colors duration-150"
            activeClass="text-accent"
            inactiveClass=""
          >
            <span class="leading-none">{tabIcon(item.path, 23)}</span>
            <span class="text-[10.5px] font-medium tracking-[0.02em]">{t(item.labelKey)}</span>
          </A>
        )}
      </For>
    </nav>
  );
}

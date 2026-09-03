import { For } from "solid-js";
import { A } from "@solidjs/router";
import { BookIcon, CompassIcon, SettingsIcon } from "./icons";

const TABS = [
  { href: "/", label: "书架", Icon: BookIcon },
  { href: "/discover", label: "发现", Icon: CompassIcon },
  { href: "/settings", label: "设置", Icon: SettingsIcon },
];

/** 底部主导航（移动端 Tab 栏） */
export function TabBar() {
  return (
    <nav class="tabbar" aria-label="主导航">
      <For each={TABS}>
        {(tab) => (
          <A
            href={tab.href}
            end
            class="tab"
            activeClass="tab--active"
            inactiveClass=""
          >
            <span class="tab__icon">
              <tab.Icon size={23} />
            </span>
            <span class="tab__label">{tab.label}</span>
          </A>
        )}
      </For>
    </nav>
  );
}

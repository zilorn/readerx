import { useLocation } from "@solidjs/router";
import { createContext, createSignal, onCleanup, untrack, useContext, type JSX } from "solid-js";
import { isDesktopPlatform, isDesktopShell } from "../lib/platform";

export interface PageTitle {
  readonly title: string;
  readonly subtitle?: string;
  readonly onBack?: () => void;
  readonly backLabel?: string;
  readonly afterTitle?: JSX.Element;
  readonly right?: JSX.Element;
}

/** PageBody 为保活页提供创建时的路径，避免懒加载迟到时误用新路由。 */
export const PageTitlePathContext = createContext<string>();

interface Registration { path: string; content: PageTitle }
const [registrations, setRegistrations] = createSignal<Registration[]>([]);

/** 只合并有原生窗口标题栏的宽屏；浏览器预览和移动平台保留页内工具栏。 */
export const usesWindowPageTitle = () => isDesktopPlatform() && isDesktopShell();

/** 保存响应式 props 而非快照；保活页离开后仍注册，但不会覆盖当前路径。 */
export function registerPageTitle(content: PageTitle): void {
  const location = useLocation();
  const entry = { path: useContext(PageTitlePathContext) ?? untrack(() => location.pathname), content };
  setRegistrations((entries) => [...entries, entry]);
  onCleanup(() => setRegistrations((entries) => entries.filter((item) => item !== entry)));
}

export function pageTitleForPath(path: string): PageTitle | undefined {
  return [...registrations()].reverse().find((entry) => entry.path === path)?.content;
}

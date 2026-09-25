/**
 * 外壳共用的路由口径：哪些路径是「主 Tab」、哪些页面自管整页高度。
 *
 * 手机外壳（底部 Tab + 页面栈动画）与桌面外壳（侧边导航 + 内容区）都要按同一份名单
 * 决定导航高亮、是否给内容区留底部空白，因此集中在这里，避免两边各写一份而走偏。
 */
import { t, type MessageKey } from "../lib/i18n";

/**
 * 主 Tab 路由（手机端显示底部导航；桌面端在侧边栏里高亮）。
 * 这里存文案 key 而不是成品文本：路由表在模块顶层求值，写死的文本会停在启动时的语言上。
 */
export const TAB_ROUTES = [
  { path: "/", labelKey: "shell.tab.shelf" },
  { path: "/discover", labelKey: "shell.tab.discover" },
  { path: "/settings", labelKey: "shell.tab.settings" },
] as const satisfies readonly { path: string; labelKey: MessageKey }[];

const TAB_PATHS = new Set<string>(TAB_ROUTES.map((item) => item.path));

export const isTabRoute = (path: string): boolean => TAB_PATHS.has(path);

/** 阅读页路由前缀 */
export const isReaderPath = (path: string): boolean => path.startsWith("/book/");

/**
 * 自管整页高度的页面：内容区不滚动、页面内部再分栏（如书源编辑页的常驻 Tab +
 * JS 编辑器）。这些页面不能带内容区底部留白，否则会多出可滚动的几像素。
 */
const FULL_HEIGHT_ROUTES = new Set(["/source-editor"]);

export const isFullHeightPath = (path: string): boolean =>
  isReaderPath(path) || FULL_HEIGHT_ROUTES.has(path);

/** 页面标题（桌面端窗口标题 / 侧边栏以外的地方用得到）；按当前语言返回 */
export function pageLabel(path: string): string | undefined {
  const route = TAB_ROUTES.find((item) => item.path === path);
  return route ? t(route.labelKey) : undefined;
}

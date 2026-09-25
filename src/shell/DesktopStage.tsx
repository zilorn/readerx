/**
 * 桌面外壳：左侧导航栏 + 右侧内容区（宽窗口用，见 `lib/platform.ts` 的断点）。
 *
 * 与手机外壳（[`MobileStage`](./MobileStage.tsx)）共用同一批页面组件与同一份路由口径
 * （[`./routes`](./routes.ts)），差别只在「导航怎么摆、页面怎么切换」：
 * - 手机端是底部 Tab + 页面栈滑动动画；桌面端是侧边栏 + 内容区，**没有转场动画**
 *   （桌面窗口里横向滑入滑出不像原生行为），页面切换就是内容区整块替换；
 * - **侧边栏只在主 Tab（书架 / 发现 / 设置）显示**：其余页面（阅读页、书源管理、二级页等）
 *   整条侧边栏不显示，内容区铺满窗口 —— 与手机端「次级页不显示底部 Tab」是同一套口径；
 * - 主 Tab 里侧边栏还能**手动收起**成一条图标栏（标题行右端的按钮切换，形态由
 *   `store` 的 `readerx.sidebarCollapsed` 记住），展开 / 收起宽度都会写进 CSS 变量
 *   `--sidebar-w`，让挂在 `body` 上的浮层继续按内容区居中（见 `index.css` 的 `--app-column`）；
 * - 主 Tab 与「WebDAV 导入」等**保活页面**同样常驻 DOM，切走只是 `display:none`，
 *   页内搜索词 / 列表 / 滚动位置原样保留（与手机端一致）；
 * - 次级页面按路由推入 / 弹出，离场即卸载 —— 桌面端没有「返回栈动画」，
 *   但也因此不需要冻结离场快照。
 *
 * 阅读页（`/book/:id`）在宽窗口下由外壳给出**最大**宽度（够放并排两页），页面自己按可用宽度
 * 决定并排几页并居中限宽（见 `lib/readerLayout.ts`）；列表型页面则铺满内容区
 * ——书架的封面是固定宽度，按内容区宽度自动排列成多列网格（见 `pages/Bookshelf.tsx` 的 ShelfGrid）。
 */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type Component,
  type JSX,
} from "solid-js";
import { A, useLocation, useNavigate } from "@solidjs/router";
import { PageBody } from "../components/PageBody";
import { SidebarCollapseIcon, SidebarExpandIcon } from "../components/icons";
import { registerAppScrollEl } from "../lib/appScroll";
import { isSidebarCollapsed, setSidebarCollapsed } from "../lib/store";
import { READER_MAX_WIDTH } from "../lib/readerLayout";
import { isFullHeightPath, isTabRoute, TAB_ROUTES } from "./routes";
import { tabIcon } from "./tabIcons";
import { t } from "../lib/i18n";

export interface DesktopStageProps {
  children?: JSX.Element;
  /** 需要保活的常驻页面：路径 → 组件 */
  kept?: Record<string, Component>;
}

interface Pane {
  id: number;
  path: string;
  /** 常驻页面组件（保活层），与 children 互斥 */
  component?: Component;
  /** 瞬态页面创建时的路由出口内容 */
  children?: JSX.Element;
}

/** 侧边栏展开宽度（与 `index.css` 里 `--sidebar-w` 的桌面默认值一致） */
const SIDEBAR_WIDTH = 236;
/** 侧边栏收起后的图标栏宽度 */
const SIDEBAR_RAIL_WIDTH = 64;

export function DesktopStage(props: DesktopStageProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const path = createMemo(() => location.pathname);
  const isReader = createMemo(() => path().startsWith("/book/"));

  /**
   * 侧边栏只属于主 Tab：离开书架 / 发现 / 设置后整条不显示（阅读页要的是整屏正文，
   * 二级页有自己的返回键），回到主 Tab 再按用户记住的形态显示。
   */
  const sidebarShown = createMemo(() => isTabRoute(path()));
  const sidebarWidth = createMemo(() =>
    !sidebarShown() ? 0 : isSidebarCollapsed() ? SIDEBAR_RAIL_WIDTH : SIDEBAR_WIDTH,
  );

  // 侧边栏当前占位宽度广播给 CSS：挂在 body 上的抽屉 / 弹层按内容区居中
  // （`--app-column`），不跟着侧边栏的显示与收展走就会偏心
  createEffect(() => {
    document.documentElement.style.setProperty("--sidebar-w", `${sidebarWidth()}px`);
  });
  onCleanup(() => document.documentElement.style.removeProperty("--sidebar-w"));

  let paneSeq = 0;
  const initialPath = location.pathname;
  const initialKept = props.kept?.[initialPath];
  const initialPane: Pane = initialKept
    ? { id: paneSeq++, path: initialPath, component: initialKept }
    : { id: paneSeq++, path: initialPath, children: props.children };

  const [keptPanes, setKeptPanes] = createSignal<Pane[]>(initialKept ? [initialPane] : []);
  const [transientPanes, setTransientPanes] = createSignal<Pane[]>(
    initialKept ? [] : [initialPane],
  );
  const [currentId, setCurrentId] = createSignal(initialPane.id);

  const allPanes = createMemo(() => [...keptPanes(), ...transientPanes()]);
  const paneById = (id: number) => allPanes().find((pane) => pane.id === id);

  const scrollById = new Map<number, HTMLDivElement>();
  let targetPaneId = initialPane.id;

  /** 内容区可用宽度（阅读页据此限宽居中） */
  const [stageWidth, setStageWidth] = createSignal(0);
  let stageEl: HTMLDivElement | undefined;

  onMount(() => {
    if (!stageEl) return;
    const observer = new ResizeObserver(() => setStageWidth(stageEl?.clientWidth ?? 0));
    observer.observe(stageEl);
    setStageWidth(stageEl.clientWidth);
    onCleanup(() => observer.disconnect());
  });

  /** 让 appScrollEl 指向当前页面的滚动容器（页面内「回到顶部」等逻辑依赖它） */
  function registerTopScroll(): void {
    const el = scrollById.get(currentId());
    if (el) registerAppScrollEl(el);
  }

  function dropTransient(id: number): void {
    setTransientPanes((list) => list.filter((pane) => pane.id !== id));
  }

  // 路由变化：复用常驻层，或新建 / 卸载瞬态层
  createEffect(
    on(path, (nextPath, prevPath) => {
      if (prevPath === undefined || nextPath === prevPath) return;
      const keptComponent = props.kept?.[nextPath];
      const prevId = currentId();

      let pane: Pane;
      if (keptComponent) {
        const existing = keptPanes().find((item) => item.path === nextPath);
        if (existing) {
          pane = existing;
        } else {
          pane = { id: paneSeq++, path: nextPath, component: keptComponent };
          setKeptPanes((list) => [...list, pane]);
        }
      } else {
        pane = { id: paneSeq++, path: nextPath, children: props.children };
        setTransientPanes((list) => [...list, pane]);
      }

      if (pane.id !== prevId) {
        const prev = paneById(prevId);
        // 离散导航（不经过页面栈）：上一页是瞬态层就直接卸载，常驻层留着保活
        if (prev && !prev.component) dropTransient(prev.id);
      }
      setCurrentId(pane.id);
      targetPaneId = pane.id;
      // 页面挂载完成后再注册滚动容器（本帧稍后 el 才存在）
      window.requestAnimationFrame(() => {
        if (targetPaneId !== pane.id) return;
        registerTopScroll();
      });
      sweepMaps();
    }),
  );

  function sweepMaps(): void {
    const alive = new Set(allPanes().map((pane) => pane.id));
    for (const id of [...scrollById.keys()]) {
      if (!alive.has(id)) scrollById.delete(id);
    }
  }

  // ------------------------------------------------------------------
  // 键盘快捷键（桌面端）：Esc 收起 / 返回
  // ------------------------------------------------------------------
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // 页内弹层 / 抽屉开着时先让它们自己处理（它们挂在 Portal 上、自己监听 Esc 或遮罩点击）
      if (document.querySelector('[role="dialog"], [data-desktop-overlay]')) return;
      if (isTabRoute(path())) return;
      event.preventDefault();
      if (window.history.length > 1) navigate(-1);
      else navigate("/");
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  /** 页面内容区的底部留白与限宽：自管整页高度的页面（阅读页 / 书源编辑页）自己处理 */
  const contentClass = (panePath: string): string => {
    if (isFullHeightPath(panePath)) return "";
    return isReader() ? "" : "pb-8";
  };

  /**
   * 阅读页在宽内容区里居中限宽；其余页面铺满（书架等列表页自己会分多列）。
   * 上限是「放得下并排两页」的宽度（见 `lib/readerLayout.ts`），够不够宽、并排几页由阅读页自己算；
   * 窗口不够宽时按内容区宽度收窄，两侧始终留 48px。
   */
  const paneInnerStyle = (panePath: string) => {
    if (!isReader() || panePath !== path()) return undefined;
    const width = Math.min(READER_MAX_WIDTH, Math.max(0, stageWidth() - 96));
    return width > 0 ? { width: `${width}px`, margin: "0 auto" } : undefined;
  };

  return (
    <div class="relative flex min-h-0 flex-1 overflow-hidden">
      <Show when={sidebarShown()}>
        <SideNav collapsed={isSidebarCollapsed()} />
      </Show>
      <div
        ref={stageEl}
        class="relative min-h-0 min-w-0 flex-1 overflow-hidden"
        style={{ background: "var(--bg)" }}
      >
        <For each={allPanes()}>
          {(pane) => (
            <div
              class="absolute inset-0 flex flex-col overflow-hidden"
              style={{ display: pane.id === currentId() ? undefined : "none" }}
            >
              <div class="flex min-h-0 flex-1 flex-col" style={paneInnerStyle(pane.path)}>
                <PageBody
                  component={pane.component}
                  renderChildren={pane.id === currentId()}
                  contentClass={contentClass(pane.path)}
                  onScrollEl={(el) => {
                    scrollById.set(pane.id, el);
                    if (pane.id === targetPaneId) registerAppScrollEl(el);
                  }}
                >
                  {pane.children}
                </PageBody>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

interface SideNavProps {
  /** 收起为图标栏（只留三个主 Tab 的图标，标题行最右端的按钮切换） */
  collapsed: boolean;
}

/** 左侧导航：品牌 + 主 Tab（桌面端没有底部 Tab，主 Tab 只在这里） */
function SideNav(props: SideNavProps) {
  const location = useLocation();
  const isActive = (target: string) => location.pathname === target;

  return (
    <nav
      class="flex flex-none flex-col gap-1 overflow-hidden border-r border-border bg-surface px-3 py-4 transition-[width] duration-200"
      classList={{ "w-[236px]": !props.collapsed, "w-[64px]": props.collapsed }}
    >
      {/* 标题行：展开时品牌靠左、收起 / 展开按钮贴这一行的最右（侧边栏右上角）；
          收起成图标栏后这一行只剩按钮本身，改为与下方主 Tab 图标同轴居中 */}
      <div
        class="mb-3 flex items-center gap-2.5"
        classList={{ "pl-2": !props.collapsed, "justify-center": props.collapsed }}
      >
        <Show when={!props.collapsed}>
          <span class="flex min-w-0 flex-1 items-center gap-2.5">
            <BrandMark />
            <span class="flex min-w-0 flex-col leading-tight">
              <span class="text-[15px] font-bold tracking-[0.01em]">ReaderX</span>
              <span class="text-[10.5px] text-text-3">{t("shell.sidebar.tagline")}</span>
            </span>
          </span>
        </Show>
        <SidebarToggle collapsed={props.collapsed} />
      </div>
      <For each={TAB_ROUTES}>
        {(item) => (
          <A
            href={item.path}
            title={props.collapsed ? t(item.labelKey) : undefined}
            aria-label={props.collapsed ? t(item.labelKey) : undefined}
            class="flex items-center gap-3 rounded-[10px] px-2.5 py-2 text-[13.5px] font-medium transition-colors duration-150"
            classList={{
              "justify-center px-0": props.collapsed,
              "bg-accent-weak text-accent": isActive(item.path),
              "text-text-2 hover:bg-surface-2 hover:text-text": !isActive(item.path),
            }}
          >
            {tabIcon(item.path, 18)}
            <Show when={!props.collapsed}>{t(item.labelKey)}</Show>
          </A>
        )}
      </For>
    </nav>
  );
}

/** 收起 / 展开侧边栏：展开时常驻标题行最右端（品牌右侧）；收起后标题行只剩它一个，
 *  与主 Tab 图标一样居中在图标栏中线上 */
function SidebarToggle(props: SideNavProps) {
  const label = () =>
    props.collapsed ? t("shell.sidebar.expand") : t("shell.sidebar.collapse");
  return (
    <button
      type="button"
      class="grid h-7 w-7 flex-none place-items-center rounded-lg text-text-3 transition-[background-color,color,scale] duration-150 hover:bg-surface-2 hover:text-text active:scale-[0.94]"
      aria-label={label()}
      title={label()}
      onClick={() => setSidebarCollapsed(!props.collapsed)}
    >
      {props.collapsed ? <SidebarExpandIcon size={17} /> : <SidebarCollapseIcon size={17} />}
    </button>
  );
}

/** 侧边栏品牌标记：与手机端图标同色系的几何标记 */
function BrandMark() {
  return (
    <span
      class="grid h-8 w-8 flex-none place-items-center rounded-[9px] text-white"
      style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-deep))" }}
      aria-hidden="true"
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a1.5 1.5 0 0 0-1.5-1.5H4z" />
        <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a1.5 1.5 0 0 1 1.5-1.5H20z" />
      </svg>
    </span>
  );
}

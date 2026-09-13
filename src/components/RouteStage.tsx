/**
 * 页面栈（路由级页面切换动画 + 常驻页面保活）
 * ------------------------------------------------
 * 每次路由变化挂起一层「页面」(pane)，用 CSS transform / opacity 做符合移动端习惯的过渡：
 * - push（进入更深页面，如设置 → 书源、书架 → 阅读页）：旧页同步向左滑出、
 *   新页自右滑入（平行堆叠，顶部标题栏全程都在运动）；
 * - pop（返回，页面返回键 / 系统返回 / 浏览器后退）：上一页自左滑回，
 *   当前页向右滑出，方向是 push 的倒放；
 * - fade（主 Tab 之间切换）：新页先以不透明状态垫在下方并等其正文（含标题栏）
 *   渲染完成，再让旧页整体淡出将其露出。
 * 动画结束后立即卸载离场的瞬态层。
 *
 * 页面分两类：
 * - **常驻页面（保活）**：`kept` 注册表（见 App.tsx 的 `KEPT_PAGES`）里的路径由本组件
 *   按组件直接挂载，首次进入后一直留在 DOM 中，切走只是隐藏（display:none）。
 *   再次进入时复用同一层 —— 页面不会重新挂载，搜索词 / 结果列表 / 抽屉开关 /
 *   滚动位置等页内状态原样保留（书架、发现、设置、WebDAV 导入；从阅读页返回 WebDAV
 *   导入页也走这条路径）。这类路径不需要、也不应该在路由表里再声明 Route。
 * - **瞬态页面**：渲染路由出口内容，被覆盖 / 返回时按旧行为卸载（阅读页、书源、
 *   书籍详情等）。
 *
 * 路由出口（`props.children`）同一时刻只由最上层一层渲染：出口是路由的共享快照，
 * 多层同时渲染会互相抢 DOM。瞬态页面离场时改用「离场快照」（滚动区 DOM 克隆）
 * 参与退出动画，滑出 / 淡出看到的仍是离开时的那一页。
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
  Suspense,
  type Component,
  type JSX,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { useBeforeLeave, useLocation } from "@solidjs/router";
import { ScrollArea } from "./ScrollArea";
import { TabBar } from "./TabBar";
import { LoadingScreen } from "./LoadingScreen";
import { registerAppScrollEl } from "../lib/appScroll";
import { shelfSelectingMode } from "../lib/store";

/* 底部导航的主 Tab 路由；其余均为需「推入 / 弹出」的次级页面 */
const TAB_ROUTES = new Set(["/", "/discover", "/settings"]);
const isTabRoute = (path: string) => TAB_ROUTES.has(path);
const isReaderPath = (path: string) => path.startsWith("/book/");

/**
 * 自管整页高度的页面：内容区不滚动、页面内部再分栏（如书源编辑页的常驻 Tab +
 * JS 编辑器）。这些页面不能带内容区底部留白，否则会多出可滚动的几像素。
 */
const FULL_HEIGHT_ROUTES = new Set(["/source-editor"]);
const isFullHeightPath = (path: string) =>
  isReaderPath(path) || FULL_HEIGHT_ROUTES.has(path);

/* 与阅读器翻页动画同一套缓动曲线 */
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const DUR_SLIDE = 300;
const DUR_FADE = 220;

interface Pane {
  id: number;
  path: string;
  /** 常驻页面组件（保活层），与 children 互斥 */
  component?: Component;
  /** 瞬态页面创建时的路由出口内容 */
  children?: JSX.Element;
}

/** 离场快照：滚动区克隆 + 当时的滚动位置 */
interface FrozenExit {
  node: HTMLElement;
  scrollTop: number;
}

type NavMode = "push" | "pop" | "fade";
/** 新页入场方向：push 自右入、pop 自左回（fade 的新页始终垫底，无需入场姿态） */
type IntroKind = "right" | "left";

export interface RouteStageProps {
  children?: JSX.Element;
  /** 需要保活的常驻页面：路径 → 组件 */
  kept?: Record<string, Component>;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function resetAnimStyle(el: HTMLElement): void {
  el.style.transition = "";
  el.style.transform = "";
  el.style.opacity = "";
  el.style.boxShadow = "";
}

/** 入场姿态：新页在首次挂载（或常驻页被重新激活）时直接摆好位移，避免先闪现一帧静止画面 */
function applyIntroPose(el: HTMLElement, intro: IntroKind): void {
  el.style.transform = intro === "right" ? "translateX(100%)" : "translateX(-100%)";
}

/* Suspense 回退层标记：判定新页面是否已真正挂载（正文与顶部标题栏就位） */
const STAGE_LOADING_ATTR = "data-stage-loading";
const READY_WAIT_CAP = 350; // 等待新页内容挂载的上限（毫秒），超时后照常开始动画

/** 新页面是否已不再显示加载占位（正文已挂载） */
function isPageReady(el: HTMLElement): boolean {
  return !el.querySelector(`[${STAGE_LOADING_ATTR}]`);
}

/** 轮询等待页面正文挂载完成（每帧检查一次，最多 READY_WAIT_CAP 毫秒） */
function waitPageReady(el: HTMLElement, onReady: () => void): void {
  const t0 = performance.now();
  const tick = () => {
    if (!el.isConnected || performance.now() - t0 > READY_WAIT_CAP || isPageReady(el)) {
      onReady();
      return;
    }
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}

export function RouteStage(props: RouteStageProps) {
  const location = useLocation();
  const path = createMemo(() => location.pathname);

  let paneSeq = 0;
  const initialPath = location.pathname;
  const initialKept = props.kept?.[initialPath];
  const initialPane: Pane = initialKept
    ? { id: paneSeq++, path: initialPath, component: initialKept }
    : { id: paneSeq++, path: initialPath, children: props.children };

  // 常驻层（保活）与瞬态层分开存放：常驻层只增不减，瞬态层随导航建立 / 卸载
  const [keptPanes, setKeptPanes] = createSignal<Pane[]>(
    initialKept ? [initialPane] : [],
  );
  const [transientPanes, setTransientPanes] = createSignal<Pane[]>(
    initialKept ? [] : [initialPane],
  );
  const [currentId, setCurrentId] = createSignal(initialPane.id);
  const [outgoingId, setOutgoingId] = createSignal<number | undefined>(undefined);
  /** 过渡中旧页是否压在新页上方（fade 需要，滑动过渡不重叠、无需置顶） */
  const [outgoingOnTop, setOutgoingOnTop] = createSignal(false);
  /** 正在离场的瞬态层快照（贴在 outgoingId 那一层上做退出动画） */
  const [frozenExit, setFrozenExit] = createSignal<FrozenExit | undefined>(undefined);
  const [busy, setBusy] = createSignal(false);

  const allPanes = createMemo(() => [...keptPanes(), ...transientPanes()]);
  const paneById = (id: number) => allPanes().find((pane) => pane.id === id);
  const isVisiblePane = (id: number) =>
    id === currentId() || id === outgoingId();

  const elById = new Map<number, HTMLDivElement>();
  const scrollById = new Map<number, HTMLDivElement>();
  // 入场姿态：新层在首次挂载时直接以「平移 / 透明」出生，避免先以静止态闪现一帧再跳回起点。
  const introById = new Map<number, IntroKind>();
  const reducedMotion = prefersReducedMotion();

  let targetPaneId = initialPane.id; // 最近一次导航的目标层（其滚动容器注册给 appScrollEl）
  let removeTimer: number | undefined;
  /** 下一次导航要冻结的离场快照（在路由提交前抓取，此时 DOM 仍是离开的那一页） */
  let pendingExit: { paneId: number; exit: FrozenExit } | undefined;

  // 访问过的页面栈（去重相邻重复），用于判断当前跳转是否为「返回」：
  // 不依赖 popstate 时序，直接比较新路径与栈顶前一项是否一致。
  const navStack = [initialPath];

  onMount(() => {
    onCleanup(() => {
      if (removeTimer !== undefined) window.clearTimeout(removeTimer);
      elById.clear();
      scrollById.clear();
      introById.clear();
    });
  });

  /**
   * 路由提交前抓一份顶层页面的离场快照。
   * 常驻层自己就是内容的持有者（不经过路由出口），切走时 DOM 原样留着，无需快照；
   * 瞬态层的内容来自路由出口，路由一变就会被换掉，因此提前克隆滚动区留给退出动画。
   */
  useBeforeLeave(() => {
    const id = currentId();
    const pane = paneById(id);
    if (!pane || pane.component) return;
    const scrollEl = scrollById.get(id);
    if (!scrollEl) return;
    const node = scrollEl.cloneNode(true) as HTMLElement;
    pendingExit = { paneId: id, exit: { node, scrollTop: scrollEl.scrollTop } };
  });

  /** 让 appScrollEl 指向当前最上层页面的滚动容器 */
  function registerTopScroll(): void {
    const el = scrollById.get(currentId());
    if (el) registerAppScrollEl(el);
  }

  // 清理已被卸载层级的 DOM/滚动记录，避免长期导航后 Map 无限增长
  function sweepMaps(): void {
    const alive = new Set(allPanes().map((pane) => pane.id));
    for (const id of [...elById.keys()]) {
      if (!alive.has(id)) {
        elById.delete(id);
        scrollById.delete(id);
        introById.delete(id);
      }
    }
  }

  function dropTransient(id: number): void {
    setTransientPanes((list) => list.filter((pane) => pane.id !== id));
  }

  /** 过渡收尾：卸载离场的瞬态层、复位常驻层样式并隐藏、清场 */
  function finishTransition(stayId: number): void {
    const outId = outgoingId();
    setOutgoingId(undefined);
    setOutgoingOnTop(false);
    setFrozenExit(undefined);
    if (outId !== undefined && outId !== stayId) {
      const outPane = paneById(outId);
      if (outPane && !outPane.component) {
        dropTransient(outId);
      } else {
        const outEl = elById.get(outId);
        if (outEl) resetAnimStyle(outEl); // 常驻层：回位，下次进入重新摆姿态
      }
    }
    const stayEl = elById.get(stayId);
    if (stayEl) resetAnimStyle(stayEl);
    introById.delete(stayId);
    sweepMaps();
    setBusy(false);
    registerTopScroll();
  }

  // 路由变化驱动页面栈推进
  createEffect(
    on(path, (nextPath, prevPath) => {
      if (prevPath === undefined || nextPath === prevPath) return;
      go(nextPath, prevPath);
    }),
  );

  function go(nextPath: string, prevPath: string): void {
    const prevIsTab = isTabRoute(prevPath);
    const nextIsTab = isTabRoute(nextPath);

    // 「返回」判定：新路径是页面栈里当前页的前一项（浏览器后退 / navigate(-1) 等）
    const back = navStack.length > 1 && navStack[navStack.length - 2] === nextPath;
    if (back) navStack.pop();
    else if (navStack[navStack.length - 1] !== nextPath) navStack.push(nextPath);

    // Tab ↔ Tab 之间统一淡入淡出；其余进入用平行滑动，返回用其倒放
    const mode: NavMode =
      prevIsTab && nextIsTab
        ? "fade"
        : back
          ? "pop"
          : nextIsTab
            ? "fade" // 非返回地跳到主 Tab（如「返回书架」兜底）：柔和淡入即可
            : "push";

    if (removeTimer !== undefined) {
      window.clearTimeout(removeTimer);
      removeTimer = undefined;
    }

    const prevId = currentId();
    const prevPane = paneById(prevId);

    // 上一次过渡被打断：它正在滑出的瞬态层已经不需要了，直接卸载
    const staleOutId = outgoingId();
    if (staleOutId !== undefined) {
      setOutgoingId(undefined);
      const stale = paneById(staleOutId);
      if (stale && !stale.component) dropTransient(staleOutId);
    }

    // 目标层：常驻页面复用既有层（保活），瞬态页面新建一层
    const keptComponent = props.kept?.[nextPath];
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

    // 离场的瞬态层内容会随路由换掉：贴上离场快照做退出动画
    const exitSnapshot =
      prevPane && prevPane.id !== pane.id && !prevPane.component &&
      pendingExit?.paneId === prevPane.id
        ? pendingExit.exit
        : undefined;
    pendingExit = undefined;
    setFrozenExit(exitSnapshot);

    setCurrentId(pane.id);
    setOutgoingId(prevPane && prevPane.id !== pane.id ? prevId : undefined);
    setOutgoingOnTop(mode === "fade");
    targetPaneId = pane.id;

    const prevEl = prevPane ? elById.get(prevPane.id) : undefined;
    // 上一页可能正处于上一次过渡中：先回位成静止态，再作为滑出 / 垫底层
    if (prevEl) resetAnimStyle(prevEl);

    // 系统偏好“减少动态效果”时不做过渡，直接整体切换
    if (reducedMotion || prevId === pane.id) {
      finishTransition(pane.id);
      return;
    }

    // 入场姿态：push 自右、pop 自左。
    // fade 的新页不需要入场姿态——它始终以不透明态垫在旧页下方，
    // 由「旧页淡出」把完整的新页（含顶部标题栏）逐渐露出来。
    const intro: IntroKind | undefined =
      mode === "push" ? "right" : mode === "pop" ? "left" : undefined;
    if (intro) {
      const inEl = elById.get(pane.id);
      if (inEl) {
        // 复用的常驻层已经在 DOM 里：同步摆好姿态（此刻尚未绘制，不会闪现）
        resetAnimStyle(inEl);
        applyIntroPose(inEl, intro);
      } else {
        introById.set(pane.id, intro); // 新层在 ref 挂载时以入场姿态出生
      }
    }

    const navToken = pane.id;
    setBusy(true);

    // 等一帧让新层完成挂载（ref / 入场姿态已写入），再等待正文真正渲染出来。
    window.requestAnimationFrame(() => {
      if (targetPaneId !== navToken) return; // 已被更新的导航接管
      const inEl = elById.get(pane.id);
      if (!inEl) return; // 尚未挂载（如被后续导航接管），交由新导航处理

      // 关键：必须等 Suspense 加载占位被正文替换后再开始过渡。
      // 否则淡入/滑动的只有旧页与空白，新页标题栏会在动画结束后才突然出现。
      waitPageReady(inEl, () => {
        if (targetPaneId !== navToken) return;
        // 再等两帧：保证新页（含标题栏）已真正完成绘制后再开始过渡
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            if (targetPaneId !== navToken) return;
            const cur = elById.get(pane.id);
            const out = prevEl;
            if (!cur) return;

            const finish = () => {
              const ms = mode === "fade" ? DUR_FADE : DUR_SLIDE;
              removeTimer = window.setTimeout(() => {
                removeTimer = undefined;
                if (targetPaneId !== navToken) return;
                finishTransition(pane.id);
              }, ms + 60);
            };

            // fade：新页保持不透明垫底，旧页在其上淡出 → 整页（含标题栏）随之显隐
            if (mode === "fade") {
              if (!out) {
                finishTransition(pane.id);
                return;
              }
              void cur.getBoundingClientRect();
              void out.getBoundingClientRect();
              out.style.transition = `opacity ${DUR_FADE}ms ease`;
              out.style.opacity = "0";
              finish();
              return;
            }

            if (!out) {
              finishTransition(pane.id);
              return;
            }

            // 平行堆叠滑动：旧页与新页以同一速度反向平移，形成无缝的“推拉”效果
            void cur.getBoundingClientRect();
            void out.getBoundingClientRect();
            cur.style.transition = `transform ${DUR_SLIDE}ms ${EASE}`;
            cur.style.transform = "";
            out.style.transition = `transform ${DUR_SLIDE}ms ${EASE}`;
            if (mode === "push") {
              out.style.transform = "translateX(-100%)";
            } else {
              out.style.boxShadow = "-14px 0 26px rgb(0 0 0 / 0.14)";
              out.style.transform = "translateX(100%)";
            }
            finish();
          });
        });
      });
    });
  }

  return (
    <div class="relative min-h-0 flex-1 overflow-hidden">
      <For each={allPanes()}>
        {(pane) => (
          <div
            ref={(el) => {
              elById.set(pane.id, el);
              // 入场姿态在首次挂载时直接写入，避免页面先闪现静止帧
              const intro = introById.get(pane.id);
              if (intro) applyIntroPose(el, intro);
            }}
            class="absolute inset-0 flex flex-col overflow-hidden bg-bg"
            style={{
              // 保活层切走后只是隐藏，DOM 与页内状态都留着
              display: isVisiblePane(pane.id) ? undefined : "none",
              "z-index": outgoingOnTop() && pane.id === outgoingId() ? 2 : undefined,
            }}
          >
            <ScrollArea
              class="min-h-0 flex-1"
              contentClass={isFullHeightPath(pane.path) ? "" : "pb-4"}
              onEl={(el) => {
                scrollById.set(pane.id, el);
                if (pane.id === targetPaneId) registerAppScrollEl(el);
              }}
            >
              <Suspense
                fallback={
                  <div class="h-full" data-stage-loading="true">
                    <LoadingScreen label="页面加载中…" />
                  </div>
                }
              >
                {/* 常驻层渲染注册表里的页面组件 */}
                <Show when={pane.component}>
                  {(component) => <Dynamic component={component()} />}
                </Show>
                {/* 瞬态层渲染路由出口，且只由当前层渲染：出口是路由的共享快照，
                    离场中的旧层若一起渲染会把新页面的 DOM 抢走 */}
                <Show when={!pane.component && pane.id === currentId()}>
                  {pane.children}
                </Show>
              </Suspense>
            </ScrollArea>
            <Show
              when={
                isTabRoute(pane.path) &&
                !(pane.path === "/" && shelfSelectingMode())
              }
            >
              <TabBar />
            </Show>
            {/* 离场快照：接管旧页画面，直到这一层被卸载 */}
            <Show
              when={pane.id === outgoingId() ? frozenExit() : undefined}
            >
              {(frozen) => (
                <div
                  class="absolute inset-0 z-20 flex flex-col bg-bg"
                  ref={(el) => {
                    el.append(frozen().node);
                    frozen().node.scrollTop = frozen().scrollTop;
                  }}
                />
              )}
            </Show>
          </div>
        )}
      </For>
      {/* 过渡期间吞掉一切指针事件，避免误触滑动中的页面 */}
      <Show when={busy()}>
        <div class="absolute inset-0 z-50" aria-hidden="true" />
      </Show>
    </div>
  );
}

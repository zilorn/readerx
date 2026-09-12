/**
 * 页面栈（路由级页面切换动画）
 * ------------------------------------------------
 * 把「内容滚动区 + 底部 Tab」从 AppShell 收进这里：每次路由变化挂起一层
 * 「页面」(pane)，用 CSS transform / opacity 做符合移动端习惯的过渡：
 * - push（进入更深页面，如设置 → 书源、书架 → 阅读页）：旧页同步向左滑出、
 *   新页自右滑入（平行堆叠，顶部标题栏全程都在运动）；
 * - pop（返回，页面返回键 / 系统返回 / 浏览器后退）：上一页自左滑回，
 *   当前页向右滑出，方向是 push 的倒放；
 * - fade（书架 / 发现 / 设置三个主 Tab 之间切换）：新页先以不透明状态垫在
 *   下方并等其正文（含标题栏）渲染完成，再让旧页整体淡出将其露出——整页
 *   （标题栏在内）一起过渡，不会出现「动画结束后标题栏才突然切换」。
 * 同一时刻最多保留两层，动画结束后立即卸载被盖住 / 已离场的旧层。
 *
 * 各 pane 自带独立滚动容器（ScrollArea），因此弹层/阅读页等原先依赖外层
 * 滚动容器的行为不变；「顶层页面」的滚动容器会注册给 appScrollEl，供页面
 * （如 WebDAV 导入页）保存 / 恢复滚动位置。此动画不涉及阅读器内部翻页动画。
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
  type JSX,
} from "solid-js";
import { useLocation } from "@solidjs/router";
import { ScrollArea } from "./ScrollArea";
import { TabBar } from "./TabBar";
import { LoadingScreen } from "./LoadingScreen";
import { registerAppScrollEl } from "../lib/appScroll";
import { shelfSelectingMode } from "../lib/store";

/* 底部导航的三个主 Tab 路由；其余均为需「推入 / 弹出」的次级页面 */
const TAB_ROUTES = new Set(["/", "/discover", "/settings"]);
const isTabRoute = (path: string) => TAB_ROUTES.has(path);
const isReaderPath = (path: string) => path.startsWith("/book/");

/**
 * 自管整页高度的页面：内容区不滚动、页面内部再分栏（如书源编辑页的常驻 Tab +
 * JS 编辑器）。这些页面不能带内容区底部留白，否则会多出可滚动的几像素。
 */
const FULL_HEIGHT_ROUTES = new Set(["/source-editor"]);
const isFullHeightPath = (path: string) => isReaderPath(path) || FULL_HEIGHT_ROUTES.has(path);

/* 与阅读器翻页动画同一套缓动曲线 */
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const DUR_SLIDE = 300;
const DUR_FADE = 220;

interface Pane {
  id: number;
  path: string;
  children: JSX.Element;
}

type NavMode = "push" | "pop" | "fade";
/** 新页入场方向：push 自右入、pop 自左回（fade 的新页始终垫底，无需入场姿态） */
type IntroKind = "right" | "left";

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
    if (
      !el.isConnected ||
      performance.now() - t0 > READY_WAIT_CAP ||
      isPageReady(el)
    ) {
      onReady();
      return;
    }
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}

export function RouteStage(props: { children?: JSX.Element }) {
  const location = useLocation();
  const path = createMemo(() => location.pathname);

  // 首层页面以挂载时刻的路由内容为快照，之后的切换由下方 go() 推进。
  let paneSeq = 0;
  const initialPath = location.pathname;
  const [frames, setFrames] = createSignal<Pane[]>([
    { id: paneSeq++, path: initialPath, children: props.children },
  ]);
  const [busy, setBusy] = createSignal(false);

  const elById = new Map<number, HTMLDivElement>();
  const scrollById = new Map<number, HTMLDivElement>();
  // 入场姿态：新页面在首次挂载时直接以「平移 / 透明」出生，
  // 避免先以静止态闪现一帧再跳回起点。
  const introById = new Map<number, IntroKind>();
  const reducedMotion = prefersReducedMotion();

  let targetPaneId = 0; // 最近一次导航的目标 pane（其滚动容器注册给 appScrollEl）
  let removeTimer: number | undefined;

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

  /** 让 appScrollEl 指向当前最上层页面的滚动容器 */
  function registerTopScroll(): void {
    const list = frames();
    const top = list[list.length - 1];
    const el = top ? scrollById.get(top.id) : undefined;
    if (el) registerAppScrollEl(el);
  }

  // 清理已被裁掉层级的 DOM/滚动记录，避免长期导航后 Map 无限增长
  function sweepMaps(): void {
    const alive = new Set(frames().map((p) => p.id));
    for (const id of [...elById.keys()]) {
      if (!alive.has(id)) {
        elById.delete(id);
        scrollById.delete(id);
        introById.delete(id);
      }
    }
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
    const back =
      navStack.length > 1 && navStack[navStack.length - 2] === nextPath;
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

    // 新页快照当前路由内容（effect 阶段读 props.children 即最新匹配页）
    const pane: Pane = {
      id: paneSeq++,
      path: nextPath,
      children: props.children,
    };
    const navToken = pane.id;
    targetPaneId = pane.id;

    if (removeTimer !== undefined) {
      window.clearTimeout(removeTimer);
      removeTimer = undefined;
    }

    const prevList = frames();
    const oldPane = prevList[prevList.length - 1];
    const oldEl = oldPane ? elById.get(oldPane.id) : undefined;
    // 上一页可能正处于上一次过渡中：先回位成静止态，再作为滑出 / 垫底层
    if (oldEl) resetAnimStyle(oldEl);

    // 系统偏好“减少动态效果”时不做过渡，直接整体替换当前页
    if (reducedMotion) {
      setFrames([pane]);
      sweepMaps();
      setBusy(false);
      return;
    }

    // 新页以入场姿态出生（ref 挂载时应用）：push 自右、pop 自左。
    // fade 的新页不需要入场姿态——它始终以不透明态垫在旧页下方，
    // 由「旧页淡出」把完整的新页（含顶部标题栏）逐渐露出来。
    if (mode === "push") introById.set(pane.id, "right");
    else if (mode === "pop") introById.set(pane.id, "left");

    setFrames((list) => {
      const top = list[list.length - 1];
      // DOM 顺序即堆叠顺序：pop / fade 让旧页在上（滑出/淡出），push 让新页在上（右滑入）
      return mode === "pop" || mode === "fade" ? [pane, top] : [top, pane];
    });
    sweepMaps();

    const dropOld = () => {
      setFrames((list) => list.filter((p) => p.id === pane.id));
      const stay = elById.get(pane.id);
      if (stay) resetAnimStyle(stay);
      if (oldPane) {
        elById.delete(oldPane.id);
        scrollById.delete(oldPane.id);
        introById.delete(oldPane.id);
      }
      introById.delete(pane.id);
      setBusy(false);
      registerTopScroll();
    };

    const finish = () => {
      const ms = mode === "fade" ? DUR_FADE : DUR_SLIDE;
      removeTimer = window.setTimeout(() => {
        removeTimer = undefined;
        dropOld();
      }, ms + 60);
    };

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
            const out = oldPane ? elById.get(oldPane.id) : undefined;
            if (!cur || !out) return;

            // fade：新页保持不透明垫底，旧页在其上淡出 → 整页（含标题栏）随之显隐
            if (mode === "fade") {
              void cur.getBoundingClientRect();
              void out.getBoundingClientRect();
              out.style.transition = `opacity ${DUR_FADE}ms ease`;
              out.style.opacity = "0";
              finish();
              return;
            }

            // 平行堆叠滑动：旧页与新页以同一速度反向平移，形成无缝的“推拉”效果
            void cur.getBoundingClientRect();
            void out.getBoundingClientRect();
            if (mode === "push") {
              cur.style.transition = `transform ${DUR_SLIDE}ms ${EASE}`;
              cur.style.transform = "";
              out.style.transition = `transform ${DUR_SLIDE}ms ${EASE}`;
              out.style.transform = "translateX(-100%)";
            } else {
              cur.style.transition = `transform ${DUR_SLIDE}ms ${EASE}`;
              cur.style.transform = "";
              out.style.transition = `transform ${DUR_SLIDE}ms ${EASE}`;
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
      <For each={frames()}>
        {(pane) => (
          <div
            ref={(el) => {
              elById.set(pane.id, el);
              // 入场姿态在首次挂载时直接写入，避免页面先闪现静止帧
              const intro = introById.get(pane.id);
              if (intro === "right") el.style.transform = "translateX(100%)";
              else if (intro === "left") el.style.transform = "translateX(-100%)";
            }}
            class="absolute inset-0 flex flex-col overflow-hidden bg-bg"
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
                {pane.children}
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

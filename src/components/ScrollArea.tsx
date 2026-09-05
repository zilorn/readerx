/**
 * 移动端右侧自定义滚动条（非原生，仅考虑移动端交互）：
 * - 列表可纵向滚动时，右侧显示一条 iOS 风格细滚动条；
 * - 内容放得下时完全不显示；触摸/滚轮滚动时浮现，静止 ~1s 后自动隐藏；
 * - 在滚动条上按住并拖动即快速定位（手指按住轨道即按位置跳转、继续拖动微调）；
 * - 按住 / 拖动过程中拇指会放大加宽，便于看清当前进度，松手后恢复并淡出。
 *
 * 用法（替代原先单层 “定位类 + overflow-y-auto” 写法）：
 *   <ScrollArea class="min-h-0 flex-1" contentClass="px-4 pb-4">
 *     …内容…
 *   </ScrollArea>
 * - class：外层盒子的布局类（原滚动元素上的 min-h-0 flex-1 等）；
 * - contentClass：原本加在滚动元素上的内边距类（px/py/pb 等）；
 * - onEl：父级若要拿真正滚动元素（scrollIntoView / 注册滚动容器等）在此回调。
 */
import { createSignal, onCleanup, onMount, type JSX } from "solid-js";

export interface ScrollAreaProps {
  /** 外层盒子的布局类（原滚动元素上的定位/弹性类） */
  class?: string;
  /** 内层滚动区域的附加类（padding 等，overflow / scrollbar 由组件统一管理）；支持函数以便响应式 */
  contentClass?: string | (() => string);
  /** 需要时把内层滚动元素回传给父级（scrollIntoView / 注册滚动容器等） */
  onEl?: (el: HTMLDivElement) => void;
  children?: JSX.Element;
}

const HIDE_DELAY = 1000; // 静止多久后淡出
const THUMB_MIN = 36; // 拇指最小高度，保证手指可抓
const RAIL_HIT = 20; // 右侧触摸命中宽度（拖动时拇指会放大）
const THUMB_IDLE = 5; // 平时拇指宽度
const THUMB_ACTIVE = 13; // 按住/拖动时拇指宽度（放大反馈）
const THUMB_PAD = 4; // 轨道上下留白

export function ScrollArea(props: ScrollAreaProps) {
  let innerEl: HTMLDivElement | undefined;
  let railEl: HTMLDivElement | undefined;
  let thumbEl: HTMLDivElement | undefined;

  const [shown, setShown] = createSignal(false);
  const [canScroll, setCanScroll] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);

  let hideTimer: number | undefined;
  let rafId = 0;
  let ro: ResizeObserver | undefined;
  let measureTimer: number | undefined;
  let thumbH = THUMB_MIN;

  function clearHide(): void {
    if (hideTimer !== undefined) {
      window.clearTimeout(hideTimer);
      hideTimer = undefined;
    }
  }

  function scheduleHide(delay = HIDE_DELAY): void {
    clearHide();
    hideTimer = window.setTimeout(() => {
      hideTimer = undefined;
      if (!dragging()) setShown(false);
    }, delay);
  }

  /** 浮现并重置隐藏计时（滚动 / 触摸轨道时调用） */
  function reveal(): void {
    setShown(true);
    scheduleHide();
    queueMeasure();
  }

  function measure(): void {
    if (!innerEl || !railEl || !thumbEl) return;
    const sh = innerEl.scrollHeight;
    const ch = innerEl.clientHeight;
    const over = sh > ch + 2;
    if (over !== canScroll()) setCanScroll(over);
    if (!over) {
      thumbH = THUMB_MIN;
      if (shown()) setShown(false);
      return;
    }
    const railH = railEl.clientHeight;
    thumbH = Math.min(
      railH - THUMB_PAD * 2,
      Math.max(THUMB_MIN, Math.round((ch * ch) / sh)),
    );
    const maxScroll = sh - ch;
    const travel = Math.max(1, railH - THUMB_PAD * 2 - thumbH);
    const top =
      THUMB_PAD + (maxScroll > 0 ? (innerEl.scrollTop / maxScroll) * travel : 0);
    thumbEl.style.height = `${thumbH}px`;
    thumbEl.style.top = `${Math.round(top)}px`;
  }

  function queueMeasure(): void {
    if (rafId) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = 0;
      measure();
    });
  }

  function onInnerScroll(): void {
    queueMeasure();
    if (!dragging()) reveal();
  }

  /** 按 y 计算滚动位置：拇指中心对齐触点 */
  function applyPointerY(clientY: number): void {
    if (!innerEl || !railEl) return;
    const rect = railEl.getBoundingClientRect();
    const railH = rect.height;
    const travel = Math.max(1, railH - THUMB_PAD * 2 - thumbH);
    const frac = clampFrac((clientY - rect.top - THUMB_PAD - thumbH / 2) / travel);
    innerEl.scrollTop = frac * (innerEl.scrollHeight - innerEl.clientHeight);
  }

  function railPointerDown(e: PointerEvent): void {
    if (!innerEl || !railEl || !canScroll()) return;
    e.preventDefault(); // 阻止触摸时触发原生滚动 / 文本选择
    setDragging(true);
    setShown(true);
    clearHide();
    railEl.setPointerCapture?.(e.pointerId);
    applyPointerY(e.clientY);
  }

  function railPointerMove(e: PointerEvent): void {
    if (!dragging() || !innerEl) return;
    applyPointerY(e.clientY);
  }

  function railPointerUp(): void {
    if (!dragging()) return;
    setDragging(false);
    scheduleHide(400);
  }

  function railWheel(e: WheelEvent): void {
    if (!innerEl) return;
    innerEl.scrollTop += e.deltaY;
    e.preventDefault();
  }

  function clampFrac(v: number): number {
    return v <= 0 ? 0 : v >= 1 ? 1 : v;
  }

  onMount(() => {
    if (!innerEl) return;
    innerEl.addEventListener("scroll", onInnerScroll, { passive: true });
    ro = new ResizeObserver(() => queueMeasure());
    ro.observe(innerEl);
    measure();
    // 内容（scrollHeight）变化时拇指长度/位置需要重算：外层盒子尺寸由
    // ResizeObserver 覆盖，内容高度变化仅在显示期间轮询补足，避免常驻开销。
    measureTimer = window.setInterval(() => {
      if (shown()) measure();
    }, 200);
  });

  onCleanup(() => {
    innerEl?.removeEventListener("scroll", onInnerScroll);
    ro?.disconnect();
    clearHide();
    if (rafId) window.cancelAnimationFrame(rafId);
    if (measureTimer !== undefined) window.clearInterval(measureTimer);
  });

  const innerClass = () =>
    `min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain scrollbar-none ${
      typeof props.contentClass === "function"
        ? props.contentClass()
        : (props.contentClass ?? "")
    }`;

  const thumbWidth = () => (dragging() ? THUMB_ACTIVE : THUMB_IDLE);

  return (
    <div class={`relative flex min-w-0 flex-col ${props.class ?? ""}`}>
      <div
        ref={(el) => {
          innerEl = el;
          props.onEl?.(el);
        }}
        class={innerClass()}
      >
        {props.children}
      </div>
      <div
        ref={railEl}
        aria-hidden="true"
        class={`absolute bottom-0 right-0 top-0 select-none transition-opacity duration-200 ${
          shown() && canScroll() ? "opacity-100" : "opacity-0"
        }`}
        style={{
          width: `${RAIL_HIT}px`,
          // 隐藏时（透明）不接管指针：触摸/滚动都落在内容上；
          // 浮现后才可拖（touch-action none 阻止手指拖动拇指时原生滚动内容）。
          "pointer-events":
            shown() && canScroll() ? "auto" : "none",
          "touch-action": shown() && canScroll() ? "none" : "auto",
          "z-index": 30,
        }}
        onPointerDown={railPointerDown}
        onPointerMove={railPointerMove}
        onPointerUp={railPointerUp}
        onPointerCancel={railPointerUp}
        onWheel={railWheel}
      >
        <div
          ref={thumbEl}
          class="absolute top-0 rounded-full"
          style={{
            left: "50%",
            height: `${thumbH}px`,
            width: `${thumbWidth()}px`,
            transform: "translateX(-50%)",
            background: dragging() ? "var(--accent)" : "var(--text-2)",
            opacity: dragging() ? 1 : 0.55,
            transition:
              "width 120ms ease, opacity 120ms ease, background-color 120ms ease",
          }}
        />
      </div>
    </div>
  );
}

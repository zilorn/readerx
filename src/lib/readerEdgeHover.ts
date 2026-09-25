/**
 * 桌面端「贴边呼出」阅读控件：鼠标移到阅读区边缘即显示隐藏的菜单。
 *
 * 桌面窗口里阅读页占满整屏（宽窗口下正文列居中留白），顶栏 / 底栏平时收起、把正文留给读者，
 * 于是需要一条不用点按的呼出路径（鼠标操作不必先「呼出菜单再点按钮」）：
 * - **上 / 下边缘** → 顶部栏 + 底部栏一起弹出（隐藏的菜单整块出现，不做半截显示）；
 * - **右边缘** → 目录侧栏滑出，不改动顶 / 底栏的显隐。
 *
 * 热区跟着**阅读区（app 列）自己的边缘**走，而不是窗口边缘：顶 / 底栏与目录侧栏都贴着这块区域
 * 排布，热区与它们同一条边才对得上（窗口比阅读列宽时，把热区放到窗口边缘会出现「鼠标在窗口
 * 边缘、面板却从几百像素外的列边上滑出」的错位）。
 *
 * 判定只用指针坐标与浮层矩形，不铺任何遮罩元素，因此不会吞掉正文的点击与翻页。
 *
 * 自动收起只针对**悬浮呼出**的那一次（`armed()`）：用户点按呼出的菜单 / 目录仍按原先的点按
 * 方式关闭，这里不插手。鼠标离开边缘、也没停在顶栏 / 底栏 / 目录面板上时延时一小会儿再收
 * （划过去不至于一闪而过）；按住鼠标拖动（拖选正文、拖进度条）期间一律不收 —— 拖到一半菜单
 * 消失会把操作打断。
 */
import { onCleanup, onMount } from "solid-js";

/** 边缘热区厚度（px）：指针进到离边缘这么近的地方即触发 */
export const EDGE_HOT_PX = 8;

/** 悬浮呼出后，指针离开边缘与浮层多久自动收起（ms） */
export const EDGE_HIDE_DELAY_MS = 400;

/** 指针所在的边缘热区 */
export type EdgeZone = "menu" | "toc";

/** 热区判定只需阅读区矩形的这几条边（DOMRect 直接可用） */
export interface EdgeBounds {
  top: number;
  right: number;
  bottom: number;
}

/**
 * 指针坐标 → 命中的边缘热区：上 / 下边缘归顶底栏，右边缘归目录。
 * 上下边缘的条带横贯整个阅读区宽度（四角按上下边缘算），两条热区因此不会互相抢；
 * 右边缘取的是边缘两侧各 `EDGE_HOT_PX` 的窄带 —— 从留白一侧靠近同样算贴边。
 */
export function edgeZoneAt(
  x: number,
  y: number,
  frame: EdgeBounds,
): EdgeZone | null {
  if (y <= frame.top + EDGE_HOT_PX || y >= frame.bottom - EDGE_HOT_PX) return "menu";
  if (Math.abs(x - frame.right) <= EDGE_HOT_PX) return "toc";
  return null;
}

export interface EdgeHoverRevealOptions {
  /** 是否参与贴边呼出（桌面外壳为真；手机端恒假，移动端不受影响） */
  enabled: () => boolean;
  /** 阅读区元素（app 列）：热区贴着它的边缘判 */
  frameEl: () => HTMLElement | null | undefined;
  /** 指针贴上 / 下边缘：呼出隐藏的顶栏 + 底栏 */
  onMenuEdge: () => void;
  /** 指针贴右边缘：呼出目录 */
  onTocEdge: () => void;
  /** 悬浮呼出的控件该收起了 */
  onHide: () => void;
  /** 当前是否有「悬浮呼出」尚未收起（为假时本模块只负责呼出，不管收起） */
  armed: () => boolean;
  /** 指针落在这些浮层里视作仍在使用（顶栏 / 底栏 / 目录面板） */
  keepAliveEls: () => (HTMLElement | null | undefined)[];
}

/**
 * 挂上贴边呼出的指针监听（组件 `onCleanup` 时自动摘掉）。
 * 只在组件体内调用一次；`enabled()` 为假时连判定都不做。
 */
export function createEdgeHoverReveal(opts: EdgeHoverRevealOptions): void {
  let hideTimer: number | undefined;
  /** 最近一次指针位置；指针移出窗口后置为 NaN（此时视作不在任何浮层上） */
  let pointerX = Number.NaN;
  let pointerY = Number.NaN;

  /**
   * 指针是否落在已滑出的浮层上。收起状态的顶栏 / 底栏被 transform 移出视口，
   * 矩形判定自然为假，不必区分「显示中」与「已收起」。
   */
  function pointerInKeepAlive(): boolean {
    if (Number.isNaN(pointerX) || Number.isNaN(pointerY)) return false;
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const el of opts.keepAliveEls()) {
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      // 完全移出视口的浮层不算（已收起的顶 / 底栏就是这种情形）
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= h || rect.left >= w) continue;
      if (
        pointerX >= rect.left &&
        pointerX <= rect.right &&
        pointerY >= rect.top &&
        pointerY <= rect.bottom
      ) {
        return true;
      }
    }
    return false;
  }

  function cancelHide(): void {
    if (hideTimer === undefined) return;
    window.clearTimeout(hideTimer);
    hideTimer = undefined;
  }

  function scheduleHide(): void {
    if (!opts.armed() || hideTimer !== undefined) return;
    hideTimer = window.setTimeout(() => {
      hideTimer = undefined;
      if (!opts.armed() || pointerInKeepAlive()) return;
      opts.onHide();
    }, EDGE_HIDE_DELAY_MS);
  }

  function onPointerMove(event: PointerEvent): void {
    // 触屏 / 手写笔不参与：贴边呼出是鼠标操作方式，手机端保持原样
    if (!opts.enabled() || event.pointerType === "touch" || event.pointerType === "pen")
      return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    // 按住鼠标拖动（拖选正文、拖进度条）期间不收：中途收起会把操作打断
    if (event.buttons !== 0) {
      cancelHide();
      return;
    }
    const frame = opts.frameEl()?.getBoundingClientRect();
    if (!frame || frame.width <= 0 || frame.height <= 0) {
      scheduleHide();
      return;
    }
    const zone = edgeZoneAt(pointerX, pointerY, frame);
    if (zone === "toc") {
      cancelHide();
      opts.onTocEdge();
      return;
    }
    if (zone === "menu") {
      cancelHide();
      opts.onMenuEdge();
      return;
    }
    // 没有「悬浮呼出」的控件要收时，后面的浮层矩形判定都不必做
    if (!opts.armed()) return;
    if (pointerInKeepAlive()) {
      cancelHide();
      return;
    }
    scheduleHide();
  }

  /** 指针离开窗口（切到别的窗口 / 移到另一块屏）：当作离开了边缘与浮层 */
  function onPointerGone(): void {
    pointerX = Number.NaN;
    pointerY = Number.NaN;
    scheduleHide();
  }

  /** pointerleave 的兜底：pointerout 的 relatedTarget 为空同样表示指针已经出了窗口 */
  function onPointerOut(event: PointerEvent): void {
    if (event.relatedTarget) return;
    onPointerGone();
  }

  onMount(() => {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerleave", onPointerGone);
    document.addEventListener("pointerout", onPointerOut);
    window.addEventListener("blur", onPointerGone);
    onCleanup(() => {
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", onPointerGone);
      document.removeEventListener("pointerout", onPointerOut);
      window.removeEventListener("blur", onPointerGone);
      cancelHide();
    });
  });
}

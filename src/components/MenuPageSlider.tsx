/**
 * 阅读菜单章节页进度条（左右翻页模式使用）：
 * 悬浮在阅读菜单底部按钮上方，是一个大圆角框（槽）+ 内部滑动的圆球；
 * 点按 / 拖动框内任意位置跳转到本章任意一页，拖动中在进度条上方实时
 * 显示「x/y页」提示，松手后才真正翻页。
 */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

export interface MenuPageSliderProps {
  /** 当前页（0 起） */
  page: number;
  /** 本章总页数 */
  total: number;
  /** 拖动结束后跳转到目标页（0 起；调用方自行与当前页比较 / 去抖） */
  onCommit: (page: number) => void;
  /** 是否显示逐页等分刻度（灰色圆点）；缺省为显示 */
  nodes?: boolean;
}

/** 圆球直径 / 半径（px） */
const KNOB_R = 13;
/** 球心距框左右端的留白：保证圆球整体始终落在框内 */
const END_MARGIN = KNOB_R + 6;
/** 进度高亮在圆球右缘之外继续延伸的长度：让球整体“住在高亮内” */
const HIGHLIGHT_TRAIL = KNOB_R + 4;

export function MenuPageSlider(props: MenuPageSliderProps) {
  /** 拖动中的目标页（0 起）；null 表示未在拖动 */
  const [scrub, setScrub] = createSignal<number | null>(null);
  /** 触控行实际宽度（px），决定球心 / 填充的像素落点 */
  const [trackW, setTrackW] = createSignal(0);
  let trackRef: HTMLDivElement | undefined;

  const max = () => Math.max(0, props.total - 1);
  /** 当前展示页（拖动中取预览目标，否则取实际页），已钳制到有效范围 */
  const shown = () => Math.min(Math.max(0, Math.round(props.page)), max());
  /** 进度（0..1） */
  const ratio = () => (max() > 0 ? (scrub() ?? shown()) / max() : 0);
  /** 球心距框左端的距离（px） */
  const ballCenterPx = () => {
    const inner = Math.max(0, trackW() - END_MARGIN * 2);
    return END_MARGIN + ratio() * inner;
  };
  /** 进度高亮前沿（px）：始终延伸到圆球右缘之外，球完全落在高亮里 */
  const frontPx = () => ballCenterPx() + HIGHLIGHT_TRAIL;

  /** 每个“页节点”的 x 位置（px）：按总页数等分，与球心活动区间一致 */
  const nodePx = () => {
    const inner = Math.max(0, trackW() - END_MARGIN * 2);
    const n = props.total;
    if (n <= 1 || inner <= 0) return [];
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      out[i] = END_MARGIN + (i / (n - 1)) * inner;
    }
    return out;
  };

  onMount(() => {
    const el = trackRef;
    if (!el) return;
    const update = () => setTrackW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  /** 客户端 x → 0 起目标页（把指针夹到框内可移动区间再换算） */
  function pageFromClientX(clientX: number): number {
    const el = trackRef;
    if (!el || max() <= 0) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const lo = rect.left + END_MARGIN;
    const hi = rect.right - END_MARGIN;
    const inner = Math.max(1, hi - lo);
    const t = Math.min(1, Math.max(0, (clientX - lo) / inner));
    return Math.round(t * max());
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      trackRef?.setPointerCapture(e.pointerId);
    } catch {
      /* 指针已失效等情况忽略 */
    }
    setScrub(pageFromClientX(e.clientX));
  }

  function onPointerMove(e: PointerEvent): void {
    if (scrub() === null) return;
    setScrub(pageFromClientX(e.clientX));
  }

  function endScrub(pointerId: number): void {
    try {
      if (trackRef?.hasPointerCapture(pointerId)) {
        trackRef.releasePointerCapture(pointerId);
      }
    } catch {
      /* ignore */
    }
  }

  function onPointerUp(e: PointerEvent): void {
    const target = scrub();
    if (target === null) return;
    endScrub(e.pointerId);
    setScrub(null);
    props.onCommit(target);
  }

  function onPointerCancel(e: PointerEvent): void {
    if (scrub() === null) return;
    endScrub(e.pointerId);
    setScrub(null);
  }

  const now = () => scrub() ?? shown();

  return (
    <div data-reader-ui class="relative select-none px-9 pb-3 pt-2">
      <div
        ref={trackRef}
        role="slider"
        aria-label="本章页数进度"
        aria-valuemin={1}
        aria-valuemax={props.total}
        aria-valuenow={now() + 1}
        aria-valuetext={`${now() + 1}/${props.total}页`}
        class="relative h-12 w-full cursor-pointer touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {/* 拖动提示：x/y页 */}
        <Show when={scrub() !== null}>
          <div class="pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-full border border-border bg-surface px-3 py-1 text-[12px] font-semibold leading-none text-text tabular-nums shadow-md">
            {now() + 1}/{props.total}页
          </div>
        </Show>

        {/* 大框（槽）：圆角胶囊，内层为进度高亮（accent），右端未走到部分保持槽底颜色 */}
        <div class="pointer-events-none absolute inset-x-0 top-1/2 h-10 -translate-y-1/2 overflow-hidden rounded-full border border-border bg-surface shadow-[0_3px_14px_rgb(0_0_0/0.18)]">
          <div
            class="h-full rounded-full bg-accent"
            style={{ width: `${frontPx()}px` }}
          />
        </div>

        {/* 页节点：按总页数等分的一个个灰色圆点（当前页那颗被圆球盖住）；可在阅读设置里开关 */}
        <Show when={props.nodes !== false}>
          <div class="pointer-events-none absolute inset-x-0 top-1/2 h-0">
            <For each={nodePx()}>
              {(px) => (
                <div
                  class="absolute top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-text-3/75"
                  style={{ left: `${px}px` }}
                />
              )}
            </For>
          </div>
        </Show>

        {/* 圆球：整体住在进度高亮内（高亮在球右缘之外仍有延伸），随高亮前沿滑动 */}
        <div
          class="pointer-events-none absolute top-1/2 h-[26px] w-[26px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface shadow-[0_2px_10px_rgb(0_0_0/0.45)]"
          style={{ left: `${ballCenterPx()}px` }}
        />
      </div>
    </div>
  );
}

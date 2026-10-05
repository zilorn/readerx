/**
 * 阅读页长按/拖选文本后的自定义菜单（替换原生菜单/右键菜单观感）。
 *
 * - 阻止原生弹出：容器已统一 contextmenu preventDefault，iOS 加 touch-callout none；
 * - 仅「复制 / 书签 / 朗读 / 替换」等动作项，带 SVG 图标；
 * - 「书签」右侧的伸缩按钮展开样式面板：线条（直线 / 虚线 / 点线 / 波浪线 / 荧光笔）
 *   与颜色（默认跟随主题 + 若干固定色）；面板里的选择直接作用于当前选区的书签
 *   （没有书签则按该样式新建），由页面回调落地；
 * - 固定高度条，宽度自适应内容；内容超出可用宽度时内部横向滚动，杜绝纵向溢出/出屏；
 * - 跟随选区定位，但只在能完整放进安全区（上/下留白）的区间摆放，绝不压到选区两端手柄
 *   （自定义选区模式下页面会传手柄位置来避让）；滚动手势或选区消失即隐藏。
 * - 点按自身期间（pointerdown → click）位置被冻结：条一旦在按下与抬起之间移位，click 的
 *   目标会退化成按下点/抬起点的公共祖先（按钮收不到 click），表现为「按了没反应、条还跳到
 *   别处，再按一次才生效」；同一个选区也不再重复重建状态，避免无谓的重算定位。
 *
 * 两种驱动方式：
 * 1. 原生选区（滚动模式等）：监听 selectionchange / pointerup，从 window.getSelection
 *    读出文本与 Range；「书签/朗读」按 Range 回调由页面换算镜像偏移。
 * 2. 自定义选区（分页模式自绘拖选，可跨页连选）：页面把整段镜像文本、定位锚点
 *    （可见端的折叠 caret）与 [lo,hi) 偏移通过 props.custom 注入；回调直接给偏移。
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { t, type MessageKey } from "../lib/i18n";
import {
  BOOKMARK_COLORS,
  BOOKMARK_STYLES,
  DEFAULT_BOOKMARK_APPEARANCE,
  type BookmarkAppearance,
  type BookmarkColor,
  type BookmarkStyle,
} from "../lib/bookmarks";
import {
  BookmarkIcon,
  BookmarkStyleIcon,
  ChevronDownIcon,
  CopyIcon,
  ReplaceIcon,
  SpeakerIcon,
} from "./icons";

/** 自定义（跨页）选区数据：全文 + 定位锚点 + 镜像偏移区间 */
export interface SelectionCustom {
  text: string;
  /** 菜单定位锚点（选区可见端的折叠 caret Range） */
  anchor: Range;
  /** 当前章镜像文本内的偏移区间 [lo, hi) */
  span: [number, number];
  /**
   * 选区在本页可见内容的纵向范围与两端手柄圆心（相对阅读区容器坐标）。
   * 提供后，菜单条会在竖直方向上避开手柄，且只在能完整放下的区间定位。
   */
  avoid?: {
    /** 选区首/末可见行的行盒上/下缘（相对阅读区容器顶部） */
    top: number;
    bottom: number;
    /** 选区两端手柄的圆心与半径（相对阅读区容器） */
    handles: Array<{ x: number; y: number; r: number }>;
  };
}

/** 菜单当前对应的选区（原生 Range / 自定义选区数据 + 选区文本） */
export interface SelectionTarget {
  range: Range;
  text: string;
  /** 自定义（跨页）选区数据；原生选区为 null */
  custom: SelectionCustom | null;
}

export interface SelectionMenuProps {
  /** 坐标换算基准（阅读区容器） */
  rootRef: () => HTMLDivElement | undefined;
  /** 是否允许展示（阅读页就绪且无弹层/工具栏） */
  active: () => boolean;
  /** 传入时菜单进入“自定义选区”模式，不再跟随原生选区 */
  custom?: () => SelectionCustom | null;
  /** 菜单条上/下沿距阅读区容器边的安全留白（px），防止贴到屏幕边缘/被刘海遮挡 */
  insets?: () => { top: number; bottom: number };
  onCopy: (text: string) => void;
  /** 原生选区模式：书签（页面内部换算偏移） */
  onBookmark?: (range: Range) => void;
  /** 原生选区模式：从选区起点所在句子开始朗读 */
  onSpeak?: (range: Range) => void;
  /** 自定义选区模式：按镜像偏移区间添加书签 */
  onBookmarkSpan?: (lo: number, hi: number) => void;
  /** 自定义选区模式：从镜像偏移处开始朗读 */
  onSpeakOffset?: (start: number) => void;
  /** 文本替换：把所选文字交给阅读页打开替换抽屉（预填查找框） */
  onReplace?: (text: string) => void;
  /** 当前选区已有书签的样式（样式面板回显用）；没有书签返回 null */
  currentMark?: (target: SelectionTarget) => BookmarkAppearance | null;
  /** 应用书签样式：给当前选区的书签改样式，选区没有书签时按该样式新建 */
  onApplyMark?: (target: SelectionTarget, mark: BookmarkAppearance) => void;
}

/** 线条样式名（选项本体与顺序在 lib/bookmarks.ts 的 BOOKMARK_STYLES） */
const STYLE_LABEL_KEYS: Record<BookmarkStyle, MessageKey> = {
  line: "readerChrome.selection.style.line",
  dashed: "readerChrome.selection.style.dashed",
  dotted: "readerChrome.selection.style.dotted",
  wavy: "readerChrome.selection.style.wavy",
  marker: "readerChrome.selection.style.marker",
};

/** 颜色选项名（色板本体在 lib/bookmarks.ts） */
const COLOR_LABEL_KEYS: Record<BookmarkColor, MessageKey> = {
  default: "readerChrome.selection.color.default",
  red: "readerChrome.selection.color.red",
  orange: "readerChrome.selection.color.orange",
  yellow: "readerChrome.selection.color.yellow",
  green: "readerChrome.selection.color.green",
  blue: "readerChrome.selection.color.blue",
  purple: "readerChrome.selection.color.purple",
};

const BAR_H = 46;
const GAP = 10;
const SIDE = 8;
/** 抬起后等待 click 派发的兜底时长（ms）：超时仍未派发（手势被系统接管等）就自行解冻对账 */
const PRESS_FALLBACK_MS = 400;

export function SelectionMenu(props: SelectionMenuProps) {
  const [menu, setMenu] = createSignal<{ range: Range; text: string } | null>(null);
  /** 书签样式面板是否展开（收起菜单时一并复位） */
  const [markPanel, setMarkPanel] = createSignal(false);
  let barRef: HTMLDivElement | undefined;
  let rowRef: HTMLDivElement | undefined;
  let panelRef: HTMLDivElement | undefined;
  /**
   * 指针正按在菜单条上（pointerdown → click）。
   * 期间既不重算位置也不收起菜单条：条在按下与 click 之间移位，click 的目标就变成
   * 按下点与抬起点的公共祖先，按钮的 onClick 不会执行（且看起来像是位置被重置）。
   */
  let pressing = false;
  let pressFallbackTimer: number | undefined;
  /** 按下期间正文滚动过：滚动照旧要收起菜单，但只能等 click 派发完再收 */
  let pressScrolled = false;
  /** 解冻计数器：按下期间跳过的定位重算，在解冻后补一次 */
  const [pressTick, setPressTick] = createSignal(0);

  function hide(): void {
    if (pressing) return;
    if (menu()) {
      setMenu(null);
      setMarkPanel(false); // 收起菜单的同时复位样式面板，下次展开是收起态
    }
  }

  /** 菜单当前对应的选区数据（供样式回显与样式应用回调用） */
  function target(): SelectionTarget | null {
    const current = menu();
    if (!current) return null;
    return { range: current.range, text: current.text, custom: props.custom?.() ?? null };
  }

  /** 当前选区已有书签的样式（没有书签 / 未接样式入口时为 null；同一次渲染内复用） */
  const activeMark = createMemo<BookmarkAppearance | null>(() => {
    const sel = target();
    if (!sel) return null;
    return props.currentMark?.(sel) ?? null;
  });

  /** 样式面板里点了一条样式或颜色：把「样式 + 当前颜色」组合交给页面落地 */
  function applyMark(style: BookmarkStyle, color: BookmarkColor): void {
    const sel = target();
    if (!sel || !props.onApplyMark) return;
    props.onApplyMark(sel, { style, color });
  }

  /** 事件目标是否落在菜单条内部（目标可能不是 Node，如 window 上的滚动） */
  function insideBar(target: EventTarget | null): boolean {
    return target instanceof Node && !!barRef?.contains(target);
  }

  /** 两个 Range 是否指向同一段内容（浏览器每次 getRangeAt 都给新对象，只能比边界） */
  function sameRange(a: Range, b: Range): boolean {
    if (a === b) return true;
    if (a.commonAncestorContainer !== b.commonAncestorContainer) return false;
    try {
      return (
        a.compareBoundaryPoints(Range.START_TO_START, b) === 0 &&
        a.compareBoundaryPoints(Range.END_TO_END, b) === 0
      );
    } catch {
      // 节点已随重渲染脱离文档，无法比较：按「选区变了」处理
      return false;
    }
  }

  /** 更新菜单状态；选区与文本都没变时不重建，避免顺带重算一次位置 */
  function show(range: Range, text: string): void {
    const cur = menu();
    if (cur && cur.text === text && sameRange(cur.range, range)) return;
    setMenu({ range, text });
  }

  /** 一次点按结束（click 已派发 / 指针离开菜单条 / 兜底超时）：解冻并按当前选区对账 */
  function endPress(): void {
    if (!pressing) return;
    pressing = false;
    window.clearTimeout(pressFallbackTimer);
    pressFallbackTimer = undefined;
    if (pressScrolled) {
      // 按下期间正文滚过（此刻收起会吞掉这次 click）：click 已派发完，按原语义收起
      pressScrolled = false;
      hide();
      return;
    }
    setPressTick((n) => n + 1); // 补上按下期间跳过的定位重算
    sync();
  }

  function sync(): void {
    if (pressing) return; // 按下期间冻结：此刻重算位置或收起都会让这次 click 落空
    const custom = props.custom?.() ?? null;
    if (custom) {
      if (!props.active()) {
        hide();
        return;
      }
      show(custom.anchor, custom.text);
      return;
    }
    const root = props.rootRef();
    const sel = window.getSelection();
    if (
      !root ||
      !props.active() ||
      !sel ||
      sel.isCollapsed ||
      sel.rangeCount === 0
    ) {
      hide();
      return;
    }
    const range = sel.getRangeAt(0);
    const text = sel.toString();
    if (!text.trim()) {
      hide();
      return;
    }
    const ancestor = range.commonAncestorContainer;
    const el =
      ancestor.nodeType === Node.ELEMENT_NODE
        ? (ancestor as Element)
        : ancestor.parentElement;
    if (
      !root.contains(ancestor) ||
      !el ||
      !!el.closest?.("[data-reader-ui]")
    ) {
      hide();
      return;
    }
    show(range, text);
  }

  // active / custom 变化（工具栏、弹层收起或选区变更）后重查
  createEffect(() => {
    props.active();
    props.custom?.();
    queueMicrotask(sync);
  });

  onMount(() => {
    const onSelection = () => sync();
    const onPointerUp = (e: PointerEvent) => {
      if (pressing) {
        // 抬起仍在菜单条上：等这次 click 派发完再对账（click 派发前动条就会吞掉它），
        // 正常路径由菜单条上的 click 调 endPress；这里只挂兜底，防 click 不来时一直冻着
        if (insideBar(e.target)) {
          window.clearTimeout(pressFallbackTimer);
          pressFallbackTimer = window.setTimeout(endPress, PRESS_FALLBACK_MS);
          return;
        }
        endPress();
        return;
      }
      queueMicrotask(sync);
    };
    const onPointerCancel = () => endPress();
    // scroll 不冒泡，捕获阶段监听以覆盖内部滚动容器；菜单条自身的横向滚动不收起自己
    const onScroll = (e: Event) => {
      if (insideBar(e.target)) return;
      if (pressing) {
        pressScrolled = true; // 按下期间先记账，等 click 派发完再收（见 endPress）
        return;
      }
      hide();
    };
    document.addEventListener("selectionchange", onSelection);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("scroll", onScroll, true);
    onCleanup(() => {
      window.clearTimeout(pressFallbackTimer);
      document.removeEventListener("selectionchange", onSelection);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("scroll", onScroll, true);
    });
  });

  // 定位：按实际尺寸计算，保证条不越界（上下翻面、左右避让）
  // 竖直方向按候选区间逐个挑选：只在能完整放下、且不压到选区手柄的位置摆放；
  // 全程受上/下安全留白约束，杜绝菜单条被顶到阅读区上缘（贴屏幕顶部）。
  createEffect(() => {
    const current = menu();
    const root = props.rootRef();
    const bar = barRef;
    const row = rowRef;
    if (!current || !root || !bar || !row) {
      if (bar) bar.style.visibility = "hidden";
      return;
    }
    // 点按期间冻结位置：任何重算都会让 click 落空（见 pressing 注释）；解冻时重算一次
    pressTick();
    markPanel(); // 面板展开/收起会改变整体高度，需重算摆放
    if (pressing) return;
    const area = root.getBoundingClientRect();
    if (area.width <= 0 || area.height <= 0) return;
    // 实际高度随样式面板展开而变（下拉行固定 BAR_H，面板整块量取）
    const barH = bar.offsetHeight || BAR_H;
    let r = current.range.getBoundingClientRect();
    if (!r) return;
    // 折叠 caret（自定义选区锚点）没有宽高：按其所在行的行高补出可用矩形
    if (r.width <= 0 || r.height <= 0) {
      const node = current.range.startContainer;
      const el = (
        node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
      ) as Element | null;
      let lineH = 0;
      if (el) lineH = parseFloat(getComputedStyle(el).lineHeight) || 0;
      if (!lineH) lineH = 24;
      const top = r.top;
      const height = Math.max(r.height, lineH);
      r = { left: r.left, right: r.left, top, bottom: top + height } as DOMRect;
    }
    const rect = {
      left: r.left,
      right: Math.max(r.right, r.left + 2),
      top: r.top,
      bottom: Math.max(r.bottom, r.top + 2),
    };

    // 行内按钮自然宽超出可用宽时：条固定到可用宽，内部横向滚动。
    // 样式面板展开时它可能比按钮行更宽（面板每行自己可横向滚动，取各行内容宽的最大值）
    let panelW = 0;
    if (panelRef) {
      for (const rowEl of Array.from(panelRef.children) as HTMLElement[]) {
        panelW = Math.max(panelW, rowEl.scrollWidth);
      }
    }
    const contentW = Math.max(row.offsetWidth, panelW);
    const maxW = Math.max(90, area.width - SIDE * 2);
    const width = Math.min(contentW, maxW);
    const cx = (rect.left + rect.right) / 2 - area.left;
    const left = Math.min(
      Math.max(SIDE, cx - width / 2),
      Math.max(SIDE, area.width - width - SIDE),
    );

    // ---- 竖直定位：候选区间逐个验证（放得下 + 不压手柄） ----
    const ins = props.insets?.() ?? { top: SIDE, bottom: SIDE };
    const topMin = Math.max(SIDE, ins.top); // 条上缘至少离容器顶这么远
    const topMax = Math.max(topMin, area.height - Math.max(SIDE, ins.bottom) - barH);
    const custom = props.custom?.() ?? null;
    const avoid = custom?.avoid ?? null;
    const handles = avoid?.handles ?? [];
    const anchorTop = rect.top - area.top;
    const anchorBottom = rect.bottom - area.top;
    const zoneTop = avoid ? avoid.top : anchorTop;
    const zoneBottom = avoid ? avoid.bottom : anchorBottom;

    /** 某候选 top 处的条是否压到任一手柄（按手柄外接方框保守判断） */
    const barOverlaps = (top: number): boolean => {
      const bT = top;
      const bB = top + barH;
      const bL = left;
      const bR = left + width;
      for (const h of handles) {
        if (bR < h.x - h.r || bL > h.x + h.r) continue;
        if (bB < h.y - h.r || bT > h.y + h.r) continue;
        return true;
      }
      return false;
    };

    // 候选按偏好排序：先锚点行上方（贴近选区结尾），空间不够再整段上方/下方，
    // 长选区还能落到两端手柄之间的空隙里；每项都要能完整放下。
    const cands: Array<{ top: number; pref: number }> = [];
    const push = (top: number, pref: number): void => {
      if (top >= topMin && top <= topMax) cands.push({ top, pref });
    };
    push(anchorTop - barH - GAP, 0); // 选区结尾上方（默认摆放）
    push(zoneTop - barH - GAP, 1); // 整段选区上方
    push(zoneBottom + GAP, 2); // 整段选区下方（上方放不下 / 压手柄时）
    if (handles.length >= 2) {
      let minY = Infinity;
      let maxY = -Infinity;
      for (const h of handles) {
        if (h.y < minY) minY = h.y;
        if (h.y > maxY) maxY = h.y;
      }
      // 两端手柄之间的空隙足以整条放下时才用中间带
      if (maxY - minY >= barH + 2 * (GAP + 12)) {
        push((minY + maxY) / 2 - barH / 2, 3);
      }
    }
    cands.sort((a, b) => a.pref - b.pref);

    let top: number | null = null;
    for (const c of cands) {
      if (!barOverlaps(c.top)) {
        top = c.top;
        break;
      }
    }
    if (top === null) {
      // 兜底（极小容器等极端情况）：仍贴安全区上下限，选离锚点最近的位置
      const anchorMid = (anchorTop + anchorBottom) / 2;
      let best: number | null = null;
      let bestDist = Infinity;
      for (const c of cands) {
        const t = Math.max(topMin, Math.min(c.top, topMax));
        const dist = Math.abs(t + barH / 2 - anchorMid);
        if (dist < bestDist) {
          bestDist = dist;
          best = t;
        }
      }
      top = best ?? Math.max(topMin, Math.min(anchorTop - barH - GAP, topMax));
    }

    bar.style.visibility = "visible";
    bar.style.top = `${top}px`;
    bar.style.left = `${left}px`;
    bar.style.width = `${width}px`;
  });

  return (
    <Show when={menu()}>
      {(current) => (
        <div
          ref={barRef}
          data-reader-ui
          class="absolute z-[45] overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_10px_34px_rgb(0_0_0/0.22)] select-none"
          style={{ visibility: "hidden" }}
          onPointerDown={(e) => {
            // 保住文本选区/自定义选区，避免点按菜单导致选区折叠；
            // 同时冻结菜单条位置，直到这次 click 派发完（见 pressing 注释）
            e.preventDefault();
            e.stopPropagation();
            pressing = true;
          }}
          onClick={() => endPress()}
        >
          <div
            class="scrollbar-none flex w-full items-center overflow-x-auto"
            style={{ height: `${BAR_H}px` }}
          >
            <div
              ref={rowRef}
              class="flex flex-none items-center px-1.5"
            >
              <button
                class="flex h-9 flex-none cursor-pointer items-center gap-1.5 rounded-xl px-3 text-[13px] text-text-2 transition-colors active:bg-surface-2"
                onClick={() => props.onCopy(current().text)}
              >
                <CopyIcon size={17} />
                <span>{t("common.copy")}</span>
              </button>
              <div class="mx-1 h-5 w-px flex-none bg-border" />
              <button
                class="flex h-9 flex-none cursor-pointer items-center gap-1.5 rounded-xl px-3 text-[13px] text-text-2 transition-colors active:bg-surface-2"
                onClick={() => {
                  const c = props.custom?.() ?? null;
                  if (c) props.onBookmarkSpan?.(c.span[0], c.span[1]);
                  else props.onBookmark?.(current().range);
                }}
              >
                <BookmarkIcon size={17} />
                <span>{t("readerChrome.selection.bookmark")}</span>
              </button>
              {/* 书签右侧的伸缩按钮：展开线条与颜色选项 */}
              <Show when={props.onApplyMark}>
                <button
                  class="grid h-9 w-6 flex-none cursor-pointer place-items-center rounded-lg text-text-3 transition-[background-color,color,scale] active:scale-[0.92] active:bg-surface-2"
                  classList={{ "text-accent": markPanel() }}
                  aria-label={t("readerChrome.selection.markStyle")}
                  aria-expanded={markPanel()}
                  onClick={() => setMarkPanel((open) => !open)}
                >
                  <span class="transition-transform duration-150" classList={{ "rotate-180": markPanel() }}>
                    <ChevronDownIcon size={17} />
                  </span>
                </button>
              </Show>
              <div class="mx-1 h-5 w-px flex-none bg-border" />
              <button
                class="flex h-9 flex-none cursor-pointer items-center gap-1.5 rounded-xl px-3 text-[13px] text-text-2 transition-colors active:bg-surface-2"
                onClick={() => {
                  const c = props.custom?.() ?? null;
                  if (c) props.onSpeakOffset?.(c.span[0]);
                  else props.onSpeak?.(current().range);
                }}
              >
                <SpeakerIcon size={17} />
                <span>{t("readerChrome.selection.speak")}</span>
              </button>
              <Show when={props.onReplace}>
                <div class="mx-1 h-5 w-px flex-none bg-border" />
                <button
                  class="flex h-9 flex-none cursor-pointer items-center gap-1.5 rounded-xl px-3 text-[13px] text-text-2 transition-colors active:bg-surface-2"
                  onClick={() => {
                    const text = current().text.trim();
                    if (!text) return;
                    hide();
                    props.onReplace?.(text);
                  }}
                >
                  <ReplaceIcon size={17} />
                  <span>{t("readerChrome.selection.replace")}</span>
                </button>
              </Show>
            </div>
          </div>
          {/* 样式面板：线条一行、颜色一行；当前选区已有书签时回显它的样式 */}
          <Show when={markPanel() && props.onApplyMark}>
            <div
              ref={panelRef}
              class="flex flex-col gap-1.5 border-t border-border px-2 pb-2 pt-2"
            >
              <div class="scrollbar-none flex items-center gap-1 overflow-x-auto">
                <For each={BOOKMARK_STYLES}>
                  {(style) => (
                    <button
                      class="grid h-8 w-9 flex-none cursor-pointer place-items-center rounded-lg transition-colors"
                      classList={{
                        "bg-accent-weak text-accent": activeMark()?.style === style,
                        "text-text-2 active:bg-surface-2": activeMark()?.style !== style,
                      }}
                      aria-label={t(STYLE_LABEL_KEYS[style])}
                      aria-pressed={activeMark()?.style === style}
                      // 选区还没有书签时：按默认样式（直线 + 主题色）补齐另一半
                      onClick={() =>
                        applyMark(style, activeMark()?.color ?? DEFAULT_BOOKMARK_APPEARANCE.color)
                      }
                    >
                      <BookmarkStyleIcon size={20} style={style} />
                    </button>
                  )}
                </For>
              </div>
              <div class="flex items-center gap-1">
                <For each={BOOKMARK_COLORS}>
                  {(option) => (
                    <button
                      class="grid h-7 w-7 flex-none cursor-pointer place-items-center rounded-full border-2 transition-colors"
                      classList={{
                        "border-accent": activeMark()?.color === option.color,
                        "border-transparent": activeMark()?.color !== option.color,
                      }}
                      aria-label={t(COLOR_LABEL_KEYS[option.color])}
                      aria-pressed={activeMark()?.color === option.color}
                      onClick={() =>
                        applyMark(activeMark()?.style ?? DEFAULT_BOOKMARK_APPEARANCE.style, option.color)
                      }
                    >
                      <span
                        class="h-[18px] w-[18px] rounded-full border border-border"
                        style={{
                          "background-color": option.value ?? "var(--accent)",
                        }}
                      />
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}

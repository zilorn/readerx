/**
 * 阅读页长按/拖选文本后的自定义菜单（替换原生菜单/右键菜单观感）。
 *
 * - 阻止原生弹出：容器已统一 contextmenu preventDefault，iOS 加 touch-callout none；
 * - 仅“复制 / 书签”两项，带 SVG 图标；
 * - 固定高度条，宽度自适应内容；内容超出可用宽度时内部横向滚动，杜绝纵向溢出/出屏；
 * - 跟随选区定位：上方空间不足自动翻到选区下方；滚动手势或选区消失即隐藏。
 */
import {
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { BookmarkIcon, CopyIcon } from "./icons";

export interface SelectionMenuProps {
  /** 坐标换算基准（阅读区容器） */
  rootRef: () => HTMLDivElement | undefined;
  /** 是否允许展示（阅读页就绪且无弹层/工具栏） */
  active: () => boolean;
  onCopy: (text: string) => void;
  onBookmark: (range: Range) => void;
}

const BAR_H = 46;
const GAP = 10;
const SIDE = 8;

export function SelectionMenu(props: SelectionMenuProps) {
  const [menu, setMenu] = createSignal<{ range: Range; text: string } | null>(null);
  let barRef: HTMLDivElement | undefined;
  let rowRef: HTMLDivElement | undefined;

  function hide(): void {
    if (menu()) setMenu(null);
  }

  function sync(): void {
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
    setMenu({ range, text });
  }

  // active 由 false → true（工具栏/弹层收起）后重查选区
  createEffect(() => {
    props.active();
    queueMicrotask(sync);
  });

  onMount(() => {
    const onSelection = () => sync();
    const onPointerUp = () => queueMicrotask(sync);
    // scroll 不冒泡，捕获阶段监听以覆盖内部滚动容器
    const onScroll = () => hide();
    document.addEventListener("selectionchange", onSelection);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("scroll", onScroll, true);
    onCleanup(() => {
      document.removeEventListener("selectionchange", onSelection);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("scroll", onScroll, true);
    });
  });

  // 定位：按实际尺寸计算，保证条不越界（上下翻面、左右避让）
  createEffect(() => {
    const current = menu();
    const root = props.rootRef();
    const bar = barRef;
    const row = rowRef;
    if (!current || !root || !bar || !row) {
      if (bar) bar.style.visibility = "hidden";
      return;
    }
    const area = root.getBoundingClientRect();
    if (area.width <= 0 || area.height <= 0) return;
    const rect = current.range.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;

    const roomTop = rect.top - area.top;
    const above = roomTop >= BAR_H + GAP;
    let top = above ? roomTop - BAR_H - GAP : rect.bottom - area.top + GAP;
    const maxTop = Math.max(SIDE, area.height - BAR_H - SIDE);
    top = Math.max(SIDE, Math.min(top, maxTop));

    // 行内按钮自然宽超出可用宽时：条固定到可用宽，内部横向滚动
    const contentW = row.offsetWidth;
    const maxW = Math.max(90, area.width - SIDE * 2);
    const width = Math.min(contentW, maxW);
    const cx = (rect.left + rect.right) / 2 - area.left;
    const left = Math.min(
      Math.max(SIDE, cx - width / 2),
      Math.max(SIDE, area.width - width - SIDE),
    );

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
          style={{ height: `${BAR_H}px`, visibility: "hidden" }}
          onPointerDown={(e) => {
            // 保住文本选区，避免点按菜单导致选区折叠
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div class="scrollbar-none flex h-full w-full items-center overflow-x-auto">
            <div
              ref={rowRef}
              class="flex flex-none items-center px-1.5"
            >
              <button
                class="flex h-9 flex-none cursor-pointer items-center gap-1.5 rounded-xl px-3 text-[13px] text-text-2 transition-colors active:bg-surface-2"
                onClick={() => props.onCopy(current().text)}
              >
                <CopyIcon size={17} />
                <span>复制</span>
              </button>
              <div class="mx-1 h-5 w-px flex-none bg-border" />
              <button
                class="flex h-9 flex-none cursor-pointer items-center gap-1.5 rounded-xl px-3 text-[13px] text-text-2 transition-colors active:bg-surface-2"
                onClick={() => props.onBookmark(current().range)}
              >
                <BookmarkIcon size={17} />
                <span>书签</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

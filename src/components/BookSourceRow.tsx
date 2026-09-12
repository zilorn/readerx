import { Show, onCleanup } from "solid-js";
import {
  CheckIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  TrashIcon,
} from "./icons";
import { CAPABILITY_LABELS, type BookSourceSummary } from "../lib/bookSourcesTypes";
import { sourceGroupName } from "../lib/sourceGroups";

/** 长按多久进入多选（与书架卡片一致） */
const LONG_PRESS_MS = 480;
/** 手指位移超过该距离视为滚动列表，取消长按 */
const LONG_PRESS_SLOP = 12;

interface BookSourceRowProps {
  summary: BookSourceSummary;
  /** 多选模式：整行点击 = 勾选 / 取消勾选，行内操作区收起 */
  selectMode: boolean;
  selected: boolean;
  onOpen: (id: string) => void;
  onLongPress: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onAssignGroup: (id: string) => void;
  onCopyExport: (id: string) => void;
  onDelete: (id: string) => void;
}

/**
 * 书源列表行：点击进入编辑，长按进入多选；多选模式下整行可勾选。
 * 行内操作区（开关 / 归组 / 复制 / 删除）用 data-row-action 标出，
 * 从这些控件按下时不触发长按，点它们也不当作整行点击。
 */
export function BookSourceRow(props: BookSourceRowProps) {
  let longPressTimer: number | undefined;
  let longPressFired = false;
  let downX = 0;
  let downY = 0;

  onCleanup(() => window.clearTimeout(longPressTimer));

  function fromRowAction(e: Event): boolean {
    const target = e.target;
    return target instanceof Element && target.closest("[data-row-action]") !== null;
  }

  function onPointerDown(e: PointerEvent) {
    if (fromRowAction(e)) return;
    longPressFired = false;
    downX = e.clientX;
    downY = e.clientY;
    window.clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      // 已在多选中：长按不再触发（松开时的点击会切换该行勾选）
      if (props.selectMode) return;
      longPressFired = true;
      props.onLongPress(props.summary.id);
    }, LONG_PRESS_MS);
  }

  function onPointerMove(e: PointerEvent) {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > LONG_PRESS_SLOP) {
      window.clearTimeout(longPressTimer);
    }
  }

  function cancelLongPress() {
    window.clearTimeout(longPressTimer);
  }

  /** 吃掉长按后紧随的那次点击：刚进多选就被它取消勾选 */
  function consumeLongPressClick(): boolean {
    if (!longPressFired) return false;
    longPressFired = false;
    return true;
  }

  function activate() {
    if (props.selectMode) props.onToggleSelect(props.summary.id);
    else props.onOpen(props.summary.id);
  }

  return (
    <div
      class="flex items-center gap-3 px-4 py-[12px] select-none touch-manipulation"
      classList={{ "bg-accent-weak": props.selectMode && props.selected }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        if (fromRowAction(e)) return;
        if (consumeLongPressClick()) return;
        activate();
      }}
    >
      <button
        class="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
        aria-label={
          props.selectMode
            ? props.selected
              ? `取消选中书源《${props.summary.name}》`
              : `选中书源《${props.summary.name}》`
            : `编辑书源《${props.summary.name}》`
        }
        onClick={(e) => {
          // 交给整行统一处理，避免点击被行与按钮各算一次
          e.stopPropagation();
          if (consumeLongPressClick()) return;
          activate();
        }}
      >
        <span class="flex w-full items-center gap-1.5">
          <span class="truncate text-[14.5px] font-medium">{props.summary.name}</span>
          <span class="shrink-0 truncate text-[11px] text-text-3">
            {props.summary.bookSourceUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
          </span>
        </span>
        <span class="flex flex-wrap items-center gap-1">
          <Show when={sourceGroupName(props.summary.groupId)}>
            <i class="not-italic flex max-w-[110px] items-center gap-0.5 truncate rounded-full bg-accent-weak px-1.5 py-0.5 text-[9.5px] font-semibold text-accent">
              <FolderIcon size={10} class="flex-none" />
              <span class="truncate">{sourceGroupName(props.summary.groupId)}</span>
            </i>
          </Show>
          {(Object.keys(CAPABILITY_LABELS) as (keyof typeof CAPABILITY_LABELS)[])
            .filter((key) => props.summary.capabilities[key])
            .map((key) => (
              <i class="not-italic rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-semibold text-text-3">
                {CAPABILITY_LABELS[key]}
              </i>
            ))}
          <span class="text-[10px] text-text-3/80">JS {props.summary.jsLength}</span>
        </span>
      </button>

      <Show
        when={props.selectMode}
        fallback={
          <div class="flex flex-none flex-col items-end gap-1.5" data-row-action>
            <button
              role="switch"
              aria-checked={props.summary.enabled}
              class={`relative h-6 w-11 flex-none rounded-full transition-colors duration-150 ${
                props.summary.enabled ? "bg-accent" : "bg-surface-2"
              }`}
              aria-label={`${props.summary.enabled ? "停用" : "启用"}书源《${props.summary.name}》`}
              onClick={() => props.onToggleEnabled(props.summary.id, !props.summary.enabled)}
            >
              <span
                class={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left] duration-150 ${
                  props.summary.enabled ? "left-[22px]" : "left-0.5"
                }`}
              />
            </button>
            <span class="flex items-center gap-0.5">
              <button
                class="grid h-7 w-7 place-items-center rounded-lg text-text-3 active:bg-surface-2"
                classList={{ "text-accent": !!sourceGroupName(props.summary.groupId) }}
                aria-label={`归入分组：${props.summary.name}`}
                onClick={() => props.onAssignGroup(props.summary.id)}
              >
                <FolderIcon size={15} />
              </button>
              <button
                class="grid h-7 w-7 place-items-center rounded-lg text-text-3 active:bg-surface-2"
                aria-label={`复制导出 JSON：${props.summary.name}`}
                onClick={() => props.onCopyExport(props.summary.id)}
              >
                <FileTextIcon size={15} />
              </button>
              <button
                class="grid h-7 w-7 place-items-center rounded-lg text-text-3 active:bg-surface-2"
                aria-label={`删除书源：${props.summary.name}`}
                onClick={() => props.onDelete(props.summary.id)}
              >
                <TrashIcon size={15} />
              </button>
              <ChevronRightIcon size={16} class="text-text-3/80" />
            </span>
          </div>
        }
      >
        <span
          class="grid h-[22px] w-[22px] flex-none place-items-center rounded-full border-2 transition-colors duration-150"
          classList={{
            "border-accent bg-accent text-on-accent": props.selected,
            "border-border text-transparent": !props.selected,
          }}
          aria-hidden="true"
        >
          <CheckIcon size={13} />
        </span>
      </Show>
    </div>
  );
}

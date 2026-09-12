import { For, Show } from "solid-js";
import { FolderIcon } from "./icons";
import {
  SOURCE_FILTER_ALL,
  SOURCE_FILTER_NONE,
  sourceGroupList,
} from "../lib/sourceGroups";

/** 一个分组筛选 chip：key 为筛选值（all / none / sg-<id>） */
export interface SourceGroupChip {
  key: string;
  label: string;
  count: number;
}

/**
 * 生成筛选条选项（全部 / 未分组 / 各自定义分组）。
 * 未分组没有书源时不占位（除非正选中它）；自定义分组建了就显示，空分组也要能点进去。
 */
export function sourceGroupChips(
  counts: Record<string, number>,
  active: string,
): SourceGroupChip[] {
  const chips: SourceGroupChip[] = [
    { key: SOURCE_FILTER_ALL, label: "全部", count: counts[SOURCE_FILTER_ALL] ?? 0 },
  ];
  const noneCount = counts[SOURCE_FILTER_NONE] ?? 0;
  if (noneCount > 0 || active === SOURCE_FILTER_NONE) {
    chips.push({ key: SOURCE_FILTER_NONE, label: "未分组", count: noneCount });
  }
  for (const group of sourceGroupList()) {
    chips.push({ key: group.id, label: group.name, count: counts[group.id] ?? 0 });
  }
  return chips;
}

interface SourceGroupChipsProps {
  chips: SourceGroupChip[];
  value: string;
  onSelect: (key: string) => void;
  /** 传了才显示尾部「分组管理」按钮，并支持长按分组 chip 进入管理 */
  onManage?: () => void;
  manageLabel?: string;
}

/** 横向分组筛选条（书源管理页与发现页共用） */
export function SourceGroupChips(props: SourceGroupChipsProps) {
  return (
    <div class="m-0.5 flex gap-2 overflow-x-auto pb-1.5 pt-2 scrollbar-none">
      <For each={props.chips}>
        {(chip) => (
          <SourceGroupChipButton
            chip={chip}
            active={props.value === chip.key}
            onSelect={() => props.onSelect(chip.key)}
            onLongPress={
              props.onManage && chip.key !== SOURCE_FILTER_ALL && chip.key !== SOURCE_FILTER_NONE
                ? props.onManage
                : undefined
            }
          />
        )}
      </For>
      <Show when={props.onManage}>
        <button
          class="inline-flex flex-none select-none items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-[7px] text-[13px] text-text-3 touch-manipulation active:bg-surface-2"
          aria-label="书源分组管理"
          onClick={() => props.onManage?.()}
        >
          <FolderIcon size={15} />
          {props.manageLabel ?? "分组"}
        </button>
      </Show>
    </div>
  );
}

function SourceGroupChipButton(props: {
  chip: SourceGroupChip;
  active: boolean;
  onSelect: () => void;
  onLongPress?: () => void;
}) {
  let longPressTimer: number | undefined;
  let longPressFired = false;
  let downX = 0;
  let downY = 0;

  function cancelLongPress() {
    window.clearTimeout(longPressTimer);
  }

  function onPointerDown(e: PointerEvent) {
    if (!props.onLongPress) return;
    longPressFired = false;
    downX = e.clientX;
    downY = e.clientY;
    window.clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      longPressFired = true;
      props.onLongPress?.();
    }, 480);
  }

  return (
    <button
      class="inline-flex flex-none select-none items-center gap-1.5 rounded-full px-3.5 py-[7px] text-[13px] touch-manipulation transition-colors duration-150"
      classList={{
        "bg-accent font-semibold text-on-accent": props.active,
        "border border-border bg-surface text-text-2": !props.active,
      }}
      onClick={() => {
        if (longPressFired) {
          longPressFired = false;
          return;
        }
        props.onSelect();
      }}
      onContextMenu={(e) => e.preventDefault()}
      {...(props.onLongPress
        ? {
            onPointerDown,
            onPointerMove: (e: PointerEvent) => {
              if (Math.hypot(e.clientX - downX, e.clientY - downY) > 12) cancelLongPress();
            },
            onPointerUp: cancelLongPress,
            onPointerCancel: cancelLongPress,
            onPointerLeave: cancelLongPress,
          }
        : {})}
    >
      <span class="max-w-[120px] truncate">{props.chip.label}</span>
      <span class={props.active ? "text-on-accent/80" : "text-text-3"}>{props.chip.count}</span>
    </button>
  );
}

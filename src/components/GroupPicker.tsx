import { For, Show, createSignal } from "solid-js";
import { CheckIcon, CloseIcon, PlusIcon } from "./icons";
import { createGroup, groupList } from "../lib/groups";
import { ScrollArea } from "./ScrollArea";

interface GroupPickerProps {
  value: string | null | undefined;
  onSelect: (groupId: string | null) => void;
  onClose: () => void;
}

/** 底部抽屉：选择（或新建）一个书架分组 */
export function GroupPicker(props: GroupPickerProps) {
  const [newName, setNewName] = createSignal("");

  function pick(groupId: string | null) {
    props.onSelect(groupId);
    props.onClose();
  }

  function createAndPick() {
    const name = newName().trim();
    if (!name) return;
    const group = createGroup(name);
    pick(group.id);
  }

  return (
    <div class="fixed inset-0 z-50" role="dialog" aria-label="选择分组">
      <div
        class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
        onClick={props.onClose}
      />
      <div class="absolute inset-x-0 bottom-0 z-[51] flex max-h-[72%] animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]">
        <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
          <span class="text-[15px] font-bold">归入分组</span>
          <span class="flex-1 text-xs text-text-3">选择一个书架分组</span>
          <button
            class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label="关闭"
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </div>

        {/* 底部预留安全区，避免列表 / 新建分组输入被 Home 指示条遮挡 */}
        <ScrollArea
          class="min-h-0 flex-1"
          contentClass="px-0 py-1 pb-[calc(14px+env(safe-area-inset-bottom))]"
        >
          <GroupRow
            label="未分组"
            active={!props.value}
            onClick={() => pick(null)}
          />
          <For each={groupList()}>
            {(group) => (
              <GroupRow
                label={group.name}
                active={props.value === group.id}
                onClick={() => pick(group.id)}
              />
            )}
          </For>

          <div class="mt-1 flex items-center gap-2 px-[18px]">
            <input
              value={newName()}
              onInput={(e) => setNewName(e.currentTarget.value)}
              placeholder="新建分组"
              class="min-w-0 flex-1 rounded-[10px] border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors placeholder:text-text-3 focus:border-accent"
              onKeyDown={(e) => {
                if (e.key === "Enter") createAndPick();
              }}
            />
            <button
              class="inline-flex h-[38px] flex-none items-center justify-center gap-1 rounded-[10px] bg-accent px-3 text-[13px] font-semibold text-on-accent transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
              onClick={createAndPick}
            >
              <PlusIcon size={16} />
              创建
            </button>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function GroupRow(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      class="flex w-full items-center gap-3 px-[18px] py-[12px] text-left text-[14px] transition-colors active:bg-surface-2"
      classList={{ "bg-accent-weak font-semibold text-accent": props.active, "text-text-2": !props.active }}
      onClick={props.onClick}
    >
      <span class="min-w-0 flex-1 truncate">{props.label}</span>
      <Show when={props.active}>
        <CheckIcon size={18} class="flex-none text-accent" />
      </Show>
    </button>
  );
}

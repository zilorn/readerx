import { For, Show, createSignal, type JSX } from "solid-js";
import { CheckIcon, CloseIcon, EditIcon, FolderIcon, PlusIcon, TrashIcon } from "./icons";
import {
  createSourceGroup,
  deleteSourceGroup,
  renameSourceGroup,
  sourceGroupById,
  sourceGroupList,
} from "../lib/sourceGroups";
import {
  bookSourceList,
  bookSourceSummaryById,
  refreshBookSources,
  setBookSourcesEnabled,
} from "../lib/bookSources";
import { showToast } from "../lib/toast";
import { ScrollArea } from "./ScrollArea";
import { ToggleSwitch } from "./ToggleSwitch";

/** 底部抽屉：书源分组管理（新建 / 重命名 / 删除 + 整组启停） */
export function SourceGroupManagerSheet(props: { onClose: () => void }) {
  const [newName, setNewName] = createSignal("");
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editName, setEditName] = createSignal("");
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  /** 未归入任何分组的书源（归属分组已被删除的也算） */
  const ungroupedIds = (): string[] =>
    bookSourceList()
      .filter((source) => !sourceGroupById(source.groupId))
      .map((source) => source.id);

  const idsInGroup = (groupId: string): string[] =>
    bookSourceList()
      .filter((source) => source.groupId === groupId)
      .map((source) => source.id);

  function stats(ids: string[]): { total: number; enabled: number } {
    const enabled = ids.filter((id) => bookSourceSummaryById(id)?.enabled).length;
    return { total: ids.length, enabled };
  }

  const ungrouped = () => stats(ungroupedIds());

  async function toggleGroup(ids: string[], next: boolean): Promise<void> {
    if (busy()) return;
    setBusy(true);
    try {
      const changed = await setBookSourcesEnabled(ids, next);
      if (changed > 0) showToast(`已${next ? "启用" : "停用"} ${changed} 个书源`);
    } catch (err) {
      showToast(String(err), true);
    }
    setBusy(false);
  }

  function handleCreate(): void {
    const name = newName().trim();
    if (!name) return;
    const duplicate = sourceGroupList().some((group) => group.name === name);
    createSourceGroup(name);
    setNewName("");
    if (duplicate) showToast("已有同名分组", true);
  }

  function startEdit(id: string, name: string): void {
    setEditingId(id);
    setEditName(name);
  }

  function commitEdit(id: string, previous: string): void {
    const name = editName().trim();
    setEditingId(null);
    if (!name || name === previous) return;
    if (!renameSourceGroup(id, name)) showToast("已有同名分组", true);
  }

  async function handleDelete(id: string): Promise<void> {
    if (confirmDelete() !== id) {
      setConfirmDelete(id);
      window.setTimeout(() => setConfirmDelete(null), 3000);
      return;
    }
    setConfirmDelete(null);
    try {
      const cleared = await deleteSourceGroup(id);
      await refreshBookSources();
      showToast(cleared > 0 ? `分组已删除，${cleared} 个书源退回未分组` : "分组已删除");
    } catch (err) {
      showToast(String(err), true);
    }
  }

  return (
    <div class="fixed inset-0 z-50" role="dialog" aria-label="书源分组管理">
      <div
        class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
        onClick={props.onClose}
      />
      <div class="absolute inset-x-0 bottom-0 z-[51] flex max-h-[76%] animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]">
        <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
          <span class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-accent-weak text-accent">
            <FolderIcon size={18} />
          </span>
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="text-[15px] font-bold leading-tight">书源分组</span>
            <span class="text-[11px] text-text-3">新建、重命名、删除；开关整组书源</span>
          </span>
          <button
            class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label="关闭书源分组管理"
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <ScrollArea class="min-h-0 flex-1">
          <div class="divide-y divide-border">
            {/* 未分组：只提供整组启停（不能改名 / 删除） */}
            <GroupRow
              label="未分组"
              total={ungrouped().total}
              enabled={ungrouped().enabled}
              busy={busy()}
              onToggle={(next) => void toggleGroup(ungroupedIds(), next)}
            />
            <For each={sourceGroupList()}>
              {(group) => {
                const ids = (): string[] => idsInGroup(group.id);
                return (
                  <GroupRow
                    label={group.name}
                    total={stats(ids()).total}
                    enabled={stats(ids()).enabled}
                    busy={busy()}
                    onToggle={(next) => void toggleGroup(ids(), next)}
                  >
                    <Show
                      when={editingId() === group.id}
                      fallback={
                        <>
                          <button
                            class="grid h-8 w-8 flex-none place-items-center rounded-lg text-text-2 transition-colors active:bg-surface-2"
                            aria-label={`重命名分组《${group.name}》`}
                            onClick={() => startEdit(group.id, group.name)}
                          >
                            <EditIcon size={16} />
                          </button>
                          <button
                            class="grid h-8 w-8 flex-none place-items-center rounded-lg text-text-2 transition-colors active:bg-surface-2"
                            classList={{ "text-danger": confirmDelete() === group.id }}
                            aria-label={
                              confirmDelete() === group.id
                                ? `确认删除分组《${group.name}》`
                                : `删除分组《${group.name}》`
                            }
                            onClick={() => void handleDelete(group.id)}
                          >
                            {confirmDelete() === group.id ? (
                              <CheckIcon size={16} />
                            ) : (
                              <TrashIcon size={16} />
                            )}
                          </button>
                        </>
                      }
                    >
                      <input
                        value={editName()}
                        onInput={(e) => setEditName(e.currentTarget.value)}
                        class="min-w-0 flex-1 rounded-[8px] border border-border bg-bg px-2 py-[6px] text-[14px] text-text outline-none focus:border-accent"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit(group.id, group.name);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                      />
                      <button
                        class="grid h-8 w-8 flex-none place-items-center rounded-lg text-accent transition-colors active:bg-surface-2"
                        aria-label="保存分组名"
                        onClick={() => commitEdit(group.id, group.name)}
                      >
                        <CheckIcon size={17} />
                      </button>
                    </Show>
                  </GroupRow>
                );
              }}
            </For>
            <Show when={sourceGroupList().length === 0}>
              <p class="px-4 py-4 text-center text-[12.5px] text-text-3">
                还没有书源分组，在下方创建一个。
              </p>
            </Show>
          </div>
        </ScrollArea>

        {/* 新建分组 */}
        <div class="flex flex-none items-center gap-2 border-t border-border px-4 py-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
          <input
            value={newName()}
            onInput={(e) => setNewName(e.currentTarget.value)}
            placeholder="新建分组"
            class="min-w-0 flex-1 rounded-[10px] border border-border bg-bg px-3 py-[8px] text-[13.5px] text-text outline-none transition-colors placeholder:text-text-3 focus:border-accent"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
          />
          <button
            class="inline-flex h-[34px] flex-none items-center justify-center gap-1 rounded-[9px] bg-accent px-3 text-[13px] font-semibold text-on-accent transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
            onClick={handleCreate}
          >
            <PlusIcon size={15} />
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

function GroupRow(props: {
  label: string;
  total: number;
  enabled: number;
  busy: boolean;
  onToggle: (next: boolean) => void;
  children?: JSX.Element;
}) {
  /** 全启用 = 开关处于开位；点一下把整组切到相反状态 */
  const allEnabled = (): boolean => props.total > 0 && props.enabled === props.total;
  return (
    <div class="flex items-center gap-3 px-4 py-[12px]">
      <span class="grid h-[30px] w-[30px] flex-none place-items-center rounded-lg bg-surface-2 text-text-2">
        <FolderIcon size={16} />
      </span>
      <span class="flex min-w-0 flex-1 flex-col gap-[1px]">
        <span class="min-w-0 truncate text-[14px] font-medium">{props.label}</span>
        <span class="text-[11px] text-text-3">
          {props.enabled} / {props.total} 启用
        </span>
      </span>
      <span
        class="flex flex-none items-center gap-1"
        classList={{ "pointer-events-none opacity-40": props.total === 0 || props.busy }}
      >
        <ToggleSwitch
          on={allEnabled()}
          label={`整组启停：${props.label}`}
          onChange={() => props.onToggle(!allEnabled())}
        />
      </span>
      {props.children}
    </div>
  );
}

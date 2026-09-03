import { For, Show, createSignal } from "solid-js";
import { CheckIcon, EditIcon, PlusIcon, TrashIcon, FolderIcon } from "./icons";
import { createGroup, deleteGroup, groupList, renameGroup } from "../lib/groups";

/** 设置页分组管理：创建 / 重命名 / 删除 */
export function GroupManager() {
  const [newName, setNewName] = createSignal("");
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editName, setEditName] = createSignal("");
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);

  function handleCreate() {
    const name = newName().trim();
    if (!name) return;
    createGroup(name);
    setNewName("");
  }

  function startEdit(id: string, name: string) {
    setEditingId(id);
    setEditName(name);
  }

  function commitEdit(id: string) {
    renameGroup(id, editName());
    setEditingId(null);
  }

  async function handleDelete(id: string) {
    if (confirmDelete() !== id) {
      setConfirmDelete(id);
      window.setTimeout(() => setConfirmDelete(null), 3000);
      return;
    }
    setConfirmDelete(null);
    await deleteGroup(id);
  }

  return (
    <div class="overflow-hidden rounded-[14px] border border-border bg-surface">
      <Show
        when={groupList().length > 0}
        fallback={
          <div class="px-4 py-3 text-[12.5px] text-text-3">
            还没有书架分组，在下方创建一个。
          </div>
        }
      >
        <div class="divide-y divide-border">
          <For each={groupList()}>
            {(group) => (
              <div class="flex items-center gap-3 px-4 py-[12px]">
                <span class="grid h-[30px] w-[30px] flex-none place-items-center rounded-lg bg-surface-2 text-text-2">
                  <FolderIcon size={16} />
                </span>
                <Show when={editingId() === group.id} fallback={<>
                  <span class="min-w-0 flex-1 truncate text-[14px] font-medium">
                    {group.name}
                  </span>
                  <button
                    class="grid h-8 w-8 flex-none place-items-center rounded-lg text-text-2 transition-colors active:bg-surface-2"
                    aria-label={`重命名《${group.name}》`}
                    onClick={() => startEdit(group.id, group.name)}
                  >
                    <EditIcon size={16} />
                  </button>
                  <button
                    class="grid h-8 w-8 flex-none place-items-center rounded-lg text-text-2 transition-colors active:bg-surface-2"
                    classList={{ "text-danger": confirmDelete() === group.id }}
                    aria-label={confirmDelete() === group.id ? `确认删除分组《${group.name}》` : `删除分组《${group.name}》`}
                    onClick={() => void handleDelete(group.id)}
                  >
                    {confirmDelete() === group.id ? <CheckIcon size={16} /> : <TrashIcon size={16} />}
                  </button>
                </>}>
                  <input
                    value={editName()}
                    onInput={(e) => setEditName(e.currentTarget.value)}
                    class="min-w-0 flex-1 rounded-[8px] border border-border bg-bg px-2 py-[6px] text-[14px] text-text outline-none focus:border-accent"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(group.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                  <button
                    class="grid h-8 w-8 flex-none place-items-center rounded-lg text-accent transition-colors active:bg-surface-2"
                    aria-label="保存分组名"
                    onClick={() => commitEdit(group.id)}
                  >
                    <CheckIcon size={17} />
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      <div class="flex items-center gap-2 border-t border-border px-4 py-3">
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
  );
}

import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  CheckIcon,
  ChevronLeftIcon,
  CloseIcon,
  EditIcon,
  PlusIcon,
  ServerIcon,
  TrashIcon,
} from "./icons";
import {
  activateDavServer,
  createDavServer,
  davActiveId,
  davServerById,
  davServers,
  deleteDavServer,
  updateDavServer,
  type DavServer,
} from "../lib/webdav";
import { showToast } from "../lib/toast";

interface DavServerDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 在某台服务器上点击「使用」后回调（父页面通常切回根目录） */
  onActivate?: (id: string) => void;
}

type DrawerView = "list" | "form";

/** WebDAV 服务器配置底部抽屉：多台增删改 + 点选激活 */
export function DavServerDrawer(props: DavServerDrawerProps) {
  const [view, setView] = createSignal<DrawerView>("list");
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [name, setName] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [deletingId, setDeletingId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let deleteTimer: number | undefined;

  onCleanup(() => window.clearTimeout(deleteTimer));

  // 每次打开回到列表视图
  createEffect(() => {
    if (props.open) {
      setView("list");
      setEditingId(null);
      setDeletingId(null);
    }
  });

  function toList() {
    setView("list");
    setEditingId(null);
  }

  function startAdd() {
    setName("");
    setUrl("");
    setUsername("");
    setPassword("");
    setEditingId(null);
    setView("form");
  }

  function startEdit(server: DavServer) {
    setName(server.name);
    setUrl(server.url);
    setUsername(server.username);
    setPassword(server.password);
    setEditingId(server.id);
    setView("form");
  }

  async function save() {
    if (!url().trim()) {
      showToast("请填写服务器地址", true);
      return;
    }
    if (busy()) return;
    setBusy(true);
    try {
      const input = {
        name: name(),
        url: url(),
        username: username(),
        password: password(),
      };
      const editing = editingId();
      if (editing && davServerById(editing)) {
        updateDavServer(editing, input);
        showToast("已保存服务器配置");
      } else {
        createDavServer(input);
        showToast("已添加服务器");
      }
      toList();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", true);
    } finally {
      setBusy(false);
    }
  }

  function requestDelete(id: string) {
    if (deletingId() !== id) {
      setDeletingId(id);
      window.clearTimeout(deleteTimer);
      deleteTimer = window.setTimeout(() => setDeletingId(null), 2600);
      return;
    }
    window.clearTimeout(deleteTimer);
    setDeletingId(null);
    deleteDavServer(id);
    showToast("已删除服务器");
  }

  function pickServer(id: string) {
    activateDavServer(id);
    props.onActivate?.(id);
    props.onClose();
  }

  return (
    <Show when={props.open}>
      <Portal>
        <div
          class="fixed inset-0 z-[70]"
          role="dialog"
          aria-label="WebDAV 服务器配置"
        >
          <div
            class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
            onClick={props.onClose}
          />
          <div class="absolute inset-x-0 bottom-0 z-[71] flex max-h-[86%] animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]">
            <div class="flex flex-none items-center gap-2 border-b border-border px-4 py-3">
              <Show
                when={view() === "form"}
                fallback={
                  <span class="flex-1 text-[15px] font-bold">WebDAV 服务器</span>
                }
              >
                <button
                  class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                  aria-label="返回服务器列表"
                  onClick={toList}
                >
                  <ChevronLeftIcon />
                </button>
                <span class="flex-1 text-[15px] font-bold">
                  {editingId() ? "编辑服务器" : "新增服务器"}
                </span>
              </Show>
              <button
                class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                aria-label="关闭"
                onClick={props.onClose}
              >
                <CloseIcon />
              </button>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto pb-[calc(14px+env(safe-area-inset-bottom))] scrollbar-none">
              <Show when={view() === "list"}>
                <p class="px-[18px] pb-1 pt-2 text-[12px] text-text-3">
                  可配置多台服务器，点选一台即在导入页使用
                </p>
                <Show
                  when={davServers().length > 0}
                  fallback={
                    <div class="flex flex-col items-center gap-1 px-6 py-10 text-center">
                      <ServerIcon size={42} class="mb-1 text-text-3" />
                      <p class="text-[13.5px] font-medium text-text-2">
                        还没有 WebDAV 服务器
                      </p>
                    </div>
                  }
                >
                  <For each={davServers()}>
                    {(server) => (
                      <ServerRow
                        server={server}
                        active={server.id === davActiveId()}
                        deleting={deletingId() === server.id}
                        onPick={() => pickServer(server.id)}
                        onEdit={() => startEdit(server)}
                        onDelete={() => requestDelete(server.id)}
                      />
                    )}
                  </For>
                </Show>

                <button
                  class="mx-[18px] mt-2 flex w-[calc(100%-36px)] items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-[11px] text-[13.5px] font-medium text-text-2 transition-colors active:bg-surface-2"
                  onClick={startAdd}
                >
                  <PlusIcon size={16} />
                  新增服务器
                </button>
              </Show>

              <Show when={view() === "form"}>
                <div class="flex flex-col gap-3 px-[18px] pb-2 pt-3">
                  <Field
                    label="名称"
                    placeholder="如：我的坚果云"
                    value={name()}
                    onInput={setName}
                  />
                  <Field
                    label="服务器地址"
                    placeholder="https://dav.example.com/dav"
                    value={url()}
                    onInput={setUrl}
                    autofocus
                  />
                  <Field
                    label="账号"
                    placeholder="（留空则为匿名访问）"
                    value={username()}
                    onInput={setUsername}
                  />
                  <Field
                    label="密码"
                    placeholder=""
                    value={password()}
                    onInput={setPassword}
                    type="password"
                  />
                  <button
                    class="mt-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-[11px] text-[14px] font-semibold text-on-accent shadow-lg shadow-accent/25 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                    disabled={busy()}
                    onClick={() => void save()}
                  >
                    {busy() ? "保存中…" : "保存"}
                  </button>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

function ServerRow(props: {
  server: DavServer;
  active: boolean;
  deleting: boolean;
  onPick: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const account = () =>
    props.server.username.trim()
      ? `账号 ${props.server.username.trim()}`
      : "匿名访问";
  return (
    <div
      class="flex items-center gap-1 px-[18px] py-2 transition-colors active:bg-surface-2"
      classList={{ "bg-accent-weak": props.active }}
    >
      <button
        class="flex min-w-0 flex-1 items-center gap-3 py-2 text-left"
        aria-label={props.active ? `${props.server.name}（正在使用）` : `使用 ${props.server.name}`}
        onClick={props.onPick}
      >
        <span
          class="grid h-[22px] w-[22px] flex-none place-items-center rounded-full border-2"
          classList={{
            "border-accent bg-accent text-on-accent": props.active,
            "border-text-3": !props.active,
          }}
          aria-hidden="true"
        >
          <Show when={props.active}>
            <CheckIcon size={13} />
          </Show>
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            class="truncate text-[14.5px] font-semibold"
            classList={{ "text-accent": props.active }}
          >
            {props.server.name}
          </span>
          <span class="truncate text-[11.5px] text-text-3">
            {props.server.url} · {account()}
          </span>
        </span>
      </button>
      <button
        class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-colors active:bg-surface-2"
        aria-label={`编辑 ${props.server.name}`}
        onClick={props.onEdit}
      >
        <EditIcon size={17} />
      </button>
      <button
        class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-3 transition-colors active:bg-surface-2"
        aria-label={`删除 ${props.server.name}`}
        onClick={props.onDelete}
      >
        {props.deleting ? (
          <span class="text-[11.5px] font-semibold text-danger">确认</span>
        ) : (
          <TrashIcon size={17} />
        )}
      </button>
    </div>
  );
}

function Field(props: {
  label: string;
  placeholder: string;
  value: string;
  type?: string;
  autofocus?: boolean;
  onInput: (value: string) => void;
}) {
  return (
    <label class="flex flex-col gap-1">
      <span class="text-[12.5px] font-medium text-text-2">{props.label}</span>
      <input
        class="rounded-[10px] border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors placeholder:text-text-3 focus:border-accent"
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        autofocus={props.autofocus}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}

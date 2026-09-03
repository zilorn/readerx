import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { DavServerDrawer } from "../components/DavServerDrawer";
import { LoadingScreen } from "../components/LoadingScreen";
import { PageHeader } from "../components/PageHeader";
import {
  CheckIcon,
  ChevronLeftIcon,
  CloudIcon,
  FileTextIcon,
  FolderIcon,
  RefreshIcon,
  ServerIcon,
  SettingsIcon,
} from "../components/icons";
import {
  activeDavServer,
  davReady,
  ensureWebDavLoaded,
  formatBytes,
  importDavFile,
  isBookFileName,
  listDavDirectory,
  type DavEntry,
} from "../lib/webdav";
import { showToast } from "../lib/toast";

let reloadSeq = 0;

/** 目录条目按类型分开渲染：文件夹可进入，书籍文件可勾选导入 */
export default function WebdavImportPage() {
  const navigate = useNavigate();
  const [path, setPath] = createSignal("");
  const [dirList, setDirList] = createSignal<DavEntry[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [selected, setSelected] = createSignal<Record<string, boolean>>({});
  const [configOpen, setConfigOpen] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  const [importProgress, setImportProgress] = createSignal(0);
  const [importTotal, setImportTotal] = createSignal(0);

  createEffect(() => {
    void ensureWebDavLoaded();
  });

  const server = () => activeDavServer();

  /** 读取当前激活服务器指定路径的目录（带竞态序号，丢弃过期结果） */
  async function loadDir() {
    const srv = server();
    const dir = path();
    const seq = ++reloadSeq;
    setImporting(false);
    setSelected({});
    setError(null);
    setLoading(true);
    setDirList(null);
    if (!srv) {
      setLoading(false);
      return;
    }
    try {
      const entries = await listDavDirectory(srv, dir);
      if (seq !== reloadSeq) return;
      setDirList(entries);
    } catch (err) {
      if (seq !== reloadSeq) return;
      setDirList(null);
      setError(err instanceof Error ? err.message : "读取目录失败");
    } finally {
      if (seq === reloadSeq) setLoading(false);
    }
  }

  // 激活服务器 / 当前路径变化时重新加载
  createEffect(() => {
    if (!davReady()) return;
    server(); // 订阅：激活服务器变化
    path(); // 订阅：目录路径变化
    void loadDir();
  });

  const dirs = createMemo<DavEntry[]>(() =>
    (dirList() ?? []).filter((e) => e.isDir),
  );
  const files = createMemo<DavEntry[]>(() =>
    (dirList() ?? []).filter((e) => !e.isDir && isBookFileName(e.name)),
  );

  const pathLabel = createMemo(() => {
    const s = server();
    if (!s) return "";
    return s.name + (path() ? ` / ${path()}` : "");
  });

  const selectedCount = createMemo(() => Object.keys(selected()).length);
  const allFilesSelected = createMemo(
    () => files().length > 0 && files().every((f) => selected()[f.path]),
  );

  function enterDir(entry: DavEntry) {
    setPath(entry.path);
  }

  function goUp() {
    const dir = path();
    const idx = dir.lastIndexOf("/");
    setPath(idx < 0 ? "" : dir.slice(0, idx));
  }

  function toggleFile(pathToToggle: string) {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[pathToToggle]) delete next[pathToToggle];
      else next[pathToToggle] = true;
      return next;
    });
  }

  function toggleSelectAll() {
    const paths = files().map((f) => f.path);
    if (paths.length === 0) return;
    setSelected((prev) => {
      const next = { ...prev };
      if (paths.every((p) => next[p])) {
        for (const p of paths) delete next[p];
      } else {
        for (const p of paths) next[p] = true;
      }
      return next;
    });
  }

  async function importSelected() {
    const s = server();
    const list = files().filter((f) => selected()[f.path]).map((f) => f.path);
    if (!s || list.length === 0 || importing()) return;
    setImporting(true);
    setImportTotal(list.length);
    setImportProgress(0);
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < list.length; i++) {
      setImportProgress(i + 1);
      try {
        await importDavFile(s, list[i]);
        ok++;
      } catch (err) {
        failed++;
        console.error("[webdav] 导入失败:", list[i], err);
      }
    }
    setImporting(false);
    setSelected({});
    if (failed === 0) showToast(`已导入 ${ok} 本书`);
    else if (ok === 0)
      showToast(`导入失败 ${failed} 本，请检查文件与网络`, true);
    else showToast(`导入 ${ok} 本，失败 ${failed} 本`, true);
  }

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/");
  }

  function onActivate() {
    setPath("");
  }

  const showBar = () => selectedCount() > 0 || importing();

  return (
    <div class="page">
      <PageHeader
        title="WebDAV 导入"
        onBack={goBack}
        backLabel="返回书架"
        right={
          <button
            class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label="配置 WebDAV 服务器"
            onClick={() => setConfigOpen(true)}
          >
            <SettingsIcon />
          </button>
        }
      />

      <div
        class="flex flex-col px-[18px] pt-1"
        classList={{
          "pb-[calc(112px+env(safe-area-inset-bottom))]": showBar(),
          "pb-[calc(28px+env(safe-area-inset-bottom))]": !showBar(),
        }}
      >
        <Show when={davReady()} fallback={<LoadingScreen label="读取配置…" />}>
          <Show
            when={server()}
            fallback={
              <div class="flex flex-col items-center gap-1 px-6 py-14 text-center text-text-3">
                <CloudIcon size={54} class="mb-2.5" />
                <p class="text-[15.5px] font-semibold text-text-2">
                  尚未激活 WebDAV 服务器
                </p>
                <p class="mb-[18px] mt-0.5 text-[12.5px] leading-[1.6]">
                  先配置并激活一台服务器，即可浏览远程书库导入
                </p>
                <button
                  class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-[22px] py-[11px] text-sm font-semibold text-on-accent shadow-lg shadow-accent/30 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                  onClick={() => setConfigOpen(true)}
                >
                  <ServerIcon size={17} />
                  配置服务器
                </button>
              </div>
            }
          >
            <Show
              when={dirList() !== null}
              fallback={
                <Show
                  when={error() === null}
                  fallback={
                    <div class="flex flex-col items-center gap-1 px-6 py-12 text-center">
                      <CloudIcon size={48} class="mb-2 text-text-3" />
                      <p class="max-w-[300px] text-[13px] leading-[1.6] text-text-2">
                        {error()}
                      </p>
                      <button
                        class="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-surface px-5 py-[9px] text-[13px] font-semibold text-text-2 shadow-sm transition-[scale] active:scale-[0.97]"
                        onClick={() => void loadDir()}
                      >
                        <RefreshIcon size={16} />
                        重试
                      </button>
                    </div>
                  }
                >
                  <LoadingScreen label="读取目录…" />
                </Show>
              }
            >
              {/* 导航：上级 / 路径 / 刷新 */}
              <div class="flex items-center gap-2">
                <button
                  class="grid h-9 w-9 flex-none place-items-center rounded-[10px] text-text-2 transition-colors disabled:opacity-35 active:bg-surface-2"
                  aria-label="返回上级目录"
                  disabled={!path()}
                  onClick={goUp}
                >
                  <ChevronLeftIcon size={19} />
                </button>
                <div class="flex min-w-0 flex-1 items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3 py-[8px]">
                  <FolderIcon size={15} class="flex-none text-accent" />
                  <span class="truncate text-[13px] font-medium text-text-2">
                    {pathLabel()}
                  </span>
                </div>
                <button
                  class="grid h-9 w-9 flex-none place-items-center rounded-[10px] text-text-2 transition-colors active:bg-surface-2"
                  aria-label="刷新当前目录"
                  onClick={() => void loadDir()}
                >
                  <RefreshIcon size={17} class={loading() ? "animate-spin" : undefined} />
                </button>
              </div>

              {/* 可选文件工具行 */}
              <Show when={files().length > 0}>
                <div class="flex items-center justify-between px-0.5 py-2">
                  <span class="text-[12px] text-text-3">
                    {files().length} 本可导入
                  </span>
                  <button
                    class="text-[12.5px] font-medium text-accent"
                    onClick={toggleSelectAll}
                  >
                    {allFilesSelected() ? "取消全选" : "全选本目录"}
                  </button>
                </div>
              </Show>

              <Show
                when={dirs().length > 0 || files().length > 0}
                fallback={
                  <div class="flex flex-col items-center gap-1 px-6 py-12 text-center text-text-3">
                    <FolderIcon size={44} class="mb-1.5" />
                    <p class="text-[13.5px] font-medium text-text-2">
                      当前目录没有可导入的内容
                    </p>
                  </div>
                }
              >
                <div class="divide-y divide-border overflow-hidden rounded-[16px] border border-border bg-surface">
                  <For each={dirs()}>
                    {(entry) => (
                      <button
                        class="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors active:bg-surface-2"
                        aria-label={`进入文件夹 ${entry.name}`}
                        onClick={() => enterDir(entry)}
                      >
                        <FolderIcon size={19} class="flex-none text-accent" />
                        <span class="min-w-0 flex-1 truncate text-[14px] font-medium">
                          {entry.name}
                        </span>
                        <ChevronLeftIcon
                          size={16}
                          class="flex-none rotate-180 text-text-3"
                        />
                      </button>
                    )}
                  </For>
                  <For each={files()}>
                    {(entry) => {
                      const isSelected = () => selected()[entry.path] ?? false;
                      return (
                        <div
                          class="flex items-center transition-colors active:bg-surface-2"
                          classList={{ "bg-accent-weak": isSelected() }}
                        >
                          <button
                            class="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-3 text-left"
                            aria-label={
                              isSelected()
                                ? `取消选择《${entry.name}》`
                                : `选择《${entry.name}》`
                            }
                            onClick={() => toggleFile(entry.path)}
                          >
                            <span
                              class="grid h-[21px] w-[21px] flex-none place-items-center rounded-full border-[1.8px] transition-colors"
                              classList={{
                                "border-accent bg-accent text-on-accent": isSelected(),
                                "border-text-3": !isSelected(),
                              }}
                              aria-hidden="true"
                            >
                              <Show when={isSelected()}>
                                <CheckIcon size={13} />
                              </Show>
                            </span>
                            <FileTextIcon
                              size={19}
                              class="flex-none text-text-2"
                            />
                            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                              <span class="truncate text-[14px] font-medium">
                                {entry.name}
                              </span>
                              <Show when={formatBytes(entry.size)}>
                                {(size) => (
                                  <span class="text-[11.5px] text-text-3">
                                    {size()}
                                  </span>
                                )}
                              </Show>
                            </span>
                          </button>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>

      {/* 多选导入操作条 */}
      <Show when={showBar()}>
        <div class="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[480px] border-t border-border bg-surface px-[18px] pb-[calc(10px+env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_28px_rgb(0_0_0/0.14)]">
          <div class="flex items-center gap-3">
            <Show
              when={importing()}
              fallback={
                <>
                  <span class="min-w-0 flex-1 truncate text-[13px] text-text-2">
                    已选 {selectedCount()} 本
                  </span>
                  <button
                    class="flex-none rounded-lg px-2 py-1 text-[12.5px] text-text-3 transition-colors active:bg-surface-2"
                    onClick={() => setSelected({})}
                  >
                    取消选择
                  </button>
                  <button
                    class="inline-flex flex-none items-center gap-1.5 rounded-xl bg-accent px-4 py-[10px] text-[13.5px] font-semibold text-on-accent shadow-lg shadow-accent/25 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                    onClick={() => void importSelected()}
                  >
                    导入所选（{selectedCount()}）
                  </button>
                </>
              }
            >
              <span
                class="size-4 flex-none animate-spin rounded-full border-2 border-surface-2 border-t-accent"
                aria-hidden="true"
              />
              <span class="flex-1 text-[13px] text-text-2">
                正在导入 {importProgress()}/{importTotal()}
              </span>
            </Show>
          </div>
        </div>
      </Show>

      <DavServerDrawer
        open={configOpen()}
        onClose={() => setConfigOpen(false)}
        onActivate={() => onActivate()}
      />
    </div>
  );
}

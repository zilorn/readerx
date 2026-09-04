import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import { Portal } from "solid-js/web";
import { useNavigate } from "@solidjs/router";
import { DavServerDrawer } from "../components/DavServerDrawer";
import { LoadingScreen } from "../components/LoadingScreen";
import { PageHeader } from "../components/PageHeader";
import {
  BookOpenIcon,
  CheckIcon,
  ChevronLeftIcon,
  CloudIcon,
  FileTextIcon,
  FolderIcon,
  RefreshIcon,
  ServerIcon,
  SettingsIcon,
} from "../components/icons";
import { localBookList } from "../lib/books";
import type { LocalBook } from "../lib/booksTypes";
import {
  activeDavServer,
  davEntryImportedBook,
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

/** 未导入书籍的文件行：点击切换勾选，供底部批量导入 */
function SelectableBookRow(props: {
  entry: DavEntry;
  selected: boolean;
  onToggle: (path: string) => void;
}) {
  return (
    <div
      class="flex items-center transition-colors active:bg-surface-2"
      classList={{ "bg-accent-weak": props.selected }}
    >
      <button
        class="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-3 text-left"
        aria-label={
          props.selected
            ? `取消选择《${props.entry.name}》`
            : `选择《${props.entry.name}》`
        }
        onClick={() => props.onToggle(props.entry.path)}
      >
        <span
          class="grid h-[21px] w-[21px] flex-none place-items-center rounded-full border-[1.8px] transition-colors"
          classList={{
            "border-accent bg-accent text-on-accent": props.selected,
            "border-text-3": !props.selected,
          }}
          aria-hidden="true"
        >
          <Show when={props.selected}>
            <CheckIcon size={13} />
          </Show>
        </span>
        <FileTextIcon size={19} class="flex-none text-text-2" />
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="truncate text-[14px] font-medium">{props.entry.name}</span>
          <Show when={formatBytes(props.entry.size)}>
            {(size) => <span class="text-[11.5px] text-text-3">{size()}</span>}
          </Show>
        </span>
      </button>
    </div>
  );
}

/** 已导入书籍的文件行：点击直接阅读本地副本，长按询问是否重新导入 */
function ImportedBookRow(props: {
  entry: DavEntry;
  book: LocalBook;
  onOpen: (bookId: string) => void;
  onLongPress: (entry: DavEntry) => void;
}) {
  let longPressTimer: number | undefined;
  let longPressFired = false;
  let downX = 0;
  let downY = 0;

  function onPointerDown(e: PointerEvent) {
    longPressFired = false;
    downX = e.clientX;
    downY = e.clientY;
    window.clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      longPressFired = true;
      props.onLongPress(props.entry);
    }, 480);
  }

  function onPointerMove(e: PointerEvent) {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 12) {
      window.clearTimeout(longPressTimer);
    }
  }

  function cancelLongPress() {
    window.clearTimeout(longPressTimer);
  }

  function onClick() {
    if (longPressFired) return;
    props.onOpen(props.book.id);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    props.onOpen(props.book.id);
  }

  return (
    <button
      type="button"
      class="flex w-full select-none items-center gap-3 px-3.5 py-3 text-left transition-colors active:bg-surface-2 touch-manipulation"
      aria-label={`打开《${props.entry.name}》阅读（已导入，长按可重新导入）`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onContextMenu={(e) => e.preventDefault()}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <BookOpenIcon size={19} class="flex-none text-success" />
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate text-[14px] font-medium">{props.entry.name}</span>
        <Show when={formatBytes(props.entry.size)}>
          {(size) => <span class="text-[11.5px] text-text-3">{size()}</span>}
        </Show>
      </span>
      <span class="flex-none rounded-full bg-accent-weak px-2 py-[3px] text-[10.5px] font-semibold text-accent">
        已导入
      </span>
    </button>
  );
}

/** 目录条目按类型分开渲染：文件夹可进入，书籍文件可勾选导入；已导入的书可直接阅读/长按重新导入 */
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
  const [reimportEntry, setReimportEntry] = createSignal<DavEntry | null>(null);
  const [reimporting, setReimporting] = createSignal(false);

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

  /** 远程书文件 → 本地已存在的同名书（按文件名匹配，远端有更新也识别为已导入） */
  const importedByPath = createMemo<Record<string, LocalBook>>(() => {
    const books = localBookList();
    const map: Record<string, LocalBook> = {};
    for (const f of files()) {
      const hit = davEntryImportedBook(f, books);
      if (hit) map[f.path] = hit;
    }
    return map;
  });

  /** 尚未导入、可勾选批量导入的文件 */
  const importableFiles = createMemo<DavEntry[]>(() =>
    files().filter((f) => !(f.path in importedByPath())),
  );
  /** 已在本地书架的文件（点击阅读 / 长按重新导入） */
  const importedFiles = createMemo<DavEntry[]>(() =>
    files().filter((f) => f.path in importedByPath()),
  );

  const pathLabel = createMemo(() => {
    const s = server();
    if (!s) return "";
    return s.name + (path() ? ` / ${path()}` : "");
  });

  const selectedCount = createMemo(() => Object.keys(selected()).length);
  const allFilesSelected = createMemo(
    () =>
      importableFiles().length > 0 &&
      importableFiles().every((f) => selected()[f.path]),
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
    const paths = importableFiles().map((f) => f.path);
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
    const list = importableFiles()
      .filter((f) => selected()[f.path])
      .map((f) => f.path);
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

  /** 点击已导入的行：直接打开本地副本阅读 */
  function openLocalBook(bookId: string) {
    navigate(`/book/${bookId}`);
  }

  /** 长按已导入的行：弹窗确认是否重新导入 */
  function requestReimport(entry: DavEntry) {
    setReimportEntry(entry);
  }

  /** 确认重新导入：用服务器最新文件原位替换本地书（保留进度/分组） */
  async function confirmReimport() {
    const srv = server();
    const entry = reimportEntry();
    if (!srv || !entry || reimporting()) return;
    setReimporting(true);
    try {
      const existing = importedByPath()[entry.path];
      const book = await importDavFile(srv, entry.path, existing);
      showToast(`已重新导入《${book.title}》`);
      setReimportEntry(null);
    } catch (err) {
      setReimportEntry(null);
      showToast(err instanceof Error ? err.message : "重新导入失败", true);
    } finally {
      setReimporting(false);
    }
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
                    {importableFiles().length} 本可导入
                    <Show when={importedFiles().length > 0}>
                      <span>，已导入 {importedFiles().length} 本</span>
                    </Show>
                  </span>
                  <Show when={importableFiles().length > 0}>
                    <button
                      class="text-[12.5px] font-medium text-accent"
                      onClick={toggleSelectAll}
                    >
                      {allFilesSelected() ? "取消全选" : "全选本目录"}
                    </button>
                  </Show>
                </div>
                <Show when={importedFiles().length > 0}>
                  <p class="px-0.5 pb-1 text-[11.5px] leading-[1.6] text-text-3">
                    已导入的书：点击直接阅读，长按可重新导入
                  </p>
                </Show>
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
                    {(entry) => (
                      <Show
                        when={importedByPath()[entry.path]}
                        fallback={
                          <SelectableBookRow
                            entry={entry}
                            selected={selected()[entry.path] ?? false}
                            onToggle={toggleFile}
                          />
                        }
                      >
                        {(book) => (
                          <ImportedBookRow
                            entry={entry}
                            book={book()}
                            onOpen={openLocalBook}
                            onLongPress={requestReimport}
                          />
                        )}
                      </Show>
                    )}
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

      {/* 重新导入确认弹窗 */}
      <Show when={reimportEntry()}>
        {(entry) => (
          <Portal>
            <div
              class="fixed inset-0 z-[80] grid place-items-center px-8"
              role="dialog"
              aria-modal="true"
              aria-label={`重新导入《${entry().name}》`}
            >
              <div
                class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
                onClick={() => setReimportEntry(null)}
              />
              <div class="relative w-full max-w-[330px] animate-pop-in overflow-hidden rounded-[18px] border border-border bg-surface p-4 shadow-[0_18px_50px_rgb(0_0_0/0.3)]">
                <p class="text-[15px] font-bold leading-snug">
                  重新导入《{entry().name}》？
                </p>
                <p class="mt-2 text-[12.5px] leading-[1.7] text-text-2">
                  这本书已导入本地书架。重新导入会用服务器上的最新文件替换本地内容，阅读进度与分组会保留。
                </p>
                <div class="mt-4 flex items-center gap-2.5">
                  <button
                    class="flex-1 rounded-xl border border-border bg-bg px-4 py-[10px] text-[13.5px] font-medium text-text-2 transition-colors active:bg-surface-2 disabled:opacity-50"
                    disabled={reimporting()}
                    onClick={() => setReimportEntry(null)}
                  >
                    取消
                  </button>
                  <button
                    class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-[10px] text-[13.5px] font-semibold text-on-accent shadow-lg shadow-accent/25 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90 disabled:opacity-60"
                    disabled={reimporting()}
                    onClick={() => void confirmReimport()}
                  >
                    <Show
                      when={reimporting()}
                      fallback="重新导入"
                    >
                      <span
                        class="size-3.5 flex-none animate-spin rounded-full border-2 border-on-accent/40 border-t-on-accent"
                        aria-hidden="true"
                      />
                      正在导入…
                    </Show>
                  </button>
                </div>
              </div>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
}

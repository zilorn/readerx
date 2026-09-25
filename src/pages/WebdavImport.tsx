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
  CloseIcon,
  CloudIcon,
  FileTextIcon,
  FolderIcon,
  RefreshIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
} from "../components/icons";
import {
  ensureLocalBooksLoaded,
  bookMetaList,
  replaceBookContent,
  type BookDraft,
} from "../lib/books";
import type { BookMeta } from "../lib/booksTypes";
import {
  previewBookmarkInheritance,
  type BookmarkInheritPreview,
} from "../lib/bookmarks";
import {
  activeDavServer,
  davEntryImportedBook,
  davReady,
  ensureWebDavLoaded,
  fetchDavBookDraft,
  formatBytes,
  importDavFile,
  isBookFileName,
  listDavDirectory,
  type DavEntry,
} from "../lib/webdav";
import { BookmarkRiskDialog } from "../components/BookmarkRiskDialog";
import { showToast } from "../lib/toast";
import { closeOnRouteChange } from "../lib/keptPage";
import { createLogger } from "../lib/logger";
import { t } from "../lib/i18n";

const log = createLogger("webdav");

let reloadSeq = 0;

/**
 * “重新导入”已确认但书签继承失效：等待用户决定是否仍替换（draft 已拉取，避免二次下载）
 */
interface PendingReimportRisk {
  existing: BookMeta;
  draft: BookDraft;
  preview: BookmarkInheritPreview;
}

/** 当前 dirList 快照对应的 (serverId, path)，用于避免重复解析同一目录 */
let listedDirKey: string | null = null;

/** 条目名是否包含搜索词（小写不区分大小写；空词放行全部） */
function nameMatchesQuery(name: string, query: string): boolean {
  return !query || name.toLowerCase().includes(query);
}

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
            ? t("webdav.entry.deselect", { name: props.entry.name })
            : t("webdav.entry.select", { name: props.entry.name })
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
  book: BookMeta;
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
      aria-label={t("webdav.entry.openImported", { name: props.entry.name })}
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
        {t("webdav.entry.imported")}
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
  const [bookmarkRisk, setBookmarkRisk] = createSignal<PendingReimportRisk | null>(null);
  const [riskImporting, setRiskImporting] = createSignal(false);
  const [keyword, setKeyword] = createSignal("");
  // 本页保活：离开时收起挂在 Portal 上的配置抽屉 / 重新导入弹窗
  closeOnRouteChange(() => {
    setConfigOpen(false);
    setReimportEntry(null);
    setBookmarkRisk(null);
  });

  createEffect(() => {
    void ensureWebDavLoaded();
    // 本地书清单用于“已导入”识别与重新导入，先确保载入
    void ensureLocalBooksLoaded();
  });

  const server = () => activeDavServer();

  /** 读取当前激活服务器指定路径的目录（带竞态序号，丢弃过期结果） */
  async function loadDir(opts?: { force?: boolean }) {
    const srv = server();
    const dir = path();
    // 已持有该目录的解析结果（例如刚从阅读页返回，本页常驻、不会重新挂载）：不重复请求
    if (!opts?.force && srv && dirList() !== null) {
      const listedFor = srv.id + "\u0000" + dir;
      if (listedDirKey === listedFor) {
        setError(null);
        setLoading(false);
        return;
      }
    }
    const seq = ++reloadSeq;
    setImporting(false);
    setSelected({});
    setKeyword("");
    setError(null);
    setLoading(true);
    setDirList(null);
    listedDirKey = null;
    if (!srv) {
      setLoading(false);
      return;
    }
    try {
      const entries = await listDavDirectory(srv, dir);
      if (seq !== reloadSeq) return;
      listedDirKey = srv.id + "\u0000" + dir;
      setDirList(entries);
    } catch (err) {
      if (seq !== reloadSeq) return;
      setDirList(null);
      setError(err instanceof Error ? err.message : t("webdav.error.listFailed"));
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

  const q = createMemo(() => keyword().trim().toLowerCase());

  const dirs = createMemo<DavEntry[]>(() =>
    (dirList() ?? []).filter(
      (e) => e.isDir && nameMatchesQuery(e.name, q()),
    ),
  );
  const files = createMemo<DavEntry[]>(() =>
    (dirList() ?? []).filter(
      (e) => !e.isDir && isBookFileName(e.name) && nameMatchesQuery(e.name, q()),
    ),
  );

  /** 远程书文件 → 本地已存在的同名书（按文件名匹配，远端有更新也识别为已导入） */
  const importedByPath = createMemo<Record<string, BookMeta>>(() => {
    const books = bookMetaList();
    const map: Record<string, BookMeta> = {};
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

  // 搜索词过滤后，剔除已不在可见列表中的勾选，保证全选 / 计数与所见一致
  createEffect(() => {
    const visible = importableFiles();
    const visibleSet = new Set(visible.map((f) => f.path));
    setSelected((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const key of keys) {
        if (visibleSet.has(key)) next[key] = prev[key];
        else changed = true;
      }
      return changed ? next : prev;
    });
  });

  function enterDir(entry: DavEntry) {
    setKeyword("");
    setPath(entry.path);
  }

  function goUp() {
    const dir = path();
    const idx = dir.lastIndexOf("/");
    setKeyword("");
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
        // 失败原因：WebDAV 下载 / 解析这一步（只记远端路径，不记服务器凭据）
        log.warn("WebDAV 导入失败", `path=${list[i]}`, err);
      }
    }
    setImporting(false);
    setSelected({});
    if (failed === 0) showToast(t("webdav.toast.importedCount", { count: ok }));
    else if (ok === 0)
      showToast(t("webdav.toast.importAllFailed", { count: failed }), true);
    else showToast(t("webdav.toast.importPartial", { ok, failed }), true);
  }

  /** 点击已导入的行：直接打开本地副本阅读（本页常驻，返回时目录、勾选与滚动位置原样还在） */
  function openLocalBook(bookId: string) {
    navigate(`/book/${bookId}`);
  }

  /** 长按已导入的行：弹窗确认是否重新导入 */
  function requestReimport(entry: DavEntry) {
    setReimportEntry(entry);
  }

  /** 确认重新导入：先拉取并解析远程最新文件，预演书签继承；失败时弹窗询问是否仍替换 */
  async function confirmReimport() {
    const srv = server();
    const entry = reimportEntry();
    if (!srv || !entry || reimporting()) return;
    setReimporting(true);
    try {
      await ensureLocalBooksLoaded();
      const existing = importedByPath()[entry.path];
      if (!existing) {
        setReimportEntry(null);
        showToast(t("webdav.toast.reimportMissing"), true);
        return;
      }
      const draft = await fetchDavBookDraft(srv, entry.path);
      const preview = await previewBookmarkInheritance(existing, draft.chapters);
      setReimportEntry(null);
      if (preview.failedCount > 0) {
        // 书签无法全部随新内容继承：弹窗提示，用户可放弃本次重新导入
        setBookmarkRisk({ existing, draft, preview });
        return;
      }
      const book = await replaceBookContent(existing, draft);
      showToast(t("webdav.toast.reimported", { title: book.title }));
    } catch (err) {
      setReimportEntry(null);
      showToast(
        err instanceof Error ? err.message : t("webdav.error.reimportFailed"),
        true,
      );
    } finally {
      setReimporting(false);
    }
  }

  /** 书签失效风险弹窗：用户仍决定替换本地内容 */
  async function confirmProceedWithRisk() {
    const pending = bookmarkRisk();
    if (!pending || riskImporting()) return;
    setRiskImporting(true);
    try {
      const book = await replaceBookContent(pending.existing, pending.draft);
      setBookmarkRisk(null);
      showToast(t("webdav.toast.reimported", { title: book.title }));
    } catch (err) {
      setBookmarkRisk(null);
      showToast(
        err instanceof Error ? err.message : t("webdav.error.reimportFailed"),
        true,
      );
    } finally {
      setRiskImporting(false);
    }
  }

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/");
  }

  function onActivate() {
    setKeyword("");
    setPath("");
  }

  const showBar = () => selectedCount() > 0 || importing();

  return (
    <div class="page">
      <PageHeader
        title={t("webdav.page.title")}
        onBack={goBack}
        backLabel={t("webdav.page.backToShelf")}
        right={
          <button
            class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label={t("webdav.page.configureServer")}
            onClick={() => setConfigOpen(true)}
          >
            <SettingsIcon />
          </button>
        }
      >
        {/* 浏览目录时吸顶的工具条：导航 / 搜索过滤 / 数量与全选 */}
        <Show when={dirList() !== null}>
          <div class="flex flex-col gap-2.5 px-[18px] pb-2.5 pt-1.5">
            {/* 导航：上级 / 路径 / 刷新 */}
            <div class="flex items-center gap-2">
              <button
                class="grid h-9 w-9 flex-none place-items-center rounded-[10px] text-text-2 transition-colors disabled:opacity-35 active:bg-surface-2"
                aria-label={t("webdav.dir.up")}
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
                aria-label={t("webdav.dir.refresh")}
                onClick={() => void loadDir({ force: true })}
              >
                <RefreshIcon size={17} class={loading() ? "animate-spin" : undefined} />
              </button>
            </div>

            {/* 搜索当前目录：按名称即时过滤文件夹与书文件 */}
            <div class="flex items-center gap-2 rounded-[12px] border border-border bg-surface px-3 transition-colors focus-within:border-accent">
              <SearchIcon size={17} class="flex-none text-text-3" />
              <input
                class="min-w-0 flex-1 bg-transparent py-[8px] text-[14px] text-text outline-none placeholder:text-text-3"
                type="text"
                placeholder={t("webdav.dir.searchPlaceholder")}
                aria-label={t("webdav.dir.searchLabel")}
                value={keyword()}
                onInput={(e) => setKeyword(e.currentTarget.value)}
              />
              <Show when={keyword()}>
                <button
                  class="grid h-6 w-6 flex-none place-items-center rounded-full text-text-3 transition-colors active:bg-surface-2"
                  type="button"
                  aria-label={t("webdav.dir.clearKeyword")}
                  onClick={() => setKeyword("")}
                >
                  <CloseIcon size={15} />
                </button>
              </Show>
            </div>

            {/* 可选文件工具行 */}
            <Show when={files().length > 0}>
              <div class="flex items-center justify-between px-0.5">
                <span class="text-[12px] text-text-3">
                  {t("webdav.dir.importableCount", { count: importableFiles().length })}
                  <Show when={importedFiles().length > 0}>
                    <span>{t("webdav.dir.importedCount", { count: importedFiles().length })}</span>
                  </Show>
                </span>
                <Show when={importableFiles().length > 0}>
                  <button
                    class="text-[12.5px] font-medium text-accent"
                    onClick={toggleSelectAll}
                  >
                    {allFilesSelected() ? t("common.deselectAll") : t("webdav.dir.selectAll")}
                  </button>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </PageHeader>

      <div
        class="flex flex-col px-[18px] pt-1"
        classList={{
          "pb-[calc(112px+env(safe-area-inset-bottom))]": showBar(),
          "pb-[calc(28px+env(safe-area-inset-bottom))]": !showBar(),
        }}
      >
        <Show when={davReady()} fallback={<LoadingScreen label={t("webdav.loading.config")} />}>
          <Show
            when={server()}
            fallback={
              <div class="flex flex-col items-center gap-1 px-6 py-14 text-center text-text-3">
                <CloudIcon size={54} class="mb-2.5" />
                <p class="text-[15.5px] font-semibold text-text-2">
                  {t("webdav.empty.noServerTitle")}
                </p>
                <p class="mb-[18px] mt-0.5 text-[12.5px] leading-[1.6]">
                  {t("webdav.empty.noServerDesc")}
                </p>
                <button
                  class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-[22px] py-[11px] text-sm font-semibold text-on-accent shadow-lg shadow-accent/30 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                  onClick={() => setConfigOpen(true)}
                >
                  <ServerIcon size={17} />
                  {t("webdav.action.configureServer")}
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
                        {t("common.retry")}
                      </button>
                    </div>
                  }
                >
                  <LoadingScreen label={t("webdav.loading.directory")} />
                </Show>
              }
            >
              <Show when={files().length > 0 && importedFiles().length > 0}>
                <p class="px-0.5 pb-1 text-[11.5px] leading-[1.6] text-text-3">
                  {t("webdav.hint.importedBooks")}
                </p>
              </Show>

              <Show
                when={dirs().length > 0 || files().length > 0}
                fallback={
                  <div class="flex flex-col items-center gap-1 px-6 py-12 text-center text-text-3">
                    <Show when={q()} fallback={<FolderIcon size={44} class="mb-1.5" />}>
                      <SearchIcon size={44} class="mb-1.5" />
                    </Show>
                    <p class="text-[13.5px] font-medium text-text-2">
                      {q()
                        ? t("webdav.empty.noMatch")
                        : t("webdav.empty.noImportable")}
                    </p>
                  </div>
                }
              >
                <div class="divide-y divide-border overflow-hidden rounded-[16px] border border-border bg-surface">
                  <For each={dirs()}>
                    {(entry) => (
                      <button
                        class="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors active:bg-surface-2"
                        aria-label={t("webdav.entry.enterDir", { name: entry.name })}
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
        <div class="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[var(--app-column)] border-t border-border bg-surface px-[18px] pb-[calc(10px+env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_28px_rgb(0_0_0/0.14)]">
          <div class="flex items-center gap-3">
            <Show
              when={importing()}
              fallback={
                <>
                  <span class="min-w-0 flex-1 truncate text-[13px] text-text-2">
                    {t("webdav.bar.selectedCount", { count: selectedCount() })}
                  </span>
                  <button
                    class="flex-none rounded-lg px-2 py-1 text-[12.5px] text-text-3 transition-colors active:bg-surface-2"
                    onClick={() => setSelected({})}
                  >
                    {t("webdav.bar.clearSelection")}
                  </button>
                  <button
                    class="inline-flex flex-none items-center gap-1.5 rounded-xl bg-accent px-4 py-[10px] text-[13.5px] font-semibold text-on-accent shadow-lg shadow-accent/25 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                    onClick={() => void importSelected()}
                  >
                    {t("webdav.bar.importSelected", { count: selectedCount() })}
                  </button>
                </>
              }
            >
              <span
                class="size-4 flex-none animate-spin rounded-full border-2 border-surface-2 border-t-accent"
                aria-hidden="true"
              />
              <span class="flex-1 text-[13px] text-text-2">
                {t("webdav.bar.importing", {
                  done: importProgress(),
                  total: importTotal(),
                })}
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
              aria-label={t("webdav.reimport.dialogLabel", { name: entry().name })}
            >
              <div
                class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
                onClick={() => setReimportEntry(null)}
              />
              <div class="relative w-full max-w-[330px] animate-pop-in overflow-hidden rounded-[18px] border border-border bg-surface p-4 shadow-[0_18px_50px_rgb(0_0_0/0.3)]">
                <p class="text-[15px] font-bold leading-snug">
                  {t("webdav.reimport.title", { name: entry().name })}
                </p>
                <p class="mt-2 text-[12.5px] leading-[1.7] text-text-2">
                  {t("webdav.reimport.desc")}
                </p>
                <div class="mt-4 flex items-center gap-2.5">
                  <button
                    class="flex-1 rounded-xl border border-border bg-bg px-4 py-[10px] text-[13.5px] font-medium text-text-2 transition-colors active:bg-surface-2 disabled:opacity-50"
                    disabled={reimporting()}
                    onClick={() => setReimportEntry(null)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-[10px] text-[13.5px] font-semibold text-on-accent shadow-lg shadow-accent/25 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90 disabled:opacity-60"
                    disabled={reimporting()}
                    onClick={() => void confirmReimport()}
                  >
                    <Show
                      when={reimporting()}
                      fallback={t("webdav.reimport.action")}
                    >
                      <span
                        class="size-3.5 flex-none animate-spin rounded-full border-2 border-on-accent/40 border-t-on-accent"
                        aria-hidden="true"
                      />
                      {t("webdav.reimport.checking")}
                    </Show>
                  </button>
                </div>
              </div>
            </div>
          </Portal>
        )}
      </Show>

      {/* 重新导入书签继承失效：仍可选择不重新导入 */}
      <Show when={bookmarkRisk()}>
        {(pending) => (
          <BookmarkRiskDialog
            bookTitle={pending().existing.title}
            preview={pending().preview}
            busy={riskImporting()}
            onCancel={() => {
              setBookmarkRisk(null);
              showToast(t("webdav.toast.reimportCancelled"));
            }}
            onProceed={() => void confirmProceedWithRisk()}
          />
        )}
      </Show>
    </div>
  );
}

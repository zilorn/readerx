import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { BookCover } from "../components/BookCover";
import { GroupPicker } from "../components/GroupPicker";
import { LoadingScreen } from "../components/LoadingScreen";
import { PageHeader } from "../components/PageHeader";
import { ImportButton } from "../components/ImportButton";
import {
  CheckIcon,
  CloseIcon,
  FolderIcon,
  LibraryIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from "../components/icons";
import {
  ensureLocalBooksLoaded,
  localBookById,
  localBooksReady,
  removeLocalBook,
  setLocalBookGroup,
} from "../lib/books";
import { bookSourceOf, type BookSource, type LocalBook } from "../lib/booksTypes";
import { groupList } from "../lib/groups";
import {
  hasReadingProgress,
  readingPercent,
  resolveReadingTarget,
} from "../lib/progress";
import {
  removeShelfEntry,
  setShelfSelecting,
  shelfOrder,
  type ShelfEntry,
} from "../lib/store";

interface ShelfItem {
  entry: ShelfEntry;
  book: LocalBook;
}

/** 书架来源筛选：全部 / 本地 / WebDAV */
type SourceFilter = "all" | BookSource;

/**
 * 按“正文文本位置”计算进度：已读章节累计字符 + 当前章节内偏移 → 整书百分比。
 * 不使用页码（受字号 / 版面影响），同一偏移在任意排版下都指向同一段文字。
 */
function cardProgress(entry: ShelfEntry, book: LocalBook): {
  hasRead: boolean;
  finished: boolean;
  percent: number;
} {
  const loc = resolveReadingTarget(book, entry);
  const hasRead = hasReadingProgress(entry);
  const percent = Math.round(
    readingPercent(book, loc?.chapterIndex ?? entry.chapter, loc?.charOffset ?? null),
  );
  const finished =
    hasRead &&
    loc !== null &&
    loc.chapterIndex + 1 >= book.chapters.length &&
    percent >= 99.5;
  return { hasRead, finished, percent: Math.max(1, Math.min(100, percent)) };
}

/** 单本书卡片：支持单击打开、长按进入多选、选中状态下点击切换选中 */
function BookCard(props: {
  item: ShelfItem;
  selectMode: boolean;
  selected: boolean;
  onOpen: (id: string) => void;
  onLongPress: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const { entry, book } = props.item;
  const { hasRead, finished, percent } = cardProgress(entry, book);

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
      if (!props.selectMode) props.onLongPress(book.id);
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
    if (props.selectMode) props.onToggle(book.id);
    else props.onOpen(book.id);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (props.selectMode) props.onToggle(book.id);
    else props.onOpen(book.id);
  }

  return (
    <div
      class="flex w-full select-none flex-col items-start gap-[5px] text-left touch-manipulation"
      role="button"
      tabindex={0}
      aria-label={
        props.selectMode
          ? props.selected
            ? `取消选中《${book.title}》`
            : `选中《${book.title}》`
          : `打开《${book.title}》`
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onContextMenu={(e) => e.preventDefault()}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <div class="relative w-full rounded-[10px]">
        <BookCover bookId={book.id} variant="grid" />
        <Show when={props.selectMode && props.selected}>
          <span class="absolute right-[5px] top-[5px] z-[2] grid h-[26px] w-[26px] animate-pop-in place-items-center rounded-full bg-accent text-on-accent shadow-md">
            <CheckIcon size={15} />
          </span>
          <span class="pointer-events-none absolute inset-0 rounded-[10px] ring-2 ring-accent" />
        </Show>
      </div>
      <span class="max-w-full truncate text-[13.5px] font-semibold">
        {book.title}
      </span>
      <Show when={hasRead}>
        <span
          class={`text-[11px] font-medium ${
            finished ? "text-success" : "text-accent"
          }`}
        >
          {finished ? "已读完" : `读到 ${percent}%`}
        </span>
        <span class="h-[3px] w-full overflow-hidden rounded-[2px] bg-surface-2" aria-hidden="true">
          <i
            class="block h-full rounded-[2px] bg-accent transition-[width] duration-200"
            style={{ width: `${finished ? 100 : percent}%` }}
          />
        </span>
      </Show>
    </div>
  );
}

interface ShelfGridProps {
  items: ShelfItem[];
  selectMode: boolean;
  selectedIds: string[];
  onOpen: (id: string) => void;
  onLongPress: (id: string) => void;
  onToggle: (id: string) => void;
}

function ShelfGrid(props: ShelfGridProps) {
  return (
    <div class="grid grid-cols-3 gap-x-3.5 gap-y-[22px] py-[2px] pb-1.5">
      <For each={props.items}>
        {(item) => (
          <BookCard
            item={item}
            selectMode={props.selectMode}
            selected={props.selectedIds.includes(item.book.id)}
            onOpen={props.onOpen}
            onLongPress={props.onLongPress}
            onToggle={props.onToggle}
          />
        )}
      </For>
    </div>
  );
}

function GroupChip(props: {
  label: string;
  active: boolean;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      class="inline-flex flex-none items-center gap-1.5 rounded-full px-3.5 py-[7px] text-[13px] transition-colors duration-150"
      classList={{
        "bg-accent text-on-accent font-semibold": props.active,
        "bg-surface text-text-2 border border-border": !props.active,
      }}
      onClick={props.onClick}
    >
      {props.label}
      <span class={props.active ? "text-on-accent/80" : "text-text-3"}>{props.count}</span>
    </button>
  );
}

export default function BookshelfPage() {
  const navigate = useNavigate();
  const [groupId, setGroupId] = createSignal<string>("all");
  const [sourceFilter, setSourceFilter] = createSignal<SourceFilter>("all");
  const [selecting, setSelecting] = createSignal(false);
  const [selectedIds, setSelectedIds] = createSignal<string[]>([]);
  const [groupPickerOpen, setGroupPickerOpen] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  let confirmTimer: number | undefined;

  onCleanup(() => {
    window.clearTimeout(confirmTimer);
    // 离开书架（页面卸载）时兜底复位，避免 AppShell 一直隐藏底部 Tab
    setShelfSelecting(false);
  });

  createEffect(() => {
    void ensureLocalBooksLoaded();
  });

  const items = createMemo<ShelfItem[]>(() =>
    shelfOrder()
      .map((entry) => {
        const book = localBookById(entry.bookId);
        return book ? { entry, book } : null;
      })
      .filter((item): item is ShelfItem => item !== null),
  );

  /** 书架内是否存在 WebDAV 导入的书（决定来源筛选行是否显示） */
  const hasWebdavBooks = createMemo(() =>
    items().some((item) => bookSourceOf(item.book) === "webdav"),
  );

  /** 实际生效的来源筛选：没有 WebDAV 书时来源行隐藏，一律视为全部 */
  const activeSource = createMemo<SourceFilter>(() =>
    hasWebdavBooks() ? sourceFilter() : "all",
  );

  /** 当前可见书架（分组筛选 × 来源筛选叠加） */
  const visibleItems = createMemo(() => {
    const gid = groupId();
    const src = activeSource();
    return items().filter((item) => {
      if (gid !== "all" && (item.book.groupId ?? null) !== gid) return false;
      if (src !== "all" && bookSourceOf(item.book) !== src) return false;
      return true;
    });
  });

  /** 分组 chips 数量：在当前来源筛选内统计（两行筛选叠加生效） */
  const groupCounts = createMemo<Record<string, number>>(() => {
    const src = activeSource();
    const counts: Record<string, number> = { all: 0 };
    for (const item of items()) {
      if (src !== "all" && bookSourceOf(item.book) !== src) continue;
      counts.all = (counts.all ?? 0) + 1;
      const gid = item.book.groupId ?? null;
      if (gid) counts[gid] = (counts[gid] ?? 0) + 1;
    }
    return counts;
  });

  /** 来源 chips 数量：在当前分组筛选内统计 */
  const sourceCounts = createMemo(() => {
    const gid = groupId();
    const counts = { all: 0, local: 0, webdav: 0 };
    for (const item of items()) {
      if (gid !== "all" && (item.book.groupId ?? null) !== gid) continue;
      counts.all++;
      if (bookSourceOf(item.book) === "webdav") counts.webdav++;
      else counts.local++;
    }
    return counts;
  });

  const openBook = (id: string) => navigate(`/book/${id}`);

  function toggleSelect(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  function onLongPress(id: string) {
    if (!selecting()) {
      setSelecting(true);
      setShelfSelecting(true);
      setConfirmDelete(false);
      setGroupPickerOpen(false);
    }
    toggleSelect(id);
  }

  function cancelSelect() {
    setSelecting(false);
    setShelfSelecting(false);
    setSelectedIds([]);
    setConfirmDelete(false);
    setGroupPickerOpen(false);
  }

  async function deleteSelected() {
    const ids = selectedIds();
    for (const id of ids) {
      try {
        await removeLocalBook(id);
        removeShelfEntry(id);
      } catch {
        /* 单本失败不影响其它 */
      }
    }
    cancelSelect();
  }

  async function moveSelectedToGroup(groupId: string | null) {
    const ids = selectedIds();
    for (const id of ids) {
      await setLocalBookGroup(id, groupId);
    }
    cancelSelect();
  }

  function sharedGroup(): string | null | undefined {
    const ids = selectedIds();
    if (ids.length === 0) return undefined;
    const groups = ids.map((id) => localBookById(id)?.groupId ?? null);
    return groups.every((g) => g === groups[0]) ? groups[0] : undefined;
  }

  function onRequestDelete() {
    if (selectedIds().length === 0) return;
    if (!confirmDelete()) {
      setConfirmDelete(true);
      window.clearTimeout(confirmTimer);
      confirmTimer = window.setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    window.clearTimeout(confirmTimer);
    setConfirmDelete(false);
    void deleteSelected();
  }

  const selectedCount = () => selectedIds().length;

  return (
    <div class="page relative">
      <PageHeader
        title={selecting() ? "选中书籍" : "书架"}
        subtitle={
          selecting()
            ? `已选 ${selectedCount()} 本`
            : visibleItems().length > 0
              ? `${visibleItems().length} 本在架`
              : undefined
        }
        right={
          selecting() ? (
            <button
              class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
              aria-label="取消选择"
              onClick={cancelSelect}
            >
              <CloseIcon />
            </button>
          ) : (
            <div class="flex flex-none items-center gap-1">
              <button
                class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                aria-label="搜索书架书籍"
                onClick={() => navigate("/shelf-search")}
              >
                <SearchIcon />
              </button>
              <ImportButton
                class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                ariaLabel="导入书籍"
              >
                <PlusIcon />
              </ImportButton>
            </div>
          )
        }
      >
        <div class="flex flex-col">
          <Show when={groupList().length > 0}>
            <div class="m-0.5 flex gap-2 overflow-x-auto px-[18px] pb-1 pt-2 scrollbar-none">
              <GroupChip
                label="全部"
                active={groupId() === "all"}
                count={groupCounts().all ?? 0}
                onClick={() => setGroupId("all")}
              />
              <For each={groupList()}>
                {(group) => (
                  <GroupChip
                    label={group.name}
                    active={groupId() === group.id}
                    count={groupCounts()[group.id] ?? 0}
                    onClick={() => setGroupId(group.id)}
                  />
                )}
              </For>
            </div>
          </Show>
          <Show when={hasWebdavBooks()}>
            <div
              class="m-0.5 flex gap-2 overflow-x-auto px-[18px] pb-1.5 scrollbar-none"
              classList={{ "pt-2": groupList().length === 0 }}
            >
              <GroupChip
                label="全部"
                active={activeSource() === "all"}
                count={sourceCounts().all}
                onClick={() => setSourceFilter("all")}
              />
              <GroupChip
                label="本地"
                active={activeSource() === "local"}
                count={sourceCounts().local}
                onClick={() => setSourceFilter("local")}
              />
              <GroupChip
                label="WebDAV"
                active={activeSource() === "webdav"}
                count={sourceCounts().webdav}
                onClick={() => setSourceFilter("webdav")}
              />
            </div>
          </Show>
        </div>
      </PageHeader>

      <div
        class="px-[18px] pt-1"
        classList={{
          // 多选时给底部固定操作条让位，避免最后一行书被遮住
          "pb-[calc(116px+env(safe-area-inset-bottom))]": selecting(),
          "pb-[calc(28px+env(safe-area-inset-bottom))]": !selecting(),
        }}
      >
        <Show when={localBooksReady()} fallback={<LoadingScreen label="加载本地书库…" />}>
          <Show
            when={visibleItems().length > 0}
            fallback={
              <div class="flex flex-col items-center gap-1 px-6 py-14 text-center text-text-3">
                <LibraryIcon size={56} class="mb-2.5" />
                <p class="text-[15.5px] font-semibold text-text-2">
                  {items().length === 0
                    ? "书架空空如也"
                    : groupId() !== "all" && activeSource() === "all"
                      ? "该分组暂无书籍"
                      : "没有符合条件的书籍"}
                </p>
                <p class="mb-[18px] mt-0.5 text-[12.5px] leading-[1.6]">
                  {items().length === 0
                    ? "导入 TXT / EPUB 到本地书架"
                    : groupId() !== "all" && activeSource() === "all"
                      ? "在书架顶部切回「全部」分组即可看到书"
                      : "切换书架顶部的筛选条件即可看到其它书籍"}
                </p>
                <ImportButton
                  class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-[22px] py-[11px] text-sm font-semibold text-on-accent shadow-lg shadow-accent/30 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                  ariaLabel="导入书籍"
                >
                  导入书籍
                </ImportButton>
              </div>
            }
          >
            <Show when={selecting()}>
              <p class="mx-0.5 mt-2.5 text-xs text-text-3">
                长按书籍进入多选；点击已选书籍可取消，底部可移动到分组或删除
              </p>
              <div class="mt-1">
                <ShelfGrid
                  items={visibleItems()}
                  selectMode
                  selectedIds={selectedIds()}
                  onOpen={openBook}
                  onLongPress={onLongPress}
                  onToggle={toggleSelect}
                />
              </div>
            </Show>
            <Show when={!selecting()}>
              <ShelfGrid
                items={visibleItems()}
                selectMode={false}
                selectedIds={[]}
                onOpen={openBook}
                onLongPress={onLongPress}
                onToggle={toggleSelect}
              />
            </Show>
          </Show>
        </Show>
      </div>

      {/* 多选底部操作条：固定贴住屏幕最底部（期间底部 Tab 由 AppShell 临时隐藏） */}
      <Show when={selecting()}>
        <div class="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[480px] animate-sheet-up border-t border-border bg-surface px-[18px] pb-[calc(10px+env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_28px_rgb(0_0_0/0.14)]">
          <Show when={selectedCount() > 0}>
            <div class="flex items-center gap-2.5">
              <button
                class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-bg px-0.5 py-[11px] text-[13.5px] font-medium text-text-2 transition-colors active:bg-surface-2"
                onClick={() => setGroupPickerOpen(true)}
              >
                <FolderIcon size={17} />
                移动到分组
              </button>
              <button
                class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-0.5 py-[11px] text-[13.5px] font-medium transition-colors"
                classList={{
                  "border-transparent bg-danger text-white": confirmDelete(),
                  "border-border bg-bg text-danger": !confirmDelete(),
                }}
                onClick={onRequestDelete}
              >
                <TrashIcon size={17} />
                {confirmDelete() ? "确认删除" : "删除"}
              </button>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={groupPickerOpen()}>
        <GroupPicker
          value={sharedGroup()}
          onSelect={(targetGroupId) => {
            void moveSelectedToGroup(targetGroupId);
          }}
          onClose={() => setGroupPickerOpen(false)}
        />
      </Show>
    </div>
  );
}

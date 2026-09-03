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
import { FolderIcon, LibraryIcon, PlusIcon, TrashIcon } from "../components/icons";
import {
  ensureLocalBooksLoaded,
  localBookById,
  localBooksReady,
  removeLocalBook,
  setLocalBookGroup,
} from "../lib/books";
import type { LocalBook } from "../lib/booksTypes";
import { groupList } from "../lib/groups";
import { removeShelfEntry, shelfOrder, type ShelfEntry } from "../lib/store";

interface ShelfItem {
  entry: ShelfEntry;
  book: LocalBook;
}

function progressPercent(entry: ShelfEntry, book: LocalBook): number {
  if (book.chapters.length === 0) return 0;
  const pct = Math.round(((entry.chapter + 1) / book.chapters.length) * 100);
  return Math.min(100, Math.max(1, pct));
}

interface ShelfGridProps {
  items: ShelfItem[];
  managing: boolean;
  confirmId: string | null;
  horizontal?: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onGroup: (id: string) => void;
}

function ShelfGrid(props: ShelfGridProps) {
  return (
    <div
      class={
        props.horizontal
          ? "flex w-max gap-4"
          : "grid grid-cols-3 gap-x-3.5 gap-y-[22px] py-[2px] pb-1.5"
      }
    >
      <For each={props.items}>
        {(item) => {
          const { entry, book } = item;
          const finished = entry.chapter + 1 >= book.chapters.length;
          const pct = progressPercent(entry, book);
          const openable = !props.managing;
          return (
            <div
              class={`flex flex-col items-start gap-[5px] text-left ${
                props.horizontal ? "w-24" : "w-full"
              }`}
            >
              <div
                class={`relative w-full rounded-[10px] ${
                  openable ? "cursor-pointer" : ""
                }`}
                role={openable ? "button" : undefined}
                tabindex={openable ? 0 : undefined}
                aria-label={openable ? `打开《${book.title}》` : undefined}
                onClick={() => openable && props.onOpen(book.id)}
                onKeyDown={(e) => {
                  if (openable && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    props.onOpen(book.id);
                  }
                }}
              >
                <BookCover
                  book={{ title: book.title, author: book.author, hue: book.hue, format: book.format }}
                  variant="grid"
                />
                <Show when={props.managing}>
                  <button
                    class="absolute left-[5px] top-[5px] z-[2] inline-flex h-[26px] w-[26px] items-center justify-center rounded-full bg-black/70 text-white backdrop-blur-sm transition-colors duration-150"
                    aria-label={`将《${book.title}》归入分组`}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onGroup(book.id);
                    }}
                  >
                    <FolderIcon size={13} />
                  </button>
                  <button
                    class={`absolute right-[5px] top-[5px] z-[2] inline-flex h-[26px] min-w-[26px] items-center justify-center gap-[3px] rounded-full px-[7px] text-[11px] font-semibold text-white transition-colors duration-150 ${
                      props.confirmId === book.id ? "bg-danger" : "bg-black/70 backdrop-blur-sm"
                    }`}
                    aria-label={props.confirmId === book.id ? "确认删除这本书" : `删除《${book.title}》`}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onDelete(book.id);
                    }}
                  >
                    {props.confirmId === book.id ? "确认" : <TrashIcon size={13} />}
                  </button>
                </Show>
              </div>
              <span class="max-w-full truncate text-[13.5px] font-semibold">
                {book.title}
              </span>
              <Show when={entry.chapter > 0}>
                <span
                  class={`text-[11px] font-medium ${
                    finished ? "text-success" : "text-accent"
                  }`}
                >
                  {finished ? "已读完" : `读到 ${pct}%`}
                </span>
                <span class="h-[3px] w-full overflow-hidden rounded-[2px] bg-surface-2" aria-hidden="true">
                  <i
                    class="block h-full rounded-[2px] bg-accent transition-[width] duration-200"
                    style={{ width: `${pct}%` }}
                  />
                </span>
              </Show>
            </div>
          );
        }}
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
  const [managing, setManaging] = createSignal(false);
  const [confirmId, setConfirmId] = createSignal<string | null>(null);
  const [assigningId, setAssigningId] = createSignal<string | null>(null);
  let confirmTimer: number | undefined;

  onCleanup(() => window.clearTimeout(confirmTimer));

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

  const visibleItems = createMemo(() => {
    const gid = groupId();
    return gid === "all"
      ? items()
      : items().filter((item) => (item.book.groupId ?? null) === gid);
  });

  const continuing = createMemo(() =>
    groupId() === "all" ? items().filter((item) => item.entry.chapter > 0) : [],
  );

  const groupCounts = createMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = { all: items().length };
    for (const item of items()) {
      const gid = item.book.groupId ?? null;
      if (gid) counts[gid] = (counts[gid] ?? 0) + 1;
    }
    return counts;
  });

  const openBook = (id: string) => navigate(`/book/${id}`);

  function toggleManage() {
    setManaging((value) => !value);
    setConfirmId(null);
    setAssigningId(null);
  }

  function requestDelete(id: string) {
    if (confirmId() === id) {
      window.clearTimeout(confirmTimer);
      setConfirmId(null);
      void deleteBook(id);
      return;
    }
    setConfirmId(id);
    window.clearTimeout(confirmTimer);
    confirmTimer = window.setTimeout(() => setConfirmId(null), 3000);
  }

  async function deleteBook(id: string) {
    try {
      await removeLocalBook(id);
      removeShelfEntry(id);
    } catch {
      /* 删除失败时保持原样即可 */
    }
    if (items().length <= 1) setManaging(false);
  }

  return (
    <div class="page relative">
      <PageHeader
        title="书架"
        subtitle={visibleItems().length > 0 ? `${visibleItems().length} 本在架` : undefined}
        right={
          <div class="flex flex-none items-center gap-0.5">
            <ImportButton
              class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
              ariaLabel="导入本地书籍"
            >
              <PlusIcon />
            </ImportButton>
            <Show when={items().length > 0}>
              <button
                class={`grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,color,scale] duration-150 active:scale-[0.94] active:bg-surface-2 ${
                  managing() ? "bg-accent-weak text-accent" : ""
                }`}
                aria-label={managing() ? "退出管理" : "管理书籍"}
                onClick={toggleManage}
              >
                <TrashIcon />
              </button>
            </Show>
          </div>
        }
      >
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
      </PageHeader>

      <div class="px-[18px] pb-[calc(28px+env(safe-area-inset-bottom))] pt-1">
        <Show when={localBooksReady()} fallback={<LoadingScreen label="加载本地书库…" />}>
          <Show
            when={visibleItems().length > 0}
            fallback={
              <div class="flex flex-col items-center gap-1 px-6 py-14 text-center text-text-3">
                <LibraryIcon size={56} class="mb-2.5" />
                <p class="text-[15.5px] font-semibold text-text-2">
                  {groupId() === "all" ? "书架空空如也" : "该分组暂无书籍"}
                </p>
                <p class="mb-[18px] mt-0.5 text-[12.5px] leading-[1.6]">
                  {groupId() === "all"
                    ? "导入 TXT / EPUB，或在发现页连接 TransBook 下载书籍到本地"
                    : "在管理模式下点开书籍封面左上角，即可将它归入这个分组"}
                </p>
                <ImportButton
                  class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-[22px] py-[11px] text-sm font-semibold text-on-accent shadow-lg shadow-accent/30 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                  ariaLabel="导入本地书籍"
                >
                  导入本地书籍
                </ImportButton>
              </div>
            }
          >
            <Show when={managing()}>
              <p class="mx-0.5 mt-2.5 text-xs text-text-3">
                点击封面右上角删除，再点一次确认；左上角图标可将书籍归入分组
              </p>
            </Show>
            <Show when={!managing() && continuing().length > 0}>
              <section>
                <h2 class="mx-0.5 mb-3 mt-5 text-[15px] font-semibold tracking-[0.02em]">
                  继续阅读
                </h2>
                <div class="-mx-[18px] overflow-x-auto px-[18px] pb-1 scrollbar-none">
                  <ShelfGrid
                    items={continuing()}
                    managing={false}
                    confirmId={null}
                    horizontal
                    onOpen={openBook}
                    onDelete={requestDelete}
                    onGroup={() => undefined}
                  />
                </div>
              </section>
              <section>
                <h2 class="mx-0.5 mb-3 mt-5 text-[15px] font-semibold tracking-[0.02em]">
                  全部书籍
                </h2>
                <ShelfGrid
                  items={visibleItems()}
                  managing={false}
                  confirmId={null}
                  onOpen={openBook}
                  onDelete={requestDelete}
                  onGroup={() => undefined}
                />
              </section>
            </Show>
            <Show when={managing() || continuing().length === 0}>
              <ShelfGrid
                items={visibleItems()}
                managing={managing()}
                confirmId={confirmId()}
                onOpen={openBook}
                onDelete={requestDelete}
                onGroup={(id) => setAssigningId(id)}
              />
            </Show>
          </Show>
        </Show>
      </div>

      <Show when={assigningId()}>
        <GroupPicker
          value={items().find((item) => item.book.id === assigningId())?.book.groupId}
          onSelect={(targetGroupId) => {
            const item = items().find((it) => it.book.id === assigningId());
            if (item) void setLocalBookGroup(item.book.id, targetGroupId);
          }}
          onClose={() => setAssigningId(null)}
        />
      </Show>
    </div>
  );
}

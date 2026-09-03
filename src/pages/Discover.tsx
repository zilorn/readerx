import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { BookCover } from "../components/BookCover";
import { LoadingScreen } from "../components/LoadingScreen";
import { PageHeader } from "../components/PageHeader";
import {
  ChevronRightIcon,
  CompassIcon,
  DownloadIcon,
  LinkIcon,
  RefreshIcon,
} from "../components/icons";
import { importCloudBookToLocal } from "../lib/books";
import { ensureShelfEntry } from "../lib/store";
import {
  currentTransbookUrl,
  fetchTransBooks,
  fetchTransGroups,
  initTransbookConfig,
  saveTransbookUrl,
  transHue,
  transbookReady,
  type TransBook,
  type TransGroup,
} from "../lib/transbook";

function displayTitle(book: TransBook): string {
  return book.title_translated || book.title || "未命名书籍";
}

function BookRow(props: { book: TransBook; onOpen: () => void }) {
  const book = props.book;
  const title = () => displayTitle(book);
  const hue = transHue(title() || book.id);
  return (
    <button
      class="flex w-full items-center gap-3 rounded-[12px] border border-border bg-surface p-2.5 text-left transition-colors active:bg-surface-2"
      onClick={props.onOpen}
      aria-label={`打开《${title()}》`}
    >
      <BookCover
        book={{ title: title(), author: book.author, hue, format: book.format ?? "txt" }}
        variant="thumb"
      />
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="truncate text-[15px] font-semibold">{title()}</span>
        <span class="truncate text-[12px] text-text-3">
          {book.author || "佚名"} · {book.chapters} 章
        </span>
        <span class="flex items-center gap-1.5 text-[11px] text-text-3">
          <span class="rounded-md bg-surface-2 px-1.5 py-[2px] tracking-[0.04em]">
            {(book.format ?? "txt").toUpperCase()}
          </span>
          <Show when={book.done != null && book.chapters > 0}>
            <span>{Math.round(((book.done ?? 0) / book.chapters) * 100)}% 已翻译</span>
          </Show>
        </span>
      </div>
      <ChevronRightIcon size={18} class="flex-none text-text-3" />
    </button>
  );
}

function GroupChip(props: {
  label: string;
  active: boolean;
  count?: number;
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
      <Show when={props.count != null}>
        <span class={props.active ? "text-on-accent/80" : "text-text-3"}>
          {props.count}
        </span>
      </Show>
    </button>
  );
}

export default function DiscoverPage() {
  const navigate = useNavigate();
  const [connectInput, setConnectInput] = createSignal("");
  const [groups, setGroups] = createSignal<TransGroup[]>([]);
  const [books, setBooks] = createSignal<TransBook[]>([]);
  const [activeGroup, setActiveGroup] = createSignal<string>("all");
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [download, setDownload] = createSignal<{
    remoteId: string;
    title: string;
    done: number;
    total: number;
    error: string | null;
  } | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const [gs, bs] = await Promise.all([fetchTransGroups(), fetchTransBooks()]);
      setGroups(gs);
      setBooks(bs);
      setActiveGroup((prev) =>
        prev === "all" || gs.some((group) => group.id === prev) ? prev : "all",
      );
    } catch (err) {
      setGroups([]);
      setBooks([]);
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    void initTransbookConfig();
  });

  createEffect(
    on(transbookReady, (ready) => {
      if (ready) setConnectInput(currentTransbookUrl());
    }),
  );

  createEffect(
    on(
      [transbookReady, currentTransbookUrl],
      async ([ready, url]) => {
        if (!ready) return;
        if (!url) {
          setGroups([]);
          setBooks([]);
          setActiveGroup("all");
          setError(null);
          setLoading(false);
          return;
        }
        await reload();
      },
    ),
  );

  const visibleBooks = createMemo(() => {
    const gid = activeGroup();
    return gid === "all" ? books() : books().filter((book) => book.group_id === gid);
  });

  const view = createMemo(() => {
    if (!transbookReady()) return "init";
    if (!currentTransbookUrl()) return "empty";
    if (loading()) return "loading";
    if (error()) return "error";
    return "list";
  });

  return (
    <div class="page">
      <PageHeader
        title="发现"
        subtitle={currentTransbookUrl() ? "TransBook" : undefined}
        right={
          <Show when={view() === "list"}>
            <button
              class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
              aria-label="刷新书架"
              onClick={() => void reload()}
            >
              <RefreshIcon />
            </button>
          </Show>
        }
      />

      <div class="px-[18px] pb-[calc(28px+env(safe-area-inset-bottom))] pt-1">
        <Show when={view() !== "init"} fallback={<LoadingScreen label="连接初始化…" />}>
          <Show
            when={view() === "empty"}
            fallback={
              <MaybeList
                loading={loading()}
                error={error()}
                onRetry={() => void reload()}
              />
            }
          >
            {/* 未配置书源 */}
            <div class="flex flex-col items-center gap-1 px-6 pb-5 pt-6 text-center text-text-3">
              <CompassIcon size={52} class="mb-2.5" />
              <p class="text-[15.5px] font-semibold text-text-2">还没有连接书源</p>
              <p class="mb-4 mt-0.5 text-[12.5px] leading-[1.6]">
                输入 TransBook 服务器地址，即可浏览并下载远程书籍
              </p>
              <div class="flex w-full max-w-[300px] items-center gap-2">
                <input
                  type="url"
                  placeholder="http://192.168.0.104:8300"
                  value={connectInput()}
                  onInput={(e) => setConnectInput(e.currentTarget.value)}
                  class="min-w-0 flex-1 rounded-[10px] border border-border bg-surface px-3 py-[10px] text-[14px] text-text outline-none transition-colors placeholder:text-text-3 focus:border-accent"
                  aria-label="TransBook 服务器地址"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void connect();
                  }}
                />
                <button
                  class="inline-flex h-[40px] flex-none items-center justify-center gap-1.5 rounded-[10px] bg-accent px-[18px] text-sm font-semibold text-on-accent shadow-lg shadow-accent/30 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                  onClick={() => void connect()}
                >
                  <LinkIcon size={16} />
                  连接
                </button>
              </div>
            </div>
          </Show>
        </Show>

        <Show when={view() === "list"}>
      <BookListView
            groups={groups()}
            books={visibleBooks()}
            total={books().length}
            activeGroup={activeGroup()}
            onSelectGroup={setActiveGroup}
            onOpenBook={openBook}
          />
        </Show>
      </div>

      <Show when={download()}>
        {(d) => (
          <div class="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-bg/90 px-6 text-center backdrop-blur-[2px]">
            <DownloadIcon size={48} class="mb-1 text-accent" />
            <p class="text-[15px] font-semibold text-text-2">
              正在下载《{d().title}》
            </p>
            <Show when={d().error} fallback={<>
              <div class="h-[6px] w-full max-w-[300px] overflow-hidden rounded-[3px] bg-surface-2">
                <i
                  class="block h-full rounded-[3px] bg-accent transition-[width] duration-150"
                  style={{ width: `${percent(d().done, d().total)}%` }}
                />
              </div>
              <span class="text-[12px] text-text-3 tabular-nums">
                {d().done} / {d().total}
              </span>
            </>}>
              <p class="max-w-[300px] text-[12.5px] text-danger">{d().error}</p>
              <button
                class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-[22px] py-[10px] text-sm font-semibold text-on-accent shadow-lg shadow-accent/30"
                onClick={() => setDownload(null)}
              >
                关闭
              </button>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );

  async function connect() {
    await saveTransbookUrl(connectInput());
  }

  async function openBook(remoteBook: TransBook) {
    const title = displayTitle(remoteBook);
    setDownload({ remoteId: remoteBook.id, title, done: 0, total: 0, error: null });
    try {
      const book = await importCloudBookToLocal(
        remoteBook.id,
        currentTransbookUrl(),
        (done, total) => setDownload((prev) => (prev ? { ...prev, done, total } : prev)),
      );
      ensureShelfEntry(book.id);
      setDownload(null);
      navigate(`/book/${book.id}`);
    } catch (err) {
      setDownload({
        remoteId: remoteBook.id,
        title,
        done: 0,
        total: 0,
        error: err instanceof Error ? err.message : "下载失败",
      });
    }
  }
}

function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

function MaybeList(props: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (props.loading) return <LoadingScreen label="连接书源…" />;
  return (
    <div class="flex flex-col items-center gap-1 px-6 py-14 text-center text-text-3">
      <CompassIcon size={52} class="mb-2.5" />
      <p class="text-[15.5px] font-semibold text-text-2">无法连接 TransBook</p>
      <p class="mb-[18px] mt-0.5 text-[12.5px] leading-[1.6]">
        {props.error ?? "加载失败"}
      </p>
      <button
        class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-[22px] py-[11px] text-sm font-semibold text-on-accent shadow-lg shadow-accent/30 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
        onClick={props.onRetry}
      >
        重试
      </button>
    </div>
  );
}

function BookListView(props: {
  groups: TransGroup[];
  books: TransBook[];
  total: number;
  activeGroup: string;
  onSelectGroup: (id: string) => void;
  onOpenBook: (book: TransBook) => void;
}) {
  return (
    <>
      <Show when={props.groups.length > 0}>
        <div class="-mx-[18px] mb-3 flex gap-2 overflow-x-auto px-[18px] pb-1 scrollbar-none">
          <GroupChip
            label="全部"
            count={props.total}
            active={props.activeGroup === "all"}
            onClick={() => props.onSelectGroup("all")}
          />
          <For each={props.groups}>
            {(group) => (
              <GroupChip
                label={group.name}
                count={group.count}
                active={props.activeGroup === group.id}
                onClick={() => props.onSelectGroup(group.id)}
              />
            )}
          </For>
        </div>
      </Show>

      <Show
        when={props.books.length > 0}
        fallback={
          <EmptyState
            title="这个书源暂时没有书籍"
            desc="切换到其他分组，或确认 TransBook 书架里已有书目"
          />
        }
      >
        <div class="flex flex-col gap-3">
          <For each={props.books}>
            {(book) => (
              <BookRow book={book} onOpen={() => props.onOpenBook(book)} />
            )}
          </For>
        </div>
      </Show>
    </>
  );
}

function EmptyState(props: { title: string; desc: string }) {
  return (
    <div class="flex flex-col items-center gap-1 px-6 py-14 text-center text-text-3">
      <CompassIcon size={52} class="mb-2.5" />
      <p class="text-[15.5px] font-semibold text-text-2">{props.title}</p>
      <p class="mt-0.5 text-[12.5px] leading-[1.6]">{props.desc}</p>
    </div>
  );
}

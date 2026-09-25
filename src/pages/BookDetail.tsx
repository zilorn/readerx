import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { LoadingScreen } from "../components/LoadingScreen";
import { PageHeader } from "../components/PageHeader";
import { BookCover } from "../components/BookCover";
import { BookMetaSheet } from "../components/BookMetaSheet";
import { TagChips } from "../components/TagChips";
import { QuickSearchText } from "../components/QuickSearchText";
import { EditIcon, LinkIcon, RefreshIcon } from "../components/icons";
import { openExternal } from "../lib/external";
import {
  ensureLocalBooksLoaded,
  bookMetaById,
  bookMetasReady,
} from "../lib/books";
import {
  bookSourceOf,
  formatFileSize,
  isOnlineBook,
  type BookFormat,
  type BookMeta,
} from "../lib/booksTypes";
import { withHanMeta } from "../lib/hanDisplay";
import { t } from "../lib/i18n";
import { refreshOnlineBookInfo } from "../lib/online";
import { showToast } from "../lib/toast";
import { groupDisplayName } from "../lib/groups";
import { bookDisplayAuthor, bookDisplayTitle, isFallbackBookAuthor } from "../lib/bookDisplay";

function formatName(format: BookFormat): string {
  if (format === "online") return t("book.detail.online");
  if (format === "epub") return "EPUB";
  if (format === "pdf") return "PDF";
  if (format === "txt") return "TXT";
  return format;
}

function sourceName(book: BookMeta): string {
  const source = bookSourceOf(book);
  return source === "online"
    ? t("book.detail.online")
    : source === "webdav"
      ? t("book.detail.webdavImport")
      : t("book.detail.localImport");
}

function formatImportedAt(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface MetaRow {
  label: string;
  value: string;
  /** 在线书书源地址：存在时该行可点击，用系统浏览器打开原网页 */
  url?: string;
}

function bookMetaRows(book: BookMeta): MetaRow[] {
  const chars = book.chapters.reduce((sum, chapter) => sum + (chapter.chars || 0), 0);
  const rows: MetaRow[] = [
    { label: t("book.field.title"), value: bookDisplayTitle(book.title) },
    { label: t("book.field.author"), value: bookDisplayAuthor(book.author) },
    { label: t("book.field.format"), value: formatName(book.format) },
    { label: t("book.field.source"), value: sourceName(book) },
    ...(book.format === "online" && book.bookUrl
      ? [{ label: t("book.field.bookUrl"), value: book.bookUrl, url: book.bookUrl }]
      : []),
    {
      label: t("book.field.chapters"),
      value: t("book.detail.chapterCount", { count: book.chapters.length }),
    },
    ...(chars > 0
      ? [{ label: t("book.field.chars"), value: t("book.detail.charCount", { count: chars }) }]
      : []),
    ...(book.size > 0 ? [{ label: t("book.field.size"), value: formatFileSize(book.size) }] : []),
    { label: t("book.field.file"), value: book.fileName },
    {
      label: t("book.field.group"),
      value: groupDisplayName(book.groupId) || t("common.ungrouped"),
    },
    { label: t("book.field.importedAt"), value: formatImportedAt(book.importedAt) },
  ];
  return rows;
}

/** 详情列表行：书源地址行为整行可点击，点击用浏览器打开原网页 */
function MetaRowItem(props: { row: MetaRow }) {
  const label = () => props.row.label;
  const value = () => props.row.value;
  return (
    <Show
      when={props.row.url}
      fallback={
        <div class="flex items-start gap-4 px-4 py-[10px]">
          <span class="w-[64px] flex-none text-[12.5px] text-text-3">{label()}</span>
          <span class="min-w-0 flex-1 break-words text-[12.5px] leading-[1.6] text-text">
            {value()}
          </span>
        </div>
      }
    >
      {(url) => (
        <button
          type="button"
          class="flex w-full items-start gap-4 px-4 py-[10px] text-left transition-[background-color] duration-150 active:bg-surface-2"
          aria-label={t("book.detail.openInBrowser", { name: label() })}
          onClick={() => void openExternal(url())}
        >
          <span class="w-[64px] flex-none text-[12.5px] text-text-3">{label()}</span>
          <span class="min-w-0 flex-1 break-words text-[12.5px] leading-[1.6] text-accent">
            {value()}
          </span>
          <LinkIcon size={15} class="mt-[3px] flex-none text-text-3" />
        </button>
      )}
    </Show>
  );
}

export default function BookDetailPage() {
  const navigate = useNavigate();
  const params = useParams();

  const bookId = () => params.id ?? "";
  const book = createMemo(() => bookMetaById(bookId()));
  /** 展示用副本（简繁转换）；编辑抽屉与「重新拉取书籍信息」一律用原始记录，避免把转换结果写回书库 */
  const displayBook = createMemo(() => withHanMeta(book()));
  const [editOpen, setEditOpen] = createSignal(false);
  /** 在线书：重新拉取简介 / 封面 / 标签（书源 bookDetail）是否进行中 */
  const [refreshing, setRefreshing] = createSignal(false);

  createEffect(() => {
    void ensureLocalBooksLoaded();
  });

  /** 该书是仍在书架、可向书源重新拉取简介 / 封面 / 标签的在线书 */
  const refreshable = createMemo(() => {
    const current = book();
    return (
      !!current &&
      isOnlineBook(current) &&
      !!current.bookSourceId &&
      !!current.bookUrl
    );
  });

  async function refreshBookInfo(): Promise<void> {
    if (refreshing()) return;
    const id = bookId();
    if (!refreshable()) return;
    setRefreshing(true);
    try {
      const result = await refreshOnlineBookInfo(id);
      const updated: string[] = [];
      if (result.introUpdated) updated.push(t("book.field.intro"));
      if (result.coverUpdated) updated.push(t("book.field.cover"));
      if (result.tagsUpdated) updated.push(t("book.field.tags"));
      showToast(
        updated.length > 0
          ? t("book.detail.updated", {
              fields: updated.join(t("book.detail.fieldSeparator")),
            })
          : t("book.detail.upToDate"),
      );
    } catch (e) {
      showToast(
        t("book.detail.refreshFailed", {
          reason: e instanceof Error ? e.message : String(e),
        }),
        true,
      );
    } finally {
      setRefreshing(false);
    }
  }

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/");
  }

  /** 点击标签 / 书名 / 作者：跳去发现页按该词做一次全源快速搜索 */
  function quickSearch(keyword: string) {
    const kw = keyword.trim();
    if (!kw) return;
    navigate(`/discover?q=${encodeURIComponent(kw)}`);
  }

  /** 展示用作者名（空作者不显示为可搜索，避免搜「佚名」） */
  // 展示层：落库兜底作者（佚名）当成「没有作者」，既不显示成中文也不拿它去搜索
  const authorName = createMemo(() => {
    const author = displayBook()?.author;
    return isFallbackBookAuthor(author) ? "" : (author?.trim() ?? "");
  });

  const rows = createMemo(() => {
    const current = displayBook();
    return current ? bookMetaRows(current) : [];
  });

  return (
    <div class="page">
      <PageHeader
        title={t("book.detail.title")}
        onBack={goBack}
        right={
          <Show when={book()}>
            <div class="flex items-center gap-1">
              <Show when={refreshable()}>
                <button
                  class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2 disabled:pointer-events-none disabled:opacity-60"
                  aria-label={t("book.detail.refresh")}
                  disabled={refreshing()}
                  onClick={() => void refreshBookInfo()}
                >
                  <Show when={refreshing()} fallback={<RefreshIcon size={20} />}>
                    <RefreshIcon size={20} class="animate-spin" />
                  </Show>
                </button>
              </Show>
              <button
                class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                aria-label={t("book.meta.title")}
                onClick={() => setEditOpen(true)}
              >
                <EditIcon size={20} />
              </button>
            </div>
          </Show>
        }
      />

      <Show
        when={bookMetasReady()}
        fallback={<LoadingScreen label={t("book.detail.loading")} />}
      >
        <Show
          when={book()}
          fallback={
            <div class="flex flex-col items-center gap-4 px-6 py-24 text-center text-sm text-text-2">
              <p>{t("book.detail.notFound")}</p>
              <button
                class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-5.5 py-2.75 text-sm font-semibold text-on-accent shadow-lg shadow-accent/30 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                onClick={goBack}
              >
                {t("common.back")}
              </button>
            </div>
          }
        >
          <div class="flex flex-col gap-5 px-[18px] pb-[calc(36px+env(safe-area-inset-bottom))] pt-2">
            {/* 封面 + 核心信息 */}
            <div class="flex gap-4">
              <div class="w-[112px] flex-none">
                <BookCover bookId={book()!.id} variant="thumb" />
              </div>
              <div class="flex min-w-0 flex-1 flex-col justify-center gap-2">
                <h2 class="text-[18px] font-bold leading-snug">
                  <QuickSearchText
                    text={displayBook()!.title}
                    action={t("book.detail.searchTitle")}
                    iconSize={14}
                    iconClass="mt-[5px]"
                    onSearch={quickSearch}
                  />
                </h2>
                <p class="text-[13px] leading-snug text-text-3">
                  <Show
                    when={authorName()}
                    fallback={<span>{t("common.anonymousAuthor")}</span>}
                  >
                    {(author) => (
                      <QuickSearchText
                        text={author()}
                        action={t("book.detail.searchAuthor")}
                        iconSize={12}
                        iconClass="mt-[3px]"
                        onSearch={quickSearch}
                      />
                    )}
                  </Show>
                </p>
                <div class="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <span class="rounded-full bg-accent-weak px-2 py-0.5 text-[11px] font-semibold text-accent">
                    {formatName(book()!.format)}
                  </span>
                  <span class="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-3">
                    {sourceName(book()!)}
                  </span>
                </div>
              </div>
            </div>

            {/* 标签 */}
            <section>
              <h3 class="mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
                {t("book.field.tags")}
              </h3>
              <Show
                when={(displayBook()!.tags?.length ?? 0) > 0}
                fallback={
                  <div class="flex min-h-[44px] items-center justify-center rounded-[14px] border border-dashed border-border bg-surface px-4 text-center text-[12.5px] leading-[1.7] text-text-3">
                    {t("book.detail.tagsEmpty")}
                  </div>
                }
              >
                <div class="flex flex-wrap gap-1.5 pt-0.5">
                  <TagChips
                    tags={displayBook()!.tags ?? []}
                    onTagClick={quickSearch}
                  />
                </div>
              </Show>
            </section>

            {/* 简介 */}
            <section>
              <h3 class="mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
                {t("book.field.intro")}
              </h3>
              <Show
                when={displayBook()!.intro}
                fallback={
                  <div class="flex min-h-[72px] items-center justify-center rounded-[14px] border border-dashed border-border bg-surface px-4 text-center text-[12.5px] leading-[1.7] text-text-3">
                    {t("book.detail.introEmpty")}
                  </div>
                }
              >
                <p class="whitespace-pre-wrap break-words rounded-[14px] border border-border bg-surface px-3.5 py-3 text-[12.5px] leading-[1.75] text-text-2">
                  {displayBook()!.intro}
                </p>
              </Show>
            </section>

            {/* 其它元信息 */}
            <section>
              <h3 class="mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
                {t("common.details")}
              </h3>
              <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
                <For each={rows()}>
                  {(row) => <MetaRowItem row={row} />}
                </For>
              </div>
            </section>
          </div>
        </Show>
      </Show>

      {/* 编辑书籍信息抽屉（每次打开重新挂载，表单初值来自当前书籍） */}
      <Show when={editOpen() && book()}>
        {(current) => (
          <BookMetaSheet
            book={current()}
            onClose={() => setEditOpen(false)}
          />
        )}
      </Show>
    </div>
  );
}

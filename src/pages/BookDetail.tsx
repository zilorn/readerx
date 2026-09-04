import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { LoadingScreen } from "../components/LoadingScreen";
import { PageHeader } from "../components/PageHeader";
import { BookCover } from "../components/BookCover";
import { BookMetaSheet } from "../components/BookMetaSheet";
import { EditIcon } from "../components/icons";
import {
  ensureLocalBooksLoaded,
  localBookById,
  localBooksReady,
} from "../lib/books";
import {
  bookSourceOf,
  formatFileSize,
  totalChars,
  type LocalBook,
} from "../lib/booksTypes";
import { groupName } from "../lib/groups";

function formatName(format: LocalBook["format"]): string {
  if (format === "online") return "在线书";
  if (format === "epub") return "EPUB";
  if (format === "txt") return "TXT";
  return format;
}

function sourceName(book: LocalBook): string {
  const source = bookSourceOf(book);
  return source === "online"
    ? "在线书"
    : source === "webdav"
      ? "WebDAV 导入"
      : "本地导入";
}

function formatImportedAt(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface MetaRow {
  label: string;
  value: string;
}

function bookMetaRows(book: LocalBook): MetaRow[] {
  const chars = totalChars(book);
  const rows: MetaRow[] = [
    { label: "书名", value: book.title },
    { label: "作者", value: book.author || "佚名" },
    { label: "格式", value: formatName(book.format) },
    { label: "来源", value: sourceName(book) },
    { label: "章节", value: `${book.chapters.length} 章` },
    ...(chars > 0 ? [{ label: "字数", value: `${chars} 字` }] : []),
    ...(book.size > 0 ? [{ label: "大小", value: formatFileSize(book.size) }] : []),
    { label: "文件", value: book.fileName },
    { label: "分组", value: groupName(book.groupId) || "未分组" },
    { label: "导入时间", value: formatImportedAt(book.importedAt) },
  ];
  return rows;
}

export default function BookDetailPage() {
  const navigate = useNavigate();
  const params = useParams();

  const bookId = () => params.id ?? "";
  const book = createMemo(() => localBookById(bookId()));
  const [editOpen, setEditOpen] = createSignal(false);

  createEffect(() => {
    void ensureLocalBooksLoaded();
  });

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/");
  }

  const rows = createMemo(() => (book() ? bookMetaRows(book()!) : []));

  return (
    <div class="page">
      <PageHeader
        title="书籍详情"
        onBack={goBack}
        right={
          <Show when={book()}>
            <button
              class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
              aria-label="编辑书籍信息"
              onClick={() => setEditOpen(true)}
            >
              <EditIcon size={20} />
            </button>
          </Show>
        }
      />

      <Show
        when={localBooksReady()}
        fallback={<LoadingScreen label="加载本地书库…" />}
      >
        <Show
          when={book()}
          fallback={
            <div class="flex flex-col items-center gap-4 px-6 py-24 text-center text-sm text-text-2">
              <p>书籍不存在</p>
              <button
                class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-5.5 py-2.75 text-sm font-semibold text-on-accent shadow-lg shadow-accent/30 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                onClick={goBack}
              >
                返回
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
                <h2 class="break-words text-[18px] font-bold leading-snug">
                  {book()!.title}
                </h2>
                <p class="break-words text-[13px] leading-snug text-text-3">
                  {book()!.author || "佚名"}
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

            {/* 简介 */}
            <section>
              <h3 class="mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
                简介
              </h3>
              <Show
                when={book()!.intro}
                fallback={
                  <div class="flex min-h-[72px] items-center justify-center rounded-[14px] border border-dashed border-border bg-surface px-4 text-center text-[12.5px] leading-[1.7] text-text-3">
                    暂无简介，点击右上角「编辑」补充
                  </div>
                }
              >
                <p class="whitespace-pre-wrap break-words rounded-[14px] border border-border bg-surface px-3.5 py-3 text-[12.5px] leading-[1.75] text-text-2">
                  {book()!.intro}
                </p>
              </Show>
            </section>

            {/* 其它元信息 */}
            <section>
              <h3 class="mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
                详情
              </h3>
              <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
                <For each={rows()}>
                  {(row) => (
                    <div class="flex items-start gap-4 px-4 py-[10px]">
                      <span class="w-[64px] flex-none text-[12.5px] text-text-3">
                        {row.label}
                      </span>
                      <span class="min-w-0 flex-1 break-words text-[12.5px] leading-[1.6] text-text">
                        {row.value}
                      </span>
                    </div>
                  )}
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

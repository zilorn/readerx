import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { BookCover } from "../components/BookCover";
import { LoadingScreen } from "../components/LoadingScreen";
import { PageHeader } from "../components/PageHeader";
import { ChevronRightIcon, CloseIcon, SearchIcon } from "../components/icons";
import {
  ensureLocalBooksLoaded,
  bookMetaById,
  bookMetasReady,
} from "../lib/books";
import type { BookMeta } from "../lib/booksTypes";
import { fuzzyScore } from "../lib/fuzzy";
import { hanText } from "../lib/hanDisplay";
import { groupName, isHiddenGroupId } from "../lib/groups";
import { metaCardStatus } from "../lib/progress";
import { shelfOrder, type ShelfEntry } from "../lib/store";

interface ShelfItem {
  entry: ShelfEntry;
  book: BookMeta;
}

/** 候选字段：0=书名 1=作者 2=文件名 3=分组，越小优先级越高 */
interface FieldCandidate {
  field: number;
  text: string;
}

interface ScoredItem {
  item: ShelfItem;
  field: number;
  quality: number;
}

/**
 * 对一本在架书打分：取命中字段中优先级最高且质量最高的一条。
 * 书名 / 作者按「原文 + 简繁转换副本」两个形态各匹配一次：
 * 开启转换后界面显示转换后的字形，用户无论按哪种字形输入都能搜到。
 */
function scoreItem(rawQuery: string, item: ShelfItem): ScoredItem | null {
  const book = item.book;
  const candidates: FieldCandidate[] = [
    { field: 0, text: book.title },
    { field: 1, text: book.author },
    { field: 2, text: book.fileName },
    { field: 3, text: groupName(book.groupId) },
  ];
  const titleHan = hanText(book.title);
  const authorHan = hanText(book.author);
  if (titleHan !== book.title) candidates.push({ field: 0, text: titleHan });
  if (authorHan !== book.author) candidates.push({ field: 1, text: authorHan });
  let best: ScoredItem | null = null;
  for (const c of candidates) {
    if (!c.text) continue;
    const quality = fuzzyScore(rawQuery, c.text);
    if (quality < 0) continue;
    if (
      !best ||
      c.field < best.field ||
      (c.field === best.field && quality > best.quality)
    ) {
      best = { item, field: c.field, quality };
    }
  }
  return best;
}

/** 已读进度摘要：与书架卡片同一套口径（元数据字符百分比，不物化整书） */
function readSummary(entry: ShelfEntry, book: BookMeta): {
  finished: boolean;
  percent: number;
} | null {
  const status = metaCardStatus(book, entry);
  if (!status.hasRead) return null;
  return { finished: status.finished, percent: status.percent };
}

export default function ShelfSearchPage() {
  const navigate = useNavigate();
  const [keyword, setKeyword] = createSignal("");

  createEffect(() => {
    void ensureLocalBooksLoaded();
  });

  const items = createMemo<ShelfItem[]>(() =>
    shelfOrder()
      .map((entry) => {
        const book = bookMetaById(entry.bookId);
        return book ? { entry, book } : null;
      })
      // 归入隐藏分组的书不参与书架搜索
      .filter(
        (item): item is ShelfItem => item !== null && !isHiddenGroupId(item.book.groupId),
      ),
  );

  const results = createMemo<ScoredItem[]>(() => {
    const q = keyword().trim();
    if (!q) return [];
    const scored = items()
      .map((item) => scoreItem(q, item))
      .filter((s): s is ScoredItem => s !== null);
    scored.sort((a, b) => a.field - b.field || b.quality - a.quality);
    return scored;
  });

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/");
  }

  const openBook = (id: string) => navigate(`/book/${id}`);

  return (
    <div class="page">
      <PageHeader title="搜索书架" onBack={goBack} backLabel="返回书架">
        <div class="flex items-center gap-2 px-[18px] pb-2 pt-1.5">
          <div class="flex min-w-0 flex-1 items-center gap-2 rounded-[12px] border border-border bg-surface px-3 transition-colors focus-within:border-accent">
            <SearchIcon size={17} class="flex-none text-text-3" />
            <input
              class="min-w-0 flex-1 bg-transparent py-[9px] text-[14px] text-text outline-none placeholder:text-text-3"
              type="text"
              placeholder="书名 / 作者 / 文件名"
              autofocus
              value={keyword()}
              onInput={(event) => setKeyword(event.currentTarget.value)}
            />
            <Show when={keyword()}>
              <button
                class="grid h-6 w-6 flex-none place-items-center rounded-full text-text-3 transition-colors hover:text-text-2 active:bg-surface-2"
                type="button"
                aria-label="清空搜索词"
                onClick={() => setKeyword("")}
              >
                <CloseIcon size={15} />
              </button>
            </Show>
          </div>
          <Show when={keyword().trim()}>
            <span class="flex-none text-xs text-text-3">
              {results().length} 本
            </span>
          </Show>
        </div>
      </PageHeader>

      <div class="px-[18px] pb-[calc(28px+env(safe-area-inset-bottom))] pt-1">
        <Show when={bookMetasReady()} fallback={<LoadingScreen label="加载本地书库…" />}>
          <Show
            when={keyword().trim() !== ""}
            fallback={
              <div class="flex flex-col items-center gap-1 px-6 py-16 text-center text-text-3">
                <SearchIcon size={52} class="mb-2.5" />
                <p class="text-[15.5px] font-semibold text-text-2">
                  输入关键词开始搜索
                </p>
                <p class="mt-0.5 text-[12.5px] leading-[1.6]">
                  支持按书名、作者、文件名模糊匹配
                </p>
              </div>
            }
          >
            <Show
              when={results().length > 0}
              fallback={
                <div class="flex flex-col items-center gap-1 px-6 py-16 text-center text-text-3">
                  <SearchIcon size={52} class="mb-2.5" />
                  <p class="text-[15.5px] font-semibold text-text-2">
                    未找到相关书籍
                  </p>
                </div>
              }
            >
              <div class="divide-y divide-border overflow-hidden rounded-[16px] border border-border bg-surface">
                <For each={results()}>
                  {(result) => {
                    const { entry, book } = result.item;
                    const summary = readSummary(entry, book);
                    const title = hanText(book.title);
                    // 展示与搜索都用同一套字形：书名/作者按用户偏好转换后显示
                    const author = hanText(book.author);
                    return (
                      <div
                        role="button"
                        tabindex={0}
                        class="flex w-full items-center gap-3.5 px-3.5 py-3 text-left transition-colors active:bg-surface-2"
                        aria-label={`打开《${title}》`}
                        onClick={() => openBook(book.id)}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          openBook(book.id);
                        }}
                      >
                        <BookCover bookId={book.id} variant="row" />
                        <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
                          <span class="truncate text-[14.5px] font-semibold">
                            {title}
                          </span>
                          <span class="truncate text-[12px] text-text-3">
                            {author}
                            <Show when={groupName(book.groupId)}>
                              {(name) => (
                                <span> · {name()}</span>
                              )}
                            </Show>
                          </span>
                          <Show when={summary}>
                            {(info) => (
                              <span
                                class="text-[11.5px] font-medium"
                                classList={{
                                  "text-success": info().finished,
                                  "text-accent": !info().finished,
                                }}
                              >
                                {info().finished
                                  ? "已读完"
                                  : `读到 ${info().percent}%`}
                              </span>
                            )}
                          </Show>
                        </span>
                        <ChevronRightIcon
                          size={17}
                          class="flex-none text-text-3"
                        />
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}

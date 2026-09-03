import { For, Show, createMemo } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { BookCover } from "../components/BookCover";
import { PageHeader } from "../components/PageHeader";
import { LibraryIcon, PlusIcon } from "../components/icons";
import { getBook } from "../lib/mock";
import {
  shelfOrder,
  type ShelfEntry,
} from "../lib/store";
import type { Book } from "../lib/mock";

interface ShelfItem {
  entry: ShelfEntry;
  book: Book;
}

function progressPercent(entry: ShelfEntry, book: Book): number {
  const pct = Math.round(((entry.chapter + 1) / book.chapters) * 100);
  return Math.min(100, Math.max(1, pct));
}

function ShelfGrid({ items, onOpen }: { items: ShelfItem[]; onOpen: (id: string) => void }) {
  return (
    <div class="book-grid">
      <For each={items}>
        {(item) => {
          const { entry, book } = item;
          const finished = entry.chapter + 1 >= book.chapters;
          const pct = progressPercent(entry, book);
          return (
            <button
              class="book-cell"
              onClick={() => onOpen(book.id)}
              aria-label={`打开《${book.title}》`}
            >
              <BookCover book={book} variant="grid" />
              <span class="book-cell__title">{book.title}</span>
              <Show
                when={entry.chapter > 0}
                fallback={<span class="book-cell__hint">未开始阅读</span>}
              >
                <span class={`book-cell__meta ${finished ? "book-cell__meta--done" : ""}`}>
                  {finished ? "已读完" : `读到 ${pct}%`}
                </span>
                <span class="mini-progress" aria-hidden="true">
                  <i class="mini-progress__fill" style={{ width: `${pct}%` }} />
                </span>
              </Show>
            </button>
          );
        }}
      </For>
    </div>
  );
}

export default function BookshelfPage() {
  const navigate = useNavigate();

  const items = createMemo<ShelfItem[]>(() =>
    shelfOrder()
      .map((entry) => {
        const book = getBook(entry.bookId);
        return book ? { entry, book } : null;
      })
      .filter((x): x is ShelfItem => x !== null),
  );

  const continuing = createMemo(() => items().filter((i) => i.entry.chapter > 0));

  const openBook = (id: string) => navigate(`/book/${id}`);

  return (
    <div class="page">
      <PageHeader
        title="书架"
        subtitle={items().length > 0 ? `${items().length} 本在架` : undefined}
        right={
          <button
            class="icon-btn"
            aria-label="去发现添加书籍"
            onClick={() => navigate("/discover")}
          >
            <PlusIcon />
          </button>
        }
      />

      <div class="page-body">
        <Show
          when={items().length > 0}
          fallback={
            <div class="empty">
              <LibraryIcon size={56} />
              <p class="empty__title">书架空空如也</p>
              <p class="empty__desc">去发现页挑一本喜欢的书开始阅读吧</p>
              <button class="btn-primary" onClick={() => navigate("/discover")}>
                去发现好书
              </button>
            </div>
          }
        >
          <Show when={continuing().length > 0}>
            <section>
              <h2 class="section-title">继续阅读</h2>
              <div class="hscroll">
                <ShelfGrid items={continuing()} onOpen={openBook} />
              </div>
            </section>
            <section>
              <h2 class="section-title">全部书籍</h2>
              <ShelfGrid items={items()} onOpen={openBook} />
            </section>
          </Show>
          <Show when={continuing().length === 0}>
            <ShelfGrid items={items()} onOpen={openBook} />
          </Show>
        </Show>
      </div>
    </div>
  );
}

import { For, Show, createMemo, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { BookCover } from "../components/BookCover";
import { PageHeader } from "../components/PageHeader";
import { CheckIcon, PlusIcon, SearchIcon } from "../components/icons";
import { BOOKS, CATEGORIES, formatWords } from "../lib/mock";
import { isOnShelf, toggleShelf } from "../lib/store";

export default function DiscoverPage() {
  const navigate = useNavigate();
  const [query, setQuery] = createSignal("");
  const [category, setCategory] = createSignal("全部");

  const visible = createMemo(() => {
    const q = query().trim().toLowerCase();
    const cat = category();
    return BOOKS.filter((b) => {
      if (cat !== "全部" && b.category !== cat) return false;
      if (!q) return true;
      return (
        b.title.toLowerCase().includes(q) ||
        b.author.toLowerCase().includes(q) ||
        b.category.includes(q) ||
        b.tags.some((t) => t.includes(q)) ||
        b.intro.toLowerCase().includes(q)
      );
    });
  });

  return (
    <div class="page">
      <PageHeader title="发现">
        <div class="search">
          <span class="search__icon">
            <SearchIcon size={18} />
          </span>
          <input
            class="search__input"
            type="search"
            placeholder="搜索书名 / 作者 / 标签"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <div class="chips" role="tablist" aria-label="分类筛选">
          <For each={CATEGORIES}>
            {(cat) => (
              <button
                role="tab"
                aria-selected={category() === cat}
                class={`chip ${category() === cat ? "chip--active" : ""}`}
                onClick={() => setCategory(cat)}
              >
                {cat}
              </button>
            )}
          </For>
        </div>
      </PageHeader>

      <div class="page-body">
        <Show
          when={visible().length > 0}
          fallback={
            <div class="empty">
              <SearchIcon size={52} />
              <p class="empty__title">没有找到相关书籍</p>
              <p class="empty__desc">换个关键词或分类试试吧</p>
            </div>
          }
        >
          <div class="book-list">
            <For each={visible()}>
              {(book) => {
                const added = () => isOnShelf(book.id);
                return (
                  <div
                    class="book-row"
                    role="button"
                    tabindex={0}
                    onClick={() => navigate(`/book/${book.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(`/book/${book.id}`);
                      }
                    }}
                  >
                    <BookCover book={book} variant="row" />
                    <div class="book-row__body">
                      <div class="book-row__head">
                        <span class="book-row__title">{book.title}</span>
                        <span class="book-row__status">{book.status}</span>
                      </div>
                      <p class="book-row__intro">{book.intro}</p>
                      <div class="book-row__foot">
                        <span class="book-row__meta">
                          {formatWords(book.wordCount)} · 共 {book.chapters} 章
                        </span>
                        <span class="book-row__rating">{book.rating.toFixed(1)} 分</span>
                        <button
                          class={`add-btn ${added() ? "add-btn--added" : ""}`}
                          aria-label={added() ? "移出书架" : "加入书架"}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleShelf(book.id);
                          }}
                        >
                          {added() ? <CheckIcon size={14} /> : <PlusIcon size={14} />}
                          {added() ? "已在书架" : "加入书架"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

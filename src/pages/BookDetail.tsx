import { useNavigate, useParams } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import { createMemo, Show } from "solid-js";
import { localBookById } from "../lib/books";

export default function BookDetailPage() {
  const navigate = useNavigate();
  const params = useParams();

  const book_id = () => params.id ?? "";
  const book = createMemo(() => localBookById(book_id()));
  const book_title = createMemo(() => book()?.title);

  function goBack() {
    navigate(-1);
  }

  return (
    <div class="page">
      <PageHeader title="书籍详情页" onBack={goBack} />
      <Show
        when={book()}
        fallback={
          <div class="flex flex-1 flex-col items-center justify-center gap-4 text-sm text-text-2">
            <p>详情页加载失败...</p>
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
        <div class="m-5">
          <p>{book_title()}</p>
        </div>
      </Show>
    </div>
  );
}

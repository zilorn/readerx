import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
} from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import {
  chapterParagraphs,
  chapterTitle,
  getBook,
} from "../lib/mock";
import {
  FONT_MAX,
  FONT_MIN,
  currentFontSize,
  isOnShelf,
  setFontSize,
  setReadingChapter,
  shelfEntries,
  toggleShelf,
} from "../lib/store";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  ListIcon,
} from "../components/icons";

export default function ReaderPage() {
  const navigate = useNavigate();
  const params = useParams();

  const book = createMemo(() => getBook(params.id ?? ""));

  // 首次打开时自动加入书架
  createEffect(
    on(book, (b) => {
      if (b && !isOnShelf(b.id)) toggleShelf(b.id);
    }),
  );

  // 当前章节（沿用书架里记录的进度）
  const initChapter = (() => {
    const b = book();
    return b ? shelfEntries()[b.id]?.chapter ?? 0 : 0;
  })();
  const [chapter, setChapter] = createSignal<number>(initChapter);
  const [sheetOpen, setSheetOpen] = createSignal(false);

  // 进度变化持久化到书架
  createEffect(
    on(chapter, (idx) => {
      const b = book();
      if (b && isOnShelf(b.id)) setReadingChapter(b.id, idx);
    }),
  );

  const paras = createMemo(() => {
    const b = book();
    return b ? chapterParagraphs(b, chapter()) : [];
  });

  const isFirst = () => chapter() <= 0;
  const isLast = () => {
    const b = book();
    return b ? chapter() + 1 >= b.chapters : true;
  };

  let bodyRef: HTMLDivElement | undefined;
  createEffect(
    on(chapter, () => bodyRef?.scrollTo({ top: 0 })),
  );

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/");
  }

  function incFont(delta: number) {
    setFontSize(currentFontSize() + delta);
  }

  function jumpTo(idx: number) {
    setChapter(idx);
    setSheetOpen(false);
  }

  let listRef: HTMLDivElement | undefined;
  createEffect(
    on(sheetOpen, (open) => {
      if (!open || !listRef) return;
      const cur = listRef.querySelector<HTMLElement>(".sheet__item--current");
      cur?.scrollIntoView({ block: "center" });
    }),
  );

  return (
    <div class="reader">
      <Show
        when={book()}
        fallback={
          <div class="reader__missing">
            <p>书籍不存在或已下架</p>
            <button class="btn-primary" onClick={goBack}>
              返回
            </button>
          </div>
        }
      >
        {(b) => (
          <>
            {/* 顶部工具栏 */}
            <div class="reader__top">
              <button class="icon-btn" aria-label="返回" onClick={goBack}>
                <ChevronLeftIcon />
              </button>
              <div class="reader__top-title">
                <span class="reader__top-name">{b().title}</span>
                <span class="reader__top-ch">{chapterTitle(b(), chapter())}</span>
              </div>
              <div class="reader__fs" aria-label="调整字号">
                <button
                  class="fs-btn"
                  aria-label="减小字号"
                  disabled={currentFontSize() <= FONT_MIN}
                  onClick={() => incFont(-1)}
                >
                  A−
                </button>
                <button
                  class="fs-btn"
                  aria-label="增大字号"
                  disabled={currentFontSize() >= FONT_MAX}
                  onClick={() => incFont(1)}
                >
                  A+
                </button>
              </div>
            </div>

            {/* 正文 */}
            <div class="reader__body" ref={bodyRef}>
              <div
                class="reader__ch"
                style={{ "font-size": `${currentFontSize()}px` }}
              >
                <h2 class="reader__ch-title">{chapterTitle(b(), chapter())}</h2>
                <p class="reader__ch-owner">{b().author} 著</p>
                <For each={paras()}>
                  {(para) => <p class="reader__para">{para}</p>}
                </For>
              </div>
            </div>

            {/* 底部工具条 */}
            <div class="reader__bar">
              <button
                class="bar-btn"
                disabled={isFirst()}
                onClick={() => setChapter((c) => Math.max(0, c - 1))}
              >
                <ChevronLeftIcon size={16} />
                上一章
              </button>
              <button class="bar-btn bar-btn--main" onClick={() => setSheetOpen(true)}>
                <ListIcon size={17} />
                {chapter() + 1} / {b().chapters}
              </button>
              <button
                class="bar-btn"
                disabled={isLast()}
                onClick={() => setChapter((c) => c + 1)}
              >
                下一章
                <ChevronRightIcon size={16} />
              </button>
            </div>

            {/* 目录抽屉 */}
            <Show when={sheetOpen()}>
              <div class="sheet-backdrop" onClick={() => setSheetOpen(false)} />
              <div class="sheet" role="dialog" aria-label="目录">
                <div class="sheet__head">
                  <span class="sheet__title">目录</span>
                  <span class="sheet__count">共 {b().chapters} 章</span>
                  <button
                    class="icon-btn"
                    aria-label="关闭目录"
                    onClick={() => setSheetOpen(false)}
                  >
                    <CloseIcon />
                  </button>
                </div>
                <div class="sheet__list" ref={listRef}>
                  <For each={Array.from({ length: b().chapters }, (_, i) => i)}>
                    {(idx) => {
                      const current = idx === chapter();
                      return (
                        <button
                          class={`sheet__item ${current ? "sheet__item--current" : ""}`}
                          data-idx={idx}
                          onClick={() => jumpTo(idx)}
                        >
                          <span class="sheet__item-idx">{idx + 1}</span>
                          <span class="sheet__item-name">
                            {chapterTitle(b(), idx)}
                          </span>
                          {current && <span class="sheet__item-tag">当前</span>}
                        </button>
                      );
                    }}
                  </For>
                </div>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

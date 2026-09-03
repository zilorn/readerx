import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
} from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { LoadingScreen } from "../components/LoadingScreen";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  ListIcon,
} from "../components/icons";
import {
  ensureLocalBooksLoaded,
  localBookById,
  localBooksReady,
} from "../lib/books";
import {
  FONT_MAX,
  FONT_MIN,
  currentFontSize,
  currentParaSpacing,
  ensureShelfEntry,
  setFontSize,
  setReadingChapter,
  shelfEntries,
} from "../lib/store";

export default function ReaderPage() {
  const navigate = useNavigate();
  const params = useParams();
  const bookId = () => params.id ?? "";

  createEffect(() => {
    void ensureLocalBooksLoaded();
  });

  const book = createMemo(() => localBookById(bookId()));
  const [chapter, setChapter] = createSignal<number>(0);
  const [sheetOpen, setSheetOpen] = createSignal(false);

  // 书载入后：补建进度档案并定位到上次章节
  createEffect(
    on(
      book,
      (current) => {
        if (!current) return;
        ensureShelfEntry(current.id);
        setChapter(shelfEntries()[current.id]?.chapter ?? 0);
      },
    ),
  );

  // 章节变化持久化进度
  createEffect(
    on(chapter, (idx) => {
      const current = book();
      if (current) setReadingChapter(current.id, idx);
    }),
  );

  const chapterData = createMemo(() => {
    const current = book();
    return current?.chapters[chapter()];
  });

  const isFirst = () => chapter() <= 0;
  const isLast = () => {
    const current = book();
    return current ? chapter() + 1 >= current.chapters.length : true;
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
      const current = listRef.querySelector<HTMLElement>('[data-current="true"]');
      current?.scrollIntoView({ block: "center" });
    }),
  );

  return (
    <div class="relative flex h-full flex-col">
      <Show when={localBooksReady()} fallback={<LoadingScreen label="加载书籍…" />}>
        <Show
          when={book()}
          fallback={
            <div class="flex flex-1 flex-col items-center justify-center gap-4 text-sm text-text-2">
              <p>本地书籍不存在或已被删除</p>
              <button
                class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-[22px] py-[11px] text-sm font-semibold text-on-accent shadow-lg shadow-accent/30 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                onClick={goBack}
              >
                返回书架
              </button>
            </div>
          }
        >
          {(current) => (
            <>
              {/* 顶部工具栏 */}
              <div class="z-[5] flex flex-none items-center gap-1.5 border-b border-border bg-surface px-3 pb-2 pt-[max(env(safe-area-inset-top),8px)]">
                <button
                  class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                  aria-label="返回"
                  onClick={goBack}
                >
                  <ChevronLeftIcon />
                </button>
              <div class="flex min-w-0 flex-1 flex-col items-center gap-[1px]">
                  <span class="max-w-full truncate text-[14.5px] font-semibold">
                    {current().title}
                  </span>
                  <span class="max-w-full truncate text-[10.5px] text-text-3">
                    {chapterData()?.title}
                  </span>
                </div>
                <div class="flex flex-none gap-1" aria-label="调整字号">
                  <button
                    class="grid h-[30px] w-[30px] place-items-center rounded-lg border border-border text-xs font-bold text-text-2 disabled:opacity-30"
                    aria-label="减小字号"
                    disabled={currentFontSize() <= FONT_MIN}
                    onClick={() => incFont(-1)}
                  >
                    A−
                  </button>
                  <button
                    class="grid h-[30px] w-[30px] place-items-center rounded-lg border border-border text-xs font-bold text-text-2 disabled:opacity-30"
                    aria-label="增大字号"
                    disabled={currentFontSize() >= FONT_MAX}
                    onClick={() => incFont(1)}
                  >
                    A+
                  </button>
                </div>
              </div>

              {/* 正文 */}
              <div
                ref={bodyRef}
                class="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-none"
              >
                <div
                  class="mx-auto max-w-[680px] px-6 pb-[52px] pt-[22px] text-justify leading-[1.95] tracking-[0.01em]"
                  style={{ "font-size": `${currentFontSize()}px` }}
                >
                  <h2 class="mb-1 text-center text-[1.35em] font-bold tracking-[0.06em]">
                    {chapterData()?.title}
                  </h2>
                  <p class="mb-5 text-center text-[0.66em] tracking-[0.4em] text-text-3">
                    {current().author} 著
                  </p>
                  <Show
                    when={chapterData()?.blocks}
                    fallback={
                      <For each={chapterData()?.paragraphs ?? []}>
                        {(paragraph) => (
                          <p
                            class="indent-[2em]"
                            style={{ "margin-bottom": `${currentParaSpacing()}em` }}
                          >
                            {paragraph}
                          </p>
                        )}
                      </For>
                    }
                  >
                    {(blocks) => (
                      <For each={blocks()}>
                        {(block) => {
                          if (block.kind === "p") {
                            return (
                              <p
                                class="indent-[2em]"
                                style={{ "margin-bottom": `${currentParaSpacing()}em` }}
                              >
                                {block.text}
                              </p>
                            );
                          }
                          if (block.kind === "h") {
                            return (
                              <h3
                                class="font-semibold tracking-[0.04em]"
                                style={{
                                  "margin-bottom": `${currentParaSpacing()}em`,
                                  "margin-top": `calc(${currentParaSpacing()}em * 1.2)`,
                                  "font-size": block.level <= 3 ? "1.15em" : "1.05em",
                                }}
                              >
                                {block.text}
                              </h3>
                            );
                          }
                          return (
                            <figure class="my-[1em] text-center">
                              <Show
                                when={block.src}
                                fallback={
                                  <div class="mx-auto flex max-w-full items-center justify-center rounded-md border border-dashed border-border bg-surface-2 px-4 py-10 text-[12px] text-text-3">
                                    {block.alt ? `${block.alt}（图片缺失）` : "图片缺失"}
                                  </div>
                                }
                              >
                                <img
                                  src={block.src}
                                  alt={block.alt ?? ""}
                                  class="mx-auto max-h-[68vh] max-w-full rounded-md object-contain"
                                />
                              </Show>
                            </figure>
                          );
                        }}
                      </For>
                    )}
                  </Show>
                </div>
              </div>

              {/* 底部工具条 */}
              <div class="z-[5] flex flex-none items-center gap-2 border-t border-border bg-surface px-3.5 pb-[calc(10px+env(safe-area-inset-bottom))] pt-2">
                <button
                  class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-border bg-bg px-0.5 py-[9px] text-[12.5px] text-text-2 disabled:pointer-events-none disabled:opacity-30"
                  disabled={isFirst()}
                  onClick={() => setChapter((c) => Math.max(0, c - 1))}
                >
                  <ChevronLeftIcon size={16} />
                  上一章
                </button>
                <button
                  class="inline-flex flex-[1.7] items-center justify-center gap-1.5 rounded-[10px] border border-transparent bg-accent px-0.5 py-[9px] text-[12.5px] font-semibold tabular-nums text-on-accent"
                  onClick={() => setSheetOpen(true)}
                >
                  <ListIcon size={17} />
                  {chapter() + 1} / {current().chapters.length}
                </button>
                <button
                  class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-border bg-bg px-0.5 py-[9px] text-[12.5px] text-text-2 disabled:pointer-events-none disabled:opacity-30"
                  disabled={isLast()}
                  onClick={() => setChapter((c) => c + 1)}
                >
                  下一章
                  <ChevronRightIcon size={16} />
                </button>
              </div>

              {/* 目录抽屉 */}
              <Show when={sheetOpen()}>
                <div
                  class="absolute inset-0 z-40 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
                  onClick={() => setSheetOpen(false)}
                />
                <div
                  class="absolute inset-x-0 bottom-0 z-[41] flex max-h-[72%] animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
                  role="dialog"
                  aria-label="目录"
                >
                  <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
                    <span class="text-[15px] font-bold">目录</span>
                    <span class="flex-1 text-xs text-text-3">
                      共 {current().chapters.length} 章
                    </span>
                    <button
                      class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                      aria-label="关闭目录"
                      onClick={() => setSheetOpen(false)}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                  <div
                    class="min-h-0 flex-1 overflow-y-auto px-0 py-1 pb-3.5 scrollbar-none"
                    ref={listRef}
                  >
                    <For each={current().chapters}>
                      {(item, idx) => {
                        const active = idx() === chapter();
                        return (
                          <button
                            class={`flex w-full items-center gap-3 px-[18px] py-[11px] text-left text-[13.5px] transition-colors active:bg-surface-2 ${
                              active
                                ? "bg-accent-weak font-semibold text-accent"
                                : "text-text-2"
                            }`}
                            data-idx={idx()}
                            data-current={active ? "true" : undefined}
                            onClick={() => jumpTo(idx())}
                          >
                            <span
                              class={`w-8 flex-none text-[11.5px] tabular-nums ${
                                active ? "text-accent" : "text-text-3"
                              }`}
                            >
                              {idx() + 1}
                            </span>
                            <span class="min-w-0 flex-1 truncate">
                              {item.title}
                            </span>
                            {active && (
                              <span class="flex-none rounded-full bg-accent px-2 py-0.5 text-[10px] text-on-accent">
                                当前
                              </span>
                            )}
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
      </Show>
    </div>
  );
}

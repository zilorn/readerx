import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
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
  MISSING_IMAGE_HEIGHT,
  chapterUnits,
  decodeImageSize,
  figureStyle,
  headingStyle,
  paginateChapter,
  paragraphStyle,
  readingBaseStyle,
  titleAuthorStyle,
  titleTextStyle,
  titleWrapperStyle,
  type CssRecord,
  type PageFragment,
  type PaginateLayout,
  type ReaderBlock,
} from "../lib/pagination";
import {
  FONT_MAX,
  FONT_MIN,
  currentFontSize,
  currentPageMode,
  currentParaSpacing,
  ensureShelfEntry,
  setFontSize,
  setReadingChapter,
  shelfEntries,
} from "../lib/store";
import { showToast } from "../lib/toast";

const PAD_X = 24; // 阅读区左右留白
const PAD_TOP = 14; // 正文顶部留白
const PAD_BOTTOM_PAGED = 30; // 分页底部留白（容纳页号）
const PAD_BOTTOM_SCROLL = 28; // 滚动底部留白

// 安全区（刘海/系统手势条）探针：用 env(safe-area-inset-*) 解析成像素
let safeInsetsCache: { top: number; bottom: number } | null = null;
function safeInsets(): { top: number; bottom: number } {
  if (safeInsetsCache) return safeInsetsCache;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;left:0;top:-9999px;width:1px;height:1px;pointer-events:none;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const num = (v: string) => Math.max(0, parseFloat(v) || 0);
  safeInsetsCache = { top: num(cs.paddingTop), bottom: num(cs.paddingBottom) };
  probe.remove();
  return safeInsetsCache;
}

const topPad = () => safeInsets().top + PAD_TOP;
const bottomPadPaged = () => safeInsets().bottom + PAD_BOTTOM_PAGED;
const bottomPadScroll = () => safeInsets().bottom + PAD_BOTTOM_SCROLL;

/** 分页引擎的行内样式记录 → Solid 样式对象 */
function asCss(record: CssRecord): JSX.CSSProperties {
  return record as JSX.CSSProperties;
}

// ---------------------------------------------------------------------------
// 阅读片段渲染（分页与滚动共用同一套版式样式）
// ---------------------------------------------------------------------------

function TitleBlock(props: {
  layout: PaginateLayout;
  title: string;
  author?: string | null;
}) {
  return (
    <div style={asCss(titleWrapperStyle())}>
      <p style={asCss(titleTextStyle(props.layout))}>{props.title}</p>
      <Show when={props.author}>
        <p style={asCss(titleAuthorStyle(props.layout))}>{props.author}</p>
      </Show>
    </div>
  );
}

/** 图片：分页按已计算尺寸渲染；滚动按自然比例自适配 */
function ImageBlock(props: {
  src: string;
  alt?: string;
  /** 分页模式的展示尺寸（px）；0 表示未知/缺失 */
  w?: number;
  h?: number;
  /** 滚动模式：交给 CSS 自适应 */
  natural?: boolean;
}) {
  return (
    <figure style={asCss(figureStyle())}>
      <Show
        when={props.src && (props.natural || (props.w ?? 0) > 0)}
        fallback={
          <div
            class="mx-auto flex max-w-full items-center justify-center rounded-md border border-dashed border-border bg-surface-2 px-4 text-[12px] text-text-3"
            style={{ height: `${MISSING_IMAGE_HEIGHT}px` }}
          >
            {props.alt || "图片缺失"}
          </div>
        }
      >
        <img
          src={props.src}
          alt={props.alt ?? ""}
          draggable={false}
          class="mx-auto max-w-full rounded-md object-contain"
          classList={{ "max-h-[62vh]": props.natural }}
          style={
            props.natural
              ? undefined
              : { width: `${props.w}px`, height: `${props.h}px` }
          }
        />
      </Show>
    </figure>
  );
}

/** 分页视图里的单个片段 */
function PagedFragment(props: { fragment: PageFragment; layout: PaginateLayout }) {
  const fragment = props.fragment;
  const layout = props.layout;
  if (fragment.kind === "title") {
    return <TitleBlock layout={layout} title={fragment.title} author={fragment.author} />;
  }
  if (fragment.kind === "p") {
    return (
      <p style={asCss(paragraphStyle(layout, fragment.indent, fragment.end))}>
        {fragment.text}
      </p>
    );
  }
  if (fragment.kind === "h") {
    return <h3 style={asCss(headingStyle(layout, fragment.level))}>{fragment.text}</h3>;
  }
  return <ImageBlock src={fragment.src} alt={fragment.alt} w={fragment.w} h={fragment.h} />;
}

/** 滚动模式下的正文单元 */
function ScrollBlock(props: { layout: PaginateLayout; block: ReaderBlock }) {
  const block = props.block;
  const layout = props.layout;
  if (block.kind === "p") {
    return <p style={asCss(paragraphStyle(layout, true, true))}>{block.text}</p>;
  }
  if (block.kind === "h") {
    return <h3 style={asCss(headingStyle(layout, block.level))}>{block.text}</h3>;
  }
  return <ImageBlock src={block.src} alt={block.alt} natural />;
}

// ---------------------------------------------------------------------------
// 阅读页
// ---------------------------------------------------------------------------

export default function ReaderPage() {
  const navigate = useNavigate();
  const params = useParams();
  const bookId = () => params.id ?? "";

  createEffect(() => {
    void ensureLocalBooksLoaded();
  });

  const book = createMemo(() => localBookById(bookId()));
  const [chapterIdx, setChapterIdx] = createSignal(0);
  const [pageIdx, setPageIdx] = createSignal(0);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [tocOpen, setTocOpen] = createSignal(false);

  const isPaged = () => currentPageMode() === "paged";

  // 书载入后：补建档案、恢复上次章节
  createEffect(
    on(book, (current) => {
      if (!current) return;
      ensureShelfEntry(current.id);
      const entry = shelfEntries()[current.id];
      const max = Math.max(0, current.chapters.length - 1);
      setChapterIdx(Math.min(max, Math.max(0, entry?.chapter ?? 0)));
      setPageIdx(0);
    }),
  );

  // 章节变化 → 持久化阅读进度
  createEffect(
    on(chapterIdx, (idx) => {
      const current = book();
      if (current) setReadingChapter(current.id, idx);
    }),
  );

  const chapter = createMemo(() => {
    const current = book();
    const list = current?.chapters;
    if (!list || list.length === 0) return undefined;
    return list[Math.min(chapterIdx(), list.length - 1)];
  });

  const isFirstChapter = () => chapterIdx() <= 0;
  const isLastChapter = () => {
    const current = book();
    return current ? chapterIdx() + 1 >= current.chapters.length : true;
  };

  // 阅读区几何（分页排版依赖真实尺寸；书就绪且元素挂载后测量）
  const [area, setArea] = createSignal({ w: 0, h: 0 });
  let areaRef: HTMLDivElement | undefined;
  let areaObserver: ResizeObserver | null = null;
  createEffect(
    on(book, () => {
      const el = areaRef;
      if (!el || areaObserver) return;
      const measure = () => setArea({ w: el.clientWidth, h: el.clientHeight });
      measure();
      areaObserver = new ResizeObserver(measure);
      areaObserver.observe(el);
      onCleanup(() => {
        areaObserver?.disconnect();
        areaObserver = null;
      });
    }),
  );

  const layout = createMemo<PaginateLayout | null>(() => {
    const a = area();
    if (a.w < 100 || a.h < 140) return null;
    return {
      textWidth: a.w - PAD_X * 2,
      pageHeight: a.h - topPad() - bottomPadPaged(),
      fontSize: currentFontSize(),
      paraSpacingEm: currentParaSpacing(),
      imageCapHeight: Math.max(180, Math.min(a.h * 0.5, 460)),
    };
  });

  // 当前章节内容单元（稳定引用，分页/滚动共用）
  const units = createMemo<ReaderBlock[]>(() => {
    const ch = chapter();
    return ch ? chapterUnits(ch) : [];
  });

  // 分页结果：图片解码完成后重算
  const [paged, setPaged] = createSignal<ReturnType<typeof paginateChapter>>(null);
  createEffect(() => {
    const mode = isPaged();
    const ch = chapter();
    const geo = layout();
    if (!mode || !ch || !geo) {
      setPaged(null);
      return;
    }
    setPaged(null);
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    const author = book()?.author ?? null;
    void (async () => {
      const sizes = new Map<string, { w: number; h: number } | null>();
      const imageUnits = chapterUnits(ch).filter((u) => u.kind === "img");
      await Promise.all(
        imageUnits.map((unit) =>
          decodeImageSize((unit as { src: string }).src).then((size) =>
            sizes.set((unit as { src: string }).src, size),
          ),
        ),
      );
      if (cancelled || !isPaged() || chapter() !== ch) return;
      const result = paginateChapter(ch, author, geo, sizes);
      if (!result || cancelled || !isPaged() || chapter() !== ch) return;
      // 回翻“上一章末页”的挂起目标在此落地（无论新旧章页数是否相同）
      if (wantLastPage) {
        wantLastPage = false;
        setPageIdx(Math.max(0, result.pages.length - 1));
      }
      setPaged(result);
    })();
  });

  const totalPages = createMemo(() => paged()?.pages.length ?? 0);

  // 需要跳转到上一章最后一页时置位（回翻/工具栏上一章）
  let wantLastPage = false;

  // 几何/字号变化导致同章重排时，按比例保留阅读位置
  createEffect(
    on(totalPages, (total, prevTotal) => {
      if (total <= 0 || prevTotal === undefined || prevTotal <= 0) return;
      const ratio = pageIdx() / prevTotal;
      const next = Math.min(total - 1, Math.max(0, Math.round(ratio * (total - 1))));
      if (next !== pageIdx()) setPageIdx(next);
    }),
  );

  // 页码越界钳制
  createEffect(() => {
    const total = totalPages();
    const idx = pageIdx();
    if (total > 0 && idx >= total) setPageIdx(total - 1);
  });

  const pageFragments = createMemo<PageFragment[]>(() => {
    if (!isPaged()) return [];
    const pages = paged()?.pages;
    if (!pages || pages.length === 0) return [];
    return pages[Math.min(pageIdx(), pages.length - 1)] ?? [];
  });

  const chapterCount = () => book()?.chapters.length ?? 0;

  // -------------------------------------------------------------------
  // 翻页 / 章节跳转
  // -------------------------------------------------------------------

  function goToChapter(idx: number): void {
    const current = book();
    if (!current) return;
    const clamped = Math.max(0, Math.min(idx, current.chapters.length - 1));
    if (clamped === chapterIdx()) return;
    setChapterIdx(clamped);
    setPageIdx(0);
  }

  function jumpFromToc(idx: number): void {
    goToChapter(idx);
    setTocOpen(false);
    setMenuOpen(false);
  }

  /** 左右翻页（含章节边界衔接）；返回是否发生了位移 */
  function turnPage(dir: 1 | -1): boolean {
    if (!isPaged()) return false;
    const total = totalPages();
    const idx = pageIdx();
    if (dir > 0) {
      if (idx + 1 < total) {
        setPageIdx(idx + 1);
        return true;
      }
      if (!isLastChapter()) {
        goToChapter(chapterIdx() + 1);
        return true;
      }
      return false;
    }
    if (idx > 0) {
      setPageIdx(idx - 1);
      return true;
    }
    if (!isFirstChapter()) {
      wantLastPage = true;
      goToChapter(chapterIdx() - 1);
      return true;
    }
    return false;
  }

  function goBack(): void {
    if (window.history.length > 1) navigate(-1);
    else navigate("/");
  }

  function incFont(delta: number): void {
    setFontSize(currentFontSize() + delta);
  }

  // -------------------------------------------------------------------
  // 手势：点中间呼出/收起菜单；左右区域翻页；横向滑动翻页
  // -------------------------------------------------------------------

  let gestureStart: { x: number; y: number; t: number } | null = null;
  let animDir: 1 | -1 = 1;
  let animTriggered = false;

  function isUiTarget(e: Event): boolean {
    const target = e.target as HTMLElement | null;
    return !!target?.closest?.("[data-reader-ui]");
  }

  function onSurfacePointerDown(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (isUiTarget(e)) return;
    gestureStart = { x: e.clientX, y: e.clientY, t: performance.now() };
  }

  function onSurfacePointerUp(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const start = gestureStart;
    gestureStart = null;
    if (!start || isUiTarget(e)) return;
    const dt = performance.now() - start.t;
    if (dt > 700) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const moved = Math.hypot(dx, dy);
    const rect = areaRef?.getBoundingClientRect();
    if (!rect) return;

    // 菜单/目录展开时：轻点正文任意处先收起，避免误翻页
    if (menuOpen() || tocOpen()) {
      if (moved < 12) {
        setMenuOpen(false);
        setTocOpen(false);
      }
      return;
    }

    // 横向滑动翻页
    if (isPaged() && moved >= 56 && Math.abs(dx) > Math.abs(dy)) {
      animDir = dx < 0 ? 1 : -1;
      if (turnPage(animDir)) animTriggered = true;
      return;
    }
    if (moved >= 12) return; // 纵向拖动等：不处理

    const x = e.clientX - rect.left;
    const inMiddle = x >= rect.width / 3 && x <= (rect.width * 2) / 3;
    if (!isPaged()) {
      if (inMiddle) setMenuOpen(true);
      return;
    }
    if (x < rect.width / 3) {
      animDir = -1;
      if (turnPage(-1)) animTriggered = true;
    } else if (x > (rect.width * 2) / 3) {
      animDir = 1;
      if (turnPage(1)) animTriggered = true;
    } else {
      setMenuOpen(true);
    }
  }

  // 翻页动画：仅用户主动翻页时触发（改字号/重排不触发）
  let pageAnimRef: HTMLDivElement | undefined;
  createEffect(
    on(
      () => (isPaged() ? `${chapterIdx()}:${pageIdx()}` : ""),
      (key, prev) => {
        const el = pageAnimRef;
        if (!el || !key) return;
        if (prev !== undefined && prev !== key && animTriggered) {
          el.style.animation = "none";
          void el.getBoundingClientRect();
          el.style.animation = `${
            animDir > 0 ? "page-in-right" : "page-in-left"
          } 0.3s cubic-bezier(0.22, 1, 0.36, 1)`;
        }
        animTriggered = false;
      },
    ),
  );

  // 键盘左右方向键翻页（桌面便利）
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      if (menuOpen() || tocOpen() || !isPaged()) return;
      const dir = e.key === "ArrowRight" ? 1 : -1;
      animDir = dir;
      if (turnPage(dir)) animTriggered = true;
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // 首次进入时的操作提示（一次性）
  let hintShown = false;
  createEffect(() => {
    if (hintShown || !book()) return;
    hintShown = true;
    showToast("点屏幕中间唤出菜单");
  });

  // 目录抽屉打开后滚动定位当前章节
  let listRef: HTMLDivElement | undefined;
  createEffect(
    on(tocOpen, (open) => {
      if (!open || !listRef) return;
      const current = listRef.querySelector<HTMLElement>('[data-current="true"]');
      current?.scrollIntoView({ block: "center" });
    }),
  );

  return (
    <div class="relative flex h-full min-h-0 flex-col overflow-hidden bg-bg">
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
          <div
            ref={areaRef}
            class="relative min-h-0 flex-1 select-none overflow-hidden"
            onPointerDown={onSurfacePointerDown}
            onPointerUp={onSurfacePointerUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            {/* 正文（分页 / 滚动） */}
            <Show
              when={layout() && chapter()}
              fallback={<LoadingScreen label={isPaged() ? "排版中…" : "加载书籍…"} />}
            >
              <Show
                when={!isPaged()}
                fallback={
                  /* 分页模式：左右翻页视图 */
                  <div
                    ref={pageAnimRef}
                    class="absolute inset-0 overflow-hidden"
                    style={{ "touch-action": "none" }}
                  >
                    <div
                      class="mx-auto flex h-full flex-col"
                      style={{
                        width: `${layout()!.textWidth}px`,
                        ...asCss(readingBaseStyle(layout()!)),
                      }}
                    >
                      <div style={{ height: `${topPad()}px`, "flex": "none" }} />
                      <div
                        class="relative w-full overflow-hidden"
                        style={{ height: `${layout()!.pageHeight}px` }}
                      >
                        <For each={pageFragments()}>
                          {(fragment) => (
                            <PagedFragment fragment={fragment} layout={layout()!} />
                          )}
                        </For>
                      </div>
                      <div
                        class="relative flex-none"
                        style={{ height: `${bottomPadPaged()}px` }}
                      >
                        <Show when={totalPages() > 1 && !menuOpen()}>
                          <span
                            class="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 text-[10.5px] tracking-[0.08em] text-text-3 opacity-70 tabular-nums"
                            aria-hidden="true"
                          >
                            {pageIdx() + 1} / {totalPages()}
                          </span>
                        </Show>
                      </div>
                    </div>
                  </div>
                }
              >
                {/* 滚动模式：整章上下滚动 */}
                <div
                  class="absolute inset-0 overflow-y-auto overscroll-contain scrollbar-none"
                  style={{
                    padding: `${topPad()}px ${PAD_X}px ${bottomPadScroll()}px`,
                  }}
                >
                  <div style={asCss(readingBaseStyle(layout()!))}>
                    <TitleBlock
                      layout={layout()!}
                      title={chapter()!.title}
                      author={
                        book()!.author && book()!.author !== "佚名"
                          ? `${book()!.author} 著`
                          : null
                      }
                    />
                    <For each={units()}>
                      {(block) => <ScrollBlock layout={layout()!} block={block} />}
                    </For>
                  </div>
                </div>
              </Show>
            </Show>

            {/* 顶部工具栏（菜单呼出后显示） */}
            <header
              data-reader-ui
              class="absolute inset-x-0 top-0 z-30 border-b border-border bg-topbar-bg backdrop-blur-[14px] transition-transform duration-200"
              classList={{
                "-translate-y-full": !menuOpen(),
                "translate-y-0": menuOpen(),
              }}
              style={{ "pointer-events": menuOpen() ? "auto" : "none" }}
              aria-hidden={!menuOpen()}
            >
              <div class="flex items-center gap-1.5 px-3 pb-2 pt-[max(env(safe-area-inset-top),8px)]">
                <button
                  class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                  aria-label="返回"
                  onClick={goBack}
                >
                  <ChevronLeftIcon />
                </button>
                <div class="flex min-w-0 flex-1 flex-col items-center gap-[1px]">
                  <span class="max-w-full truncate text-[14.5px] font-semibold">
                    {book()!.title}
                  </span>
                  <span class="max-w-full truncate text-[10.5px] text-text-3">
                    {chapter() ? `${chapter()!.cid} · ${chapter()!.title}` : ""}
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
            </header>

            {/* 底部工具栏 */}
            <footer
              data-reader-ui
              class="absolute inset-x-0 bottom-0 z-30 border-t border-border bg-surface transition-transform duration-200"
              classList={{
                "translate-y-full": !menuOpen(),
                "translate-y-0": menuOpen(),
              }}
              style={{ "pointer-events": menuOpen() ? "auto" : "none" }}
              aria-hidden={!menuOpen()}
            >
              <div class="flex items-center gap-2 px-3.5 pb-[calc(10px+env(safe-area-inset-bottom))] pt-2">
                <button
                  class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-border bg-bg px-0.5 py-[9px] text-[12.5px] text-text-2 disabled:pointer-events-none disabled:opacity-30"
                  disabled={isFirstChapter()}
                  onClick={() => {
                    if (isPaged()) {
                      if (!isFirstChapter()) {
                        wantLastPage = true;
                        goToChapter(chapterIdx() - 1);
                      }
                    } else if (!isFirstChapter()) {
                      setChapterIdx((c) => c - 1);
                    }
                  }}
                >
                  <ChevronLeftIcon size={16} />
                  上一章
                </button>
                <button
                  class="inline-flex flex-[1.7] items-center justify-center gap-1.5 rounded-[10px] border border-transparent bg-accent px-0.5 py-[9px] text-[12.5px] font-semibold tabular-nums text-on-accent"
                  onClick={() => setTocOpen(true)}
                >
                  <ListIcon size={17} />
                  <span class="truncate">
                    {chapterIdx() + 1}/{chapterCount()}章
                    {isPaged() && totalPages() > 0
                      ? ` · ${pageIdx() + 1}/${totalPages()}页`
                      : ""}
                  </span>
                </button>
                <button
                  class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-border bg-bg px-0.5 py-[9px] text-[12.5px] text-text-2 disabled:pointer-events-none disabled:opacity-30"
                  disabled={isLastChapter()}
                  onClick={() => {
                    if (isPaged()) {
                      if (!isLastChapter()) goToChapter(chapterIdx() + 1);
                    } else if (!isLastChapter()) {
                      setChapterIdx((c) => c + 1);
                    }
                  }}
                >
                  下一章
                  <ChevronRightIcon size={16} />
                </button>
              </div>
            </footer>

            {/* 目录抽屉 */}
            <Show when={tocOpen()}>
              <div
                data-reader-ui
                class="absolute inset-0 z-40 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
                onClick={() => setTocOpen(false)}
              />
              <div
                data-reader-ui
                class="absolute inset-x-0 bottom-0 z-[41] flex max-h-[72%] animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
                role="dialog"
                aria-label="目录"
              >
                <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
                  <span class="text-[15px] font-bold">目录</span>
                  <span class="flex-1 text-xs text-text-3">
                    共 {chapterCount()} 章
                  </span>
                  <button
                    class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                    aria-label="关闭目录"
                    onClick={() => setTocOpen(false)}
                  >
                    <CloseIcon />
                  </button>
                </div>
                <div
                  ref={listRef}
                  class="min-h-0 flex-1 overflow-y-auto px-0 py-1 pb-3.5 scrollbar-none"
                >
                  <For each={book()!.chapters}>
                    {(item, idx) => {
                      const active = idx() === chapterIdx();
                      return (
                        <button
                          class={`flex w-full items-center gap-3 px-[18px] py-[11px] text-left text-[13.5px] transition-colors active:bg-surface-2 ${
                            active
                              ? "bg-accent-weak font-semibold text-accent"
                              : "text-text-2"
                          }`}
                          data-current={active ? "true" : undefined}
                          onClick={() => jumpFromToc(idx())}
                        >
                          <span
                            class={`w-12 flex-none text-[11px] tabular-nums ${
                              active ? "text-accent" : "text-text-3"
                            }`}
                          >
                            {item.cid}
                          </span>
                          <span class="min-w-0 flex-1 truncate">{item.title}</span>
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
          </div>
        </Show>
      </Show>
    </div>
  );
}

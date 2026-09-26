/**
 * 全书搜索面板（阅读器内底部抽屉，类似目录）：不占路由历史。
 * 搜索范围：全部 / 仅标题 / 仅正文；
 * 命中结果以「每条一张卡片」平铺展示；
 * 点任一结果卡片由阅读页跳到命中位置并进入「搜索模式」逐条查看，
 * 已在搜索模式时可用 activeIndex 高亮对应卡片并自动滚动到可视区。
 */
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { CloseIcon, SearchIcon } from "./icons";
import { HighlightText } from "./HighlightText";
import { ScrollArea } from "./ScrollArea";
import type { LocalBook } from "../lib/booksTypes";
import { t, type MessageKey } from "../lib/i18n";
import { centerInScroller } from "../lib/scrollWithin";
import {
  searchBookText,
  type BookSearchHit,
  type BookSearchScope,
} from "../lib/bookSearch";

/** 点击某条结果卡片时传给阅读页的信息（含整份命中列表，用于进入搜索模式逐条切换） */
export interface BookSearchOpenTarget {
  /** 被点击结果在全量 hits 中的序号（0 起） */
  index: number;
  hits: BookSearchHit[];
  /** 当前生效的搜索词 */
  term: string;
}

export interface BookSearchPanelProps {
  open: boolean;
  book: LocalBook | undefined;
  /** 搜索模式下正在查看的结果序号（0 起）；用于回列表时定位/高亮 */
  activeIndex?: number | null;
  /** 打开时是否自动聚焦输入框（默认 true；从搜索模式回列表时传 false 避免弹键盘） */
  focusInput?: boolean;
  onClose: () => void;
  onOpenResult: (target: BookSearchOpenTarget) => void;
}

const SCOPE_OPTIONS: { value: BookSearchScope; labelKey: MessageKey }[] = [
  { value: "all", labelKey: "common.all" },
  { value: "title", labelKey: "discover.bookSearch.scopeTitle" },
  { value: "body", labelKey: "discover.bookSearch.scopeBody" },
];

/** 单条结果卡片：顶部章节信息，下方命中内容 */
function HitCard(props: {
  hit: BookSearchHit;
  hits: BookSearchHit[];
  term: string;
  /** 0 起序号 */
  ordinal: number;
  active: boolean;
  onOpen: (target: BookSearchOpenTarget) => void;
}) {
  const hit = props.hit;
  return (
    <button
      type="button"
      data-hit-index={props.ordinal}
      aria-current={props.active ? "true" : undefined}
      class="block w-full overflow-hidden rounded-[14px] border text-left transition-colors active:bg-surface-2"
      classList={{
        "border-accent/80 bg-accent-weak/50 ring-1 ring-accent/70":
          props.active,
        "border-border bg-bg": !props.active,
      }}
      onClick={() =>
        props.onOpen({
          index: props.ordinal,
          hits: props.hits,
          term: props.term,
        })
      }
    >
      <div class="flex min-w-0 items-center gap-2.5 px-[15px] pt-2.5">
        <span
          class="w-11 flex-none truncate text-[11px] tabular-nums"
          classList={{
            "text-accent": props.active,
            "text-text-3": !props.active,
          }}
        >
          {hit.chapterCid}
        </span>
        <span
          class="min-w-0 flex-1 truncate text-[11.5px]"
          classList={{
            "text-accent": props.active,
            "text-text-3": !props.active,
          }}
        >
          {hit.chapterTitle}
        </span>
        <Show when={hit.kind === "title"}>
          <span class="flex-none rounded-full bg-accent-weak px-2 py-0.5 text-[10px] font-semibold text-accent">
            {t("discover.bookSearch.kindTitle")}
          </span>
        </Show>
        <Show when={props.active}>
          <span class="flex-none rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-on-accent">
            {t("discover.bookSearch.current")}
          </span>
        </Show>
      </div>
      <div class="px-[15px] pb-3 pt-1.5 text-[13px] leading-[1.75] text-text-2">
        <Show
          when={hit.kind === "title"}
          fallback={
            <span class="line-clamp-3">
              <Show when={hit.lead}>
                <span class="text-text-3">…</span>
              </Show>
              <HighlightText text={hit.windowText} marks={hit.marks} />
              <Show when={hit.trail}>
                <span class="text-text-3">…</span>
              </Show>
            </span>
          }
        >
          <span class="font-semibold text-text">
            <HighlightText text={hit.windowText} marks={hit.marks} />
          </span>
        </Show>
      </div>
    </button>
  );
}

export function BookSearchPanel(props: BookSearchPanelProps) {
  const [inputText, setInputText] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [scope, setScope] = createSignal<BookSearchScope>("all");
  let inputRef: HTMLInputElement | undefined;
  let resultListRef: HTMLDivElement | undefined;
  /** 结果列表真正的滚动容器（ScrollArea 内层），定位当前结果只滚它一个 */
  let resultScrollerRef: HTMLDivElement | undefined;
  let debounceTimer: number | undefined;
  let focusTimer: number | undefined;
  let scrollTimer: number | undefined;

  function onInput(value: string): void {
    setInputText(value);
    window.clearTimeout(debounceTimer);
    const term = value.trim();
    debounceTimer = window.setTimeout(() => setQuery(term), 160);
  }

  function clearInput(): void {
    window.clearTimeout(debounceTimer);
    setInputText("");
    setQuery("");
    inputRef?.focus();
  }

  onCleanup(() => {
    window.clearTimeout(debounceTimer);
    window.clearTimeout(focusTimer);
    window.clearTimeout(scrollTimer);
  });

  // 打开时按需聚焦输入框（默认聚焦；从搜索模式回列表时传 false）
  createEffect(() => {
    if (!props.open) {
      window.clearTimeout(focusTimer);
      return;
    }
    if (props.focusInput === false) return;
    window.clearTimeout(focusTimer);
    focusTimer = window.setTimeout(() => inputRef?.focus(), 80);
  });

  const outcome = createMemo(() => {
    const term = query();
    const current = props.book;
    if (!term || !current) return null;
    return searchBookText(current, term, scope());
  });

  const hits = createMemo<BookSearchHit[]>(() => outcome()?.hits ?? []);

  const hitCount = createMemo(() => hits().length);

  /** 打开面板（回列表）时，把当前正在查看的结果卡片滚到可视区 */
  createEffect(() => {
    if (!props.open || props.activeIndex == null) {
      window.clearTimeout(scrollTimer);
      return;
    }
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => {
      const el = resultListRef?.querySelector<HTMLElement>(
        `[data-hit-index="${props.activeIndex}"]`,
      );
      // 只滚结果列表：scrollIntoView 会连阅读区一起滚，面板入场动画期间表现为整屏抖动
      // （见 lib/scrollWithin.ts）
      if (el && resultScrollerRef) centerInScroller(resultScrollerRef, el);
    }, 120);
  });

  return (
    <Show when={props.open}>
      <div
        data-reader-ui
        class="absolute inset-0 z-[45] animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
        onClick={props.onClose}
      />
      <div
        data-reader-ui
        role="dialog"
        aria-label={t("discover.bookSearch.title")}
        class="absolute inset-x-0 bottom-0 z-[46] flex h-[min(86%,760px)] animate-sheet-up select-none flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
      >
        <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
          <SearchIcon size={18} class="flex-none text-accent" />
          <span class="text-[15px] font-bold">{t("discover.bookSearch.title")}</span>
          <span class="min-w-0 flex-1 truncate text-xs text-text-3">
            {props.book?.title ?? ""}
          </span>
          <button
            class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label={t("discover.bookSearch.close")}
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <div class="flex-none px-[18px] pb-2 pt-2.5">
          <div class="flex min-w-0 items-center gap-2 rounded-[12px] border border-border bg-bg px-3 transition-colors focus-within:border-accent">
            <SearchIcon size={17} class="flex-none text-text-3" />
            <input
              ref={inputRef}
              class="min-w-0 flex-1 bg-transparent py-[8px] text-[14px] text-text outline-none placeholder:text-text-3"
              type="text"
              placeholder={t("discover.bookSearch.placeholder")}
              value={inputText()}
              onInput={(event) => onInput(event.currentTarget.value)}
            />
            <Show when={inputText()}>
              <button
                class="grid h-6 w-6 flex-none place-items-center rounded-full text-text-3 transition-colors hover:text-text-2 active:bg-surface-2"
                type="button"
                aria-label={t("discover.bookSearch.clear")}
                onClick={clearInput}
              >
                <CloseIcon size={15} />
              </button>
            </Show>
          </div>
          <div class="mt-2 flex items-center gap-1.5">
            <For each={SCOPE_OPTIONS}>
              {(option) => (
                <button
                  type="button"
                  class="rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors"
                  classList={{
                    "bg-accent text-on-accent": scope() === option.value,
                    "bg-surface-2 text-text-2 active:bg-bg":
                      scope() !== option.value,
                  }}
                  onClick={() => setScope(option.value)}
                >
                  {t(option.labelKey)}
                </button>
              )}
            </For>
            <Show when={hitCount() > 0}>
              <span class="ml-auto flex-none text-xs text-text-3 tabular-nums">
                {t("discover.bookSearch.count", { count: hitCount() })}
              </span>
            </Show>
          </div>
        </div>

        <ScrollArea
          class="min-h-0 flex-1"
          onEl={(el) => {
            resultScrollerRef = el;
          }}
        >
          <div
            ref={resultListRef}
            class="px-[18px] pb-[max(env(safe-area-inset-bottom),12px)] pt-1"
          >
            <Show
              when={query()}
              fallback={
                <div class="flex flex-col items-center gap-1 px-6 py-14 text-center text-text-3">
                  <SearchIcon size={48} class="mb-2" />
                  <p class="text-[15px] font-semibold text-text-2">
                    {t("discover.bookSearch.hint")}
                  </p>
                  <p class="text-[12px] leading-[1.7]">
                    {t("discover.bookSearch.hintDetail")}
                  </p>
                </div>
              }
            >
              <Show
                when={hitCount() > 0}
                fallback={
                  <div class="flex flex-col items-center gap-1 px-6 py-14 text-center text-text-3">
                    <SearchIcon size={48} class="mb-2" />
                    <p class="text-[15px] font-semibold text-text-2">
                      {t("discover.bookSearch.noMatch")}
                    </p>
                    <p class="text-[12px]">{t("discover.bookSearch.noMatchHint")}</p>
                  </div>
                }
              >
                <div class="mb-2 flex items-center justify-end">
                  <Show when={outcome()?.truncated}>
                    <span class="text-[11px] text-text-3">
                      {t("discover.bookSearch.truncated", {
                        count: hitCount(),
                      })}
                    </span>
                  </Show>
                </div>
                <div class="flex flex-col gap-2.5 pb-2">
                  <For each={hits()}>
                    {(hit, idx) => (
                      <HitCard
                        hit={hit}
                        ordinal={idx()}
                        active={idx() === props.activeIndex}
                        hits={hits()}
                        term={query()}
                        onOpen={props.onOpenResult}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </ScrollArea>
      </div>
    </Show>
  );
}

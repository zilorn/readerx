/**
 * 全书搜索面板（阅读器内底部抽屉，类似目录）：不占路由历史。
 * 搜索范围：全部 / 仅标题 / 仅正文；
 * 点标题命中由阅读页跳到章首，点正文命中由阅读页跳到精确位置并高亮。
 */
import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { CloseIcon, SearchIcon } from "./icons";
import type { LocalBook } from "../lib/booksTypes";
import {
  searchBookText,
  type BookSearchHit,
  type BookSearchScope,
  type SearchMark,
} from "../lib/bookSearch";

/** 阅读页内跳转目标：章内正文镜像文本偏移；标题命中传 -1 表示章首 */
export interface BookSearchJump {
  chapterIndex: number;
  start: number;
  end: number;
}

export interface BookSearchPanelProps {
  open: boolean;
  book: LocalBook | undefined;
  onClose: () => void;
  onJump: (jump: BookSearchJump) => void;
}

interface TextSeg {
  text: string;
  hit: boolean;
}

/** 把文本按命中区间切成片段（合并/跳过重叠或乱序标记） */
function segmentText(text: string, marks: SearchMark[]): TextSeg[] {
  const segs: TextSeg[] = [];
  let cursor = 0;
  const sorted = marks.slice().sort((a, b) => a.from - b.from);
  for (const mark of sorted) {
    if (mark.to <= cursor || mark.from < cursor) continue;
    if (mark.from > cursor) segs.push({ text: text.slice(cursor, mark.from), hit: false });
    segs.push({ text: text.slice(mark.from, mark.to), hit: true });
    cursor = mark.to;
  }
  if (cursor < text.length) segs.push({ text: text.slice(cursor), hit: false });
  if (segs.length === 0) segs.push({ text, hit: false });
  return segs;
}

/** 高亮渲染：命中片段着强调色 */
function HighlightText(props: { text: string; marks: SearchMark[] }) {
  const segs = createMemo(() => segmentText(props.text, props.marks));
  return (
    <>
      <For each={segs()}>
        {(seg) =>
          seg.hit ? (
            <span class="rounded-[3px] bg-accent-weak font-semibold text-accent">
              {seg.text}
            </span>
          ) : (
            seg.text
          )
        }
      </For>
    </>
  );
}

/** 章内聚合：标题命中单列于分组头，正文命中按出现顺序列出 */
interface HitGroup {
  chapterIndex: number;
  cid: string;
  title: string;
  titleHit: BookSearchHit | null;
  bodyHits: BookSearchHit[];
}

function groupHits(hits: BookSearchHit[]): HitGroup[] {
  const groups: HitGroup[] = [];
  for (const hit of hits) {
    const last = groups[groups.length - 1];
    if (!last || last.chapterIndex !== hit.chapterIndex) {
      groups.push({
        chapterIndex: hit.chapterIndex,
        cid: hit.chapterCid,
        title: hit.chapterTitle,
        titleHit: null,
        bodyHits: [],
      });
    }
    const group = groups[groups.length - 1];
    if (hit.kind === "title") {
      if (!group.titleHit) group.titleHit = hit;
    } else {
      group.bodyHits.push(hit);
    }
  }
  return groups;
}

const SCOPE_OPTIONS: { value: BookSearchScope; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "title", label: "标题" },
  { value: "body", label: "正文" },
];

export function BookSearchPanel(props: BookSearchPanelProps) {
  const [inputText, setInputText] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [scope, setScope] = createSignal<BookSearchScope>("all");
  let inputRef: HTMLInputElement | undefined;
  let debounceTimer: number | undefined;

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

  onCleanup(() => window.clearTimeout(debounceTimer));

  const outcome = createMemo(() => {
    const term = query();
    const current = props.book;
    if (!term || !current) return null;
    return searchBookText(current, term, scope());
  });

  const groups = createMemo<HitGroup[]>(() =>
    outcome() ? groupHits(outcome()!.hits) : [],
  );

  const hitCount = createMemo(() => outcome()?.hits.length ?? 0);

  /** 点正文命中（含分组头跳第一处）→ 精确区间；标题命中/章首 → -1 */
  function requestJump(group: HitGroup, hit?: BookSearchHit): void {
    if (hit && hit.kind === "body") {
      props.onJump({
        chapterIndex: group.chapterIndex,
        start: hit.start,
        end: hit.end,
      });
    } else {
      props.onJump({ chapterIndex: group.chapterIndex, start: -1, end: -1 });
    }
  }

  /** 分组头：标题命中→章首；否则跳第一处正文命中 */
  function jumpGroupHeader(group: HitGroup): void {
    if (group.titleHit) requestJump(group);
    else if (group.bodyHits.length > 0) requestJump(group, group.bodyHits[0]);
  }

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
        aria-label="全书搜索"
        class="absolute inset-x-0 bottom-0 z-[46] flex h-[min(86%,760px)] animate-sheet-up select-none flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
      >
        <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
          <SearchIcon size={18} class="flex-none text-accent" />
          <span class="text-[15px] font-bold">全书搜索</span>
          <span class="min-w-0 flex-1 truncate text-xs text-text-3">
            {props.book?.title ?? ""}
          </span>
          <button
            class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label="关闭全书搜索"
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
              placeholder="搜索标题或正文"
              autofocus
              value={inputText()}
              onInput={(event) => onInput(event.currentTarget.value)}
            />
            <Show when={inputText()}>
              <button
                class="grid h-6 w-6 flex-none place-items-center rounded-full text-text-3 transition-colors hover:text-text-2 active:bg-surface-2"
                type="button"
                aria-label="清空搜索词"
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
                  {option.label}
                </button>
              )}
            </For>
            <Show when={hitCount() > 0}>
              <span class="ml-auto flex-none text-xs text-text-3 tabular-nums">
                {hitCount()} 处
              </span>
            </Show>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto scrollbar-none">
          <div class="px-[18px] pb-[max(env(safe-area-inset-bottom),12px)] pt-1">
            <Show
              when={query()}
              fallback={
                <div class="flex flex-col items-center gap-1 px-6 py-14 text-center text-text-3">
                  <SearchIcon size={48} class="mb-2" />
                  <p class="text-[15px] font-semibold text-text-2">
                    输入关键词搜索全书
                  </p>
                  <p class="text-[12px] leading-[1.7]">
                    可匹配章节标题与正文内容
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
                      未找到匹配内容
                    </p>
                    <p class="text-[12px]">可切换搜索范围后重试</p>
                  </div>
                }
              >
                <div class="mb-2 flex items-center justify-end">
                  <Show when={outcome()?.truncated}>
                    <span class="text-[11px] text-text-3">
                      命中过多，仅显示前 {hitCount()} 处
                    </span>
                  </Show>
                </div>
                <div class="divide-y divide-border overflow-hidden rounded-[16px] border border-border bg-bg">
                  <For each={groups()}>
                    {(group) => (
                      <div>
                        <button
                          type="button"
                          class="flex w-full items-center gap-3 px-[16px] py-[11px] text-left transition-colors active:bg-surface-2"
                          onClick={() => jumpGroupHeader(group)}
                        >
                          <span class="w-12 flex-none text-[11px] tabular-nums text-text-3">
                            {group.cid}
                          </span>
                          <span
                            class="min-w-0 flex-1 truncate text-[13.5px]"
                            classList={{
                              "font-semibold": !!group.titleHit,
                              "text-text-2": !group.titleHit,
                            }}
                          >
                            <Show when={group.titleHit}>
                              <HighlightText
                                text={group.titleHit!.windowText}
                                marks={group.titleHit!.marks}
                              />
                            </Show>
                            <Show when={!group.titleHit}>
                              <span>{group.title}</span>
                            </Show>
                          </span>
                          <Show when={group.titleHit}>
                            <span class="flex-none rounded-full bg-accent-weak px-2 py-0.5 text-[10px] font-semibold text-accent">
                              章标题
                            </span>
                          </Show>
                          <Show when={!group.titleHit && group.bodyHits.length > 0}>
                            <span class="flex-none text-[11px] text-text-3 tabular-nums">
                              {group.bodyHits.length} 处
                            </span>
                          </Show>
                        </button>
                        <Show when={group.bodyHits.length > 0}>
                          <div class="divide-y divide-border border-t border-border bg-bg/40">
                            <For each={group.bodyHits}>
                              {(hit) => (
                                <button
                                  type="button"
                                  class="block w-full px-[16px] py-[10px] text-left transition-colors active:bg-surface-2"
                                  onClick={() => requestJump(group, hit)}
                                >
                                  <span class="line-clamp-3 text-[13px] leading-[1.7] text-text-2">
                                    <Show when={hit.lead}>
                                      <span class="text-text-3">…</span>
                                    </Show>
                                    <HighlightText
                                      text={hit.windowText}
                                      marks={hit.marks}
                                    />
                                    <Show when={hit.trail}>
                                      <span class="text-text-3">…</span>
                                    </Show>
                                  </span>
                                </button>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}

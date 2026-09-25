/**
 * 书签列表面板（底部抽屉）：列出某本书的全部书签。
 * 书签按章节分组为一张张卡片（卡片按章节顺序排列），
 * 卡片内书签按正文文本顺序排列；点击跳转到精确位置，可逐条删除。
 * 打开时自动定位到当前章节的卡片（本章没有书签则定位到最近的一章）。
 *
 * 顶部搜索框按「书签所在章节」或「书签正文」筛选：章节名命中的整章书签都保留
 * （按章节找书签），只命中正文的则只留命中的条目；命中文字在卡片上高亮，
 * 点条目仍是原来的跳转定位。
 */
import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { Bookmark } from "../lib/bookmarks";
import { matchBookmarks, type BookmarkMark, type BookmarkMatch } from "../lib/bookmarkSearch";
import { BookmarkIcon, CloseIcon, SearchIcon, TrashIcon } from "./icons";
import { HighlightText } from "./HighlightText";
import { ScrollArea } from "./ScrollArea";

export interface BookmarkPanelProps {
  open: boolean;
  bookmarks: Bookmark[];
  /** 当前章节 cid（标识“本章”卡片用） */
  currentCid?: string;
  /** 当前章节序号（本章没有书签时，据此定位到最近的一章） */
  currentIndex: number;
  onClose: () => void;
  onJump: (bookmark: Bookmark) => void;
  onDelete: (bookmark: Bookmark) => void;
}

/** 目标卡片放不下时顶对齐留出的上边距（px） */
const FOCUS_TOP_GAP = 8;

interface BookmarkGroup {
  /** 章节身份（cid；“本章”标识与定位依赖它） */
  chapterCid: string;
  /** 章节序号（卡片顺序与“最近章节”判定用） */
  chapterIndex: number;
  label: string;
  /** 章节名命中区间（同章各条一致，取首条即可） */
  labelMarks: readonly BookmarkMark[];
  items: BookmarkMatch[];
}

/**
 * 把筛选结果按“章节 → 文本位置”排序后聚成卡片。
 * 排序口径与 sortedBookmarks 一致：先章节序号、再章内字符起点，
 * 保证卡片间按章节顺序、卡片内按文本顺序。
 */
function groupMatches(matches: BookmarkMatch[]): BookmarkGroup[] {
  const sorted = matches.slice().sort((a, b) => {
    const left = a.bookmark;
    const right = b.bookmark;
    return (
      left.chapterIndex - right.chapterIndex ||
      left.charStart - right.charStart ||
      left.createdAt - right.createdAt
    );
  });
  const groups: BookmarkGroup[] = [];
  const byCid = new Map<string, BookmarkGroup>();
  for (const match of sorted) {
    const { bookmark } = match;
    let group = byCid.get(bookmark.chapterCid);
    if (!group) {
      group = {
        chapterCid: bookmark.chapterCid,
        chapterIndex: bookmark.chapterIndex,
        label: match.label,
        labelMarks: match.labelMarks,
        items: [],
      };
      byCid.set(bookmark.chapterCid, group);
      groups.push(group);
    }
    group.items.push(match);
  }
  return groups;
}

/**
 * 打开面板时要定位到的卡片：
 * 1) 当前章有书签 → 本章卡片；
 * 2) 当前章没有书签 → 章节序号离当前章最近的卡片（同样近时取靠后的一章，
 *    顺着阅读方向先看还没读到的那条）。
 * 无书签返回 undefined。
 */
function focusGroup(
  groups: BookmarkGroup[],
  currentCid: string | undefined,
  currentIndex: number,
): BookmarkGroup | undefined {
  if (groups.length === 0) return undefined;
  const sameChapter = currentCid
    ? groups.find((group) => group.chapterCid === currentCid)
    : undefined;
  if (sameChapter) return sameChapter;
  let best = groups[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const group of groups) {
    const distance = Math.abs(group.chapterIndex - currentIndex);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = group;
    }
  }
  return best;
}

/** 单条书签：展示命中窗口（未搜索时即开头预览）并高亮命中文字 */
function BookmarkItem(props: {
  match: BookmarkMatch;
  onJump: (bookmark: Bookmark) => void;
  onDelete: (bookmark: Bookmark) => void;
}) {
  const bookmark = () => props.match.bookmark;
  return (
    <li class="flex items-stretch">
      <button
        class="flex min-w-0 flex-1 cursor-pointer flex-col justify-center gap-1 px-2.5 py-3 text-left transition-colors active:bg-surface-2"
        onClick={() => props.onJump(bookmark())}
      >
        <span class="line-clamp-2 text-[13.5px] leading-[1.6] text-text-2">
          <Show when={props.match.lead}>
            <span class="text-text-3">…</span>
          </Show>
          <HighlightText text={props.match.windowText} marks={props.match.textMarks} />
          <Show when={props.match.trail}>
            <span class="text-text-3">…</span>
          </Show>
        </span>
      </button>
      <button
        class="my-1 grid w-11 flex-none cursor-pointer place-items-center self-center rounded-xl text-text-3 transition-colors active:bg-danger-weak active:text-danger"
        aria-label="删除书签"
        onClick={() => props.onDelete(bookmark())}
      >
        <TrashIcon size={18} />
      </button>
    </li>
  );
}

export function BookmarkPanel(props: BookmarkPanelProps) {
  const [inputText, setInputText] = createSignal("");
  /** 生效的搜索词（去空白；输入框保留原样以便继续输入） */
  const term = createMemo(() => inputText().trim());
  const matches = createMemo(() => matchBookmarks(props.bookmarks, term()));
  const groups = createMemo(() => groupMatches(matches()));
  /** 面板自己的滚动元素（ScrollArea 内层） */
  let scrollEl: HTMLDivElement | undefined;
  /** 已挂载的章节卡片（cid → 卡片元素），供打开时定位 */
  const groupEls = new Map<string, HTMLElement>();

  /**
   * 把目标卡片滚进面板可视区（本章没有书签时即最近的一章）。
   * 卡片放得下就居中，书签太多放不下则顶对齐 —— 保证卡片标题与开头几条能看见。
   * 只改面板自己的 scrollTop：正文那层滚动位置不受影响，背后的阅读进度不动。
   */
  function focusCurrentCard(): void {
    const target = focusGroup(groups(), props.currentCid, props.currentIndex);
    const card = target ? groupEls.get(target.chapterCid) : undefined;
    if (!card || !scrollEl) return;
    const offset = card.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
    const viewport = scrollEl.clientHeight;
    const cardHeight = card.offsetHeight;
    scrollEl.scrollTop +=
      cardHeight <= viewport - FOCUS_TOP_GAP * 2
        ? offset - (viewport - cardHeight) / 2
        : offset - FOCUS_TOP_GAP;
  }

  // 打开时回到未搜索状态并定位当前章节。卡片由 <Show> 随 open 重新挂载，
  // ref 先于本效果执行，因此打开时一定已就位。
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) {
          groupEls.clear();
          return;
        }
        setInputText("");
        focusCurrentCard();
      },
    ),
  );

  // 搜索词变化后结果整体换了一批：回到顶部看最前一条；清空搜索词则回到当前章节。
  createEffect(
    on(term, (value) => {
      if (!props.open) return;
      if (value) {
        if (scrollEl) scrollEl.scrollTop = 0;
        return;
      }
      focusCurrentCard();
    }),
  );

  return (
    <Show when={props.open}>
      <div
        data-reader-ui
        class="absolute inset-0 z-40 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
        onClick={props.onClose}
      />
      <div
        data-reader-ui
        class="absolute inset-x-0 bottom-0 z-[41] flex max-h-[72%] select-none animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
        role="dialog"
        aria-label="书签"
      >
        <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
          <BookmarkIcon size={19} class="text-accent" />
          <span class="text-[15px] font-bold">书签</span>
          <span class="flex-1 text-xs text-text-3">
            <Show
              when={term()}
              fallback={
                <>
                  共 {props.bookmarks.length} 条
                  {groups().length > 1 ? ` · ${groups().length} 章` : ""}
                </>
              }
            >
              找到 {matches().length} 条
            </Show>
          </span>
          <button
            class="grid h-10 w-10 flex-none cursor-pointer place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label="关闭书签"
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <Show
          when={props.bookmarks.length > 0}
          fallback={
            <div class="flex flex-col items-center gap-3 px-6 py-14 text-center">
              <BookmarkIcon size={40} class="text-text-3/70" />
              <p class="text-[13px] leading-relaxed text-text-3">
                暂无书签
                <br />
                长按正文选取文字后点「书签」即可添加
              </p>
            </div>
          }
        >
          <div class="flex-none px-3.5 pb-2.5 pt-2">
            <div class="flex min-w-0 items-center gap-2 rounded-[12px] border border-border bg-bg px-3 transition-colors focus-within:border-accent">
              <SearchIcon size={16} class="flex-none text-text-3" />
              <input
                class="min-w-0 flex-1 bg-transparent py-[7px] text-[13.5px] text-text outline-none placeholder:text-text-3"
                type="text"
                enterkeyhint="search"
                placeholder="搜索章节或书签内容"
                value={inputText()}
                onInput={(event) => setInputText(event.currentTarget.value)}
              />
              <Show when={inputText()}>
                <button
                  class="grid h-6 w-6 flex-none place-items-center rounded-full text-text-3 transition-colors hover:text-text-2 active:bg-surface-2"
                  type="button"
                  aria-label="清空搜索词"
                  onClick={() => setInputText("")}
                >
                  <CloseIcon size={15} />
                </button>
              </Show>
            </div>
          </div>

          <Show
            when={matches().length > 0}
            fallback={
              <div class="flex flex-col items-center gap-2 px-6 py-12 text-center text-text-3">
                <SearchIcon size={38} class="mb-1 text-text-3/70" />
                <p class="text-[13.5px] font-semibold text-text-2">未找到匹配的书签</p>
                <p class="text-[12px] leading-relaxed">可搜索章节标题或书签里的文字</p>
              </div>
            }
          >
            <ScrollArea
              class="min-h-0 flex-1"
              contentClass="px-3 pb-4 pt-1"
              onEl={(el) => {
                scrollEl = el;
              }}
            >
              <div class="flex flex-col gap-2.5">
                <For each={groups()}>
                  {(group) => {
                    const isCurrent = group.chapterCid === props.currentCid;
                    return (
                      <section
                        ref={(el) => {
                          groupEls.set(group.chapterCid, el);
                        }}
                        class="overflow-hidden rounded-[14px] border border-border bg-bg"
                      >
                        <header class="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
                          <BookmarkIcon
                            size={15}
                            filled={isCurrent}
                            class={isCurrent ? "text-accent" : "text-text-3"}
                          />
                          <h3
                            class={`min-w-0 flex-1 truncate text-[13px] font-semibold ${
                              isCurrent ? "text-accent" : "text-text-2"
                            }`}
                          >
                            <HighlightText text={group.label} marks={group.labelMarks} />
                          </h3>
                          <Show when={isCurrent}>
                            <span class="shrink-0 rounded-md bg-accent-weak px-1.5 py-0.5 text-[10px] font-medium text-accent">
                              本章
                            </span>
                          </Show>
                          <span class="shrink-0 text-[10.5px] text-text-3">
                            {group.items.length} 条
                          </span>
                        </header>
                        <ul class="divide-y divide-border px-1">
                          <For each={group.items}>
                            {(match) => (
                              <BookmarkItem
                                match={match}
                                onJump={props.onJump}
                                onDelete={props.onDelete}
                              />
                            )}
                          </For>
                        </ul>
                      </section>
                    );
                  }}
                </For>
              </div>
            </ScrollArea>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

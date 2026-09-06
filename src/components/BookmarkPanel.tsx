/**
 * 书签列表面板（底部抽屉）：列出某本书的全部书签。
 * 书签按章节分组为一张张卡片（卡片按章节顺序排列），
 * 卡片内书签按正文文本顺序排列；点击跳转到精确位置，可逐条删除。
 */
import { For, Show, createMemo } from "solid-js";
import type { Bookmark } from "../lib/bookmarks";
import { BookmarkIcon, CloseIcon, TrashIcon } from "./icons";
import { ScrollArea } from "./ScrollArea";

export interface BookmarkPanelProps {
  open: boolean;
  bookmarks: Bookmark[];
  /** 当前章节 cid（标识“本章”卡片用） */
  currentCid?: string;
  onClose: () => void;
  onJump: (bookmark: Bookmark) => void;
  onDelete: (bookmark: Bookmark) => void;
}

const MAX_PREVIEW = 64;

/** 无记录章节标题时兜底为「第 N 章」 */
function chapterLabel(bookmark: Bookmark): string {
  return bookmark.chapterTitle || `第 ${bookmark.chapterIndex + 1} 章`;
}

interface BookmarkGroup {
  /** 章节身份（cid；“本章”标识依赖它） */
  chapterCid: string;
  label: string;
  items: Bookmark[];
}

/**
 * 把书签按“章节 → 文本位置”排序后聚成卡片。
 * 排序口径与 sortedBookmarks 一致：先章节序号、再章内字符起点，
 * 保证卡片间按章节顺序、卡片内按文本顺序。
 */
function groupBookmarks(bookmarks: Bookmark[]): BookmarkGroup[] {
  const sorted = bookmarks
    .slice()
    .sort(
      (a, b) =>
        a.chapterIndex - b.chapterIndex ||
        a.charStart - b.charStart ||
        a.createdAt - b.createdAt,
    );
  const groups: BookmarkGroup[] = [];
  const byCid = new Map<string, BookmarkGroup>();
  for (const bookmark of sorted) {
    let group = byCid.get(bookmark.chapterCid);
    if (!group) {
      group = {
        chapterCid: bookmark.chapterCid,
        label: chapterLabel(bookmark),
        items: [],
      };
      byCid.set(bookmark.chapterCid, group);
      groups.push(group);
    }
    group.items.push(bookmark);
  }
  return groups;
}

export function BookmarkPanel(props: BookmarkPanelProps) {
  const groups = createMemo(() => groupBookmarks(props.bookmarks));

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
            共 {props.bookmarks.length} 条
            {groups().length > 1 ? ` · ${groups().length} 章` : ""}
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
          <ScrollArea class="min-h-0 flex-1" contentClass="flex flex-col gap-2.5 px-3 pb-4 pt-2.5">
            <For each={groups()}>
              {(group) => {
                const isCurrent = group.chapterCid === props.currentCid;
                return (
                  <section class="overflow-hidden rounded-[14px] border border-border bg-bg">
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
                        {group.label}
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
                        {(bookmark) => (
                          <li class="flex items-stretch">
                            <button
                              class="flex min-w-0 flex-1 cursor-pointer flex-col justify-center gap-1 px-2.5 py-3 text-left transition-colors active:bg-surface-2"
                              onClick={() => props.onJump(bookmark)}
                            >
                              <span class="line-clamp-2 text-[13.5px] leading-[1.6] text-text-2">
                                {bookmark.text.length > MAX_PREVIEW
                                  ? `${bookmark.text.slice(0, MAX_PREVIEW)}…`
                                  : bookmark.text}
                              </span>
                            </button>
                            <button
                              class="my-1 grid w-11 flex-none cursor-pointer place-items-center self-center rounded-xl text-text-3 transition-colors active:bg-danger-weak active:text-danger"
                              aria-label="删除书签"
                              onClick={() => props.onDelete(bookmark)}
                            >
                              <TrashIcon size={18} />
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                );
              }}
            </For>
          </ScrollArea>
        </Show>
      </div>
    </Show>
  );
}

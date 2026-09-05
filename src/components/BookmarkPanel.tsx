/**
 * 书签列表面板（底部抽屉）：列出某本书的全部书签，
 * 点击跳转到精确位置，可逐条删除。
 */
import { For, Show } from "solid-js";
import type { Bookmark } from "../lib/bookmarks";
import { BookmarkIcon, CloseIcon, TrashIcon } from "./icons";
import { ScrollArea } from "./ScrollArea";

export interface BookmarkPanelProps {
  open: boolean;
  bookmarks: Bookmark[];
  /** 当前章节 cid（高亮“在本章”标识用） */
  currentCid?: string;
  onClose: () => void;
  onJump: (bookmark: Bookmark) => void;
  onDelete: (bookmark: Bookmark) => void;
}

const MAX_PREVIEW = 64;

export function BookmarkPanel(props: BookmarkPanelProps) {
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
          <span class="flex-1 text-xs text-text-3">共 {props.bookmarks.length} 条</span>
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
          <ScrollArea class="min-h-0 flex-1" contentClass="py-1 pb-3.5">
            <For each={props.bookmarks}>
              {(bookmark) => (
                <div class="group flex items-stretch gap-1 px-2">
                  <button
                    class="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 rounded-xl px-3.5 py-3 text-left transition-colors active:bg-surface-2"
                    onClick={() => props.onJump(bookmark)}
                  >
                    <span class="line-clamp-2 text-[13.5px] leading-[1.6] text-text-2">
                      {bookmark.text.length > MAX_PREVIEW
                        ? `${bookmark.text.slice(0, MAX_PREVIEW)}…`
                        : bookmark.text}
                    </span>
                    <span class="flex items-center gap-1.5 text-[11px] text-text-3">
                      <BookmarkIcon
                        size={12}
                        filled={bookmark.chapterCid === props.currentCid}
                        class={
                          bookmark.chapterCid === props.currentCid
                            ? "text-accent"
                            : undefined
                        }
                      />
                      <span class="truncate">
                        {bookmark.chapterTitle || `第 ${bookmark.chapterIndex + 1} 章`}
                      </span>
                    </span>
                  </button>
                  <button
                    class="my-1 grid w-11 flex-none cursor-pointer place-items-center self-center rounded-xl text-text-3 transition-colors active:bg-danger-weak active:text-danger"
                    aria-label="删除书签"
                    onClick={() => props.onDelete(bookmark)}
                  >
                    <TrashIcon size={18} />
                  </button>
                </div>
              )}
            </For>
          </ScrollArea>
        </Show>
      </div>
    </Show>
  );
}

/**
 * 章节范围选择抽屉（批量下载正文用）：挑一个端点（起始章 / 结束章）。
 * 顶部可直接输入章节序号（与目录左侧的编号一致，1 起），列表可滚动挑选；
 * 只能落在 [min, max] 内（起始章不得晚于结束章，反之亦然），区间外的行置灰不可点。
 * 选中的行标「当前」，尚未缓存正文的章标「未缓存」—— 便于从还没下过的地方接着下载。
 */
import { For, Show, createEffect, on } from "solid-js";
import { t } from "../lib/i18n";
import type { LocalBookChapter } from "../lib/booksTypes";
import { chapterHasContent } from "../lib/online";
import { CheckIcon, CloseIcon } from "./icons";
import { ScrollArea } from "./ScrollArea";

export interface ChapterRangeSheetProps {
  /** 是否展开（父级通常同时用 <Show> 控制挂载） */
  open: boolean;
  /** 抽屉标题，如「起始章」 */
  title: string;
  chapters: LocalBookChapter[];
  /** 当前端点的章节下标 */
  value: number;
  /** 可选下标区间（含两端） */
  min: number;
  max: number;
  /** 选中某章（下标） */
  onSelect: (index: number) => void;
  onClose: () => void;
}

export function ChapterRangeSheet(props: ChapterRangeSheetProps) {
  /** 列表滚动元素：打开 / 选中变化时把当前端点滚进可视区 */
  let scrollEl: HTMLDivElement | undefined;

  const ordinal = (): number => props.value + 1;
  const minOrdinal = (): number => props.min + 1;
  const maxOrdinal = (): number => props.max + 1;
  const current = (): LocalBookChapter | undefined => props.chapters[props.value];

  /** 输入章节序号：只认数字，夹进可选区间后立即选中（清空输入不改变选择） */
  function onOrdinalInput(input: HTMLInputElement): void {
    const digits = input.value.replace(/\D+/g, "");
    if (!digits) return;
    const parsed = Number.parseInt(digits, 10);
    const next = Math.min(Math.max(parsed, minOrdinal()), maxOrdinal());
    props.onSelect(next - 1);
    // 夹取后回填输入框：序号被夹住时用户直接看到生效值（输入框内容以选中值为准）
    const text = String(next);
    if (input.value !== text) input.value = text;
  }

  createEffect(
    on(
      () => [props.open, props.value] as const,
      ([open]) => {
        if (!open || !scrollEl) return;
        scrollEl
          .querySelector<HTMLElement>('[data-selected="true"]')
          ?.scrollIntoView({ block: "center" });
      },
    ),
  );

  return (
    <Show when={props.open}>
      <div
        data-reader-ui
        class="fixed inset-0 z-[42] animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
        onClick={props.onClose}
      />
      <div
        data-reader-ui
        class="fixed inset-x-0 bottom-0 z-[43] mx-auto flex max-h-[70%] flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
        role="dialog"
        aria-label={props.title}
      >
        <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
          <span class="text-[15px] font-bold">{props.title}</span>
          <span class="flex-1 text-xs text-text-3">
            {t("readerChrome.chapterRange.hint", { min: minOrdinal(), max: maxOrdinal() })}
          </span>
          <button
            class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label={t("common.close")}
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <div class="flex flex-none items-center gap-3 border-b border-border px-4 py-2.5">
          <label class="flex flex-none items-center gap-1.5 rounded-[10px] border border-border bg-bg px-3 py-1.5 text-[13px] text-text-3">
            {t("readerChrome.chapterRange.ordinalPrefix")}
            <input
              class="w-14 bg-transparent text-center text-[14px] font-semibold tabular-nums text-text outline-none"
              type="text"
              inputmode="numeric"
              enterkeyhint="done"
              aria-label={t("readerChrome.chapterRange.ordinalLabel")}
              value={String(ordinal())}
              onInput={(e) => onOrdinalInput(e.currentTarget)}
            />
            {t("readerChrome.chapterRange.ordinalSuffix")}
          </label>
          <span class="min-w-0 flex-1 truncate text-[12.5px] text-text-2">
            {current()?.title ?? ""}
          </span>
        </div>
        <ScrollArea
          class="min-h-0 flex-1"
          contentClass="px-0 py-1 pb-3.5"
          onEl={(el) => {
            scrollEl = el;
          }}
        >
          <For each={props.chapters}>
            {(item, idx) => {
              const active = (): boolean => idx() === props.value;
              const allowed = (): boolean => idx() >= props.min && idx() <= props.max;
              return (
                <button
                  class="flex w-full items-center gap-3 px-[18px] py-[11px] text-left text-[13.5px] transition-colors active:bg-surface-2 disabled:opacity-35"
                  classList={{
                    "bg-accent-weak font-semibold text-accent": active(),
                    "text-text-2": !active(),
                  }}
                  data-selected={active() ? "true" : undefined}
                  disabled={!allowed()}
                  onClick={() => {
                    props.onSelect(idx());
                    props.onClose();
                  }}
                >
                  <span
                    class="w-12 flex-none text-[11px] tabular-nums"
                    classList={{ "text-accent": active(), "text-text-3": !active() }}
                  >
                    {idx() + 1}
                  </span>
                  <span class="min-w-0 flex-1 truncate">{item.title}</span>
                  <Show when={!chapterHasContent(item)}>
                    <span class="flex-none rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-text-3">
                      {t("readerChrome.chapterRange.notCached")}
                    </span>
                  </Show>
                  <Show when={active()}>
                    <CheckIcon size={16} class="flex-none text-accent" />
                  </Show>
                </button>
              );
            }}
          </For>
        </ScrollArea>
      </div>
    </Show>
  );
}

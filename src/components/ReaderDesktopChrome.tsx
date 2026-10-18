import { Show } from "solid-js";
import { BrowserIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, RestoreBackIcon, SearchIcon } from "./icons";
import { MenuPageSlider } from "./MenuPageSlider";
import { t } from "../lib/i18n";

interface ReaderDesktopSearchProps {
  chapter: string;
  term: string;
  index: number;
  total: number;
  onResults: () => void;
  onRestore: () => void;
  onStep: (direction: -1 | 1) => void;
  onClose: () => void;
}

const controlClass = "grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-30";

/** 搜索期间在正文上方占位，避免覆盖首行或依赖隐藏菜单。 */
export function ReaderDesktopSearch(props: ReaderDesktopSearchProps) {
  return (
    <div data-reader-ui class="flex flex-none items-center gap-1 border-b border-border bg-surface px-3 py-1">
      <button class={`${controlClass} w-auto min-w-0 flex-1 px-2 text-left`} title={t("reader.searchingTerm", { term: props.term })} aria-label={t("reader.backToSearchResults")} onClick={props.onResults}>
        <span class="flex min-w-0 items-center gap-2"><SearchIcon size={18} /><span class="truncate text-sm">{props.chapter}</span></span>
      </button>
      <button class={controlClass} title={t("reader.restorePreSearchPosition")} aria-label={t("reader.restorePreSearchPosition")} onClick={props.onRestore}><RestoreBackIcon size={19} /></button>
      <button class={controlClass} aria-label={t("reader.prevResult")} disabled={props.index <= 0} onClick={() => props.onStep(-1)}><ChevronLeftIcon size={19} /></button>
      <span class="text-xs tabular-nums text-accent" aria-live="polite">{props.index + 1}/{props.total}</span>
      <button class={controlClass} aria-label={t("reader.nextResult")} disabled={props.index + 1 >= props.total} onClick={() => props.onStep(1)}><ChevronRightIcon size={19} /></button>
      <button class={controlClass} aria-label={t("reader.exitSearchMode")} onClick={props.onClose}><CloseIcon size={20} /></button>
    </div>
  );
}

interface ReaderDesktopTocFooterProps {
  progress: string;
  slider: boolean;
  page: number;
  total: number;
  onSeek: (page: number) => void;
  firstChapter: boolean;
  lastChapter: boolean;
  onPrevious: () => void;
  onNext: () => void;
  webUrl?: string;
  onWebview: () => void;
  onBrowser: () => void;
}

export function ReaderDesktopTocFooter(props: ReaderDesktopTocFooterProps) {
  return (
    <div class="flex-none border-t border-border bg-surface pb-3 pt-2">
      <div class="truncate px-4 text-center text-xs tabular-nums text-text-3" title={props.progress}>{props.progress}</div>
      <Show when={props.slider}><MenuPageSlider page={props.page} total={props.total} onCommit={props.onSeek} /></Show>
      <div class="mt-2 flex gap-2 px-4">
        <button class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-border bg-bg py-[9px] text-[12.5px] text-text-2 hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-30" disabled={props.firstChapter} onClick={props.onPrevious}>
          <ChevronLeftIcon size={16} />{t("reader.prevChapter")}
        </button>
        <button class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-border bg-bg py-[9px] text-[12.5px] text-text-2 hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-30" disabled={props.lastChapter} onClick={props.onNext}>
          {t("reader.nextChapter")}<ChevronRightIcon size={16} />
        </button>
      </div>
      <Show when={props.webUrl}>
        <div class="mt-2 flex items-center gap-1 px-3">
          <button type="button" class="min-w-0 flex-1 truncate py-1.5 text-left text-[11px] text-text-3 hover:text-text" title={props.webUrl} aria-label={t("reader.chapterWebviewOpen")} onClick={props.onWebview}>{props.webUrl}</button>
          <button type="button" class={controlClass} aria-label={t("reader.chapterBrowserOpen")} onClick={props.onBrowser}><BrowserIcon size={17} /></button>
        </div>
      </Show>
    </div>
  );
}

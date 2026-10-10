import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Drawer } from "./Drawer";
import { CloseIcon, EditIcon } from "./icons";
import type { LocalBookChapter } from "../lib/booksTypes";
import { chapterEditText, saveChapterEdit } from "../lib/chapterEditing";
import { createAndroidBackHandler } from "../lib/androidBack";
import { reportFailure } from "../lib/errorReport";
import { createLogger } from "../lib/logger";
import { t } from "../lib/i18n";

interface ChapterEditSheetProps {
  bookId: string;
  index: number;
  chapter: LocalBookChapter;
  onClose: () => void;
  onSaved: () => void;
}
const log = createLogger("chapterEditing");

export function ChapterEditSheet(props: ChapterEditSheetProps) {
  // 挂载时冻结编辑目标；不随下载或同步刷新草稿。
  const original = props.chapter;
  const bookId = props.bookId;
  const index = props.index;
  const initial = chapterEditText(original);
  const [draft, setDraft] = createSignal(initial);
  const [confirm, setConfirm] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const close = () => { if (!busy()) props.onClose(); };
  createAndroidBackHandler(() => true, close);
  onMount(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", escape, true);
    onCleanup(() => window.removeEventListener("keydown", escape, true));
  });
  async function save(): Promise<void> {
    if (busy() || !confirm()) return;
    setBusy(true);
    try {
      const written = await saveChapterEdit(bookId, index, original, draft());
      if (!written) throw new Error(t("readerChrome.edit.conflict"));
      log.info("保存章节正文", { bookId, cid: original.cid, chars: draft().length });
      props.onSaved();
    } catch (error) {
      setConfirm(false);
      reportFailure(t("readerChrome.edit.failed"), error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer onClose={close} label={t("readerChrome.settings.editBody")} position="absolute"
      layer={54} sizeClass="h-[85%]" readerUi>
      <div class="flex flex-none items-center gap-2 border-b border-border px-4 py-3">
        <EditIcon size={20} class="text-accent" />
        <span class="min-w-0 flex-1 truncate text-[15px] font-bold">{original.title}</span>
        <button class="grid h-10 w-10 place-items-center rounded-xl text-text-2 active:bg-surface-2"
          aria-label={t("common.close")} disabled={busy()} onClick={close}><CloseIcon /></button>
      </div>
      <label class="flex min-h-0 flex-1 flex-col gap-2 px-4 pt-3 text-sm text-text-2">
        {t("readerChrome.settings.editBody")}
        <textarea class="min-h-0 w-full flex-1 resize-none rounded-xl border border-border bg-bg p-3 text-base leading-relaxed text-text outline-none focus:border-accent"
          value={draft()} disabled={busy() || confirm()} onInput={(e) => setDraft(e.currentTarget.value)} />
      </label>
      <div class="flex flex-none gap-2 px-4 pt-3 pb-[calc(18px+env(safe-area-inset-bottom))]">
        <button class="flex-1 rounded-xl border border-border p-3 text-sm text-text-2"
          disabled={busy()} onClick={close}>{t("common.cancel")}</button>
        <button class="flex-1 rounded-xl bg-accent p-3 text-sm font-semibold text-on-accent disabled:opacity-50"
          disabled={busy() || draft() === initial} onClick={() => setConfirm(true)}>{t("common.save")}</button>
      </div>
      <Show when={confirm()}>
        <div class="absolute inset-0 z-[56] grid place-items-center bg-black/45 px-6" data-reader-ui
          role="alertdialog" aria-modal="true" aria-labelledby="chapter-edit-confirm-title" aria-describedby="chapter-edit-confirm-desc">
          <div class="w-full max-w-[340px] rounded-[18px] border border-border bg-surface p-4 shadow-xl">
            <p id="chapter-edit-confirm-title" class="text-[15px] font-bold">{t("readerChrome.edit.confirmTitle")}</p>
            <p id="chapter-edit-confirm-desc" class="mt-2 text-sm leading-relaxed text-text-2">{t("readerChrome.edit.confirmDesc")}</p>
            <div class="mt-4 flex gap-2">
              <button class="flex-1 rounded-xl border border-border p-3 text-sm" disabled={busy()} onClick={close}>{t("common.cancel")}</button>
              <button class="flex-1 rounded-xl bg-accent p-3 text-sm font-semibold text-on-accent disabled:opacity-50"
                disabled={busy()} onClick={() => void save()}>{busy() ? t("common.loading") : t("common.save")}</button>
            </div>
          </div>
        </div>
      </Show>
    </Drawer>
  );
}

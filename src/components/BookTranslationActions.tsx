import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { ToggleSwitch } from "./ToggleSwitch";
import { ensureLocalBookContent } from "../lib/books";
import { translateBookContent, translateBookTitle, type BookTranslationProgress } from "../lib/translation/manual";
import { effectiveTranslationSettings, saveTranslationBook, translationBookState } from "../lib/translation/settings";
import { reportFailure } from "../lib/errorReport";
import { t } from "../lib/i18n";

const STATUS_KEYS = {
  done: "translation.chapter.done",
  failed: "translation.chapter.failed",
  cancelled: "translation.chapter.cancelled",
} as const;

export function BookTranslationActions(props: { bookId: string; disabled: boolean; hasContent: boolean; onBusyChange: (busy: boolean) => void }) {
  const [running, setRunning] = createSignal<"title" | "content">();
  const [progress, setProgress] = createSignal<BookTranslationProgress>();
  const [status, setStatus] = createSignal<{ kind: "title" | "content"; state: keyof typeof STATUS_KEYS }>();
  let controller: AbortController | undefined;
  let disposed = false;
  onCleanup(() => { disposed = true; controller?.abort(); });
  const enabled = () => effectiveTranslationSettings(props.bookId).enabled;
  createEffect(() => { if (!enabled()) controller?.abort(); });
  const titleEnabled = () => translationBookState(props.bookId)?.titleEnabled === true;

  async function run(kind: "title" | "content", refresh = false) {
    if (running() || props.disabled || !enabled()) return;
    const task = new AbortController();
    controller = task;
    setRunning(kind);
    setStatus(undefined);
    setProgress(undefined);
    props.onBusyChange(true);
    try {
      if (kind === "title" && titleEnabled() && !refresh) {
        await saveTranslationBook(props.bookId, { titleEnabled: false });
      } else {
        const book = await ensureLocalBookContent(props.bookId);
        task.signal.throwIfAborted();
        if (!book) throw new Error(t("translation.stale"));
        if (kind === "title") await translateBookTitle(book, task.signal, refresh);
        else await translateBookContent(book, task.signal, value => { if (!disposed) setProgress(value); });
        if (!disposed) setStatus({ kind, state: "done" });
      }
    } catch (error) {
      if (!disposed) {
        setStatus({ kind, state: task.signal.aborted ? "cancelled" : "failed" });
        if (!task.signal.aborted) reportFailure(t("translation.failed"), error);
      }
    } finally {
      if (controller === task) controller = undefined;
      if (!disposed) { setRunning(undefined); props.onBusyChange(false); }
    }
  }

  return (
    <section class="mb-4 overflow-hidden rounded-[14px] border border-border bg-surface">
      <div class="flex items-center justify-between gap-3 px-4 py-3">
        <span class="text-[14px]">{t("translation.bookTitle")}</span>
        <fieldset disabled={props.disabled || !!running() || !enabled()} class="disabled:opacity-40">
          <ToggleSwitch on={titleEnabled()} label={t("translation.bookTitle")} onChange={() => void run("title")} />
        </fieldset>
      </div>
      <Show when={titleEnabled()}>
        <button class="mb-2 min-h-10 px-4 text-[13px] text-accent disabled:opacity-40" disabled={props.disabled || !!running() || !enabled()} onClick={() => void run("title", true)}>{t("translation.retranslateTitle")}</button>
      </Show>
      <div class="border-t border-border px-4 py-3">
        <button class="min-h-10 w-full rounded-lg border border-border px-3 text-[13px] text-accent disabled:opacity-40" disabled={props.disabled || !!running() || !enabled() || !props.hasContent} onClick={() => void run("content")}>
          {t("translation.bookContent")}
        </button>
        <p class="mt-2 text-[12px] text-text-3">{t("translation.downloadedOnly")}</p>
      </div>
      <Show when={running()}>
        <div class="flex items-center justify-between gap-3 border-t border-border px-4 py-2">
          <p role="status" aria-live="polite" class="text-[12px] text-text-2">{running() === "content" && progress()
            ? t("translation.bookProgress", { completed: progress()!.completed, total: progress()!.total })
            : t("translation.loading")}</p>
          <button class="min-h-10 shrink-0 px-3 text-[13px] text-accent" onClick={() => controller?.abort()}>{t("common.cancel")}</button>
        </div>
      </Show>
      <Show when={status()}>{result => <p role="status" class="border-t border-border px-4 py-3 text-[12px] text-text-2">
        {t(result().kind === "title" ? "translation.bookTitle" : "translation.bookContent")} · {t(STATUS_KEYS[result().state])}
        <Show when={result().kind === "content" && progress()}>{value => <> · {t("translation.bookProgress", { completed: value().completed, total: value().total })}</>}</Show>
      </p>}</Show>
    </section>
  );
}

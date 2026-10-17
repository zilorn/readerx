import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import { BookTranslationSettings } from "../components/BookTranslationSettings";
import { GlossarySheet } from "../components/GlossarySheet";
import { ensureLocalBookContent } from "../lib/books";
import type { LocalBook } from "../lib/booksTypes";
import { bookDisplayTitle } from "../lib/bookDisplay";
import { effectiveTranslationSettings } from "../lib/translation/settings";
import { paragraphTexts, retranslateChapter } from "../lib/translation/engine";
import { reportFailure } from "../lib/errorReport";
import { t } from "../lib/i18n";

export default function TranslationManagementPage() {
  const params = useParams();
  const navigate = useNavigate();
  const [book, setBook] = createSignal<LocalBook>();
  const [loaded, setLoaded] = createSignal(false);
  const [loadError, setLoadError] = createSignal("");
  const [glossaryOpen, setGlossaryOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [limit, setLimit] = createSignal(50);
  const [running, setRunning] = createSignal("");
  const [status, setStatus] = createSignal<Record<string, "done" | "failed" | "cancelled">>({});
  let controller: AbortController | undefined;
  let disposed = false;
  onCleanup(() => { disposed = true; controller?.abort(); });
  async function loadBook() {
    setLoadError("");
    try {
      const current = await ensureLocalBookContent(params.id!);
      if (!disposed) { setBook(current ?? undefined); setLoaded(true); }
    } catch (error) {
      if (!disposed) {
        setLoadError(t("translation.loadFailed"));
        reportFailure(t("translation.loadFailed"), error);
      }
    }
  }
  onMount(() => { void loadBook(); });
  const chapters = createMemo(() => book()?.chapters.filter(chapter =>
    chapter.title.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase()),
  ) ?? []);
  async function translate(cid: string) {
    if (running()) return;
    const task = new AbortController();
    controller = task;
    setRunning(cid);
    try {
      // 操作前重读书库，避免使用进入管理页时的旧正文。
      const current = await ensureLocalBookContent(params.id!);
      task.signal.throwIfAborted();
      const chapter = current?.chapters.find(ch => ch.cid === cid);
      if (!current || !chapter) throw new Error(t("translation.stale"));
      await retranslateChapter(current, chapter, task.signal);
      if (!disposed) setStatus(old => ({ ...old, [cid]: "done" }));
    } catch (error) {
      if (!disposed) {
        setStatus(old => ({ ...old, [cid]: task.signal.aborted ? "cancelled" : "failed" }));
        if (!task.signal.aborted) reportFailure(t("translation.failed"), error);
      }
    } finally {
      if (!disposed) setRunning("");
      if (controller === task) controller = undefined;
    }
  }
  return (
    <div class="page">
      <PageHeader title={t("translation.management")} onBack={() =>
        window.history.length > 1 ? navigate(-1) : navigate(`/detail/${params.id}`)
      } />
      <div class="px-4 pb-8 pt-4">
        <Show when={loadError()}>
          <button class="text-[13px] text-accent" onClick={() => void loadBook()}>{loadError()} · {t("translation.retry")}</button>
        </Show>
        <Show when={book()} fallback={<Show when={loaded()}><p class="text-text-3">{t("book.detail.notFound")}</p></Show>}>
          {current => <>
            <h2 class="mb-3 text-[16px] font-semibold">{bookDisplayTitle(current().title)}</h2>
            <details class="mb-4 rounded-[14px] border border-border bg-surface p-4">
              <summary class="cursor-pointer text-[13px] text-text-2">{t("translation.bookSettings")}</summary>
              <fieldset disabled={!!running()}>
                <BookTranslationSettings bookId={params.id!} showManagement={false} />
              </fieldset>
            </details>
            <button
              class="my-4 w-full rounded-[14px] border border-border bg-surface px-4 py-3 text-left text-[14px] text-accent disabled:opacity-50"
              disabled={!!running()}
              onClick={() => setGlossaryOpen(true)}
            >{t("translation.glossaryTitle")}</button>
            <h3 class="mb-2 text-[13px] font-medium text-text-2">{t("translation.chapterTranslations")}</h3>
            <input
              class="mb-3 w-full rounded-xl border border-border bg-surface px-3 py-2 text-[13px]"
              aria-label={t("translation.searchChapters")}
              placeholder={t("translation.searchChapters")}
              value={query()}
              onInput={event => { setQuery(event.currentTarget.value); setLimit(50); }}
            />
            <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
              <For each={chapters().slice(0, limit())}>
                {chapter => <div class="flex items-center justify-between gap-3 px-4 py-3">
                  <div class="min-w-0 flex-1">
                    <p class="break-words text-[13px]">{chapter.title}</p>
                    <Show when={running() !== chapter.cid && status()[chapter.cid]}>{state => <p role="status" class="mt-1 text-[12px] text-text-3">{t(`translation.chapter.${state()}`)}</p>}</Show>
                    <Show when={!paragraphTexts(chapter).length}><p class="mt-1 text-[12px] text-text-3">{t("translation.chapter.noText")}</p></Show>
                  </div>
                  <Show when={running() === chapter.cid} fallback={
                    <button
                      class="min-h-10 shrink-0 rounded-lg border border-border px-3 text-[12px] text-accent disabled:opacity-40"
                      disabled={!!running() || !effectiveTranslationSettings(params.id!).enabled || !paragraphTexts(chapter).length}
                      onClick={() => void translate(chapter.cid)}
                    >{t("translation.retranslate")}</button>
                  }>
                    <div class="flex shrink-0 flex-col items-end gap-1">
                      <span role="status" class="text-[12px] text-text-3">{t("translation.loading")}</span>
                      <button class="min-h-10 px-3 text-[12px] text-accent" onClick={() => controller?.abort()}>{t("common.cancel")}</button>
                    </div>
                  </Show>
                </div>}
              </For>
            </div>
            <Show when={chapters().length > limit()}><button class="mt-3 min-h-10 w-full text-[13px] text-accent" onClick={() => setLimit(value => value + 50)}>{t("translation.moreChapters")}</button></Show>
          </>}
        </Show>
      </div>
      <Show when={glossaryOpen()}><GlossarySheet bookId={params.id!} onClose={() => setGlossaryOpen(false)} /></Show>
    </div>
  );
}

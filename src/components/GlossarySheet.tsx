import { Index, Show, createSignal, onMount, onCleanup } from "solid-js";
import { Drawer } from "./Drawer";
import { CloseIcon, PlusIcon, TrashIcon, RefreshIcon } from "./icons";
import { t } from "../lib/i18n";
import { ensureLocalBookContent } from "../lib/books";
import {
  ensureTranslationSettings,
  ensureTranslationBook,
  effectiveTranslationSettings,
  translationBookState,
  saveTranslationBook,
} from "../lib/translation/settings";
import { bookTerms } from "../lib/translation/engine";
import { normalizeTerms } from "../lib/translation/core";
import type { GlossaryTerm } from "../lib/translation/types";
import { reportFailure } from "../lib/errorReport";
import { createAndroidBackHandler } from "../lib/androidBack";
export function GlossarySheet(props: { bookId: string; onClose: () => void }) {
  const [terms, setTerms] = createSignal<GlossaryTerm[]>([]);
  let glossaryTarget: string | undefined;
  const [ready, setReady] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  createAndroidBackHandler(() => true, props.onClose);
  onMount(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener("keydown", escape);
    onCleanup(() => window.removeEventListener("keydown", escape));
    void Promise.all([
      ensureTranslationSettings(),
      ensureTranslationBook(props.bookId),
    ])
      .then(() => {
        const state = translationBookState(props.bookId)!;
        setTerms(structuredClone(state.terms));
        // 草稿沿用条目所属语言；只有新建的空表才使用当前配置。
        glossaryTarget = state.glossaryTarget ?? (state.terms.length
          ? undefined
          : effectiveTranslationSettings(props.bookId).target);
        setReady(true);
      })
      .catch((err) => reportFailure(t("translation.loadFailed"), err));
  });
  async function regenerate() {
    setBusy(true);
    setError("");
    try {
      const book = await ensureLocalBookContent(props.bookId);
      if (!book) return;
      const settings = effectiveTranslationSettings(props.bookId);
      const result = await bookTerms(
        book,
        settings,
        controller.signal,
        true,
      );
      if (!controller.signal.aborted) {
        setTerms(result);
        glossaryTarget = settings.target;
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : t("translation.failed"));
        reportFailure(t("translation.failed"), err);
      }
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    try {
      await saveTranslationBook(props.bookId, {
        terms: normalizeTerms(terms()),
        glossaryTarget,
      });
      props.onClose();
    } catch (err) {
      reportFailure(t("translation.saveFailed"), err);
    } finally {
      setBusy(false);
    }
  }
  const inputClass =
    "min-w-0 w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px]";
  function change(index: number, key: keyof GlossaryTerm, value: string) {
    setTerms((old) =>
      old.map((term, i) => (i === index ? { ...term, [key]: value } : term)),
    );
  }
  return (
    <Drawer
      label={t("translation.glossaryTitle")}
      onClose={props.onClose}
      sizeClass="h-[78%]"
    >
      <div class="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 class="font-semibold">{t("translation.glossaryTitle")}</h2>
        <button aria-label={t("common.close")} onClick={props.onClose}>
          <CloseIcon />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        <Show when={ready()}>
          <button
            class="mb-4 flex items-center gap-2 text-[13px] text-accent disabled:opacity-50"
            disabled={busy()}
            onClick={() => void regenerate()}
          >
            <RefreshIcon size={16} class={busy() ? "animate-spin" : ""} />
            {busy() ? t("translation.generating") : t("translation.regenerate")}
          </button>
          <Show when={error()}>
            <p class="mb-4 text-[12px] text-danger">{error()}</p>
          </Show>
          <Index each={terms()}>
            {(term, index) => (
              <div class="mb-3 rounded-xl border border-border p-3">
                <div class="mb-2 flex items-center gap-2">
                  <input
                    class={inputClass}
                    value={term().source}
                    disabled={busy()}
                    maxLength={100}
                    aria-label={t("translation.source")}
                    placeholder={t("translation.source")}
                    onInput={(e) =>
                      change(index, "source", e.currentTarget.value)
                    }
                  />
                  <input
                    class={inputClass}
                    value={term().target}
                    disabled={busy()}
                    maxLength={100}
                    aria-label={t("translation.translatedTerm")}
                    placeholder={t("translation.translatedTerm")}
                    onInput={(e) =>
                      change(index, "target", e.currentTarget.value)
                    }
                  />
                  <button
                    aria-label={t("translation.removeTerm")}
                    class="flex-none text-text-3"
                    onClick={() =>
                      setTerms((old) => old.filter((_, i) => i !== index))
                    }
                  >
                    <TrashIcon size={16} />
                  </button>
                </div>
                <input
                  class={inputClass}
                  value={term().note}
                  disabled={busy()}
                  maxLength={29}
                  aria-label={t("translation.note")}
                  placeholder={t("translation.note")}
                  onInput={(e) => change(index, "note", e.currentTarget.value)}
                />
              </div>
            )}
          </Index>
          <button
            class="flex items-center gap-2 text-[13px] text-accent disabled:opacity-50"
            disabled={busy() || terms().length >= 200}
            onClick={() =>
              setTerms((old) => [...old, { source: "", target: "", note: "" }])
            }
          >
            <PlusIcon size={16} />
            {t("translation.addTerm")}
          </button>
        </Show>
      </div>
      <div class="border-t border-border p-4">
        <button
          class="w-full rounded-xl bg-accent py-3 text-[14px] font-medium text-white disabled:opacity-50"
          disabled={!ready() || busy()}
          onClick={() => void save()}
        >
          {t("translation.save")}
        </button>
      </div>
    </Drawer>
  );
}

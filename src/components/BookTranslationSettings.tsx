import { Show, onMount, createSignal } from "solid-js";
import { TranslationReadingToggle } from "./TranslationReadingToggle";
import { TranslationOptions } from "./TranslationOptions";
import {
  effectiveTranslationSettings,
  ensureTranslationBook,
  ensureTranslationSettings,
  translationSettings,
  saveTranslationBook,
  setBookTranslationOverride,
} from "../lib/translation/settings";
import { reportFailure } from "../lib/errorReport";
import { t } from "../lib/i18n";
import { A } from "@solidjs/router";
import { ToggleSwitch } from "./ToggleSwitch";
export function BookTranslationSettings(props: { bookId: string; showManagement?: boolean }) {
  const [ready, setReady] = createSignal(false);
  onMount(() => {
    void Promise.all([
      ensureTranslationSettings(),
      ensureTranslationBook(props.bookId),
    ])
      .then(() => setReady(true))
      .catch((error) => reportFailure(t("translation.loadFailed"), error));
  });
  return (
    <Show when={ready()}>
      <section class="mt-4">
        <div class="mb-2 flex items-center justify-between gap-2">
          <h3 class="text-[13px] font-medium text-text-2">
            {t("translation.bookSettings")}
          </h3>
          <button
            class="text-[12px] text-accent"
            onClick={() => {
              void saveTranslationBook(props.bookId, { overrides: {} }).catch(
                (error) => reportFailure(t("translation.saveFailed"), error),
              );
            }}
          >
            {t("translation.inherit")}
          </button>
        </div>
        <Show when={props.showManagement !== false}>
          <A
            href={`/book/${encodeURIComponent(props.bookId)}/translation`}
            class="mb-2 block rounded-[14px] border border-border bg-surface px-4 py-3 text-[13px] text-accent"
          >
            {t("translation.management")}
          </A>
        </Show>
        <Show
          when={translationSettings().enabled}
          fallback={
            <p class="px-2 py-3 text-[12px] text-text-3">
              {t("translation.globalOff")}
            </p>
          }
        >
          <p class="mb-2 text-[12px] text-text-3">
            {t("translation.bookInherit")}
          </p>
          <div class="mb-2 overflow-hidden rounded-[14px] border border-border bg-surface">
            <TranslationReadingToggle
              readingText={effectiveTranslationSettings(props.bookId).readingText}
              onChange={readingText => setBookTranslationOverride(props.bookId, { readingText })}
            />
            <div class="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
              <span class="text-[13px]">{t("translation.glossary")}</span>
              <ToggleSwitch
                on={effectiveTranslationSettings(props.bookId).glossary}
                label={t("translation.glossary")}
                onChange={() => {
                  void setBookTranslationOverride(props.bookId, {
                    glossary: !effectiveTranslationSettings(props.bookId).glossary,
                  }).catch(error => reportFailure(t("translation.saveFailed"), error));
                }}
              />
            </div>
          </div>
          <TranslationOptions
            value={effectiveTranslationSettings(props.bookId)}
            showEnabled
            showGlossary={false}
            onChange={(patch) => {
              void setBookTranslationOverride(props.bookId, patch).catch(
                (error) => reportFailure(t("translation.saveFailed"), error),
              );
            }}
          />
        </Show>
      </section>
    </Show>
  );
}

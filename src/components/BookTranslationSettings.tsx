import { Show, onMount, createSignal } from "solid-js";
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
export function BookTranslationSettings(props: { bookId: string }) {
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
          <TranslationOptions
            value={effectiveTranslationSettings(props.bookId)}
            showEnabled
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

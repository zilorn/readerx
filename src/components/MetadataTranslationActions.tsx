import { Show } from "solid-js";
import { t } from "../lib/i18n";
import type { MetadataTranslation } from "../lib/translation/metadata";

export function MetadataTranslationActions(props: { translation: MetadataTranslation; disabled?: boolean }) {
  const state = props.translation;
  return <Show when={state.enabled()}>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-1 text-[12px] text-accent">
      <Show when={state.running()} fallback={
        <button type="button" class="min-h-10 text-left disabled:opacity-40" disabled={props.disabled}
          onClick={() => void state.run(state.complete())}>
          {state.failed() ? t("translation.retryMetadata") : state.complete() ? t("translation.retranslateMetadata") : t("translation.translateMetadata")}
        </button>
      }>
        <span role="status" aria-live="polite" class="text-text-3">{t("translation.loading")}</span>
        <button type="button" class="min-h-10" onClick={state.cancel}>{t("common.cancel")}</button>
      </Show>
      <Show when={state.hasTranslation()}>
        <button type="button" class="min-h-10" onClick={state.toggleOriginal}>
          {state.original() ? t("translation.showMetadataTranslation") : t("translation.showMetadataOriginal")}
        </button>
      </Show>
    </div>
  </Show>;
}

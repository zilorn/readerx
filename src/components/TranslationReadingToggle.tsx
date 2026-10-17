import { createSignal } from "solid-js";
import { TranslateIcon } from "./icons";
import { t } from "../lib/i18n";
import { reportFailure } from "../lib/errorReport";
import type { TranslationSettings } from "../lib/translation/types";

export function TranslationReadingToggle(props: {
  mode: TranslationSettings["mode"];
  onChange: (mode: TranslationSettings["mode"]) => Promise<void>;
}) {
  const [busy, setBusy] = createSignal(false);
  async function toggleTranslationReading(): Promise<void> {
    if (busy()) return;
    const mode = props.mode === "translated" ? "original" : "translated";
    setBusy(true);
    try {
      await props.onChange(mode);
    } catch (error) {
      reportFailure(t("translation.saveFailed"), error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <span class="text-[13px] text-text-2">{t("translation.readingText")}</span>
      <button
        type="button"
        class="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[10px] border border-border bg-bg px-3 text-[12.5px] text-text-2 transition-colors hover:bg-surface-2 disabled:opacity-30"
        aria-pressed={props.mode === "translated"}
        disabled={busy()}
        onClick={() => void toggleTranslationReading()}
      >
        <TranslateIcon size={17} />
        {props.mode === "translated" ? t("translation.readOriginal") : t("translation.readTranslation")}
      </button>
    </div>
  );
}

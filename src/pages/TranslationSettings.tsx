import { TranslationReadingToggle } from "../components/TranslationReadingToggle";
import { useNavigate } from "@solidjs/router";
import { onMount } from "solid-js";
import { PageHeader } from "../components/PageHeader";
import { TranslationOptions } from "../components/TranslationOptions";
import {
  ensureTranslationSettings,
  saveTranslationSettings,
  translationSettings,
} from "../lib/translation/settings";
import { t } from "../lib/i18n";
import { reportFailure } from "../lib/errorReport";
export default function TranslationSettingsPage() {
  const navigate = useNavigate();
  onMount(() => {
    void ensureTranslationSettings().catch((error) =>
      reportFailure(t("translation.loadFailed"), error),
    );
  });
  return (
    <div class="page">
      <PageHeader
        title={t("translation.configure")}
        onBack={() => navigate(-1)}
      />
      <div class="px-4 pb-8 pt-4">
        <div class="mb-3 overflow-hidden rounded-[14px] border border-border bg-surface">
          <TranslationReadingToggle readingText={translationSettings().readingText} onChange={readingText => saveTranslationSettings({ readingText })} />
        </div>
        <TranslationOptions
          value={translationSettings()}
          onChange={(patch) => {
            void saveTranslationSettings(patch).catch((error) =>
              reportFailure(t("translation.saveFailed"), error),
            );
          }}
        />
      </div>
    </div>
  );
}

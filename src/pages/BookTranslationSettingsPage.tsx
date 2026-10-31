import { useNavigate, useParams } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import { BookTranslationSettings } from "../components/BookTranslationSettings";
import { t } from "../lib/i18n";

/** 本书翻译设置独立页（入口：阅读器「阅读设置」的翻译设置行）。 */
export default function BookTranslationSettingsPage() {
  const params = useParams();
  const navigate = useNavigate();
  return (
    <div class="page">
      <PageHeader
        title={t("translation.settingsTitle")}
        onBack={() =>
          window.history.length > 1
            ? navigate(-1)
            : navigate(`/book/${encodeURIComponent(params.id!)}`)
        }
      />
      <div class="px-4 pb-8 pt-4">
        <BookTranslationSettings bookId={params.id!} />
      </div>
    </div>
  );
}

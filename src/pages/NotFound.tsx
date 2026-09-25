import { useNavigate } from "@solidjs/router";
import { BookOpenIcon } from "../components/icons";
import { t } from "../lib/i18n";

export default function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div class="flex h-full min-h-[320px] flex-col items-center justify-center gap-1 px-6 text-center">
      <BookOpenIcon size={58} class="mb-3 text-text-3" />
      <p class="text-[40px] font-extrabold leading-none tracking-[0.04em] text-surface-2">
        404
      </p>
      <p class="text-[16.5px] font-bold text-text">{t("shell.notFound.title")}</p>
      <p class="mb-[18px] text-[12.5px] text-text-3">
        {t("shell.notFound.desc")}
      </p>
      <button
        class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-[22px] py-[11px] text-sm font-semibold text-on-accent shadow-lg shadow-accent/30 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
        onClick={() => navigate("/")}
      >
        {t("shell.notFound.action")}
      </button>
    </div>
  );
}

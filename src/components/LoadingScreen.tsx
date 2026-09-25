import { t } from "../lib/i18n";

export function LoadingScreen(props: { label?: string }) {
  return (
    <div
      class="flex h-full min-h-[260px] flex-col items-center justify-center gap-3.5 text-[12.5px] text-text-3"
      role="status"
    >
      <span
        class="size-7 animate-spin rounded-full border-[3px] border-surface-2 border-t-accent"
        aria-hidden="true"
      />
      <span>{props.label ?? t("common.loading")}</span>
    </div>
  );
}

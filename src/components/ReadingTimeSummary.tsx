import { For, onMount } from "solid-js";
import { readingTimeStats } from "../lib/store";
import { loadReadingTime, readingDay } from "../lib/readingTime";
import { t } from "../lib/i18n";

export function ReadingTimeSummary() {
  onMount(loadReadingTime);
  const entries = ["today", "week", "total"] as const;
  function duration(period: typeof entries[number]): string {
    const days = readingTimeStats().days;
    let milliseconds = 0;
    if (period === "total") milliseconds = Object.values(days).reduce((sum, value) => sum + value, 0);
    else {
      const date = new Date();
      for (let i = 0; i < (period === "today" ? 1 : 7); i++) {
        milliseconds += days[readingDay(date)] ?? 0;
        date.setDate(date.getDate() - 1);
      }
    }
    const minutes = Math.floor(milliseconds / 60_000);
    return t("settings.readingTime.duration", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  }
  return (
    <div class="px-4 py-[13px]">
      <div class="mb-3 text-[14.5px] font-medium">{t("settings.readingTime.title")}</div>
      <div class="grid grid-cols-3 gap-2">
        <For each={entries}>{(period) => (
          <div>
            <div class="text-[11.5px] text-text-3">{t(`settings.readingTime.${period}`)}</div>
            <div class="mt-1 text-[13px] font-semibold tabular-nums">{duration(period)}</div>
          </div>
        )}</For>
      </div>
    </div>
  );
}

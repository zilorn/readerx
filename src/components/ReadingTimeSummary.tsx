import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { A } from "@solidjs/router";
import { readingTimeStats } from "../lib/store";
import { formatReadingDuration, loadReadingTime, readingDay } from "../lib/readingTime";
import { t } from "../lib/i18n";
import { ChevronRightIcon } from "./icons";

interface ReadingTimeSummaryProps {
  showDetailsLink?: boolean;
}

export function ReadingTimeSummary(props: ReadingTimeSummaryProps) {
  const [today, setToday] = createSignal(readingDay());
  onMount(() => {
    void loadReadingTime();
    const timer = window.setInterval(() => setToday(readingDay()), 60_000);
    onCleanup(() => window.clearInterval(timer));
  });
  const week = createMemo(() => {
    const date = new Date(`${today()}T12:00:00`);
    let total = 0;
    for (let index = 0; index < 7; index++) {
      total += readingTimeStats().days[readingDay(date)] ?? 0;
      date.setDate(date.getDate() - 1);
    }
    return total;
  });
  const summaries = () => [
    { key: "today", value: readingTimeStats().days[today()] ?? 0 },
    { key: "week", value: week() },
    { key: "total", value: Object.values(readingTimeStats().days).reduce((sum, value) => sum + value, 0) },
  ] as const;

  return (
    <div class="px-4 py-[13px]">
      <Show when={props.showDetailsLink !== false}>
        <A href="/reading-time" class="mb-3 flex min-h-9 w-full items-center justify-between gap-2 text-left">
          <span class="text-[14.5px] font-medium">{t("settings.readingTime.title")}</span>
          <span class="flex items-center gap-1 text-[12px] text-text-3">
            {t("settings.readingTime.details")}
            <ChevronRightIcon size={16} />
          </span>
        </A>
      </Show>
      <div class="grid grid-cols-3 gap-2">
        <For each={summaries()}>{(entry) => (
          <div>
            <div class="text-[11.5px] text-text-3">{t(`settings.readingTime.${entry.key}`)}</div>
            <div class="mt-1 text-[13px] font-semibold tabular-nums">{formatReadingDuration(entry.value)}</div>
          </div>
        )}</For>
      </div>
    </div>
  );
}

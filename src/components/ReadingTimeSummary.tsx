import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { readingTimeStats } from "../lib/store";
import { loadReadingTime, readingDay } from "../lib/readingTime";
import { bookMetaById, ensureLocalBooksLoaded } from "../lib/books";
import { bookDisplayTitle } from "../lib/bookDisplay";
import { currentLocale, t } from "../lib/i18n";
import { ChevronRightIcon } from "./icons";

function formatDuration(milliseconds: number): string {
  if (milliseconds > 0 && milliseconds < 60_000) return t("settings.readingTime.lessThanMinute");
  const minutes = Math.floor(milliseconds / 60_000);
  return t("settings.readingTime.duration", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

export function ReadingTimeSummary() {
  const [expanded, setExpanded] = createSignal(false);
  const [period, setPeriod] = createSignal<7 | 30>(7);
  const [today, setToday] = createSignal(readingDay());
  const [selectedDay, setSelectedDay] = createSignal<string>();
  const [allBooks, setAllBooks] = createSignal(false);
  onMount(() => {
    void loadReadingTime();
    void ensureLocalBooksLoaded();
    const timer = window.setInterval(() => setToday(readingDay()), 60_000);
    onCleanup(() => window.clearInterval(timer));
  });
  const days = createMemo(() => {
    const date = new Date(`${today()}T12:00:00`);
    return Array.from({ length: period() }, (_, index) => {
      const day = new Date(date);
      day.setDate(day.getDate() - period() + index + 1);
      const key = readingDay(day);
      return { key, date: day, milliseconds: readingTimeStats().days[key] ?? 0 };
    });
  });
  const total = createMemo(() => Object.values(readingTimeStats().days).reduce((sum, value) => sum + value, 0));
  const week = createMemo(() => days().slice(-7).reduce((sum, day) => sum + day.milliseconds, 0));
  const periodTotal = createMemo(() => days().reduce((sum, day) => sum + day.milliseconds, 0));
  const activeDays = createMemo(() => days().filter((day) => day.milliseconds > 0).length);
  const maximum = createMemo(() => Math.max(1, ...days().map((day) => day.milliseconds)));
  const selected = createMemo(() => days().find((day) => day.key === selectedDay()) ?? days()[days().length - 1]);
  const streak = createMemo(() => {
    const date = new Date(`${today()}T12:00:00`);
    const records = readingTimeStats().days;
    // 今日尚未阅读时，连续天数截至昨日。
    if (!(records[readingDay(date)] > 0)) date.setDate(date.getDate() - 1);
    let count = 0;
    while (records[readingDay(date)] > 0) {
      count++;
      date.setDate(date.getDate() - 1);
    }
    return count;
  });
  const rankedBooks = createMemo(() => Object.entries(readingTimeStats().books)
    .filter(([, milliseconds]) => milliseconds > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const bookTotal = createMemo(() => rankedBooks().reduce((sum, [, value]) => sum + value, 0));
  const dateLabel = (date: Date) => new Intl.DateTimeFormat(currentLocale(), { month: "short", day: "numeric" }).format(date);
  const fullDateLabel = (date: Date) => new Intl.DateTimeFormat(currentLocale(), { year: "numeric", month: "short", day: "numeric", weekday: "short" }).format(date);
  const summaries = () => [
    { key: "today", value: readingTimeStats().days[today()] ?? 0 },
    { key: "week", value: week() },
    { key: "total", value: total() },
  ] as const;

  return (
    <div class="px-4 py-[13px]">
      <button type="button" class="mb-3 flex min-h-9 w-full items-center justify-between gap-2 text-left" aria-expanded={expanded()} onClick={() => setExpanded(!expanded())}>
        <span class="text-[14.5px] font-medium">{t("settings.readingTime.title")}</span>
        <span class="flex items-center gap-1 text-[12px] text-text-3">
          {t(expanded() ? "settings.readingTime.collapse" : "settings.readingTime.details")}
          <span class="transition-transform" classList={{ "rotate-90": expanded() }}><ChevronRightIcon size={16} /></span>
        </span>
      </button>
      <div class="grid grid-cols-3 gap-2">
        <For each={summaries()}>{(entry) => (
          <div>
            <div class="text-[11.5px] text-text-3">{t(`settings.readingTime.${entry.key}`)}</div>
            <div class="mt-1 text-[13px] font-semibold tabular-nums">{formatDuration(entry.value)}</div>
          </div>
        )}</For>
      </div>
      <Show when={expanded()}>
        <div class="mt-5 border-t border-border pt-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-[13px] font-medium">{t("settings.readingTime.trend")}</h3>
            <div class="flex gap-1 rounded-lg bg-bg p-1" role="group" aria-label={t("settings.readingTime.period")}>
              <For each={[7, 30] as const}>{(value) => (
                <button type="button" class="min-h-9 rounded-md px-3 text-[12px]" classList={{ "bg-accent-weak text-accent": period() === value, "text-text-2": period() !== value }} aria-pressed={period() === value} onClick={() => { setPeriod(value); setSelectedDay(undefined); }}>
                  {t(value === 7 ? "settings.readingTime.week" : "settings.readingTime.month")}
                </button>
              )}</For>
            </div>
          </div>
          <div class="mt-3 text-[18px] font-semibold tabular-nums">{formatDuration(periodTotal())}</div>
          <div class="mt-2 grid grid-cols-3 gap-2 text-[11.5px] text-text-3">
            <div>{t("settings.readingTime.activeDays")}<div class="mt-1 text-[13px] font-medium text-text">{t("settings.readingTime.days", { count: activeDays() })}</div></div>
            <div>{t("settings.readingTime.dailyAverage")}<div class="mt-1 text-[13px] font-medium text-text">{formatDuration(periodTotal() / period())}</div></div>
            <div>{t("settings.readingTime.streak")}<div class="mt-1 text-[13px] font-medium text-text">{t("settings.readingTime.days", { count: streak() })}</div></div>
          </div>
          <div class="mt-5 flex h-28 items-end gap-1" role="group" aria-label={t("settings.readingTime.trend")}>
            <For each={days()}>{(day) => (
              <button type="button" class="flex h-full min-w-0 flex-1 items-end rounded-sm focus-visible:outline-2 focus-visible:outline-accent" aria-label={`${fullDateLabel(day.date)}: ${formatDuration(day.milliseconds)}`} aria-pressed={selected().key === day.key} title={`${fullDateLabel(day.date)}: ${formatDuration(day.milliseconds)}`} onClick={() => setSelectedDay(day.key)}>
                <span class="w-full rounded-t-sm" classList={{ "bg-accent": selected().key === day.key, "bg-accent-weak": selected().key !== day.key && day.milliseconds > 0, "bg-border": selected().key !== day.key && day.milliseconds === 0 }} style={{ height: `${day.milliseconds > 0 ? Math.max(4, day.milliseconds / maximum() * 100) : 2}%` }} />
              </button>
            )}</For>
          </div>
          <div class="mt-2 flex justify-between text-[11px] text-text-3"><span>{dateLabel(days()[0].date)}</span><span>{dateLabel(days()[days().length - 1].date)}</span></div>
          <div class="mt-3 flex flex-wrap justify-between gap-1 rounded-lg bg-bg px-3 py-2 text-[12px]" aria-live="polite"><span class="text-text-2">{fullDateLabel(selected().date)}</span><span class="font-medium tabular-nums">{formatDuration(selected().milliseconds)}</span></div>
          <Show when={periodTotal() === 0}><p class="mt-3 text-[12px] text-text-3">{t("settings.readingTime.emptyPeriod")}</p></Show>
        </div>
        <div class="mt-5 border-t border-border pt-4">
          <h3 class="mb-3 text-[13px] font-medium">{t("settings.readingTime.bookRanking")}</h3>
          <Show when={rankedBooks().length > 0} fallback={<p class="text-[12px] text-text-3">{t("settings.readingTime.emptyBooks")}</p>}>
            <ol class="space-y-3">
              <For each={allBooks() ? rankedBooks() : rankedBooks().slice(0, 5)}>{([id, milliseconds], index) => (
                <li class="flex gap-3">
                  <span class="w-4 shrink-0 text-[12px] tabular-nums text-text-3">{index() + 1}</span>
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[12px]">
                      <span class="min-w-0 break-words">{bookMetaById(id) ? bookDisplayTitle(bookMetaById(id)?.title) : t("settings.readingTime.removedBook")}</span>
                      <span class="shrink-0 tabular-nums text-text-2">{formatDuration(milliseconds)} · {Math.round(milliseconds / bookTotal() * 100)}%</span>
                    </div>
                    <div class="mt-2 h-1 overflow-hidden rounded-full bg-border" aria-hidden="true"><div class="h-full rounded-full bg-accent" style={{ width: `${milliseconds / bookTotal() * 100}%` }} /></div>
                  </div>
                </li>
              )}</For>
            </ol>
            <Show when={rankedBooks().length > 5}><button type="button" class="mt-3 min-h-10 w-full text-[12px] text-accent" aria-expanded={allBooks()} onClick={() => setAllBooks(!allBooks())}>{t(allBooks() ? "settings.readingTime.showLess" : "settings.readingTime.showAll", { count: rankedBooks().length })}</button></Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}

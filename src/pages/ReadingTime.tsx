import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { readingTimeStats } from "../lib/store";
import { formatReadingDuration, readingDay } from "../lib/readingTime";
import { bookMetaById, ensureLocalBooksLoaded } from "../lib/books";
import { bookDisplayTitle } from "../lib/bookDisplay";
import { isHiddenGroupId } from "../lib/groups";
import { currentLocale, t } from "../lib/i18n";
import { useNavigate } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import { ReadingTimeSummary } from "../components/ReadingTimeSummary";

interface RankedEntry {
  /** 书籍 id；「隐藏的书籍」与「已移出书库的书籍」各自汇总为一项，没有 id */
  id: string | null;
  kind: "book" | "hidden" | "removed";
  milliseconds: number;
}

/** 排行条目标题；已移出书库的书籍取不到元信息，用汇总标题 */
function entryTitle(entry: RankedEntry): string {
  if (entry.kind === "hidden") return t("settings.readingTime.hiddenBooks");
  if (entry.kind === "removed") return t("settings.readingTime.removedBooks");
  const meta = entry.id ? bookMetaById(entry.id) : undefined;
  return meta ? bookDisplayTitle(meta.title) : t("settings.readingTime.removedBooks");
}

export default function ReadingTimePage() {
  const navigate = useNavigate();
  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/settings");
  }
  const [period, setPeriod] = createSignal<7 | 30>(7);
  const [today, setToday] = createSignal(readingDay());
  const [selectedDay, setSelectedDay] = createSignal<string>();
  const [allBooks, setAllBooks] = createSignal(false);
  onMount(() => {
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
  // 隐藏分组与已移出书库的书籍各自汇总为一项，避免大量同名条目淹没排行。
  const rankedBooks = createMemo<RankedEntry[]>(() => {
    const entries: RankedEntry[] = [];
    let hiddenMilliseconds = 0;
    let removedMilliseconds = 0;
    for (const [id, milliseconds] of Object.entries(readingTimeStats().books)) {
      if (milliseconds <= 0) continue;
      const meta = bookMetaById(id);
      if (isHiddenGroupId(meta?.groupId)) hiddenMilliseconds += milliseconds;
      else if (meta) entries.push({ id, kind: "book", milliseconds });
      else removedMilliseconds += milliseconds;
    }
    if (hiddenMilliseconds > 0) entries.push({ id: null, kind: "hidden", milliseconds: hiddenMilliseconds });
    if (removedMilliseconds > 0) entries.push({ id: null, kind: "removed", milliseconds: removedMilliseconds });
    return entries.sort((a, b) => b.milliseconds - a.milliseconds || (a.id ?? a.kind).localeCompare(b.id ?? b.kind));
  });
  const bookTotal = createMemo(() => rankedBooks().reduce((sum, entry) => sum + entry.milliseconds, 0));
  const dateLabel = (date: Date) => new Intl.DateTimeFormat(currentLocale(), { month: "short", day: "numeric" }).format(date);
  const fullDateLabel = (date: Date) => new Intl.DateTimeFormat(currentLocale(), { year: "numeric", month: "short", day: "numeric", weekday: "short" }).format(date);
  return (
    <div class="page">
      <PageHeader title={t("settings.readingTime.title")} onBack={goBack} />
      <div class="space-y-4 px-[18px] pb-[calc(36px+env(safe-area-inset-bottom))] pt-3">
        <section class="rounded-[14px] border border-border bg-surface">
          <ReadingTimeSummary showDetailsLink={false} />
        </section>
        <section class="rounded-[14px] border border-border bg-surface p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-[13px] font-medium">{t("settings.readingTime.trend")}</h2>
            <div class="flex gap-1 rounded-lg bg-bg p-1" role="group" aria-label={t("settings.readingTime.period")}>
              <For each={[7, 30] as const}>{(value) => (
                <button type="button" class="min-h-9 rounded-md px-3 text-[12px]" classList={{ "bg-accent-weak text-accent": period() === value, "text-text-2": period() !== value }} aria-pressed={period() === value} onClick={() => { setPeriod(value); setSelectedDay(undefined); }}>
                  {t(value === 7 ? "settings.readingTime.week" : "settings.readingTime.month")}
                </button>
              )}</For>
            </div>
          </div>
          <div class="mt-3 text-[18px] font-semibold tabular-nums">{formatReadingDuration(periodTotal())}</div>
          <div class="mt-2 grid grid-cols-3 gap-2 text-[11.5px] text-text-3">
            <div>{t("settings.readingTime.activeDays")}<div class="mt-1 text-[13px] font-medium text-text">{t("settings.readingTime.days", { count: activeDays() })}</div></div>
            <div>{t("settings.readingTime.dailyAverage")}<div class="mt-1 text-[13px] font-medium text-text">{formatReadingDuration(periodTotal() / period())}</div></div>
            <div>{t("settings.readingTime.streak")}<div class="mt-1 text-[13px] font-medium text-text">{t("settings.readingTime.days", { count: streak() })}</div></div>
          </div>
          <div class="mt-5 flex h-28 items-end gap-1" role="group" aria-label={t("settings.readingTime.trend")}>
            <For each={days()}>{(day) => (
              <button type="button" class="flex h-full min-w-0 flex-1 items-end rounded-sm focus-visible:outline-2 focus-visible:outline-accent" aria-label={`${fullDateLabel(day.date)}: ${formatReadingDuration(day.milliseconds)}`} aria-pressed={selected().key === day.key} title={`${fullDateLabel(day.date)}: ${formatReadingDuration(day.milliseconds)}`} onClick={() => setSelectedDay(day.key)}>
                <span class="w-full rounded-t-sm" classList={{ "bg-accent": selected().key === day.key, "bg-accent-weak": selected().key !== day.key && day.milliseconds > 0, "bg-border": selected().key !== day.key && day.milliseconds === 0 }} style={{ height: `${day.milliseconds > 0 ? Math.max(4, day.milliseconds / maximum() * 100) : 2}%` }} />
              </button>
            )}</For>
          </div>
          <div class="mt-2 flex justify-between text-[11px] text-text-3"><span>{dateLabel(days()[0].date)}</span><span>{dateLabel(days()[days().length - 1].date)}</span></div>
          <div class="mt-3 flex flex-wrap justify-between gap-1 rounded-lg bg-bg px-3 py-2 text-[12px]" aria-live="polite"><span class="text-text-2">{fullDateLabel(selected().date)}</span><span class="font-medium tabular-nums">{formatReadingDuration(selected().milliseconds)}</span></div>
          <Show when={periodTotal() === 0}><p class="mt-3 text-[12px] text-text-3">{t("settings.readingTime.emptyPeriod")}</p></Show>
        </section>
        <section class="rounded-[14px] border border-border bg-surface p-4">
          <h2 class="mb-3 text-[13px] font-medium">{t("settings.readingTime.bookRanking")}</h2>
          <Show when={rankedBooks().length > 0} fallback={<p class="text-[12px] text-text-3">{t("settings.readingTime.emptyBooks")}</p>}>
            <ol class="space-y-3">
              <For each={allBooks() ? rankedBooks() : rankedBooks().slice(0, 5)}>{(entry, index) => (
                <li class="flex gap-3">
                  <span class="w-4 shrink-0 text-[12px] tabular-nums text-text-3">{index() + 1}</span>
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[12px]">
                      <span class="min-w-0 break-words">{entryTitle(entry)}</span>
                      <span class="shrink-0 tabular-nums text-text-2">{formatReadingDuration(entry.milliseconds)} · {Math.round(entry.milliseconds / bookTotal() * 100)}%</span>
                    </div>
                    <div class="mt-2 h-1 overflow-hidden rounded-full bg-border" aria-hidden="true"><div class="h-full rounded-full bg-accent" style={{ width: `${entry.milliseconds / bookTotal() * 100}%` }} /></div>
                  </div>
                </li>
              )}</For>
            </ol>
            <Show when={rankedBooks().length > 5}><button type="button" class="mt-3 min-h-10 w-full text-[12px] text-accent" aria-expanded={allBooks()} onClick={() => setAllBooks(!allBooks())}>{t(allBooks() ? "settings.readingTime.showLess" : "settings.readingTime.showAll", { count: rankedBooks().length })}</button></Show>
          </Show>
        </section>
      </div>
    </div>
  );
}

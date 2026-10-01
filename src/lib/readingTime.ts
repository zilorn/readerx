import { invoke, isTauri } from "@tauri-apps/api/core";
import { createEffect, onCleanup } from "solid-js";
import { readingTimeStats, setReadingTimeStats, type ReadingTimeStats } from "./store";
import { reportFailure } from "./errorReport";
import { t } from "./i18n";

export function readingDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatReadingDuration(milliseconds: number): string {
  if (milliseconds > 0 && milliseconds < 60_000) return t("settings.readingTime.lessThanMinute");
  const minutes = Math.floor(milliseconds / 60_000);
  return t("settings.readingTime.duration", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

let writes: Promise<void> = Promise.resolve();
export function loadReadingTime(): Promise<void> {
  writes = writes.then(async () => {
    if (isTauri()) {
      setReadingTimeStats(await invoke<ReadingTimeStats>("readerx_reading_time_get"));
    }
  }).catch((err: unknown) => reportFailure(t("settings.readingTime.failed"), err));
  return writes;
}

function record(bookId: string, day: string, milliseconds: number): void {
  if (milliseconds <= 0) return;
  writes = writes.then(async () => {
    if (isTauri()) {
      setReadingTimeStats(await invoke<ReadingTimeStats>("readerx_reading_time_add", { bookId, day, milliseconds }));
    } else {
      const stats = readingTimeStats();
      setReadingTimeStats({
        ...stats,
        days: { ...stats.days, [day]: (stats.days[day] ?? 0) + milliseconds },
        books: { ...stats.books, [bookId]: (stats.books[bookId] ?? 0) + milliseconds },
      });
    }
  }).catch((err: unknown) => reportFailure(t("settings.readingTime.failed"), err));
}

/** 只计正文就绪且窗口可见并聚焦的时间；长时间挂起的计时器间隔不计入。 */
export function trackReadingTime(bookId: () => string, ready: () => boolean): void {
  loadReadingTime();
  createEffect(() => {
    const id = bookId();
    if (!id || !ready()) return;
    let last = performance.now();
    let day = readingDay();
    let pending = 0;
    let active = !document.hidden && document.hasFocus();
    function flush() {
      const whole = Math.floor(pending);
      pending -= whole;
      record(id, day, whole);
    }
    function tick() {
      const now = performance.now();
      const elapsed = now - last;
      const nextDay = readingDay();
      // 跨午夜拆分本次间隔，避免前一天的时间记到次日。
      if (active && elapsed > 0 && elapsed <= 5_000) {
        if (nextDay !== day) {
          const date = new Date();
          const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
          const afterMidnight = Math.min(elapsed, Math.max(0, date.getTime() - midnight));
          pending += elapsed - afterMidnight;
          flush();
          day = nextDay;
          pending += afterMidnight;
        } else pending += elapsed;
      }
      if (nextDay !== day) { flush(); day = nextDay; }
      last = now;
      if (pending >= 15_000) flush();
    }
    function visibility() {
      tick();
      active = !document.hidden && document.hasFocus();
      if (!active) flush();
    }
    function suspend() { tick(); active = false; flush(); }
    const timer = window.setInterval(tick, 1_000);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", visibility);
    window.addEventListener("blur", suspend);
    window.addEventListener("pagehide", suspend);
    onCleanup(() => {
      tick();
      flush();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", visibility);
      window.removeEventListener("blur", suspend);
      window.removeEventListener("pagehide", suspend);
    });
  });
}

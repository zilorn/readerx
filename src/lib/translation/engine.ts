import {
  readTranslationCache,
  putTranslationCache,
  invalidateRemoteTranslations,
} from "../backend";
import { t } from "../i18n";
import type { LocalBook, LocalBookChapter } from "../booksTypes";
import { chapterUnits } from "../pagination";
import {
  alreadyTarget,
  paragraphBatches,
  representativeSamples,
  translationKey,
  fingerprint,
} from "./core";
import { generateTerms, translateBatch } from "./provider";
import {
  effectiveTranslationSettings,
  ensureTranslationBook,
  ensureTranslationSettings,
  saveTranslationBook,
  translationBookState,
} from "./settings";
import type { GlossaryTerm, TranslationSettings } from "./types";
import { createTranslationSources } from "./sources";
import { createSignal } from "solid-js";

const [cacheVersion, setCacheVersion] = createSignal(0);
export const translationCacheVersion = cacheVersion;
export async function invalidateTranslations(
  bookId: string,
  cid: string,
): Promise<void> {
  await invalidateRemoteTranslations(bookId, cid);
  setCacheVersion((n) => n + 1);
}
interface GlossaryTask {
  task: Promise<GlossaryTerm[]>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
}
const glossaryTasks = new Map<string, GlossaryTask>();
function joinGlossaryTask(
  entry: GlossaryTask,
  signal: AbortSignal,
): Promise<GlossaryTerm[]> {
  signal.throwIfAborted();
  entry.consumers++;
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", abort);
      entry.consumers--;
      // 任务拥有独立的取消控制器，最后一个使用者离开才停止生成。
      if (!entry.consumers && !entry.settled) entry.controller.abort();
    };
    const abort = () => {
      release();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void entry.task.then(
      (terms) => {
        release();
        resolve(terms);
      },
      (error) => {
        release();
        reject(error);
      },
    );
  });
}
export async function bookTerms(
  book: LocalBook,
  settings: TranslationSettings,
  signal: AbortSignal,
  regenerate = false,
): Promise<GlossaryTerm[]> {
  if (!settings.glossary && !regenerate) return [];
  await ensureTranslationBook(book.id);
  signal.throwIfAborted();
  const state = translationBookState(book.id)!;
  if (!regenerate && state.glossaryTarget === settings.target)
    return state.terms;
  const key = fingerprint([
    book.id,
    settings.target,
    settings.provider,
    settings.protocol,
    settings.model,
    settings.baseUrl,
    settings.effort,
    fingerprint(settings.apiKey),
    settings.provider === "baidu" ? fingerprint(settings.appId) : "",
  ]);
  const existing = glossaryTasks.get(key);
  if (existing && !existing.controller.signal.aborted)
    return joinGlossaryTask(existing, signal);
  const controller = new AbortController();
  // 先登记使用者，再开始请求，确保同步取消也能被任务接收。
  const task = Promise.resolve()
    .then(() => {
      controller.signal.throwIfAborted();
      return generateTerms(
        representativeSamples(book.chapters),
        settings,
        controller.signal,
      );
    })
    .then(async (terms) => {
      controller.signal.throwIfAborted();
      await saveTranslationBook(book.id, {
        terms,
        glossaryTarget: settings.target,
      });
      return terms;
    })
    .finally(() => {
      entry.settled = true;
      // 旧章取消后的收尾不能删除新章刚创建的任务。
      if (glossaryTasks.get(key)?.task === task) glossaryTasks.delete(key);
    });
  const entry: GlossaryTask = { task, controller, consumers: 0, settled: false };
  glossaryTasks.set(key, entry);
  return joinGlossaryTask(entry, signal);
}
// 共享队列：书籍信息、划词请求与当前章/预翻译使用同一并发预算。
let active = 0;
const waiters: Array<() => void> = [];
export async function limited<T>(
  limit: number,
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  while (active >= limit) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = waiters.indexOf(wake);
        if (index >= 0) waiters.splice(index, 1);
        reject(new DOMException("Aborted", "AbortError"));
      };
      waiters.push(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  signal.throwIfAborted();
  active++;
  try {
    return await task();
  } finally {
    active--;
    waiters.splice(0).forEach((wake) => wake());
  }
}
const inFlight = new Map<
  string,
  { task: Promise<Record<string, string>>; signal: AbortSignal }
>();
const paragraphFlight = new Map<
  string,
  { task: Promise<string>; signal: AbortSignal }
>();
export async function translatedTexts(
  bookId: string,
  chapter: LocalBookChapter,
  texts: string[],
  settings: TranslationSettings,
  terms: GlossaryTerm[],
  signal: AbortSignal,
  onBatch?: (entries: Record<string, string>) => void,
  refresh = false,
): Promise<Record<string, string>> {
  const sources = createTranslationSources(chapter);
  const cache = await readTranslationCache(bookId, chapter.cid);
  signal.throwIfAborted();
  const out: Record<string, string> = {};
  const pending = new Map<string, string>();
  const shared: Array<Promise<void>> = [];
  const leaseKey = (key: string) =>
    fingerprint([bookId, chapter.cid, cache.revision, key]);
  for (const text of texts) {
    if (!text.trim() || alreadyTarget(text, settings.target)) continue;
    const key = translationKey(text, settings, terms);
    if (!refresh && cache.entries[key]) out[key] = cache.entries[key];
    else {
      const existing = paragraphFlight.get(leaseKey(key));
      if (existing && !existing.signal.aborted)
        shared.push(
          existing.task.then((result) => {
            signal.throwIfAborted();
            out[key] = result;
            onBatch?.({ ...out });
          }),
        );
      else pending.set(key, text);
    }
  }
  onBatch?.({ ...out });
  const batches = paragraphBatches([...pending]);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(settings.parallel, batches.length) },
    async () => {
      while (next < batches.length) {
        signal.throwIfAborted();
        const batch = batches[next++];
        const batchKey = fingerprint([
          bookId,
          chapter.cid,
          cache.revision,
          batch.map(([key]) => key),
        ]);
        const running = inFlight.get(batchKey);
        let task =
          running && !running.signal.aborted ? running.task : undefined;
        if (!task) {
          task = limited(settings.parallel, signal, async () => {
            const texts = await translateBatch(
              batch.map(([, text]) => text),
              settings,
              terms,
              signal,
            );
            signal.throwIfAborted();
            const result = Object.fromEntries(
              batch.map(([key], index) => [key, texts[index]]),
            );
            const entries = Object.fromEntries(batch.flatMap(([key, sourceText]) => {
              const source = sources.source(sourceText);
              // 显示替换后的选区可能不对应原文：仍显示译文，但不写入原文缓存。
              return source ? [[key, { ...source, text: result[key] }]] : [];
            }));
            if (
              Object.keys(entries).length &&
              !(await putTranslationCache(
                bookId,
                chapter.cid,
                cache.revision,
                entries,
              ))
            )
              throw new Error(t("translation.stale"));
            return result;
          }).finally(() => {
            if (inFlight.get(batchKey)?.task === task)
              inFlight.delete(batchKey);
          });
          inFlight.set(batchKey, { task, signal });
          for (const [key] of batch) {
            const textTask = task.then((result) => result[key]);
            paragraphFlight.set(leaseKey(key), { task: textTask, signal });
            // 立刻处理拒绝，共享者会在自身任务中得到同一失败。
            const clear = () => {
              if (paragraphFlight.get(leaseKey(key))?.task === textTask)
                paragraphFlight.delete(leaseKey(key));
            };
            void textTask.then(clear, clear);
          }
        }
        const result = await task;
        signal.throwIfAborted();
        Object.assign(out, result);
        onBatch?.({ ...out });
      }
    },
  );
  // 等所有 worker 收尾，避免一个失败后其它 worker 变成悬空写入。
  const results = await Promise.allSettled([...workers, ...shared]);
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
  return out;
}
export async function selectionTranslation(
  book: LocalBook,
  chapter: LocalBookChapter,
  text: string,
  signal: AbortSignal,
): Promise<string> {
  await Promise.all([
    ensureTranslationSettings(),
    ensureTranslationBook(book.id),
  ]);
  const settings = effectiveTranslationSettings(book.id);
  if (!settings.enabled) throw new Error(t("translation.disabled"));
  if (alreadyTarget(text, settings.target)) return text;
  const terms = await bookTerms(book, settings, signal);
  const results = await translatedTexts(
    book.id,
    chapter,
    [text],
    settings,
    terms,
    signal,
  );
  return results[translationKey(text, settings, terms)] ?? text;
}
export const paragraphTexts = (chapter: LocalBookChapter): string[] =>
  chapterUnits(chapter).flatMap((unit) =>
    unit.kind === "p" ? [unit.text] : [],
  );

/** 手动重译只处理指定章；推进租约阻止旧请求覆盖，新结果仍走原文校验。 */
export async function retranslateChapter(
  book: LocalBook,
  chapter: LocalBookChapter,
  signal: AbortSignal,
): Promise<void> {
  await Promise.all([ensureTranslationSettings(), ensureTranslationBook(book.id)]);
  signal.throwIfAborted();
  const settings = effectiveTranslationSettings(book.id);
  if (!settings.enabled) throw new Error(t("translation.disabled"));
  const texts = paragraphTexts(chapter);
  if (!texts.length) throw new Error(t("translation.noSamples"));
  const terms = await bookTerms(book, settings, signal);
  signal.throwIfAborted();
  await invalidateRemoteTranslations(book.id, chapter.cid);
  try {
    await translatedTexts(book.id, chapter, texts, settings, terms, signal, undefined, true);
  } finally {
    setCacheVersion((n) => n + 1);
  }
}

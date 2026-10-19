import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js";
import { reportFailure } from "../errorReport";
import { t } from "../i18n";
import { createLogger } from "../logger";
import { alreadyTarget, translationKey } from "./core";
import { limited } from "./engine";
import { translateBatch } from "./provider";
import { effectiveTranslationSettings, ensureTranslationBook, ensureTranslationSettings, saveTranslationBook, translationBookState, translationSettings } from "./settings";
import { titleTerms } from "./title";
import type { TranslationBookState, TranslationSettings } from "./types";

export interface MetadataBook { id?: string; title: string; intro?: string }
type CachedText = NonNullable<TranslationBookState["titleTranslation"]>;
const log = createLogger("translation-metadata");
// 未入架书目只保留有界会话缓存，不创建书库记录。
const cache = new Map<string, CachedText>();
const [cacheVersion, setCacheVersion] = createSignal(0);

function needsTranslation(text: string, target: string): boolean {
  return !!text.trim() && !alreadyTarget(text, target);
}

function matching(source: string, settings: TranslationSettings, cached?: CachedText): CachedText | undefined {
  return cached?.source === source && cached.key === translationKey(source, settings, []) ? cached : undefined;
}

export function metadataTranslations(book: MetadataBook, settings: TranslationSettings) {
  cacheVersion();
  const state = book.id ? translationBookState(book.id) : undefined;
  const title = book.id ? (state?.titleEnabled ? state.titleTranslation : undefined) : cache.get(translationKey(book.title, settings, []));
  const intro = book.id ? (state?.introEnabled ? state.introTranslation : undefined) : cache.get(translationKey(book.intro ?? "", settings, []));
  return {
    title: settings.enabled ? matching(book.title, settings, title)?.text : undefined,
    intro: settings.enabled ? matching(book.intro ?? "", settings, intro)?.text : undefined,
  };
}

/** 手动重译绕过缓存；整批成功后才更新显示，失败/取消保留上次结果。 */
export async function translateBookMetadata(book: MetadataBook, settings: TranslationSettings, signal: AbortSignal, refresh = false): Promise<void> {
  if (!settings.enabled) throw new Error(t("translation.disabled"));
  if (!needsTranslation(book.title, settings.target) && !needsTranslation(book.intro ?? "", settings.target)) return;
  if (book.id) await ensureTranslationBook(book.id);
  signal.throwIfAborted();
  const state = book.id ? translationBookState(book.id) : undefined;
  const fields = [
    { field: "title", source: book.title, saved: state?.titleTranslation },
    { field: "intro", source: book.intro ?? "", saved: state?.introTranslation },
  ] as const;
  const result: Partial<Record<"title" | "intro", CachedText>> = {};
  await limited(settings.parallel, signal, async () => {
    const missing = fields.filter(({ field, source, saved }) => {
      if (!needsTranslation(source, settings.target)) return false;
      const key = translationKey(source, settings, []);
      const cached = !refresh && matching(source, settings, book.id ? saved : cache.get(key));
      if (cached) result[field] = cached;
      return !cached;
    });
    if (!missing.length) return;
    const texts = await translateBatch(missing.map(item => item.source), settings, book.id ? titleTerms(book.id, settings) : [], signal);
    signal.throwIfAborted();
    missing.forEach((item, index) => { result[item.field] = { source: item.source, key: translationKey(item.source, settings, []), text: texts[index] }; });
  });
  signal.throwIfAborted();
  if (book.id) {
    await saveTranslationBook(book.id, {
      ...(result.title ? { titleEnabled: true, titleTranslation: result.title } : {}),
      ...(result.intro ? { introEnabled: true, introTranslation: result.intro } : {}),
    });
  } else {
    for (const entry of Object.values(result)) {
      cache.delete(entry.key);
      cache.set(entry.key, entry);
    }
    while (cache.size > 256) cache.delete(cache.keys().next().value!);
    setCacheVersion(value => value + 1);
  }
}

export function createMetadataTranslation(book: Accessor<MetadataBook | undefined>, options: { active?: Accessor<boolean>; automatic?: Accessor<boolean> } = {}) {
  const [ready, setReady] = createSignal(false);
  const [running, setRunning] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [original, setOriginal] = createSignal(false);
  const settings = () => book()?.id ? effectiveTranslationSettings(book()!.id!) : translationSettings();
  const required = createMemo(() => ({
    title: needsTranslation(book()?.title ?? "", settings().target),
    intro: needsTranslation(book()?.intro ?? "", settings().target),
  }));
  const needsAnyTranslation = () => required().title || required().intro;
  let controller: AbortController | undefined;

  createEffect(on(() => book()?.id, id => {
    setReady(false);
    let disposed = false;
    onCleanup(() => { disposed = true; });
    void Promise.all([ensureTranslationSettings(), ...(id ? [ensureTranslationBook(id)] : [])])
      .then(() => { if (!disposed) setReady(true); })
      .catch(error => { if (!disposed) reportFailure(t("translation.loadFailed"), error); });
  }));

  async function run(refresh = false, automatic = false) {
    const current = book();
    if (!current || !ready() || !settings().enabled || !needsAnyTranslation() || controller || options.active?.() === false) return;
    const task = new AbortController();
    controller = task;
    setRunning(true);
    setFailed(false);
    try {
      await translateBookMetadata(current, settings(), task.signal, refresh);
      if (!task.signal.aborted) setOriginal(false);
    } catch (error) {
      if (!task.signal.aborted) {
        setFailed(true);
        // 列表自动翻译保留逐项重试入口，避免大量失败同时弹出提示。
        if (automatic) log.warn("书籍信息自动翻译失败", error);
        else reportFailure(t("translation.failed"), error);
      }
    } finally {
      if (controller === task) { controller = undefined; setRunning(false); }
    }
  }

  createEffect(on(() => {
    const current = book();
    return JSON.stringify([ready(), options.active?.() !== false, options.automatic?.() === true,
      settings().enabled, current?.id, current?.title, current?.intro,
      translationKey("", settings(), [])]);
  }, () => {
    controller?.abort();
    controller = undefined;
    setRunning(false);
    setFailed(false);
    setOriginal(false);
    if (options.automatic?.() && needsAnyTranslation()) void run(false, true);
  }));
  onCleanup(() => controller?.abort());
  const translated = createMemo<{ title?: string; intro?: string }>(() => {
    const current = book();
    return current ? metadataTranslations(current, settings()) : {};
  });
  return {
    enabled: () => ready() && settings().enabled,
    needsTranslation: needsAnyTranslation,
    running, failed, original,
    hasTranslation: () => !!(translated().title || translated().intro),
    complete: () => !!book() && !!(book()!.title.trim() || book()!.intro?.trim())
      && (!required().title || !!translated().title)
      && (!required().intro || !!translated().intro),
    title: () => (!original() && translated().title) || book()?.title || "",
    intro: () => (!original() && translated().intro) || book()?.intro || "",
    run,
    cancel: () => controller?.abort(),
    toggleOriginal: () => setOriginal(value => !value),
  };
}

export type MetadataTranslation = ReturnType<typeof createMetadataTranslation>;

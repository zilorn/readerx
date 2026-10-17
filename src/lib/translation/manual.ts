import type { LocalBook } from "../booksTypes";
import { t } from "../i18n";
import { createLogger } from "../logger";
import { translationKey } from "./core";
import { bookTerms, paragraphTexts, translatedTexts } from "./engine";
import { translateBatch } from "./provider";
import { effectiveTranslationSettings, ensureTranslationBook, ensureTranslationSettings, saveTranslationBook, translationBookState } from "./settings";
import { titleTerms } from "./title";

const log = createLogger("translation-manual");

async function manualSettings(bookId: string, signal: AbortSignal) {
  await Promise.all([ensureTranslationSettings(), ensureTranslationBook(bookId)]);
  signal.throwIfAborted();
  const settings = effectiveTranslationSettings(bookId);
  if (!settings.enabled) throw new Error(t("translation.disabled"));
  return settings;
}

export async function translateBookTitle(book: Pick<LocalBook, "id" | "title">, signal: AbortSignal, refresh = false): Promise<void> {
  const settings = await manualSettings(book.id, signal);
  const terms = titleTerms(book.id, settings);
  // 后续生成/编辑正文术语表不隐藏已经启用的书名；新术语可通过手动重译应用。
  const key = translationKey(book.title, settings, []);
  const cached = translationBookState(book.id)?.titleTranslation;
  if (!book.title.trim()) throw new Error(t("translation.noSamples"));
  const text = !refresh && cached?.source === book.title && cached.key === key
    ? cached.text : (await translateBatch([book.title], settings, terms, signal))[0];
  signal.throwIfAborted();
  // 失败或取消不打开开关，也不覆盖上次成功的书名。
  await saveTranslationBook(book.id, { titleEnabled: true, titleTranslation: { source: book.title, key, text } });
  log.info("书名翻译完成", { bookId: book.id });
}

export interface BookTranslationProgress { completed: number; total: number; cid?: string }

/** 显式全书操作只遍历已下载正文；保留有效缓存，取消后可继续。 */
export async function translateBookContent(book: LocalBook, signal: AbortSignal, onProgress: (progress: BookTranslationProgress) => void): Promise<void> {
  const settings = await manualSettings(book.id, signal);
  const chapters = book.chapters.filter(chapter => paragraphTexts(chapter).some(text => text.trim()));
  if (!chapters.length) throw new Error(t("translation.noSamples"));
  const total = chapters.length;
  onProgress({ completed: 0, total });
  const terms = await bookTerms(book, settings, signal);
  for (let index = 0; index < total; index++) {
    signal.throwIfAborted();
    const chapter = chapters[index];
    onProgress({ completed: index, total, cid: chapter.cid });
    await translatedTexts(book.id, chapter, paragraphTexts(chapter), settings, terms, signal);
    onProgress({ completed: index + 1, total });
  }
  log.info("全书正文翻译完成", { bookId: book.id, chapters: total });
}

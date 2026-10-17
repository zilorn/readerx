import { createEffect, on, type Accessor } from "solid-js";
import { bookDisplayTitle } from "../bookDisplay";
import { reportFailure } from "../errorReport";
import { t } from "../i18n";
import { translationKey } from "./core";
import { effectiveTranslationSettings, ensureTranslationBook, ensureTranslationSettings, translationBookState } from "./settings";
import type { TranslationSettings } from "./types";

type TitledBook = { id: string; title: string };

/** 书名只使用已有的同语言术语表，不因切换书名启动正文采样。 */
export function titleTerms(bookId: string, settings: TranslationSettings) {
  const state = translationBookState(bookId);
  return settings.glossary && state?.glossaryTarget === settings.target ? state.terms : [];
}

export function translatedBookTitle(book: TitledBook): string | undefined {
  const state = translationBookState(book.id);
  const settings = effectiveTranslationSettings(book.id);
  const cached = state?.titleTranslation;
  if (!settings.enabled || !state?.titleEnabled || cached?.source !== book.title) return;
  if (cached.key === translationKey(book.title, settings, [])) return cached.text;
}

/** 仅加载当前展示书籍的本地配置；渲染书名不会发起翻译请求。 */
export function createBookTitle(book: Accessor<TitledBook | undefined>): Accessor<string> {
  createEffect(on(() => book()?.id, id => {
    if (!id) return;
    void Promise.all([ensureTranslationSettings(), ensureTranslationBook(id)])
      .catch(error => reportFailure(t("translation.loadFailed"), error));
  }));
  return () => {
    const current = book();
    return current ? translatedBookTitle(current) || bookDisplayTitle(current.title) : bookDisplayTitle("");
  };
}

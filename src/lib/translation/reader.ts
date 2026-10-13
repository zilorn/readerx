import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";
import type { LocalBook, LocalBookChapter } from "../booksTypes";
import { chapterUnits } from "../pagination";
import { bookTerms, translatedTexts, translationCacheVersion } from "./engine";
import {
  effectiveTranslationSettings,
  ensureTranslationBook,
  ensureTranslationSettings,
  translationBookState,
} from "./settings";
import { alreadyTarget, fingerprint, translationKey } from "./core";
import { reportFailure } from "../errorReport";
import { t } from "../i18n";

export function createReaderTranslation(props: {
  bookId: Accessor<string>;
  book: Accessor<LocalBook | undefined>;
  chapter: Accessor<LocalBookChapter | undefined>;
  beforeChange: () => void;
  startUnit: () => number;
}) {
  const [ready, setReady] = createSignal(false);
  const [translations, setTranslations] = createSignal<Record<number, string>>(
    {},
  );
  const [failure, setFailure] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [retry, setRetry] = createSignal(0);
  const settings = createMemo(() =>
    effectiveTranslationSettings(props.bookId()),
  );
  createEffect(
    on(props.bookId, (id) => {
      setReady(false);
      void Promise.all([ensureTranslationSettings(), ensureTranslationBook(id)])
        .then(() => {
          if (props.bookId() === id) setReady(true);
        })
        .catch((error) => reportFailure(t("translation.loadFailed"), error));
    }),
  );
  const configKey = createMemo(() =>
    fingerprint([
      settings(),
      translationBookState(props.bookId())?.terms,
      translationBookState(props.bookId())?.glossaryTarget,
    ]),
  );
  // 在线阅读窗口陆续到达正文时，只观察最多后续五章；不会扫描整本。
  const futureKey = createMemo(() => {
    const count = settings().pretranslate;
    if (!count) return "";
    const book = props.book();
    const ci =
      book?.chapters.findIndex((ch) => ch.cid === props.chapter()?.cid) ?? -1;
    return fingerprint(
      book?.chapters
        .slice(ci + 1, ci + count + 1)
        .map((ch) => [ch.cid, ch.paragraphs, ch.blocks]) ?? [],
    );
  });
  createEffect(
    on(
      [
        props.chapter,
        configKey,
        translationCacheVersion,
        retry,
        ready,
        futureKey,
      ],
      ([chapter, , , , loaded]) => {
        const controller = new AbortController();
        onCleanup(() => controller.abort());
        if (Object.keys(untrack(translations)).length) props.beforeChange();
        setTranslations({});
        setFailure("");
        setBusy(false);
        const config = settings();
        const book = untrack(props.book);
        if (
          !loaded ||
          !chapter ||
          !book ||
          !config.enabled ||
          config.mode === "original" ||
          (config.folded &&
            config.mode === "bilingual" &&
            config.pretranslate === 0)
        )
          return;
        const id = props.bookId();
        setBusy(true);
        void (async () => {
          const terms = await bookTerms(book, config, controller.signal);
          const units = chapterUnits(chapter);
          const start = untrack(props.startUnit);
          const order = [...units.keys()].sort(
            (a, b) =>
              (a < start ? a + units.length : a) -
              (b < start ? b + units.length : b),
          );
          if (!(config.folded && config.mode === "bilingual"))
            await translatedTexts(
              id,
              chapter,
              order.flatMap((index) =>
                units[index].kind === "p"
                  ? [(units[index] as { text: string }).text]
                  : [],
              ),
              config,
              terms,
              controller.signal,
              (entries) => {
                const map: Record<number, string> = {};
                units.forEach((unit, index) => {
                  if (unit.kind !== "p") return;
                  const text =
                    entries[translationKey(unit.text, config, terms)];
                  if (text) map[index] = text;
                });
                if (
                  JSON.stringify(map) !== JSON.stringify(untrack(translations))
                ) {
                  untrack(props.beforeChange);
                  setTranslations(map);
                }
              },
            );
          // 只翻译当前章及随后 1~5 章，不遍历剩余全书。未取回正文的在线章等待现有阅读窗口。
          const ci = book.chapters.findIndex((ch) => ch.cid === chapter.cid);
          for (let offset = 1; offset <= config.pretranslate; offset++) {
            controller.signal.throwIfAborted();
            const next = untrack(props.book)?.chapters[ci + offset];
            if (!next) break;
            const paragraphs = chapterUnits(next).flatMap((unit) =>
              unit.kind === "p" ? [unit.text] : [],
            );
            if (paragraphs.length)
              await translatedTexts(
                id,
                next,
                paragraphs,
                config,
                terms,
                controller.signal,
              );
          }
        })()
          .catch((error) => {
            if (controller.signal.aborted) return;
            setFailure(
              error instanceof Error ? error.message : t("translation.failed"),
            );
            reportFailure(t("translation.failed"), error);
          })
          .finally(() => {
            if (!controller.signal.aborted) setBusy(false);
          });
      },
    ),
  );
  const canFold = (text: string) =>
    settings().enabled &&
    settings().mode === "bilingual" &&
    settings().folded &&
    !alreadyTarget(text, settings().target);
  return {
    settings,
    translations,
    failure,
    busy,
    canFold,
    retry: () => setRetry((value) => value + 1),
  };
}

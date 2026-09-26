/**
 * English dictionary (target language).
 *
 * Every key of the Chinese source dictionary must exist here — the `Record<MessageKey, string>`
 * annotation turns a missing translation into a compile error. Plural forms are extra keys:
 * `key_one` / `key_other` are picked automatically when `t()` is called with `{ count }`.
 *
 * Translation style: sentence case, terse mobile UI wording, straight ASCII punctuation,
 * `{placeholders}` copied verbatim from the source. Screens with a countable noun need
 * `_one` / `_other` variants (e.g. `1 book` / `2 books`); Chinese needs only the base key.
 *
 * The dictionary is loaded on demand (see ../index.ts), so it stays out of the startup bundle.
 */
import { common } from "./en/common";
import { shell } from "./en/shell";
import { settings } from "./en/settings";
import { shelf } from "./en/shelf";
import { book } from "./en/book";
import { reader } from "./en/reader";
import { readerChrome } from "./en/readerChrome";
import { discover } from "./en/discover";
import { sources } from "./en/sources";
import { sourceEditor } from "./en/sourceEditor";
import { chapterRules } from "./en/chapterRules";
import { sourceGroups } from "./en/sourceGroups";
import { tts } from "./en/tts";
import { webdav } from "./en/webdav";
import { library } from "./en/library";
import { misc } from "./en/misc";
import { sync } from "./en/sync";
import type { MessageKey } from "./zh-CN";

export const en: Record<MessageKey, string> & Record<string, string> = {
  ...common,
  ...shell,
  ...settings,
  ...shelf,
  ...book,
  ...reader,
  ...readerChrome,
  ...discover,
  ...sources,
  ...sourceEditor,
  ...chapterRules,
  ...sourceGroups,
  ...tts,
  ...webdav,
  ...library,
  ...misc,
  ...sync,
};

import { createSignal } from "solid-js";
import {
  readTranslationSettings,
  putTranslationSettings,
  readTranslationBook,
  putTranslationBook,
} from "../backend";
import {
  DEFAULT_TRANSLATION_SETTINGS,
  TARGET_LANGUAGES,
  type TranslationSettings,
  type TranslationBookState,
} from "./types";

export function normalizeSettings(
  value: Partial<TranslationSettings>,
): TranslationSettings {
  const out = { ...DEFAULT_TRANSLATION_SETTINGS, ...value };
  if (!["bilingual", "translated", "original"].includes(out.mode))
    out.mode = "bilingual";
  if (!["original", "translated"].includes(out.readingText))
    out.readingText = "original";
  if (
    !["google", "baidu", "bing", "openai", "deepseek", "custom"].includes(
      out.provider,
    )
  )
    out.provider = "google";
  if (!["chat", "responses"].includes(out.protocol)) out.protocol = "chat";
  if (!(TARGET_LANGUAGES as readonly string[]).includes(out.target))
    out.target = "zh-CN";
  for (const key of ["enabled", "autoTranslateMetadata", "folded", "glossary"] as const)
    out[key] = out[key] === true;
  for (const key of ["baseUrl", "model", "appId", "apiKey", "effort"] as const)
    out[key] = typeof out[key] === "string" ? out[key] : "";
  out.parallel = Math.max(
    1,
    Math.min(8, Math.floor(Number(out.parallel) || 2)),
  );
  out.pretranslate = Math.max(
    0,
    Math.min(5, Math.floor(Number(out.pretranslate) || 0)),
  );
  return out;
}
const [global, setGlobal] = createSignal<TranslationSettings>({
  ...DEFAULT_TRANSLATION_SETTINGS,
});
const [books, setBooks] = createSignal<Record<string, TranslationBookState>>(
  {},
);
const loads = new Map<string, Promise<void>>();
let globalLoad: Promise<void> | undefined;
let globalWrites = Promise.resolve();
const writes = new Map<string, Promise<void>>();
export const translationSettings = global;
export const translationBookState = (id: string) => books()[id];
export const effectiveTranslationSettings = (
  id: string,
): TranslationSettings => {
  const settings = normalizeSettings({
    ...global(),
    ...books()[id]?.overrides,
  });
  settings.enabled = global().enabled && settings.enabled;
  return settings;
};
export function ensureTranslationSettings(): Promise<void> {
  return (globalLoad ??= readTranslationSettings<Partial<TranslationSettings>>()
    .then((value) => {
      setGlobal(normalizeSettings(value ?? {}));
    })
    .catch((error) => {
      globalLoad = undefined;
      throw error;
    }));
}
export async function saveTranslationSettings(
  patch: Partial<TranslationSettings>,
): Promise<void> {
  await ensureTranslationSettings();
  globalWrites = globalWrites
    .catch(() => {})
    .then(async () => {
      const next = normalizeSettings({ ...global(), ...patch });
      await putTranslationSettings(next);
      setGlobal(next);
    });
  await globalWrites;
}
export function ensureTranslationBook(id: string): Promise<void> {
  if (books()[id]) return Promise.resolve();
  const pending = loads.get(id);
  if (pending) return pending;
  const task = readTranslationBook(id)
    .then((value) => {
      setBooks((old) => ({ ...old, [id]: value }));
    })
    .finally(() => loads.delete(id));
  loads.set(id, task);
  return task;
}
export async function saveTranslationBook(
  id: string,
  patch: Partial<TranslationBookState>,
): Promise<void> {
  await ensureTranslationBook(id);
  const task = (writes.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const next = { ...books()[id]!, ...patch };
      await putTranslationBook(id, next);
      setBooks((old) => ({ ...old, [id]: next }));
    });
  writes.set(id, task);
  await task;
}
export async function setBookTranslationOverride(
  id: string,
  patch: Partial<TranslationSettings>,
): Promise<void> {
  await ensureTranslationBook(id);
  // 在队列内合并，避免两个连续设置覆盖彼此。
  const task = (writes.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const next = {
        ...books()[id]!,
        overrides: { ...books()[id]!.overrides, ...patch },
      };
      await putTranslationBook(id, next);
      setBooks((old) => ({ ...old, [id]: next }));
    });
  writes.set(id, task);
  await task;
}

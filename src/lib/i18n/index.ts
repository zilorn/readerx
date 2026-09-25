/**
 * i18n 内核：模块级 signal（与 store.ts 同一套约定，无 Context、无第三方依赖）。
 *
 * - 语言偏好持久化在后端（`readerx.locale`，值为 `system` / `zh-CN` / `en`），WebView 不落盘；
 * - 词典**按需加载**：启动只取当前语言那一份，切换语言时再取另一份 —— 两份词典都不进首屏包体；
 * - `t()` 读取当前语言 signal，语言一变，用到它的组件自动重新渲染。
 */
import { batch, createSignal } from "solid-js";
import { readState, writeState } from "../backend";
import { createLogger } from "../logger";
import {
  DEFAULT_LOCALE,
  detectSystemLocale,
  lookupMessage,
  normalizeLocalePreference,
  type Locale,
  type LocalePreference,
  type MessageParams,
  type Messages,
} from "./core";
import type { MessageKey } from "./locales/zh-CN";

export type {
  Locale,
  LocalePreference,
  MessageParams,
} from "./core";
export type { MessageKey } from "./locales/zh-CN";

const log = createLogger("i18n");

/** 语言偏好的持久化 key（后端状态文件） */
const LOCALE_KEY = "readerx.locale";

const LOADERS: Record<Locale, () => Promise<Messages>> = {
  "zh-CN": () => import("./locales/zh-CN").then((module) => module.zhCN),
  en: () => import("./locales/en").then((module) => module.en),
};

/** 当前语言的词典；尚未载入时为 null（只有渲染前的启动窗口期） */
let messages: Messages | null = null;
let loaded: Locale | null = null;

const [locale, setLocale] = createSignal<Locale>(DEFAULT_LOCALE);
const [preference, setPreference] = createSignal<LocalePreference>("system");
const warnedKeys = new Set<string>();

/** 当前生效的语言 */
export function currentLocale(): Locale {
  return locale();
}

/** 当前的语言偏好（可能是「跟随系统」） */
export function currentLocalePreference(): LocalePreference {
  return preference();
}

/** 系统语言（WebView 上报的偏好列表；拿不到时按兜底语言） */
export function systemLocale(): Locale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  return detectSystemLocale(navigator.languages ?? [navigator.language]);
}

/**
 * 取文案。组件里直接调用即可（读取当前语言 signal，切换语言会重新渲染）。
 *
 * ```tsx
 * <button>{t("common.cancel")}</button>
 * <p>{t("shelf.bookCount", { count: books().length })}</p>
 * ```
 *
 * 带 `count` 时自动选复数变体（英语按需定义 `key_one` / `key_other`，中文只写基础 key）。
 * key 拼错在编译期就能发现（`MessageKey` 是全部 key 的联合类型）；运行期词典里查不到时
 * 原样显示 key 并记一条 warn，不静默显示空白。
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const current = locale();
  const text = messages
    ? lookupMessage(messages, current, key, params)
    : undefined;
  if (text !== undefined) return text;
  if (messages && !warnedKeys.has(key)) {
    warnedKeys.add(key);
    log.warn(`缺少文案：${current} / ${key}`);
  }
  return key;
}

function applyDocumentLocale(next: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = next;
}

async function applyLocale(next: Locale): Promise<void> {
  if (loaded !== next) {
    try {
      const table = await LOADERS[next]();
      batch(() => {
        messages = table;
        loaded = next;
        setLocale(next);
      });
    } catch (error) {
      log.error(`载入 ${next} 文案失败`, error);
      // 词典载入失败不该让界面变成一串 key：退回源语言，仍失败就保持现状
      if (next !== DEFAULT_LOCALE) {
        await applyLocale(DEFAULT_LOCALE);
        return;
      }
    }
  } else {
    batch(() => setLocale(next));
  }
  applyDocumentLocale(next);
}

/** 启动时调用（渲染之前）：读回上次的语言偏好并载入对应词典 */
export async function initI18n(): Promise<void> {
  const stored = await readState<unknown>(LOCALE_KEY);
  const saved = normalizeLocalePreference(stored);
  setPreference(saved);
  await applyLocale(saved === "system" ? systemLocale() : saved);
}

/** 切换语言偏好：立即生效并持久化（`system` 表示跟随系统语言） */
export async function setLocalePreference(
  next: LocalePreference,
): Promise<void> {
  setPreference(next);
  await applyLocale(next === "system" ? systemLocale() : next);
  void writeState(LOCALE_KEY, next);
}

/**
 * i18n 纯逻辑（不依赖 Solid / Tauri）：语言判定、占位符替换、复数变体选择。
 * 与 signal 接线分开，便于脚本与单测直接使用（见 scripts/i18n-check.mjs）。
 */

/** 界面语言；新增语言时在这里加 tag，并补一份 locales/<tag>.ts 词典 */
export type Locale = "zh-CN" | "en";

/** 语言偏好：跟随系统，或固定某一种语言 */
export type LocalePreference = "system" | Locale;

/** 全部受支持的语言 */
export const LOCALES: readonly Locale[] = ["zh-CN", "en"];

/** 兜底语言（词典的源语言） */
export const DEFAULT_LOCALE: Locale = "zh-CN";

/** 文案参数：`count` 是复数选择用的数量，其余按名字插值到 `{name}` */
export type MessageParams = Record<string, string | number>;

/** 一份语言的完整词典 */
export type Messages = Record<string, string>;

/**
 * 系统语言 → 受支持语言：只认首个语言标签，`zh*`（含繁体）用简体中文，
 * 其余一律英语 —— 用户的首选语言不受支持时，英语比中文更可能看得懂。
 */
export function detectSystemLocale(
  languages: readonly (string | null | undefined)[],
): Locale {
  for (const tag of languages) {
    if (!tag) continue;
    return /^zh\b/i.test(tag) || /^zh-/i.test(tag) ? "zh-CN" : "en";
  }
  return DEFAULT_LOCALE;
}

/** 后端存回来的偏好归一化：非法值（旧数据 / 手改文件）按「跟随系统」处理 */
export function normalizeLocalePreference(value: unknown): LocalePreference {
  return value === "system" || value === "zh-CN" || value === "en"
    ? value
    : "system";
}

const pluralRulesCache = new Map<Locale, Intl.PluralRules>();

function pluralRulesFor(locale: Locale): Intl.PluralRules {
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
  }
  return rules;
}

/** 模板里的占位符名（`{name}`）；校验脚本与调试用 */
export function messagePlaceholders(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(/\{(\w+)\}/g)) names.add(match[1]);
  return [...names];
}

/** 占位符替换；没传的参数原样留在文本里（一眼能看出漏传，不静默变空） */
export function formatMessage(
  template: string,
  params?: MessageParams,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * 取一条文案：传了 `count` 时先找复数变体（`key_one` / `key_other`，按语言的复数规则），
 * 找到就用变体，否则退回基础 key（中文只有基础 key，英语按需给变体）。
 * 词典里没有该 key 时返回 undefined，由调用方决定兜底文案。
 */
export function lookupMessage(
  messages: Messages,
  locale: Locale,
  key: string,
  params?: MessageParams,
): string | undefined {
  const count = params?.count;
  if (typeof count === "number" && Number.isFinite(count)) {
    const category = pluralRulesFor(locale).select(count);
    const variant = messages[`${key}_${category}`];
    if (variant !== undefined) return formatMessage(variant, params);
  }
  const base = messages[key];
  return base === undefined ? undefined : formatMessage(base, params);
}

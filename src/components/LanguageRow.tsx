/**
 * 设置页的「语言」区：跟随系统 / 简体中文 / English 三选一。
 *
 * 语言名用各自的语言书写（简体中文 / English），不随界面语言变化 —— 否则英语界面里
 * 出现 "Simplified Chinese"、中文界面里出现「英语」，用户反而要在陌生语言里找母语。
 * 切换即时生效（`t()` 读的是同一个 signal），偏好由后端持久化（见 `lib/i18n`）。
 */
import { For } from "solid-js";
import {
  currentLocalePreference,
  setLocalePreference,
  t,
  type LocalePreference,
  type MessageKey,
} from "../lib/i18n";

const LANGUAGE_OPTIONS: readonly {
  value: LocalePreference;
  labelKey: MessageKey;
}[] = [
  { value: "system", labelKey: "app.language.system" },
  { value: "zh-CN", labelKey: "app.language.zhCN" },
  { value: "en", labelKey: "app.language.en" },
];

export function LanguageRow() {
  return (
    <section class="mb-6">
      <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
        {t("app.language.title")}
      </h2>
      <div class="overflow-hidden rounded-[14px] border border-border bg-surface">
        <div class="flex w-full cursor-default items-center gap-3 px-4 py-[13px] text-left">
          <span
            class="flex min-w-0 flex-1 flex-col gap-0.5"
            aria-hidden="true"
          >
            <span class="text-[14.5px] font-medium">{t("app.language.title")}</span>
          </span>
          <div
            class="flex flex-none gap-0.5 rounded-[10px] bg-surface-2 p-[3px]"
            role="radiogroup"
            aria-label={t("app.language.title")}
          >
            <For each={LANGUAGE_OPTIONS}>
              {(option) => (
                <button
                  role="radio"
                  type="button"
                  aria-checked={currentLocalePreference() === option.value}
                  class="inline-flex items-center whitespace-nowrap rounded-lg px-[11px] py-[7px] text-[12.5px] text-text-2 transition-all duration-150"
                  classList={{
                    "bg-surface font-semibold text-text shadow-sm shadow-black/15":
                      currentLocalePreference() === option.value,
                  }}
                  onClick={() => void setLocalePreference(option.value)}
                >
                  {t(option.labelKey)}
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </section>
  );
}

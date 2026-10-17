import { For, Show, type JSX } from "solid-js";
import { ToggleSwitch } from "./ToggleSwitch";
import { t } from "../lib/i18n";
import {
  TARGET_LANGUAGES,
  type TranslationSettings,
} from "../lib/translation/types";

function Field(props: { label: string; children: JSX.Element }) {
  return (
    <label class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 last:border-0">
      <span class="text-[13px] text-text-2">{props.label}</span>
      {props.children}
    </label>
  );
}
const inputClass =
  "min-w-0 max-w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-accent";
export function TranslationOptions(props: {
  value: TranslationSettings;
  onChange: (patch: Partial<TranslationSettings>) => void;
  showEnabled?: boolean;
  showGlossary?: boolean;
}) {
  const toggle = (key: "enabled" | "folded" | "glossary", label: string) => (
    <div class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
      <span class="text-[13px]">{label}</span>
      <ToggleSwitch
        on={props.value[key]}
        label={label}
        onChange={() => props.onChange({ [key]: !props.value[key] })}
      />
    </div>
  );
  return (
    <div class="overflow-hidden rounded-[14px] border border-border bg-surface">
      <Show when={props.showEnabled}>
        {toggle("enabled", t("translation.enabled"))}
      </Show>
      <Field label={t("translation.mode")}>
        <select
          class={inputClass}
          value={props.value.mode}
          onChange={(e) =>
            props.onChange({
              mode: e.currentTarget.value as TranslationSettings["mode"],
            })
          }
        >
          <For each={["bilingual", "translated", "original"] as const}>
            {(value) => (
              <option value={value}>{t(`translation.mode.${value}`)}</option>
            )}
          </For>
        </select>
      </Field>
      <Show when={props.value.mode === "bilingual"}>
        {toggle("folded", t("translation.folded"))}
      </Show>
      <Field label={t("translation.target")}>
        <select
          class={inputClass}
          value={props.value.target}
          onChange={(e) =>
            props.onChange({
              target: e.currentTarget.value as TranslationSettings["target"],
            })
          }
        >
          <For each={TARGET_LANGUAGES}>
            {(value) => (
              <option value={value}>{t(`translation.lang.${value}`)}</option>
            )}
          </For>
        </select>
      </Field>
      <Field label={t("translation.provider")}>
        <select
          class={inputClass}
          value={props.value.provider}
          onChange={(e) => {
            const provider = e.currentTarget
              .value as TranslationSettings["provider"];
            props.onChange({
              provider,
              baseUrl: "",
              model:
                provider === "openai"
                  ? "gpt-5-mini"
                  : provider === "deepseek"
                    ? "deepseek-flash"
                    : "",
              apiKey: "",
              effort: "",
              protocol: "chat",
            });
          }}
        >
          <For each={["google", "openai", "deepseek", "custom"] as const}>
            {(value) => (
              <option value={value}>
                {t(`translation.provider.${value}`)}
              </option>
            )}
          </For>
        </select>
      </Field>
      <Show
        when={props.value.provider !== "google"}
        fallback={
          <p class="px-4 py-3 text-[12px] text-text-3">
            {t("translation.publicService")}
          </p>
        }
      >
        <Field label={t("translation.protocol")}>
          <select
            class={inputClass}
            value={props.value.protocol}
            onChange={(e) =>
              props.onChange({
                protocol: e.currentTarget
                  .value as TranslationSettings["protocol"],
              })
            }
          >
            <option value="chat">OpenAI Chat Completions</option>
            <option value="responses">OpenAI Responses</option>
          </select>
        </Field>
        <For each={["baseUrl", "model", "apiKey"] as const}>
          {(key) => (
            <Field label={t(`translation.${key}`)}>
              <input
                class={`${inputClass} w-full`}
                type={key === "apiKey" ? "password" : "text"}
                autocomplete="off"
                spellcheck={false}
                value={props.value[key]}
                placeholder={
                  key === "baseUrl"
                    ? props.value.provider === "deepseek"
                      ? "https://api.deepseek.com"
                      : "https://api.openai.com/v1"
                    : ""
                }
                onChange={(e) =>
                  props.onChange({ [key]: e.currentTarget.value.trim() })
                }
              />
            </Field>
          )}
        </For>
        <Field label={t("translation.effort")}>
          <select
            class={inputClass}
            value={props.value.effort}
            onChange={(e) => props.onChange({ effort: e.currentTarget.value })}
          >
            <option value="">{t("translation.effort.default")}</option>
            <For each={["none", "minimal", "low", "medium", "high", "xhigh"]}>
              {(value) => <option value={value}>{value}</option>}
            </For>
          </select>
        </Field>
      </Show>
      <Field label={t("translation.pretranslate")}>
        <select
          class={inputClass}
          value={props.value.pretranslate}
          onChange={(e) =>
            props.onChange({ pretranslate: Number(e.currentTarget.value) })
          }
        >
          <option value={0}>{t("translation.pretranslate.off")}</option>
          <For each={[1, 2, 3, 4, 5]}>
            {(count) => (
              <option value={count}>
                {t("translation.chapters", { count })}
              </option>
            )}
          </For>
        </select>
      </Field>
      <Field label={t("translation.parallel")}>
        <select
          class={inputClass}
          value={props.value.parallel}
          onChange={(e) =>
            props.onChange({ parallel: Number(e.currentTarget.value) })
          }
        >
          <For each={[1, 2, 3, 4, 5, 6, 7, 8]}>
            {(count) => <option value={count}>{count}</option>}
          </For>
        </select>
      </Field>
      <Show when={props.showGlossary !== false}>
        {toggle("glossary", t("translation.glossary"))}
      </Show>
    </div>
  );
}

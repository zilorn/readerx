/**
 * 书源编辑页「书源信息」表单
 * ------------------------------------------------
 * 名称 / 地址 / 版本 / 启停 / 能力开关 / 请求头 / 网页登录。
 * 状态全部由 SourceEditor 页面持有（此处只收发值），便于切 Tab 不丢草稿。
 */
import { For } from "solid-js";
import { ChevronRightIcon, ClearIcon, FolderIcon, GlobeKeyIcon } from "./icons";
import { ToggleSwitch } from "./ToggleSwitch";
import { CAPABILITY_LABELS, type BookSourceCapabilities } from "../lib/bookSourcesTypes";
import { t } from "../lib/i18n";

export interface SourceInfoFormProps {
  name: string;
  onName: (value: string) => void;
  bookSourceUrl: string;
  onBookSourceUrl: (value: string) => void;
  author: string;
  onAuthor: (value: string) => void;
  version: string;
  onVersion: (value: string) => void;
  /** 所属书源分组名（空 = 未分组） */
  groupName: string;
  onPickGroup: () => void;
  enabled: boolean;
  onEnabled: (value: boolean) => void;
  caps: BookSourceCapabilities;
  onCaps: (caps: BookSourceCapabilities) => void;
  userAgent: string;
  onUserAgent: (value: string) => void;
  headersText: string;
  onHeadersText: (value: string) => void;
  autoAuth: boolean;
  onAutoAuth: (value: boolean) => void;
  loginUrl: string;
  onLoginUrl: (value: string) => void;
  loginBusy: boolean;
  loginSupported: boolean;
  onWebLogin: () => void;
  onClearLogin: () => void;
}

const FIELD_CLASS =
  "rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent";
const LABEL_CLASS = "text-[11.5px] font-semibold text-text-3";

export function SourceInfoForm(props: SourceInfoFormProps) {
  const capabilityKeys = (): (keyof BookSourceCapabilities)[] =>
    Object.keys(CAPABILITY_LABELS) as (keyof BookSourceCapabilities)[];

  return (
    <div class="space-y-5">
      {/* 元信息 */}
      <section class="space-y-2.5">
        <label class="flex flex-col gap-1">
          <span class={LABEL_CLASS}>{t("sourceEditor.form.name")}</span>
          <input
            class={FIELD_CLASS}
            value={props.name}
            onInput={(e) => props.onName(e.currentTarget.value)}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class={LABEL_CLASS}>{t("sourceEditor.form.bookSourceUrl")}</span>
          <input
            class={`${FIELD_CLASS} text-[13px]`}
            value={props.bookSourceUrl}
            onInput={(e) => props.onBookSourceUrl(e.currentTarget.value)}
          />
        </label>
        <div class="flex gap-2.5">
          <label class="flex min-w-0 flex-1 flex-col gap-1">
            <span class={LABEL_CLASS}>{t("sourceEditor.form.author")}</span>
            <input
              class={FIELD_CLASS}
              value={props.author}
              onInput={(e) => props.onAuthor(e.currentTarget.value)}
            />
          </label>
          <label class="flex w-24 flex-col gap-1">
            <span class={LABEL_CLASS}>{t("sourceEditor.form.version")}</span>
            <input
              class={FIELD_CLASS}
              value={props.version}
              onInput={(e) => props.onVersion(e.currentTarget.value)}
            />
          </label>
        </div>
        <div class="flex flex-col gap-1">
          <span class={LABEL_CLASS}>{t("sourceEditor.form.group")}</span>
          <button
            class="flex items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2 text-left text-[13px] outline-none active:bg-surface-2"
            onClick={props.onPickGroup}
          >
            <FolderIcon size={15} class="flex-none text-text-3" />
            <span
              class="min-w-0 flex-1 truncate"
              classList={{ "text-text-3": !props.groupName }}
            >
              {props.groupName || t("common.ungrouped")}
            </span>
            <ChevronRightIcon size={15} class="flex-none text-text-3" />
          </button>
        </div>
      </section>

      {/* 启用与能力开关 */}
      <section class="rounded-[14px] border border-border bg-surface">
        <div class="flex w-full items-center justify-between px-4 py-3">
          <span class="text-[14px] font-medium">{t("sourceEditor.form.enabled")}</span>
          <ToggleSwitch
            on={props.enabled}
            label={t("sourceEditor.form.enabled")}
            onChange={() => props.onEnabled(!props.enabled)}
          />
        </div>
        <div class="divide-y divide-border border-t border-border">
          <For each={capabilityKeys()}>
            {(key) => (
              <div class="flex w-full items-center justify-between px-4 py-2.5">
                <span class="text-[13.5px] text-text-2">{t(CAPABILITY_LABELS[key])}</span>
                <ToggleSwitch
                  on={props.caps[key]}
                  label={t("sourceEditor.form.ability", { name: t(CAPABILITY_LABELS[key]) })}
                  onChange={() => props.onCaps({ ...props.caps, [key]: !props.caps[key] })}
                />
              </div>
            )}
          </For>
        </div>
      </section>

      {/* 请求与会话 */}
      <section class="space-y-2.5">
        <label class="flex flex-col gap-1">
          <span class={LABEL_CLASS}>{t("sourceEditor.form.userAgent")}</span>
          <input
            class={`${FIELD_CLASS} text-[12px]`}
            value={props.userAgent}
            onInput={(e) => props.onUserAgent(e.currentTarget.value)}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class={LABEL_CLASS}>{t("sourceEditor.form.headers")}</span>
          <textarea
            class="min-h-16 resize-y rounded-[10px] border border-border bg-surface px-3 py-2 font-mono text-[11.5px] leading-[1.6] outline-none focus:border-accent"
            rows={3}
            value={props.headersText}
            onInput={(e) => props.onHeadersText(e.currentTarget.value)}
          />
        </label>

        {/* 网页登录（应用内 WebView） */}
        <div class="space-y-2 rounded-[14px] border border-border bg-surface p-3.5">
          <div class="flex items-center gap-1.5">
            <GlobeKeyIcon size={16} class="text-text-2" />
            <span class="whitespace-nowrap text-[13px] font-semibold text-text-2">
              {t("sourceEditor.form.webLogin")}
            </span>
            <span class="text-[10.5px] text-text-3">
              {t("sourceEditor.form.webLoginHint")}
            </span>
          </div>
          <div class="flex w-full items-center justify-between gap-3 rounded-[12px] border border-border px-3 py-2.5">
            <span class="text-left">
              <span class="block text-[12.5px] font-medium text-text-2">
                {t("sourceEditor.form.autoAuth")}
              </span>
              <span class="mt-0.5 block text-[10.5px] leading-[1.45] text-text-3">
                {t("sourceEditor.form.autoAuthHint")}
              </span>
            </span>
            <ToggleSwitch
              on={props.autoAuth}
              label={t("sourceEditor.form.autoAuth")}
              onChange={() => props.onAutoAuth(!props.autoAuth)}
            />
          </div>
          {!props.autoAuth && (
            <p class="text-[10.5px] leading-[1.5] text-text-3">
              {t("sourceEditor.form.autoAuthOff")}
            </p>
          )}
          <input
            class="w-full rounded-[10px] border border-border bg-surface px-3 py-2 font-mono text-[12px] outline-none focus:border-accent"
            placeholder="https://example.com/login"
            value={props.loginUrl}
            onInput={(e) => props.onLoginUrl(e.currentTarget.value)}
          />
          <div class="flex items-center gap-2.5">
            <button
              class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-[12.5px] font-semibold text-on-accent active:scale-[0.98] disabled:opacity-45"
              disabled={props.loginBusy || !props.loginSupported}
              onClick={props.onWebLogin}
            >
              {props.loginBusy
                ? t("sourceEditor.form.loginOpening")
                : t("sourceEditor.form.openLogin")}
            </button>
            <button
              class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] font-semibold text-text-2 active:scale-[0.98] disabled:opacity-45"
              disabled={props.loginBusy}
              onClick={props.onClearLogin}
            >
              <ClearIcon size={14} />
              {t("sourceEditor.form.clearLogin")}
            </button>
          </div>
          {!props.loginSupported && (
            <p class="text-[10.5px] leading-[1.5] text-text-3">
              {t("sourceEditor.form.unsupported")}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

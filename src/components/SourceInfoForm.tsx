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
          <span class={LABEL_CLASS}>名称</span>
          <input
            class={FIELD_CLASS}
            value={props.name}
            onInput={(e) => props.onName(e.currentTarget.value)}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class={LABEL_CLASS}>站点地址（bookSourceUrl）</span>
          <input
            class={`${FIELD_CLASS} text-[13px]`}
            value={props.bookSourceUrl}
            onInput={(e) => props.onBookSourceUrl(e.currentTarget.value)}
          />
        </label>
        <div class="flex gap-2.5">
          <label class="flex min-w-0 flex-1 flex-col gap-1">
            <span class={LABEL_CLASS}>作者</span>
            <input
              class={FIELD_CLASS}
              value={props.author}
              onInput={(e) => props.onAuthor(e.currentTarget.value)}
            />
          </label>
          <label class="flex w-24 flex-col gap-1">
            <span class={LABEL_CLASS}>版本</span>
            <input
              class={FIELD_CLASS}
              value={props.version}
              onInput={(e) => props.onVersion(e.currentTarget.value)}
            />
          </label>
        </div>
        <div class="flex flex-col gap-1">
          <span class={LABEL_CLASS}>分组</span>
          <button
            class="flex items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2 text-left text-[13px] outline-none active:bg-surface-2"
            onClick={props.onPickGroup}
          >
            <FolderIcon size={15} class="flex-none text-text-3" />
            <span
              class="min-w-0 flex-1 truncate"
              classList={{ "text-text-3": !props.groupName }}
            >
              {props.groupName || "未分组"}
            </span>
            <ChevronRightIcon size={15} class="flex-none text-text-3" />
          </button>
        </div>
      </section>

      {/* 启用与能力开关 */}
      <section class="rounded-[14px] border border-border bg-surface">
        <div class="flex w-full items-center justify-between px-4 py-3">
          <span class="text-[14px] font-medium">启用书源</span>
          <ToggleSwitch
            on={props.enabled}
            label="启用书源"
            onChange={() => props.onEnabled(!props.enabled)}
          />
        </div>
        <div class="divide-y divide-border border-t border-border">
          <For each={capabilityKeys()}>
            {(key) => (
              <div class="flex w-full items-center justify-between px-4 py-2.5">
                <span class="text-[13.5px] text-text-2">{CAPABILITY_LABELS[key]}</span>
                <ToggleSwitch
                  on={props.caps[key]}
                  label={CAPABILITY_LABELS[key]}
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
          <span class={LABEL_CLASS}>
            User-Agent（留空用内置默认；过 CF 等站点可在此填浏览器 UA）
          </span>
          <input
            class={`${FIELD_CLASS} text-[12px]`}
            value={props.userAgent}
            onInput={(e) => props.onUserAgent(e.currentTarget.value)}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class={LABEL_CLASS}>
            默认请求头（每行「名称: 值」，Cookie 等可在此粘贴，CF 站点见 docs/cloudflare.md）
          </span>
          <textarea
            class="min-h-16 resize-y rounded-[10px] border border-border bg-surface px-3 py-2 font-mono text-[11.5px] leading-[1.6] outline-none focus:border-accent"
            rows={3}
            value={props.headersText}
            onInput={(e) => props.onHeadersText(e.currentTarget.value)}
          />
        </label>

        {/* 网页登录（WebView，仅 Android） */}
        <div class="space-y-2 rounded-[14px] border border-border bg-surface p-3.5">
          <div class="flex items-center gap-1.5">
            <GlobeKeyIcon size={16} class="text-text-2" />
            <span class="whitespace-nowrap text-[13px] font-semibold text-text-2">网页登录</span>
            <span class="text-[10.5px] text-text-3">
              WebView 浮层内完成登录，捕获含 httpOnly 的 Cookie
            </span>
          </div>
          <div class="flex w-full items-center justify-between gap-3 rounded-[12px] border border-border px-3 py-2.5">
            <span class="text-left">
              <span class="block text-[12.5px] font-medium text-text-2">自动网页认证</span>
              <span class="mt-0.5 block text-[10.5px] leading-[1.45] text-text-3">
                请求遇 Cloudflare 挑战时自动弹窗认证并重试（令牌过期自动刷新）；书源代码
                webview.login 同受此开关控制
              </span>
            </span>
            <ToggleSwitch
              on={props.autoAuth}
              label="自动网页认证"
              onChange={() => props.onAutoAuth(!props.autoAuth)}
            />
          </div>
          {!props.autoAuth && (
            <p class="text-[10.5px] leading-[1.5] text-text-3">
              已关闭：该书源请求被拦截时不会自动弹出认证窗，书源代码的 webview.login
              也会返回不可用；编辑页「打开登录页」不受影响
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
              {props.loginBusy ? "登录窗口已打开…" : "打开登录页"}
            </button>
            <button
              class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] font-semibold text-text-2 active:scale-[0.98] disabled:opacity-45"
              disabled={props.loginBusy}
              onClick={props.onClearLogin}
            >
              <ClearIcon size={14} />
              清空登录 Cookie
            </button>
          </div>
          {!props.loginSupported && (
            <p class="text-[10.5px] leading-[1.5] text-text-3">
              当前平台不支持网页登录（仅 Android 端可用）；可在代码里用
              <code class="font-mono"> webview.login(url) </code>
              触发。
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * 听书设置底部抽屉：引擎（原生系统语音 / 自定义 HTTP 源）、音色、倍速、定时。
 *
 * 自定义源填写说明（帮助）：
 * - 地址/body 里的 {$TEXT} 会被替换成当前句文本，默认做一次 URL 编码；
 * - {$TEXT?URLencoding=0} 禁止编码；{$TEXT?URLencoding=2} 编码两次；
 * - POST 的 body 以 { 或 [ 开头按 JSON 发送，否则按表单编码；
 * - 服务端应返回音频字节（mp3 / wav / ogg 等）。
 */
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { TtsEngine, HttpTtsMethod } from "../lib/ttsSettings";
import type { TtsTimerMode } from "../lib/ttsPlayer";
import { TTS_RATES } from "../lib/ttsSettings";
import {
  ensureNativeVoicesLoaded,
  nativeVoicesState,
  nativeVoiceList,
} from "../lib/ttsEngine";
import {
  httpTtsBody,
  httpTtsMethod,
  httpTtsUrl,
  setHttpTtsBody,
  setHttpTtsMethod,
  setHttpTtsUrl,
} from "../lib/ttsSettings";
import { t, type MessageKey } from "../lib/i18n";
import { CheckIcon, CloseIcon, HeadphonesIcon, TimerIcon } from "./icons";
import { ScrollArea } from "./ScrollArea";

export interface TtsSheetProps {
  open: boolean;
  engine: () => TtsEngine;
  rate: () => number;
  voiceId: () => string;
  timerMode: () => TtsTimerMode;
  timerMinutes: () => number;
  timerRemainSec: () => number | null;
  onEngine: (engine: TtsEngine) => void;
  onRate: (rate: number) => void;
  onVoice: (voiceId: string) => void;
  onTimer: (mode: TtsTimerMode, minutes?: number) => void;
  /** 批量预热状态文案（预热中显示进度；null 表示空闲） */
  prewarmText: () => string | null;
  onPrewarmBook: () => void;
  onStop: () => void;
  onClose: () => void;
}

const MINUTE_OPTIONS = [10, 20, 30, 60] as const;

const ENGINES: Array<{ id: TtsEngine; labelKey: MessageKey; descKey: MessageKey }> = [
  { id: "native", labelKey: "tts.engine.native", descKey: "tts.engine.nativeDesc" },
  { id: "http", labelKey: "tts.engine.http", descKey: "tts.engine.httpDesc" },
];

function formatRemain(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function SectionTitle(props: { text: string }) {
  return (
    <div class="px-4 pb-2 pt-1 text-[12px] font-semibold tracking-[0.08em] text-text-3">
      {props.text}
    </div>
  );
}

function helpLine(text: string) {
  return (
    <li class="leading-snug">
      <code class="mr-1 text-accent">{text}</code>
    </li>
  );
}

const inputBase =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px] text-text outline-none placeholder:text-text-3 focus:border-accent";

export function TtsSheet(props: TtsSheetProps) {
  // 打开面板且使用原生引擎时，确保系统语音列表已就绪
  const [voiceLoadingHint, setVoiceLoadingHint] = createSignal(false);
  createEffect(() => {
    if (props.open && props.engine() === "native") {
      setVoiceLoadingHint(true);
      void ensureNativeVoicesLoaded().finally(() => setVoiceLoadingHint(false));
    }
  });

  const isNative = () => props.engine() === "native";

  const voiceItems = createMemo(() =>
    nativeVoiceList().map((v) => ({ id: v.id, label: v.name, desc: v.language })),
  );

  const method: () => HttpTtsMethod = () => httpTtsMethod();

  const voicesNotice = () => {
    const st = nativeVoicesState();
    if (st === "loading" || voiceLoadingHint()) return t("tts.voice.loading");
    if (st === "unavailable") return t("tts.voice.unavailable");
    if (st === "ready" && nativeVoiceList().length === 0) {
      return t("tts.voice.none");
    }
    return null;
  };

  return (
    <Show when={props.open}>
      <div
        data-reader-ui
        class="absolute inset-0 z-50 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
        onClick={props.onClose}
      />
      <div
        data-reader-ui
        class="absolute inset-x-0 bottom-0 z-[51] flex max-h-[86%] animate-sheet-up select-none flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
        role="dialog"
        aria-label={t("tts.sheet.title")}
      >
        <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
          <HeadphonesIcon size={19} class="text-accent" />
          <span class="text-[15px] font-bold">{t("tts.sheet.title")}</span>
          <span class="flex-1 text-xs text-text-3">
            {isNative() ? t("tts.sheet.nativeHint") : t("tts.sheet.httpHint")}
          </span>
          <button
            class="grid h-10 w-10 flex-none cursor-pointer place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label={t("tts.sheet.close")}
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <ScrollArea class="min-h-0 flex-1" contentClass="px-1 py-3 pb-[calc(14px+env(safe-area-inset-bottom))]">
          {/* 引擎 */}
          <SectionTitle text={t("tts.section.engine")} />
          <div class="grid grid-cols-2 gap-2 px-3 pb-4">
            <For each={ENGINES}>
              {(eng) => {
                const active = () => props.engine() === eng.id;
                return (
                  <button
                    class="flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-[9px] text-left transition-colors"
                    classList={{
                      "border-accent bg-accent-weak": active(),
                      "border-border": !active(),
                    }}
                    aria-pressed={active()}
                    onClick={() => props.onEngine(eng.id)}
                  >
                    <span class="flex flex-col">
                      <span
                        classList={{ "text-accent": active(), "text-text": !active() }}
                        class="text-[13px] font-semibold leading-tight"
                      >
                        {t(eng.labelKey)}
                      </span>
                      <span class="text-[10.5px] leading-tight text-text-3">{t(eng.descKey)}</span>
                    </span>
                    <span class="ml-auto flex-none">
                      <Show when={active()}>
                        <CheckIcon size={16} class="text-accent" />
                      </Show>
                    </span>
                  </button>
                );
              }}
            </For>
          </div>

          {/* 原生语音：音色选择 */}
          <Show when={isNative()}>
            <SectionTitle text={t("tts.section.voice")} />
            <Show when={voicesNotice()}>
              {(notice) => (
                <div class="px-3 pb-3 text-[12px] leading-snug text-text-3">{notice()}</div>
              )}
            </Show>
            <div class="grid grid-cols-2 gap-2 px-3 pb-4">
              <For each={voiceItems()}>
                {(voice) => {
                  const active = () => props.voiceId() === voice.id;
                  return (
                    <button
                      class="flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-[9px] text-left transition-colors"
                      classList={{
                        "border-accent bg-accent-weak": active(),
                        "border-border": !active(),
                      }}
                      aria-pressed={active()}
                      title={voice.label}
                      onClick={() => props.onVoice(voice.id)}
                    >
                      <span class="flex min-w-0 flex-1 flex-col">
                        <span
                          classList={{ "text-accent": active(), "text-text-2": !active() }}
                          class="truncate text-[13px] font-semibold leading-tight"
                        >
                          {voice.label}
                        </span>
                        <span class="truncate text-[10.5px] leading-tight text-text-3">
                          {voice.desc}
                        </span>
                      </span>
                      <span class="ml-1 flex-none">
                        <Show when={active()}>
                          <CheckIcon size={16} class="text-accent" />
                        </Show>
                      </span>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>

          {/* 自定义 HTTP 源 */}
          <Show when={!isNative()}>
            <SectionTitle text={t("tts.section.httpConfig")} />
            <div class="flex flex-col gap-2 px-3 pb-2">
              <div class="flex overflow-hidden rounded-lg border border-border">
                <button
                  class="flex-1 cursor-pointer py-[7px] text-[13px] transition-colors"
                  classList={{
                    "bg-accent font-semibold text-on-accent": method() === "GET",
                    "text-text-2": method() !== "GET",
                  }}
                  aria-pressed={method() === "GET"}
                  onClick={() => setHttpTtsMethod("GET")}
                >
                  GET
                </button>
                <button
                  class="flex-1 cursor-pointer py-[7px] text-[13px] transition-colors"
                  classList={{
                    "bg-accent font-semibold text-on-accent": method() === "POST",
                    "text-text-2": method() !== "POST",
                  }}
                  aria-pressed={method() === "POST"}
                  onClick={() => setHttpTtsMethod("POST")}
                >
                  POST
                </button>
              </div>
              <input
                class={inputBase}
                spellcheck={false}
                placeholder="http://127.0.0.1:8000/tts?text={$TEXT}&rate={$RATE}"
                value={httpTtsUrl()}
                onInput={(e) => setHttpTtsUrl(e.currentTarget.value)}
              />
              <Show when={method() === "POST"}>
                <textarea
                  class={`${inputBase} min-h-[64px] resize-none leading-snug`}
                  spellcheck={false}
                  placeholder={t("tts.sheet.bodyPlaceholder")}
                  value={httpTtsBody()}
                  onInput={(e) => setHttpTtsBody(e.currentTarget.value)}
                />
              </Show>
            </div>
            <div class="px-3 pb-2">
              <button
                class="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-accent/40 bg-accent-weak py-2 text-[12.5px] font-semibold text-accent transition-[scale] duration-100 active:scale-[0.98] disabled:cursor-default disabled:opacity-60"
                disabled={props.prewarmText() !== null}
                aria-label={t("tts.prewarm.bookAria")}
                onClick={props.onPrewarmBook}
              >
                {props.prewarmText() === null
                  ? t("tts.prewarm.book")
                  : t("tts.prewarm.running", { text: props.prewarmText() ?? "" })}
              </button>
            </div>
            <div class="px-3 pb-4 pt-1">
              <div class="rounded-lg border border-border bg-surface-2 px-3 py-2 text-[11.5px] leading-relaxed text-text-3">
                <div class="pb-0.5 font-semibold tracking-wide text-text-2">{t("tts.help.heading")}</div>
                <ul class="list-none space-y-0.5">
                  {helpLine("{$TEXT}")}
                  <li class="leading-snug">
                    <span class="mr-1 text-text-3">→</span>{t("tts.help.text")}
                  </li>
                  {helpLine("{$TEXT?URLencoding=0}")}
                  <li class="leading-snug">
                    <span class="mr-1 text-text-3">→</span>{t("tts.help.noEncoding")}
                  </li>
                  {helpLine("{$TEXT?URLencoding=2}")}
                  <li class="leading-snug">
                    <span class="mr-1 text-text-3">→</span>{t("tts.help.doubleEncoding")}
                  </li>
                  {helpLine("{$RATE}")}
                  <li class="leading-snug">
                    <span class="mr-1 text-text-3">→</span>{t("tts.help.rate")}
                  </li>
                  <li class="leading-snug">
                    <span class="mr-1 text-text-3">·</span>
                    {t("tts.help.rateClient")}
                  </li>
                  <li class="leading-snug">
                    <span class="mr-1 text-text-3">·</span>
                    {t("tts.help.postBody")}
                  </li>
                  <li class="leading-snug">
                    <span class="mr-1 text-text-3">·</span>
                    {t("tts.help.audioBytes")}
                  </li>
                  <li class="leading-snug">
                    <span class="mr-1 text-text-3">·</span>
                    {t("tts.help.cache")}
                  </li>
                </ul>
              </div>
            </div>
          </Show>

          {/* 倍速 */}
          <SectionTitle text={t("tts.section.rate")} />
          <div class="flex flex-wrap gap-2 px-3 pb-4">
            <For each={TTS_RATES}>
              {(rate) => {
                const active = () => props.rate() === rate;
                return (
                  <button
                    class="min-w-[52px] cursor-pointer rounded-lg border px-2.5 py-[7px] text-[13px] tabular-nums transition-colors"
                    classList={{
                      "border-accent bg-accent-weak font-semibold text-accent": active(),
                      "border-border text-text-2": !active(),
                    }}
                    aria-pressed={active()}
                    onClick={() => props.onRate(rate)}
                  >
                    {rate.toFixed(1).replace(/\.0$/, "")}x
                  </button>
                );
              }}
            </For>
          </div>

          {/* 定时 */}
          <SectionTitle text={t("tts.section.timer")} />
          <div class="flex flex-wrap items-center gap-2 px-3 pb-3">
            <button
              class="cursor-pointer rounded-lg border px-2.5 py-[7px] text-[12.5px] transition-colors"
              classList={{
                "border-accent bg-accent-weak font-semibold text-accent":
                  props.timerMode() === "off",
                "border-border text-text-2": props.timerMode() !== "off",
              }}
              aria-pressed={props.timerMode() === "off"}
              onClick={() => props.onTimer("off")}
            >
              {t("tts.timer.off")}
            </button>
            <For each={MINUTE_OPTIONS}>
              {(minutes) => {
                const active = () =>
                  props.timerMode() === "minutes" && props.timerMinutes() === minutes;
                return (
                  <button
                    class="cursor-pointer rounded-lg border px-2.5 py-[7px] text-[12.5px] tabular-nums transition-colors"
                    classList={{
                      "border-accent bg-accent-weak font-semibold text-accent": active(),
                      "border-border text-text-2": !active(),
                    }}
                    aria-pressed={active()}
                    onClick={() => props.onTimer("minutes", minutes)}
                  >
                    {t("tts.timer.minutes", { count: minutes })}
                  </button>
                );
              }}
            </For>
            <button
              class="cursor-pointer rounded-lg border px-2.5 py-[7px] text-[12.5px] transition-colors"
              classList={{
                "border-accent bg-accent-weak font-semibold text-accent":
                  props.timerMode() === "chapter",
                "border-border text-text-2": props.timerMode() !== "chapter",
              }}
              aria-pressed={props.timerMode() === "chapter"}
              onClick={() => props.onTimer("chapter")}
            >
              {t("tts.timer.chapterEnd")}
            </button>
          </div>

          <div class="flex items-center gap-1.5 px-3 text-[12px] text-text-3">
            <Show when={props.timerMode() === "minutes" && props.timerRemainSec() !== null}>
              <TimerIcon size={14} />
              <span>
                {t("tts.timer.remaining", { time: formatRemain(props.timerRemainSec() ?? 0) })}
              </span>
            </Show>
            <Show when={props.timerMode() === "chapter"}>
              <TimerIcon size={14} />
              <span>{t("tts.timer.chapterHint")}</span>
            </Show>
          </div>

          <button
            class="mx-3 mt-5 flex w-[calc(100%-24px)] cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-danger/40 bg-danger-weak py-[10px] text-[13px] font-semibold text-danger transition-[scale] duration-100 active:scale-[0.98]"
            onClick={() => {
              props.onStop();
              props.onClose();
            }}
          >
            {t("tts.action.stop")}
          </button>
        </ScrollArea>
      </div>
    </Show>
  );
}

/**
 * 听书悬浮球：暂停/继续 + 上一句/下一句 + 打开听书菜单（倍速/音色/定时）。
 * 固定在阅读页底部工具栏上方，随菜单栏一同滑入/滑出（不可自由拖动）。
 */
import { Show } from "solid-js";
import type { TtsStatus } from "../lib/ttsPlayer";
import {
  PlayIcon,
  SettingsIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "./icons";

export interface TtsBubbleProps {
  status: () => TtsStatus;
  rate: () => number;
  voiceLabel: () => string;
  /** 最近一次失败的真实原因（界面直接可读，便于无日志环境排查） */
  error: () => string | null;
  onPrev: () => void;
  onNext: () => void;
  onToggle: () => void;
  onOpenSettings: () => void;
}

export function TtsBubble(props: TtsBubbleProps) {
  const status = props.status;
  const playing = () => status() === "playing" || status() === "loading";

  return (
    <div data-reader-ui class="flex select-none flex-col items-end">
      <div class="flex items-center rounded-full border border-border bg-surface py-1 pl-1 pr-1 shadow-[0_6px_22px_rgb(0_0_0/0.22)] backdrop-blur-md">
        <button
          class="grid h-9 w-9 cursor-pointer place-items-center rounded-full text-text-2 transition-[background-color,scale] duration-100 active:scale-90 active:bg-surface-2"
          aria-label="上一句"
          onClick={(e) => {
            e.stopPropagation();
            props.onPrev();
          }}
        >
          <SkipBackIcon size={18} />
        </button>

        <button
          class="mx-0.5 grid h-11 w-11 cursor-pointer place-items-center rounded-full bg-accent text-on-accent shadow-md transition-[scale] duration-100 active:scale-90"
          aria-label={playing() ? "暂停" : "播放"}
          aria-pressed={!playing()}
          onClick={(e) => {
            e.stopPropagation();
            props.onToggle();
          }}
        >
          {playing() ? (
            <span class="grid h-4 w-4 animate-spin place-items-center">
              <span class="block h-4 w-4 rounded-full border-2 border-on-accent/30 border-t-on-accent" />
            </span>
          ) : (
            <PlayIcon size={19} class="translate-x-[1px]" />
          )}
        </button>

        <button
          class="grid h-9 w-9 cursor-pointer place-items-center rounded-full text-text-2 transition-[background-color,scale] duration-100 active:scale-90 active:bg-surface-2"
          aria-label="下一句"
          onClick={(e) => {
            e.stopPropagation();
            props.onNext();
          }}
        >
          <SkipForwardIcon size={18} />
        </button>

        <div class="mx-0.5 h-5 w-px bg-border" />

        <button
          class="grid h-9 w-9 cursor-pointer place-items-center rounded-full text-text-2 transition-[background-color,scale] duration-100 active:scale-90 active:bg-surface-2"
          aria-label="听书设置"
          onClick={(e) => {
            e.stopPropagation();
            props.onOpenSettings();
          }}
        >
          <SettingsIcon size={17} />
        </button>
      </div>

      <div class="pointer-events-none mt-1.5 pr-1 text-right text-[10px] leading-none text-text-3">
        {props.voiceLabel()} · {props.rate().toFixed(1).replace(/\.0$/, "")}x
      </div>

      <Show when={props.error()}>
        {(err) => (
          <div class="pointer-events-none mt-1 max-w-[280px] whitespace-normal break-words rounded-lg border border-danger/30 bg-danger-weak px-2 py-1 text-right text-[11px] leading-snug text-danger">
            {err()}
          </div>
        )}
      </Show>
    </div>
  );
}

/**
 * 「音频解码失败」修复指南弹窗。
 *
 * 自定义源（HTTP 听书源）返回的音频解不开时，尤其在 Linux 桌面端多半是系统缺少
 * MP3 解码器插件 —— 这不是应用能自行补救的，必须把「缺什么、装什么、怎么验证」
 * 摊开给用户，否则界面只剩一句「音频解码失败」，无从下手。
 *
 * 命令一律只展示、不代执行：装系统包要用户自己在终端里做（应用不该替你 sudo）。
 * 点命令即可整条复制，便于粘到终端。
 */
import { For, Show, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { TTS_DECODE_GUIDE, type TtsGuideCommand } from "../lib/ttsDecodeGuide";
import { CopyIcon, CheckIcon, CloseIcon, HeadphonesIcon } from "./icons";

export interface TtsDecodeGuideDialogProps {
  open: boolean;
  onClose: () => void;
}

/** 一条可点击复制的命令；复制成功后短暂显示对勾（无需再弹 toast 打扰） */
function CommandRow(props: { command: TtsGuideCommand }) {
  const [copied, setCopied] = createSignal(false);
  let timer: number | undefined;
  onCleanup(() => window.clearTimeout(timer));

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.command.cmd);
    } catch {
      // 剪贴板不可用（无权限 / 非安全上下文）：命令已在屏幕上，可手动选中复制
      return;
    }
    setCopied(true);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div class="flex flex-col gap-1">
      <button
        type="button"
        class="flex w-full cursor-pointer items-start gap-2 rounded-[10px] border border-border bg-bg px-2.5 py-2 text-left transition-colors active:bg-surface-2"
        aria-label={`复制命令：${props.command.cmd}`}
        onClick={() => void copy()}
      >
        <code class="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11.5px] leading-[1.6] text-text">
          {props.command.cmd}
        </code>
        <span class="mt-[1px] flex-none text-text-3">
          <Show when={copied()} fallback={<CopyIcon size={14} />}>
            <CheckIcon size={14} class="text-accent" />
          </Show>
        </span>
      </button>
      <Show when={props.command.note}>
        <p class="px-1 text-[11px] leading-[1.65] text-text-3">{props.command.note}</p>
      </Show>
    </div>
  );
}

export function TtsDecodeGuideDialog(props: TtsDecodeGuideDialogProps) {
  const guide = TTS_DECODE_GUIDE;

  return (
    <Show when={props.open}>
      <Portal>
        <div
          class="fixed inset-0 z-[85] grid place-items-center px-5 py-6"
          role="dialog"
          aria-modal="true"
          aria-label="音频解码失败修复指南"
        >
          <div
            class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
            onClick={props.onClose}
          />
          <div class="relative flex max-h-full w-full max-w-[420px] animate-pop-in flex-col overflow-hidden rounded-[18px] border border-border bg-surface shadow-[0_18px_50px_rgb(0_0_0/0.3)]">
            <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
              <HeadphonesIcon size={18} class="flex-none text-accent" />
              <span class="flex-1 text-[15px] font-bold">{guide.heading}</span>
              <button
                class="grid h-9 w-9 flex-none cursor-pointer place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                type="button"
                aria-label="关闭修复指南"
                onClick={props.onClose}
              >
                <CloseIcon size={18} />
              </button>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
              <p class="text-[12.5px] leading-[1.75] text-text-2">{guide.cause}</p>

              <p class="mt-3 text-[13px] font-semibold text-text">{guide.solutionLead}</p>
              <div class="mt-2 flex flex-col gap-3">
                <For each={guide.distros}>
                  {(distro) => (
                    <div class="rounded-[12px] border border-border bg-surface-2 p-2.5">
                      <p class="text-[12px] font-semibold leading-snug text-text-2">
                        {distro.name}
                      </p>
                      <Show when={distro.note}>
                        <p class="mt-0.5 text-[11px] leading-[1.65] text-text-3">{distro.note}</p>
                      </Show>
                      <div class="mt-1.5 flex flex-col gap-2">
                        <For each={distro.commands}>{(command) => <CommandRow command={command} />}</For>
                      </div>
                    </div>
                  )}
                </For>
              </div>

              <p class="mt-3 text-[13px] font-semibold text-text">验证插件是否装好</p>
              <p class="mt-1 text-[11.5px] leading-[1.7] text-text-3">{guide.verify.lead}</p>
              <div class="mt-1.5">
                <CommandRow command={{ cmd: guide.verify.cmd, note: "" }} />
              </div>
              <p class="mt-1.5 px-1 text-[11px] leading-[1.65] text-text-3">
                {guide.verify.expect}
              </p>

              <ul class="mt-3 space-y-1.5 border-t border-border pt-3">
                <For each={guide.extras}>
                  {(extra) => (
                    <li class="flex gap-1.5 text-[11.5px] leading-[1.7] text-text-3">
                      <span class="flex-none text-text-3">·</span>
                      <span>{extra}</span>
                    </li>
                  )}
                </For>
              </ul>
            </div>

            <div class="flex-none border-t border-border px-4 py-3">
              <button
                class="w-full rounded-xl bg-accent px-4 py-[10px] text-[13.5px] font-semibold text-on-accent shadow-lg shadow-accent/25 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                type="button"
                onClick={props.onClose}
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

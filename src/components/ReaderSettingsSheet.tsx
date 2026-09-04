/**
 * 阅读设置底部抽屉（入口：阅读菜单顶栏的齿轮按钮）：
 * 调整阅读页底部状态栏的显示（开/关）与进度百分比口径（整本书 / 当前章节）。
 * 状态栏本体渲染在 Reader.tsx 阅读区底部，此处只改全局偏好。
 */
import { For, Show, type JSX } from "solid-js";
import {
  currentProgressScope,
  currentStatusBarEnabled,
  setProgressScope,
  setStatusBarEnabled,
  type ProgressScope,
} from "../lib/store";
import { CloseIcon, RefreshIcon, SettingsIcon } from "./icons";

export interface ReaderSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  /** 在线书「重新加载本章」：提供即在设置中显示该入口（下载进行中时 disabled） */
  onlineReload?: {
    disabled: boolean;
    onReload: () => void;
  };
}

/** iOS 风格小开关（勿命名 Switch：与 Solid 内置流程组件重名会被编译器接管） */
function ToggleSwitch(props: { on: boolean; label: string; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      class="relative h-[26px] w-[46px] flex-none cursor-pointer rounded-full transition-colors duration-150"
      classList={{ "bg-accent": props.on, "bg-text-3/40": !props.on }}
      onClick={props.onChange}
    >
      <span
        class="absolute top-[3px] h-5 w-5 rounded-full bg-surface shadow-md shadow-black/20 transition-[left] duration-150"
        style={{ left: props.on ? "23px" : "3px" }}
      />
    </button>
  );
}

const SCOPE_OPTIONS: { value: ProgressScope; label: string }[] = [
  { value: "book", label: "整本书" },
  { value: "chapter", label: "当前章节" },
];

function Card(props: { children: JSX.Element }) {
  return (
    <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-bg">
      {props.children}
    </div>
  );
}

export function ReaderSettingsSheet(props: ReaderSettingsSheetProps) {
  return (
    <Show when={props.open}>
      <div
        data-reader-ui
        class="absolute inset-0 z-50 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
        onClick={props.onClose}
      />
      <div
        data-reader-ui
        class="absolute inset-x-0 bottom-0 z-[51] flex max-h-[70%] animate-sheet-up select-none flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
        role="dialog"
        aria-label="阅读设置"
      >
        <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
          <SettingsIcon size={19} class="text-accent" />
          <span class="text-[15px] font-bold">阅读设置</span>
          <span class="flex-1" />
          <button
            class="grid h-10 w-10 flex-none cursor-pointer place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label="关闭阅读设置"
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(20px+env(safe-area-inset-bottom))] pt-3 scrollbar-none">
          <Card>
            <div class="flex w-full items-center gap-3 px-4 py-[13px] text-left">
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">底部状态栏</span>
                <span class="text-[11.5px] text-text-3">
                  阅读时在正文底部常驻显示章节名与阅读进度
                </span>
              </span>
              <ToggleSwitch
                on={currentStatusBarEnabled()}
                label="底部状态栏"
                onChange={() => setStatusBarEnabled(!currentStatusBarEnabled())}
              />
            </div>
            <div class="flex w-full items-center gap-3 px-4 py-[13px] text-left">
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">进度百分比口径</span>
                <span class="text-[11.5px] text-text-3">状态栏百分比按哪个范围统计</span>
              </span>
              <div
                class="flex flex-none gap-0.5 rounded-[10px] bg-surface-2 p-[3px]"
                role="radiogroup"
                aria-label="进度百分比口径"
              >
                <For each={SCOPE_OPTIONS}>
                  {(opt) => {
                    const active = () => currentProgressScope() === opt.value;
                    return (
                      <button
                        role="radio"
                        aria-checked={active()}
                        class="cursor-pointer whitespace-nowrap rounded-lg px-[11px] py-[7px] text-[12.5px] text-text-2 transition-all duration-150"
                        classList={{
                          "bg-surface font-semibold text-text shadow-sm shadow-black/15":
                            active(),
                        }}
                        onClick={() => setProgressScope(opt.value)}
                      >
                        {opt.label}
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>
          </Card>

          {/* 在线书：强制重新获取当前章节正文 */}
          <Show when={props.onlineReload}>
            <div class="mt-3">
              <Card>
                <button
                  type="button"
                  class="flex w-full items-center gap-3 px-4 py-[13px] text-left transition-[background-color,opacity] duration-150 disabled:pointer-events-none disabled:opacity-45 active:bg-surface-2"
                  disabled={props.onlineReload?.disabled}
                  onClick={() => props.onlineReload?.onReload()}
                >
                  <span class="grid h-9 w-9 flex-none place-items-center rounded-[10px] bg-surface-2 text-accent">
                    <RefreshIcon size={18} />
                  </span>
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="text-[14.5px] font-medium">重新加载本章</span>
                    <span class="text-[11.5px] text-text-3">
                      <Show
                        when={!props.onlineReload?.disabled}
                        fallback="有章节下载进行中，完成后可重新加载"
                      >
                        从书源重新获取当前章节正文
                      </Show>
                    </span>
                  </span>
                </button>
              </Card>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}

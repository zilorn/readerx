/**
 * 阅读设置底部抽屉（入口：阅读菜单顶栏的齿轮按钮）：
 * - 顶部为与「设置」页共用的阅读设置（正文字号 / 段落间距 / 翻页方式），
 *   由 ReadingSettingsRows 提供，改动一处两处同步；
 * - 下方调整阅读页底部状态栏的显示（开/关）与进度百分比口径（整本书 / 当前章节）。
 * 状态栏本体渲染在 Reader.tsx 阅读区底部，此处只改全局偏好。
 */
import { For, Show, type JSX } from "solid-js";
import {
  currentMenuSliderEnabled,
  currentMenuSliderNodes,
  currentProgressScope,
  currentStatusBarEnabled,
  setMenuSliderEnabled,
  setMenuSliderNodes,
  setProgressScope,
  setStatusBarEnabled,
  type ProgressScope,
} from "../lib/store";
import {
  ChevronRightIcon,
  CloseIcon,
  RefreshIcon,
  ReplaceIcon,
  SettingsIcon,
} from "./icons";
import { ReadingSettingsRows } from "./ReadingSettingsRows";
import { ToggleSwitch } from "./ToggleSwitch";
import { ScrollArea } from "./ScrollArea";

export interface ReaderSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  /** 打开文本替换抽屉（列出本书可用替换并支持增删改） */
  onOpenReplace: () => void;
  /** 在线书「重新加载本章」：提供即在设置中显示该入口（下载进行中时 disabled） */
  onlineReload?: {
    disabled: boolean;
    onReload: () => void;
  };
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

        <ScrollArea class="min-h-0 flex-1" contentClass="px-4 pb-[calc(20px+env(safe-area-inset-bottom))] pt-3">
          {/* 与「设置」页共用的阅读设置（字号 / 段落间距 / 翻页方式） */}
          <Card>
            <ReadingSettingsRows />
          </Card>

          <div class="mt-3">
            <Card>
              <button
                type="button"
                class="flex w-full items-center gap-3 px-4 py-[13px] text-left transition-colors active:bg-surface-2"
                onClick={props.onOpenReplace}
              >
                <span class="grid h-9 w-9 flex-none place-items-center rounded-[10px] bg-surface-2 text-accent">
                  <ReplaceIcon size={18} />
                </span>
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="text-[14.5px] font-medium">文本替换</span>
                  <span class="text-[11.5px] text-text-3">
                    替换阅读正文，不改动原文文件
                  </span>
                </span>
                <ChevronRightIcon size={17} class="flex-none text-text-3" />
              </button>
            </Card>
          </div>

          <div class="mt-3">
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
              <div class="flex w-full items-center gap-3 px-4 py-[13px] text-left">
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="text-[14.5px] font-medium">菜单进度条</span>
                  <span class="text-[11.5px] text-text-3">
                    左右翻页时在菜单上方显示，可拖动跳转页数
                  </span>
                </span>
                <ToggleSwitch
                  on={currentMenuSliderEnabled()}
                  label="菜单进度条"
                  onChange={() => setMenuSliderEnabled(!currentMenuSliderEnabled())}
                />
              </div>
              <div class="flex w-full items-center gap-3 px-4 py-[13px] text-left">
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="text-[14.5px] font-medium">逐页刻度</span>
                  <span class="text-[11.5px] text-text-3">
                    菜单进度条上按页数等分显示灰色圆点
                  </span>
                </span>
                <ToggleSwitch
                  on={currentMenuSliderNodes()}
                  label="逐页刻度"
                  onChange={() => setMenuSliderNodes(!currentMenuSliderNodes())}
                />
              </div>
            </Card>
          </div>

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
        </ScrollArea>
      </div>
    </Show>
  );
}

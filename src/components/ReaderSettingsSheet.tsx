/**
 * 阅读设置底部抽屉（入口：阅读菜单顶栏的齿轮按钮）：
 * - 顶部为与「设置」页共用的阅读设置（正文字号 / 段落间距 / 翻页方式），
 *   由 ReadingSettingsRows 提供，改动一处两处同步；
 * - 下方调整阅读页底部状态栏的显示（开/关）与进度百分比口径（整本书 / 当前章节）。
 * 状态栏本体渲染在 Reader.tsx 阅读区底部，此处只改全局偏好。
 */
import { For, Show, type JSX } from "solid-js";
import { t, type MessageKey } from "../lib/i18n";
import {
  currentMenuSliderEnabled,
  currentProgressScope,
  currentStatusBarEnabled,
  setMenuSliderEnabled,
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
  UpdateIcon,
} from "./icons";
import { ReadingSettingsRows } from "./ReadingSettingsRows";
import { ToggleSwitch } from "./ToggleSwitch";
import { ScrollArea } from "./ScrollArea";

export interface ReaderSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  /** 打开文本替换抽屉（列出本书可用替换并支持增删改） */
  onOpenReplace: () => void;
  /** 在线书「重新加载本章」：提供即在设置中显示该入口（本章正在重新加载时 disabled） */
  onlineReload?: {
    disabled: boolean;
    /** 正在重新获取本章正文（图标旋转、文案切换） */
    busy: boolean;
    onReload: () => void;
  };
  /** 在线书「检查书籍更新」：提供即在设置中显示该入口（正在检查时 disabled；章节下载不阻塞它） */
  onlineUpdate?: {
    disabled: boolean;
    /** 正在执行目录检查（图标旋转、文案切换） */
    busy: boolean;
    onCheck: () => void;
  };
}

const SCOPE_OPTIONS: { value: ProgressScope; labelKey: MessageKey }[] = [
  { value: "book", labelKey: "readerChrome.settings.scopeBook" },
  { value: "chapter", labelKey: "readerChrome.settings.scopeChapter" },
];

function Card(props: { children: JSX.Element }) {
  return (
    <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-bg">
      {props.children}
    </div>
  );
}

/** 在线书操作行（检查更新 / 重新加载本章共用版式） */
function OnlineActionRow(props: {
  icon: JSX.Element;
  title: string;
  desc: string;
  disabled?: boolean;
  /** busy：图标转圈，提示文案切为 busyLabel */
  busy?: boolean;
  busyLabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class="flex w-full items-center gap-3 px-4 py-[13px] text-left transition-[background-color,opacity] duration-150 disabled:pointer-events-none disabled:opacity-45 active:bg-surface-2"
      disabled={props.disabled}
      onClick={props.onClick}
      aria-busy={props.busy ? "true" : undefined}
    >
      <span class="grid h-9 w-9 flex-none place-items-center rounded-[10px] bg-surface-2 text-accent">
        <Show when={props.busy} fallback={props.icon}>
          <RefreshIcon size={18} class="animate-spin" />
        </Show>
      </span>
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-[14.5px] font-medium">{props.title}</span>
        <span class="text-[11.5px] text-text-3">
          {props.busy && props.busyLabel ? props.busyLabel : props.desc}
        </span>
      </span>
    </button>
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
        aria-label={t("readerChrome.settings.title")}
      >
        <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
          <SettingsIcon size={19} class="text-accent" />
          <span class="text-[15px] font-bold">{t("readerChrome.settings.title")}</span>
          <span class="flex-1" />
          <button
            class="grid h-10 w-10 flex-none cursor-pointer place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label={t("readerChrome.settings.closeLabel")}
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
                  <span class="text-[14.5px] font-medium">
                    {t("readerChrome.settings.textReplace")}
                  </span>
                  <span class="text-[11.5px] text-text-3">
                    {t("readerChrome.settings.textReplaceDesc")}
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
                  <span class="text-[14.5px] font-medium">
                    {t("readerChrome.settings.statusBar")}
                  </span>
                  <span class="text-[11.5px] text-text-3">
                    {t("readerChrome.settings.statusBarDesc")}
                  </span>
                </span>
                <ToggleSwitch
                  on={currentStatusBarEnabled()}
                  label={t("readerChrome.settings.statusBar")}
                  onChange={() => setStatusBarEnabled(!currentStatusBarEnabled())}
                />
              </div>
              <div class="flex w-full items-center gap-3 px-4 py-[13px] text-left">
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="text-[14.5px] font-medium">
                    {t("readerChrome.settings.progressScope")}
                  </span>
                  <span class="text-[11.5px] text-text-3">
                    {t("readerChrome.settings.progressScopeDesc")}
                  </span>
                </span>
                <div
                  class="flex flex-none gap-0.5 rounded-[10px] bg-surface-2 p-[3px]"
                  role="radiogroup"
                  aria-label={t("readerChrome.settings.progressScope")}
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
                          {t(opt.labelKey)}
                        </button>
                      );
                    }}
                  </For>
                </div>
              </div>
              <div class="flex w-full items-center gap-3 px-4 py-[13px] text-left">
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="text-[14.5px] font-medium">
                    {t("readerChrome.settings.menuSlider")}
                  </span>
                  <span class="text-[11.5px] text-text-3">
                    {t("readerChrome.settings.menuSliderDesc")}
                  </span>
                </span>
                <ToggleSwitch
                  on={currentMenuSliderEnabled()}
                  label={t("readerChrome.settings.menuSlider")}
                  onChange={() => setMenuSliderEnabled(!currentMenuSliderEnabled())}
                />
              </div>
            </Card>
          </div>

          {/* 在线书：检查书籍更新 / 强制重新获取当前章节正文 */}
          <Show when={props.onlineReload || props.onlineUpdate}>
            <div class="mt-3">
              <Card>
                <Show when={props.onlineUpdate}>
                  <OnlineActionRow
                    icon={<UpdateIcon size={18} />}
                    title={t("readerChrome.settings.checkUpdate")}
                    desc={t("readerChrome.settings.checkUpdateDesc")}
                    disabled={props.onlineUpdate?.disabled}
                    busy={props.onlineUpdate?.busy}
                    busyLabel={t("readerChrome.settings.checkUpdateBusy")}
                    onClick={() => props.onlineUpdate?.onCheck()}
                  />
                </Show>
                <Show when={props.onlineReload}>
                  <OnlineActionRow
                    icon={<RefreshIcon size={18} />}
                    title={t("readerChrome.settings.reloadChapter")}
                    desc={
                      props.onlineReload?.disabled
                        ? t("readerChrome.settings.reloadChapterBusyDesc")
                        : t("readerChrome.settings.reloadChapterDesc")
                    }
                    disabled={props.onlineReload?.disabled}
                    busy={props.onlineReload?.busy}
                    busyLabel={t("readerChrome.settings.reloadChapterBusy")}
                    onClick={() => props.onlineReload?.onReload()}
                  />
                </Show>
              </Card>
            </div>
          </Show>
        </ScrollArea>
      </div>
    </Show>
  );
}

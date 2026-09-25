/**
 * 「确认导入」弹层（文件 / 粘贴 / 网址三条导入路径共用）：
 * - 顶部列出本次会新增与覆盖的数量，底部「仍要导入」才真正写盘；
 * - 与本机重复（同名 · 同站点）的书源可逐条关掉覆盖，保留本机版本；
 * - 导入内容携带的分组可整体关掉（关掉后新导书源落未分组、覆盖项保留本机分组）；
 * - 免责声明随内容一起展示：书源 JS 在本地沙箱运行，安全性由导入者自行判断。
 */
import { For, Show } from "solid-js";
import { CloseIcon, FolderIcon } from "./icons";
import { ScrollArea } from "./ScrollArea";
import { ToggleSwitch } from "./ToggleSwitch";
import type { ImportPlan } from "../lib/bookSources";
import { t } from "../lib/i18n";

interface SourceImportConfirmSheetProps {
  plan: ImportPlan;
  /** 被关掉覆盖的覆盖项下标（默认全部覆盖） */
  skipped: ReadonlySet<number>;
  /** 是否按导入内容里的分组名归组 */
  importGroups: boolean;
  onToggleOverwrite: (index: number) => void;
  onToggleImportGroups: () => void;
  onApply: () => void;
  onClose: () => void;
  /** 提供后底部显示「继续粘贴导入」：换一份内容重新解析（关闭当前计划） */
  onPasteImport?: () => void;
}

/** 去掉协议与末尾斜杠的站点缩写，覆盖行里展示 */
function siteLabel(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function SourceImportConfirmSheet(props: SourceImportConfirmSheetProps) {
  /** 实际会执行的覆盖数（扣除被关掉的项） */
  const activeOverwriteCount = () =>
    props.plan.overwrite.length - props.skipped.size;

  const willImport = () =>
    props.plan.create.length + activeOverwriteCount() > 0;

  return (
    <div class="fixed inset-0 z-50" role="dialog" aria-label={t("sourceEditor.import.ariaLabel")}>
      <div
        class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
        onClick={props.onClose}
      />
      <div class="absolute inset-x-0 bottom-0 z-[51] flex max-h-[78%] animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]">
        <div class="flex flex-none items-center gap-2 border-b border-border px-4 py-3">
          <span class="text-[15px] font-bold">{t("sourceEditor.import.title")}</span>
          <span class="flex-1 text-xs text-text-3">
            {t("sourceEditor.import.summary", {
              create: props.plan.create.length,
              overwrite: activeOverwriteCount(),
            })}
          </span>
          <button
            class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label={t("common.close")}
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <ScrollArea class="min-h-0 flex-1" contentClass="space-y-2.5 px-4 py-4">
          <p class="rounded-[12px] bg-surface-2 px-3.5 py-3 text-[12px] leading-[1.7] text-text-2">
            {t("sourceEditor.import.disclaimer")}
          </p>
          <Show when={props.plan.issues.length > 0}>
            <p class="rounded-[10px] bg-danger-weak px-3 py-2 text-[11.5px] leading-[1.5] text-danger">
              {t("sourceEditor.import.skipped", {
                count: props.plan.issues.length,
                items: props.plan.issues
                  .slice(0, 3)
                  .map((i) => `#${i.index} ${i.message}`)
                  .join(t("sourceEditor.import.issueSeparator")),
              })}
            </p>
          </Show>
          {/* 与本机重复（同名 + 同站点）的书源：可逐条关闭覆盖，保留本机版本 */}
          <Show when={props.plan.overwrite.length > 0}>
            <div class="overflow-hidden rounded-[12px] border border-border bg-bg">
              <p class="border-b border-border bg-surface-2/60 px-3.5 py-2 text-[11.5px] font-semibold text-text-3">
                {t("sourceEditor.import.duplicateTitle")}
              </p>
              <div class="divide-y divide-border">
                <For each={props.plan.overwrite}>
                  {(item, index) => (
                    <div class="flex items-center gap-3 px-3.5 py-2.5">
                      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="truncate text-[13px] font-medium text-text-2">
                          {item.entry.source.name}
                        </span>
                        <span class="truncate text-[11px] text-text-3">
                          {siteLabel(item.entry.source.bookSourceUrl)}
                        </span>
                      </span>
                      <span class="flex flex-none items-center gap-2">
                        <span class="text-[11px] font-semibold tabular-nums text-text-3">
                          {props.skipped.has(index())
                            ? t("sourceEditor.import.skip")
                            : t("sourceEditor.import.overwrite")}
                        </span>
                        <ToggleSwitch
                          on={!props.skipped.has(index())}
                          label={t("sourceEditor.import.overwriteAria", {
                            name: item.entry.source.name,
                          })}
                          onChange={() => props.onToggleOverwrite(index())}
                        />
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
          {/* 导入内容携带的分组：可整体关闭（关闭后新导书源落未分组） */}
          <Show when={props.plan.groups.length > 0}>
            <div class="overflow-hidden rounded-[12px] border border-border bg-bg">
              <div class="flex items-center gap-2 border-b border-border bg-surface-2/60 px-3.5 py-2">
                <span class="flex-1 text-[11.5px] font-semibold text-text-3">
                  {t("sourceEditor.import.groupsTitle")}
                </span>
                <span class="text-[11px] font-semibold tabular-nums text-text-3">
                  {props.importGroups
                    ? t("sourceEditor.import.grouped")
                    : t("common.ungrouped")}
                </span>
                <ToggleSwitch
                  on={props.importGroups}
                  label={t("sourceEditor.import.groupToggleAria")}
                  onChange={props.onToggleImportGroups}
                />
              </div>
              <div class="divide-y divide-border">
                <For each={props.plan.groups}>
                  {(group) => (
                    <div class="flex items-center gap-2.5 px-3.5 py-2">
                      <FolderIcon size={14} class="flex-none text-text-3" />
                      <span class="min-w-0 flex-1 truncate text-[12.5px] text-text-2">
                        {group.name}
                      </span>
                      <span class="flex-none text-[11px] tabular-nums text-text-3">
                        {t("sourceEditor.import.groupCount", {
                          count: group.count,
                          state: group.existing
                            ? t("sourceEditor.import.groupExisting")
                            : t("sourceEditor.import.groupNew"),
                        })}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <button
            class="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-3 text-[14px] font-semibold text-on-accent active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
            disabled={!willImport()}
            onClick={props.onApply}
          >
            {t("sourceEditor.import.apply")}
          </button>
          <Show when={props.onPasteImport}>
            <button
              class="inline-flex w-full items-center justify-center rounded-xl bg-surface-2 px-4 py-2.5 text-[13px] font-semibold text-text-2 active:scale-[0.98]"
              onClick={props.onPasteImport}
            >
              {t("sourceEditor.import.pasteMore")}
            </button>
          </Show>
        </ScrollArea>
      </div>
    </div>
  );
}

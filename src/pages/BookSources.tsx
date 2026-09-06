import { For, Show, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import {
  ChevronRightIcon,
  CloseIcon,
  DownloadIcon,
  FileTextIcon,
  PlusIcon,
  SourceIcon,
  TrashIcon,
} from "../components/icons";
import {
  blankBookSource,
  bookSourceList,
  bookSourcesReady,
  buildBookSourceExportText,
  ensureBookSourcesLoaded,
  openSourceEditor,
  planBookSourceImport,
  refreshBookSources,
  removeBookSource,
  type ImportPlan,
} from "../lib/bookSources";
import {
  getRemoteSource,
  saveRemoteSource,
} from "../lib/backend";
import { CAPABILITY_LABELS } from "../lib/bookSourcesTypes";
import { showToast } from "../lib/toast";
import { ScrollArea } from "../components/ScrollArea";
import { ToggleSwitch } from "../components/ToggleSwitch";

/**
 * 书源管理：列表 / 新建 / 导入导出 / 删除
 */
export default function BookSourcesPage() {
  const navigate = useNavigate();
  void ensureBookSourcesLoaded();
  const [confirmPlan, setConfirmPlan] = createSignal<ImportPlan | null>(null);
  /** 导入计划中逐条选择「跳过覆盖」的覆盖项下标（默认全部覆盖） */
  const [skippedOverwrites, setSkippedOverwrites] = createSignal<ReadonlySet<number>>(
    new Set<number>(),
  );
  const [deleteId, setDeleteId] = createSignal<string | null>(null);
  let fileInput: HTMLInputElement | undefined;

  function presentImportPlan(plan: ImportPlan): void {
    setSkippedOverwrites(new Set<number>());
    setConfirmPlan(plan);
  }

  function toggleOverwrite(index: number): void {
    setSkippedOverwrites((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  /** 去掉协议与末尾斜杠的站点缩写，列表与覆盖行共用 */
  function siteLabel(url: string): string {
    return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }

  /** 当前导入计划中实际会执行的覆盖数（扣除被跳过的项） */
  const activeOverwriteCount = () => {
    const plan = confirmPlan();
    if (!plan) return 0;
    return plan.overwrite.length - skippedOverwrites().size;
  };

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/discover");
  }

  function onNew() {
    openSourceEditor(blankBookSource());
    navigate("/source-editor");
  }

  function onPickFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    void (async () => {
      const text = await file.text();
      presentImportPlan(planBookSourceImport(text));
    })();
    input.value = "";
  }

  function onPasteImport() {
    void (async () => {
      const text = await navigator.clipboard.readText().catch(() => "");
      if (!text) {
        showToast("剪贴板没有可导入的内容", true);
        return;
      }
      presentImportPlan(planBookSourceImport(text));
    })();
  }

  async function applyImport() {
    const plan = confirmPlan();
    if (!plan) return;
    const skipped = skippedOverwrites();
    let created = 0;
    let overwritten = 0;
    let kept = 0;
    try {
      for (const source of plan.create) {
        await saveRemoteSource(source);
        created++;
      }
      for (const [index, item] of plan.overwrite.entries()) {
        if (skipped.has(index)) {
          kept++;
          continue;
        }
        await saveRemoteSource(item.source);
        overwritten++;
      }
      const keptText = kept > 0 ? `，保留本机 ${kept} 个` : "";
      showToast(`导入完成：新增 ${created} 个，覆盖 ${overwritten} 个${keptText}`);
    } catch (err) {
      showToast(String(err), true);
    }
    setConfirmPlan(null);
    setSkippedOverwrites(new Set<number>());
    // 导入是直接写盘：重拉清单让新增 / 覆盖立即在列表与「发现」页生效
    await refreshBookSources();
  }

  function closeImportPlan(): void {
    setConfirmPlan(null);
    setSkippedOverwrites(new Set<number>());
  }

  async function onDelete(id: string) {
    try {
      await removeBookSource(id);
      showToast("书源已删除");
    } catch (err) {
      showToast(String(err), true);
    }
    setDeleteId(null);
  }

  async function onToggle(id: string, enabled: boolean) {
    const source = await getRemoteSource(id);
    if (!source) return;
    source.enabled = enabled;
    await saveRemoteSource(source);
    // 启停是直接写盘：重拉清单让状态立即在列表与「发现」页生效
    await refreshBookSources();
  }

  async function copyExport(id: string) {
    const source = await getRemoteSource(id);
    if (!source) return;
    const text = buildBookSourceExportText([source]);
    await navigator.clipboard.writeText(text).catch(() => undefined);
    showToast("书源 JSON 已复制");
  }

  return (
    <div class="page">
      <PageHeader
        title="书源管理"
        onBack={goBack}
        right={
          <div class="flex flex-none items-center gap-1">
            <button
              class="grid h-10 w-10 place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
              aria-label="导入 JSON"
              onClick={() => fileInput?.click()}
            >
              <DownloadIcon size={21} />
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json,text/plain"
              class="hidden"
              onChange={onPickFile}
            />
            <button
              class="grid h-10 w-10 place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
              aria-label="新建书源"
              onClick={onNew}
            >
              <PlusIcon size={21} />
            </button>
          </div>
        }
      />

      <div class="px-[18px] pb-[calc(36px+env(safe-area-inset-bottom))] pt-2">
        <Show
          when={bookSourcesReady() && bookSourceList().length > 0}
          fallback={
            <div class="flex flex-col items-center gap-2 px-6 py-16 text-center text-text-3">
              <SourceIcon size={44} class="mb-1 text-text-3/70" />
              <p class="text-[15px] font-semibold text-text-2">还没有书源</p>
              <p class="mt-1 text-[12px] leading-[1.6]">
                从社区导入 JSON，或在「发现」页使用模板新建
              </p>
              <div class="mt-3 flex items-center gap-2">
                <button
                  class="inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-semibold text-on-accent active:scale-[0.97]"
                  onClick={() => fileInput?.click()}
                >
                  <DownloadIcon size={16} />
                  导入 JSON
                </button>
                <button
                  class="inline-flex items-center gap-1.5 rounded-xl bg-surface-2 px-4 py-2.5 text-[13px] font-semibold text-text-2 active:scale-[0.97]"
                  onClick={onNew}
                >
                  <PlusIcon size={16} />
                  新建
                </button>
              </div>
            </div>
          }
        >
          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <For each={bookSourceList()}>
              {(summary) => (
                <div class="flex items-center gap-3 px-4 py-[12px]">
                  <button
                    class="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
                    onClick={() => {
                      void getRemoteSource(summary.id).then((s) => {
                        if (s) {
                          openSourceEditor(s);
                          navigate("/source-editor");
                        }
                      });
                    }}
                  >
                    <span class="flex w-full items-center gap-1.5">
                      <span class="truncate text-[14.5px] font-medium">
                        {summary.name}
                      </span>
                      <span class="shrink-0 truncate text-[11px] text-text-3">
                        {summary.bookSourceUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                      </span>
                    </span>
                    <span class="flex flex-wrap items-center gap-1">
                      {(Object.keys(CAPABILITY_LABELS) as (keyof typeof CAPABILITY_LABELS)[])
                        .filter((key) => summary.capabilities[key])
                        .map((key) => (
                          <i class="not-italic rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-semibold text-text-3">
                            {CAPABILITY_LABELS[key]}
                          </i>
                        ))}
                      <span class="text-[10px] text-text-3/80">JS {summary.jsLength}</span>
                    </span>
                  </button>
                  <div class="flex flex-none flex-col items-end gap-1.5">
                    <button
                      role="switch"
                      aria-checked={summary.enabled}
                      class={`relative h-6 w-11 flex-none rounded-full transition-colors duration-150 ${
                        summary.enabled ? "bg-accent" : "bg-surface-2"
                      }`}
                      onClick={() => void onToggle(summary.id, !summary.enabled)}
                    >
                      <span
                        class={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left] duration-150 ${
                          summary.enabled ? "left-[22px]" : "left-0.5"
                        }`}
                      />
                    </button>
                    <span class="flex items-center gap-0.5">
                      <button
                        class="grid h-7 w-7 place-items-center rounded-lg text-text-3 active:bg-surface-2"
                        aria-label="复制导出 JSON"
                        onClick={() => void copyExport(summary.id)}
                      >
                        <FileTextIcon size={15} />
                      </button>
                      <button
                        class="grid h-7 w-7 place-items-center rounded-lg text-text-3 active:bg-surface-2"
                        aria-label="删除书源"
                        onClick={() => setDeleteId(summary.id)}
                      >
                        <TrashIcon size={15} />
                      </button>
                      <ChevronRightIcon size={16} class="text-text-3/80" />
                    </span>
                  </div>
                </div>
              )}
            </For>
          </div>
          <p class="mt-2.5 text-center text-[11px] leading-[1.6] text-text-3">
            已启用 {bookSourceList().filter((s) => s.enabled).length} /{" "}
            {bookSourceList().length} 个书源
          </p>
        </Show>
      </div>

      {/* 删除确认 */}
      <Show when={deleteId() !== null}>
        <div
          class="fixed inset-0 z-40 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
          onClick={() => setDeleteId(null)}
        />
        <div
          class="fixed inset-x-0 bottom-0 z-[41] mx-auto max-w-[480px] animate-sheet-up rounded-t-[16px] bg-surface px-4 pb-[calc(20px+env(safe-area-inset-bottom))] pt-4 shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
          role="dialog"
          aria-label="删除书源"
        >
          <p class="mb-1 text-center text-[15px] font-bold">删除书源？</p>
          <p class="mb-4 text-center text-[12px] leading-[1.6] text-text-3">
            已用该书源下载到本地的书籍不受影响
          </p>
          <div class="flex gap-2.5">
            <button
              class="flex-1 rounded-xl bg-surface-2 px-4 py-2.5 text-[13.5px] font-semibold text-text-2"
              onClick={() => setDeleteId(null)}
            >
              取消
            </button>
            <button
              class="flex-1 rounded-xl bg-danger px-4 py-2.5 text-[13.5px] font-semibold text-white"
              onClick={() => void onDelete(deleteId()!)}
            >
              删除
            </button>
          </div>
        </div>
      </Show>

      {/* 导入确认（含免责声明） */}
      <Show when={confirmPlan() !== null}>
        <div
          class="fixed inset-0 z-40 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
          onClick={closeImportPlan}
        />
        <div
          class="fixed inset-x-0 bottom-0 z-[41] mx-auto flex max-h-[78%] max-w-[480px] animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
          role="dialog"
          aria-label="导入书源"
        >
          <div class="flex flex-none items-center gap-2 border-b border-border px-4 py-3">
            <span class="text-[15px] font-bold">导入书源</span>
            <span class="flex-1 text-xs text-text-3">
              {confirmPlan()!.create.length} 新增 · {activeOverwriteCount()} 覆盖
            </span>
            <button
              class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 active:bg-surface-2"
              aria-label="关闭"
              onClick={closeImportPlan}
            >
              <CloseIcon />
            </button>
          </div>
          <ScrollArea
            class="min-h-0 flex-1"
            contentClass="space-y-2.5 px-4 py-4"
          >
            <p class="rounded-[12px] bg-surface-2 px-3.5 py-3 text-[12px] leading-[1.7] text-text-2">
              社区/第三方制作的书源与 ReaderX 及其作者无关，作者未参与任何书源制作。书源 JS
              会在本地沙箱执行，但作者无法保证其安全性——仅导入可信来源。
            </p>
            <Show when={confirmPlan()!.issues.length > 0}>
              <p class="rounded-[10px] bg-danger-weak px-3 py-2 text-[11.5px] leading-[1.5] text-danger">
                跳过 {confirmPlan()!.issues.length} 条无法解析的条目：
                {confirmPlan()!.issues
                  .slice(0, 3)
                  .map((i) => `#${i.index} ${i.message}`)
                  .join("；")}
              </p>
            </Show>
            {/* 与本机重复（同名 + 同站点）的书源：可逐条关闭覆盖，保留本机版本 */}
            <Show when={confirmPlan()!.overwrite.length > 0}>
              <div class="overflow-hidden rounded-[12px] border border-border bg-bg">
                <p class="border-b border-border bg-surface-2/60 px-3.5 py-2 text-[11.5px] font-semibold text-text-3">
                  与本机重复的书源（同名 · 同站点），默认用导入内容覆盖
                </p>
                <div class="divide-y divide-border">
                  <For each={confirmPlan()!.overwrite}>
                    {(item, index) => (
                      <div class="flex items-center gap-3 px-3.5 py-2.5">
                        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span class="truncate text-[13px] font-medium text-text-2">
                            {item.source.name}
                          </span>
                          <span class="truncate text-[11px] text-text-3">
                            {siteLabel(item.source.bookSourceUrl)}
                          </span>
                        </span>
                        <span class="flex flex-none items-center gap-2">
                          <span class="text-[11px] font-semibold tabular-nums text-text-3">
                            {skippedOverwrites().has(index()) ? "跳过" : "覆盖"}
                          </span>
                          <ToggleSwitch
                            on={!skippedOverwrites().has(index())}
                            label={`覆盖书源 ${item.source.name}`}
                            onChange={() => toggleOverwrite(index())}
                          />
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <button
              class="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-3 text-[14px] font-semibold text-on-accent active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
              disabled={confirmPlan()!.create.length + activeOverwriteCount() === 0}
              onClick={() => void applyImport()}
            >
              仍要导入
            </button>
            <p class="text-center text-[11px] text-text-3">
              或{" "}
              <button
                class="text-accent underline"
                onClick={() => void onPasteImport()}
              >
                从剪贴板粘贴导入
              </button>
            </p>
          </ScrollArea>
        </div>
      </Show>
    </div>
  );
}

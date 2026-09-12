import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import {
  ChevronRightIcon,
  CloseIcon,
  DownloadIcon,
  FileTextIcon,
  FolderIcon,
  LinkIcon,
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
  planBookSourceNetworkImport,
  refreshBookSources,
  removeBookSource,
  resolveImportEntryGroup,
  setBookSourceGroup,
  type ImportPlan,
} from "../lib/bookSources";
import {
  SOURCE_FILTER_ALL,
  SOURCE_FILTER_NONE,
  ensureSourceGroupsLoaded,
  filterSourcesByGroup,
  resolveSourceFilter,
  sourceGroupById,
  sourceGroupName,
} from "../lib/sourceGroups";
import { lastSourceGroupFilter, rememberSourceGroupFilter } from "../lib/store";
import {
  getRemoteSource,
  saveRemoteSource,
} from "../lib/backend";
import { CAPABILITY_LABELS } from "../lib/bookSourcesTypes";
import { showToast } from "../lib/toast";
import { ScrollArea } from "../components/ScrollArea";
import { ToggleSwitch } from "../components/ToggleSwitch";
import { SourceGroupChips, sourceGroupChips } from "../components/SourceGroupChips";
import { SourceGroupPicker } from "../components/SourceGroupPicker";
import { SourceGroupManagerSheet } from "../components/SourceGroupManager";

/**
 * 书源管理：列表 / 新建 / 导入导出 / 删除
 */
export default function BookSourcesPage() {
  const navigate = useNavigate();
  void ensureBookSourcesLoaded();
  void ensureSourceGroupsLoaded();
  const [confirmPlan, setConfirmPlan] = createSignal<ImportPlan | null>(null);
  /** 导入计划中逐条选择「跳过覆盖」的覆盖项下标（默认全部覆盖） */
  const [skippedOverwrites, setSkippedOverwrites] = createSignal<ReadonlySet<number>>(
    new Set<number>(),
  );
  /** 导入时是否按文件里的分组名归组（关闭则新导书源落未分组、覆盖项保留本机分组） */
  const [importGroups, setImportGroups] = createSignal(true);
  const [deleteId, setDeleteId] = createSignal<string | null>(null);
  /** 正在归组的书源 id / 分组管理抽屉开合 */
  const [groupPickerId, setGroupPickerId] = createSignal<string | null>(null);
  const [groupManagerOpen, setGroupManagerOpen] = createSignal(false);
  /** 网络导入（从网址拉取 JSON）：弹层开合 / 输入 / 拉取中 / 错误 */
  const [urlDialog, setUrlDialog] = createSignal(false);
  const [urlInput, setUrlInput] = createSignal("");
  const [urlBusy, setUrlBusy] = createSignal(false);
  const [urlError, setUrlError] = createSignal("");
  let fileInput: HTMLInputElement | undefined;
  let urlInputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (urlDialog()) urlInputRef?.focus();
  });

  /** 当前生效的分组筛选（分组被删 / 记忆值失效时回落「全部」） */
  const filter = (): string => resolveSourceFilter(lastSourceGroupFilter());

  /** 各筛选值下的书源数量（未分组口径与筛选口径一致） */
  const groupCounts = createMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {
      [SOURCE_FILTER_ALL]: bookSourceList().length,
      [SOURCE_FILTER_NONE]: 0,
    };
    for (const source of bookSourceList()) {
      if (!sourceGroupById(source.groupId)) {
        counts[SOURCE_FILTER_NONE] += 1;
        continue;
      }
      counts[source.groupId!] = (counts[source.groupId!] ?? 0) + 1;
    }
    return counts;
  });

  const visibleSources = createMemo(() =>
    filterSourcesByGroup(bookSourceList(), filter()),
  );

  const filterChips = createMemo(() => sourceGroupChips(groupCounts(), filter()));

  /** 文件 / 剪贴板 / 网址导入前都要先备好清单：分组名要对本机分组解析 */
  async function bootstrap(): Promise<void> {
    await Promise.all([ensureBookSourcesLoaded(), ensureSourceGroupsLoaded()]);
  }

  function presentImportPlan(plan: ImportPlan): void {
    setSkippedOverwrites(new Set<number>());
    setImportGroups(true);
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
    // 正筛在某个分组里新建时，默认就归入该分组（未分组 / 全部则不预设）
    const current = filter();
    const groupId =
      current === SOURCE_FILTER_ALL || current === SOURCE_FILTER_NONE ? undefined : current;
    openSourceEditor(blankBookSource(groupId ? { groupId } : undefined));
    navigate("/source-editor");
  }

  function onPickFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    void (async () => {
      const text = await file.text();
      await bootstrap();
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
      await bootstrap();
      presentImportPlan(planBookSourceImport(text));
    })();
  }

  function openUrlImport() {
    setUrlInput("");
    setUrlError("");
    setUrlDialog(true);
  }

  function closeUrlImport() {
    if (urlBusy()) return;
    setUrlDialog(false);
  }

  /** 从网址拉取书源 JSON → 解析 → 走统一的「确认导入」流程 */
  async function runUrlImport() {
    if (urlBusy()) return;
    const value = urlInput().trim();
    if (!value) {
      setUrlError("请输入书源 JSON 的网址");
      return;
    }
    setUrlBusy(true);
    setUrlError("");
    try {
      const plan = await planBookSourceNetworkImport(value);
      if (plan.create.length + plan.overwrite.length === 0) {
        const issue = plan.issues[0];
        setUrlError(
          issue
            ? `未识别到书源：${issue.message}`
            : "该网址内容里没有可导入的书源",
        );
        return;
      }
      setUrlDialog(false);
      presentImportPlan(plan);
    } catch (err) {
      setUrlError(err instanceof Error ? err.message : String(err));
    } finally {
      setUrlBusy(false);
    }
  }

  async function applyImport() {
    const plan = confirmPlan();
    if (!plan) return;
    const skipped = skippedOverwrites();
    const useGroups = importGroups();
    let created = 0;
    let overwritten = 0;
    let kept = 0;
    try {
      // 分组名 → 本机分组：已有同名分组直接复用，没有则新建
      for (const entry of plan.create) {
        await saveRemoteSource(resolveImportEntryGroup(entry, useGroups));
        created++;
      }
      for (const [index, item] of plan.overwrite.entries()) {
        if (skipped.has(index)) {
          kept++;
          continue;
        }
        await saveRemoteSource(resolveImportEntryGroup(item.entry, useGroups));
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

  /** 归组（null = 未分组）：走 patchBookSourceField 落盘，清单信号自动同步 */
  async function onAssignGroup(id: string, groupId: string | null) {
    try {
      if (!(await setBookSourceGroup(id, groupId))) return;
      const name = sourceGroupName(groupId);
      showToast(name ? `已归入「${name}」` : "已移出分组");
    } catch (err) {
      showToast(String(err), true);
    }
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
              aria-label="从网址导入"
              onClick={openUrlImport}
            >
              <LinkIcon size={21} />
            </button>
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
        <Show when={bookSourcesReady() && bookSourceList().length > 0}>
          <div class="-mx-[18px] px-[18px]">
            <SourceGroupChips
              chips={filterChips()}
              value={filter()}
              onSelect={(key) => rememberSourceGroupFilter(key)}
              onManage={() => setGroupManagerOpen(true)}
              manageLabel="分组管理"
            />
          </div>
        </Show>
        <Show
          when={visibleSources().length > 0}
          fallback={
            <Show
              when={bookSourcesReady() && bookSourceList().length > 0}
              fallback={
                <div class="flex flex-col items-center gap-2 px-6 py-16 text-center text-text-3">
                  <SourceIcon size={44} class="mb-1 text-text-3/70" />
                  <p class="text-[15px] font-semibold text-text-2">还没有书源</p>
                  <p class="mt-1 text-[12px] leading-[1.6]">
                    从社区导入 JSON，或在「发现」页使用模板新建
                  </p>
                  <div class="mt-3 flex flex-wrap items-center justify-center gap-2">
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
                    <button
                      class="inline-flex items-center gap-1.5 rounded-xl bg-surface-2 px-4 py-2.5 text-[13px] font-semibold text-text-2 active:scale-[0.97]"
                      onClick={openUrlImport}
                    >
                      <LinkIcon size={16} />
                      从网址导入
                    </button>
                  </div>
                </div>
              }
            >
              <p class="py-14 text-center text-[12.5px] text-text-3">
                {filter() === SOURCE_FILTER_NONE ? "没有未分组的书源" : "该分组还没有书源"}
              </p>
            </Show>
          }
        >
          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <For each={visibleSources()}>
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
                      <Show when={sourceGroupName(summary.groupId)}>
                        <i class="not-italic flex max-w-[110px] items-center gap-0.5 truncate rounded-full bg-accent-weak px-1.5 py-0.5 text-[9.5px] font-semibold text-accent">
                          <FolderIcon size={10} class="flex-none" />
                          <span class="truncate">{sourceGroupName(summary.groupId)}</span>
                        </i>
                      </Show>
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
                        classList={{ "text-accent": !!sourceGroupName(summary.groupId) }}
                        aria-label={`归入分组：${summary.name}`}
                        onClick={() => setGroupPickerId(summary.id)}
                      >
                        <FolderIcon size={15} />
                      </button>
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
            已启用 {visibleSources().filter((s) => s.enabled).length} /{" "}
            {visibleSources().length} 个书源
          </p>
        </Show>
      </div>

      {/* 归入分组 */}
      <Show when={groupPickerId() !== null}>
        <SourceGroupPicker
          value={bookSourceList().find((s) => s.id === groupPickerId())?.groupId}
          onSelect={(groupId) => void onAssignGroup(groupPickerId()!, groupId)}
          onClose={() => setGroupPickerId(null)}
        />
      </Show>

      {/* 分组管理（新建 / 重命名 / 删除 / 整组启停） */}
      <Show when={groupManagerOpen()}>
        <SourceGroupManagerSheet onClose={() => setGroupManagerOpen(false)} />
      </Show>

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

      {/* 网络导入：从网址拉取书源 JSON */}
      <Show when={urlDialog()}>
        <div
          class="fixed inset-0 z-40 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
          onClick={closeUrlImport}
        />
        <div
          class="fixed inset-x-0 bottom-0 z-[41] mx-auto max-w-[480px] animate-sheet-up rounded-t-[16px] bg-surface px-4 pb-[calc(20px+env(safe-area-inset-bottom))] pt-4 shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
          role="dialog"
          aria-label="从网址导入书源"
        >
          <p class="mb-1 text-center text-[15px] font-bold">从网址导入</p>
          <p class="mb-4 text-center text-[12px] leading-[1.6] text-text-3">
            输入指向书源 JSON（单条或数组）的网址，拉取后进入确认
          </p>
          <div class="flex items-center gap-2 rounded-[12px] border border-border bg-bg px-3 py-2.5">
            <LinkIcon size={17} class="flex-none text-text-3" />
            <input
              ref={urlInputRef}
              type="url"
              inputmode="url"
              enterkeyhint="go"
              autocapitalize="off"
              autocomplete="off"
              spellcheck={false}
              placeholder="https://example.com/book-source.json"
              class="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-text-3"
              value={urlInput()}
              onInput={(e) => setUrlInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runUrlImport();
              }}
            />
          </div>
          <Show when={urlError()}>
            <p class="mt-2 rounded-[10px] bg-danger-weak px-3 py-2 text-[12px] leading-[1.5] text-danger">
              {urlError()}
            </p>
          </Show>
          <div class="mt-4 flex gap-2.5">
            <button
              class="flex-1 rounded-xl bg-surface-2 px-4 py-2.5 text-[13.5px] font-semibold text-text-2"
              disabled={urlBusy()}
              onClick={closeUrlImport}
            >
              取消
            </button>
            <button
              class="flex-1 rounded-xl bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-on-accent disabled:pointer-events-none disabled:opacity-50"
              disabled={urlBusy()}
              onClick={() => void runUrlImport()}
            >
              {urlBusy() ? "拉取中…" : "拉取并导入"}
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
                            {item.entry.source.name}
                          </span>
                          <span class="truncate text-[11px] text-text-3">
                            {siteLabel(item.entry.source.bookSourceUrl)}
                          </span>
                        </span>
                        <span class="flex flex-none items-center gap-2">
                          <span class="text-[11px] font-semibold tabular-nums text-text-3">
                            {skippedOverwrites().has(index()) ? "跳过" : "覆盖"}
                          </span>
                          <ToggleSwitch
                            on={!skippedOverwrites().has(index())}
                            label={`覆盖书源 ${item.entry.source.name}`}
                            onChange={() => toggleOverwrite(index())}
                          />
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>
            {/* 导入内容携带的分组：可整体关闭（关闭后新导书源落未分组） */}
            <Show when={confirmPlan()!.groups.length > 0}>
              <div class="overflow-hidden rounded-[12px] border border-border bg-bg">
                <div class="flex items-center gap-2 border-b border-border bg-surface-2/60 px-3.5 py-2">
                  <span class="flex-1 text-[11.5px] font-semibold text-text-3">
                    导入内容里的分组
                  </span>
                  <span class="text-[11px] font-semibold tabular-nums text-text-3">
                    {importGroups() ? "归入分组" : "未分组"}
                  </span>
                  <ToggleSwitch
                    on={importGroups()}
                    label="按分组名导入分组"
                    onChange={() => setImportGroups(!importGroups())}
                  />
                </div>
                <div class="divide-y divide-border">
                  <For each={confirmPlan()!.groups}>
                    {(group) => (
                      <div class="flex items-center gap-2.5 px-3.5 py-2">
                        <FolderIcon size={14} class="flex-none text-text-3" />
                        <span class="min-w-0 flex-1 truncate text-[12.5px] text-text-2">
                          {group.name}
                        </span>
                        <span class="flex-none text-[11px] tabular-nums text-text-3">
                          {group.count} 个 · {group.existing ? "已有" : "新建"}
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

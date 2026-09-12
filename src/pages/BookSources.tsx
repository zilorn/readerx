import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import {
  ClipboardIcon,
  CloseIcon,
  DownloadIcon,
  LinkIcon,
  PlusIcon,
  SourceIcon,
} from "../components/icons";
import {
  blankBookSource,
  bookSourceList,
  bookSourceSummaryById,
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
  setBookSourcesEnabled,
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
import { getRemoteSource, saveRemoteSource } from "../lib/backend";
import type { BookSource } from "../lib/bookSourcesTypes";
import { showToast } from "../lib/toast";
import { SourceGroupChips, sourceGroupChips } from "../components/SourceGroupChips";
import { SourceGroupPicker } from "../components/SourceGroupPicker";
import { SourceGroupManagerSheet } from "../components/SourceGroupManager";
import { BookSourceRow } from "../components/BookSourceRow";
import { SourceSelectionBar } from "../components/SourceSelectionBar";
import { SourceImportConfirmSheet } from "../components/SourceImportConfirmSheet";
import {
  SourcePasteImportSheet,
  looksLikeSourceUrl,
  type PasteImportResult,
} from "../components/SourcePasteImportSheet";

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
  /** 粘贴导入（剪贴板 / 手输 JSON 或网址）：抽屉开合 */
  const [pasteDialog, setPasteDialog] = createSignal(false);
  /** 多选：长按书源行进入；选中项跨筛选保留，批量操作进行中忽略重复触发 */
  const [selecting, setSelecting] = createSignal(false);
  const [selectedIds, setSelectedIds] = createSignal<string[]>([]);
  const [batchBusy, setBatchBusy] = createSignal(false);
  const [batchGroupPicker, setBatchGroupPicker] = createSignal(false);
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

  // ---------------------------------------------------------------------------
  // 多选：长按行进入，页头「全选」只作用于当前筛选可见的书源，
  // 批量操作统一收口到 runBatch（跑完退出多选）。
  // ---------------------------------------------------------------------------

  /** 仍存在的选中项（书源被删掉后不计入数量） */
  function selectedSourceIds(): string[] {
    const alive = new Set(bookSourceList().map((source) => source.id));
    return selectedIds().filter((id) => alive.has(id));
  }

  const selectedCount = () => selectedSourceIds().length;

  /** 底部操作条只在有选中项时出现（0 个时不必占位） */
  const showSelectionBar = () => selecting() && selectedCount() > 0;

  /** 当前筛选可见的书源是否已全部选中（决定页头按钮是「全选」还是「取消全选」） */
  function allVisibleSelected(): boolean {
    const list = visibleSources();
    return list.length > 0 && list.every((source) => selectedIds().includes(source.id));
  }

  function toggleSelect(id: string): void {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  /** 全选 / 取消全选：只作用于当前筛选可见的书源 */
  function toggleSelectAll(): void {
    const ids = visibleSources().map((source) => source.id);
    if (ids.length === 0) return;
    setSelectedIds((prev) => {
      if (allVisibleSelected()) {
        const drop = new Set(ids);
        return prev.filter((id) => !drop.has(id));
      }
      return [...new Set([...prev, ...ids])];
    });
  }

  /** 长按行：进入多选并选中该行（已在多选中则只切换选中） */
  function enterSelect(id: string): void {
    if (!selecting()) {
      setSelecting(true);
      setBatchGroupPicker(false);
    }
    toggleSelect(id);
  }

  function cancelSelect(): void {
    setSelecting(false);
    setSelectedIds([]);
    setBatchGroupPicker(false);
  }

  /** 所选书源是否同属一个分组（同组则抽屉里预选它，否则不预选） */
  function sharedSelectedGroup(): string | null | undefined {
    const ids = selectedSourceIds();
    if (ids.length === 0) return undefined;
    const groups = ids.map((id) => bookSourceSummaryById(id)?.groupId ?? null);
    return groups.every((groupId) => groupId === groups[0]) ? groups[0] : undefined;
  }

  /** 批量操作统一收口：进行中忽略重复触发，完成后退出多选；task 返回结果文案 */
  async function runBatch(task: (ids: string[]) => Promise<string>): Promise<void> {
    if (batchBusy()) return;
    const ids = selectedSourceIds();
    if (ids.length === 0) return;
    setBatchBusy(true);
    try {
      showToast(await task(ids));
    } catch (err) {
      showToast(String(err), true);
    }
    setBatchBusy(false);
    cancelSelect();
  }

  function batchSetEnabled(enabled: boolean): void {
    void runBatch(async (ids) => {
      const changed = await setBookSourcesEnabled(ids, enabled);
      return changed > 0
        ? `已${enabled ? "启用" : "停用"} ${changed} 个书源`
        : "所选书源状态未变化";
    });
  }

  function batchAssignGroup(groupId: string | null): void {
    void runBatch(async (ids) => {
      let moved = 0;
      for (const id of ids) {
        if (await setBookSourceGroup(id, groupId)) moved += 1;
      }
      const name = sourceGroupName(groupId);
      return name ? `${moved} 个书源已归入「${name}」` : `${moved} 个书源已移出分组`;
    });
  }

  function batchExport(): void {
    void runBatch(async (ids) => {
      const fetched = await Promise.all(ids.map((id) => getRemoteSource(id)));
      const sources = fetched.filter((source): source is BookSource => source !== null);
      if (sources.length === 0) return "所选书源已不存在";
      await navigator.clipboard
        .writeText(buildBookSourceExportText(sources))
        .catch(() => undefined);
      return `已复制 ${sources.length} 个书源的 JSON`;
    });
  }

  function batchDelete(): void {
    void runBatch(async (ids) => {
      for (const id of ids) await removeBookSource(id);
      return `已删除 ${ids.length} 个书源`;
    });
  }

  /** 打开编辑器要拿整份书源（列表里只有摘要） */
  function openSource(id: string): void {
    void getRemoteSource(id).then((source) => {
      if (!source) return;
      openSourceEditor(source);
      navigate("/source-editor");
    });
  }

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

  /** 粘贴导入入口：与文件 / 网址导入并列，不必先有文件或网址 */
  function openPasteImport() {
    setConfirmPlan(null);
    setSkippedOverwrites(new Set<number>());
    void bootstrap().then(() => setPasteDialog(true));
  }

  function closePasteImport() {
    setPasteDialog(false);
  }

  /**
   * 粘贴导入的提交：内容是指向书源 JSON 的网址就走网络拉取，否则直接按 JSON 解析。
   * 两者都汇入同一条「确认导入」流程；失败原因回给抽屉就地提示。
   */
  async function submitPastedImport(text: string): Promise<PasteImportResult> {
    await bootstrap();
    try {
      const plan = looksLikeSourceUrl(text)
        ? await planBookSourceNetworkImport(text)
        : planBookSourceImport(text);
      if (plan.create.length + plan.overwrite.length === 0) {
        const issue = plan.issues[0];
        return {
          ok: false,
          message: issue
            ? `未识别到书源：${issue.message}`
            : "没有识别到可导入的书源",
        };
      }
      presentImportPlan(plan);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
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
        title={selecting() ? "选中书源" : "书源管理"}
        subtitle={selecting() ? `已选 ${selectedCount()} 个` : undefined}
        onBack={goBack}
        right={
          <div class="flex flex-none items-center gap-1">
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json,text/plain"
              class="hidden"
              onChange={onPickFile}
            />
            <Show
              when={selecting()}
              fallback={
                <>
                  <button
                    class="grid h-10 w-10 place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                    aria-label="导入 JSON"
                    onClick={() => fileInput?.click()}
                  >
                    <DownloadIcon size={21} />
                  </button>
                  <button
                    class="grid h-10 w-10 place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                    aria-label="粘贴导入"
                    onClick={openPasteImport}
                  >
                    <ClipboardIcon size={21} />
                  </button>
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
                </>
              }
            >
              <button
                class="h-10 rounded-xl px-2.5 text-[13.5px] font-medium text-accent transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2 disabled:opacity-35"
                aria-label={
                  allVisibleSelected() ? "取消全选当前筛选的书源" : "全选当前筛选的书源"
                }
                disabled={visibleSources().length === 0}
                onClick={toggleSelectAll}
              >
                {allVisibleSelected() ? "取消全选" : "全选"}
              </button>
              <button
                class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                aria-label="退出多选"
                onClick={cancelSelect}
              >
                <CloseIcon />
              </button>
            </Show>
          </div>
        }
      />

      <div
        class="px-[18px] pt-2"
        classList={{
          // 多选时给底部固定操作条让位，避免最后一行书源被遮住
          "pb-[calc(116px+env(safe-area-inset-bottom))]": showSelectionBar(),
          "pb-[calc(36px+env(safe-area-inset-bottom))]": !showSelectionBar(),
        }}
      >
        <Show when={bookSourcesReady() && bookSourceList().length > 0}>
          <div class="-mx-[18px] px-[18px]">
            <SourceGroupChips
              chips={filterChips()}
              value={filter()}
              onSelect={(key) => rememberSourceGroupFilter(key)}
              onManage={selecting() ? undefined : () => setGroupManagerOpen(true)}
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
                      onClick={openPasteImport}
                    >
                      <ClipboardIcon size={16} />
                      粘贴导入
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
          <Show when={selecting()}>
            <p class="mx-0.5 mb-1.5 mt-2.5 text-xs text-text-3">
              长按书源进入多选；点击已选书源可取消，底部可批量启停、分组、导出或删除
            </p>
          </Show>
          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <For each={visibleSources()}>
              {(summary) => (
                <BookSourceRow
                  summary={summary}
                  selectMode={selecting()}
                  selected={selectedIds().includes(summary.id)}
                  onOpen={openSource}
                  onLongPress={enterSelect}
                  onToggleSelect={toggleSelect}
                  onToggleEnabled={(id, enabled) => void onToggle(id, enabled)}
                  onAssignGroup={(id) => setGroupPickerId(id)}
                  onCopyExport={(id) => void copyExport(id)}
                  onDelete={(id) => setDeleteId(id)}
                />
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

      {/* 批量归组：把所选书源一起归入 / 移出分组 */}
      <Show when={batchGroupPicker()}>
        <SourceGroupPicker
          value={sharedSelectedGroup()}
          onSelect={(groupId) => batchAssignGroup(groupId)}
          onClose={() => setBatchGroupPicker(false)}
        />
      </Show>

      {/* 多选底部操作条 */}
      <Show when={selecting()}>
        <SourceSelectionBar
          count={selectedCount()}
          busy={batchBusy()}
          onSetEnabled={batchSetEnabled}
          onAssignGroup={() => setBatchGroupPicker(true)}
          onExport={batchExport}
          onDelete={batchDelete}
        />
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

      {/* 粘贴导入：剪贴板 / 手输 JSON 或 JSON 网址 */}
      <Show when={pasteDialog()}>
        <SourcePasteImportSheet
          detectUrl={looksLikeSourceUrl}
          onSubmit={submitPastedImport}
          onClose={closePasteImport}
        />
      </Show>

      {/* 导入确认（含免责声明） */}
      <Show when={confirmPlan()}>
        {(plan) => (
          <SourceImportConfirmSheet
            plan={plan()}
            skipped={skippedOverwrites()}
            importGroups={importGroups()}
            onToggleOverwrite={toggleOverwrite}
            onToggleImportGroups={() => setImportGroups(!importGroups())}
            onApply={() => void applyImport()}
            onClose={closeImportPlan}
            onPasteImport={openPasteImport}
          />
        )}
      </Show>
    </div>
  );
}

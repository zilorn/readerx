import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import { ToggleSwitch } from "../components/ToggleSwitch";
import { DownloadIcon, RestoreBackIcon } from "../components/icons";
import {
  backupSupported,
  exportBackup,
  importBackup,
  pickBackupArchive,
  type BackupExportResult,
  type BackupImportMode,
  type BackupImportResult,
  type BackupProgress,
  type BackupStep,
  type PickedBackup,
} from "../lib/backup";
import { reportFailure } from "../lib/errorReport";
import { t, type MessageKey } from "../lib/i18n";
import { showToast } from "../lib/toast";
import { formatBytes } from "../lib/webdav";

/** 进度里的类别 → 文案 key（模块顶层只放 key，渲染时再取文案） */
const STEP_KEYS: Record<BackupStep, MessageKey> = {
  state: "backup.step.state",
  books: "backup.step.books",
  images: "backup.step.images",
  sources: "backup.step.sources",
  sessions: "backup.step.sessions",
};

/** 归档时间（本地时区，`2026-09-26 15:04`） */
function formatDateTime(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

interface RunningProgress {
  phase: "export" | "import";
  progress: BackupProgress;
}

export default function DataBackupPage() {
  const navigate = useNavigate();
  const [includeCredentials, setIncludeCredentials] = createSignal(false);
  const [exporting, setExporting] = createSignal(false);
  const [picking, setPicking] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  const [running, setRunning] = createSignal<RunningProgress | null>(null);
  const [lastExport, setLastExport] = createSignal<BackupExportResult | null>(null);
  const [picked, setPicked] = createSignal<PickedBackup | null>(null);
  const [replaceConfirming, setReplaceConfirming] = createSignal(false);
  const [result, setResult] = createSignal<BackupImportResult | null>(null);
  let confirmTimer: number | undefined;

  onCleanup(() => window.clearTimeout(confirmTimer));

  const busy = () => exporting() || picking() || importing();

  /** 结果里只列真正发生的项（0 不展示） */
  const resultRows = createMemo(() => {
    const summary = result();
    if (!summary) return [];
    const rows: { key: MessageKey; count: number }[] = [
      { key: "backup.result.booksAdded", count: summary.booksAdded },
      { key: "backup.result.booksUpdated", count: summary.booksUpdated },
      { key: "backup.result.booksSkipped", count: summary.booksSkipped },
      { key: "backup.result.booksRemoved", count: summary.booksRemoved },
      { key: "backup.result.images", count: summary.imagesAdded },
      { key: "backup.result.sourcesAdded", count: summary.sourcesAdded },
      { key: "backup.result.sourcesUpdated", count: summary.sourcesUpdated },
      { key: "backup.result.sourcesSkipped", count: summary.sourcesSkipped },
      { key: "backup.result.sourcesRemoved", count: summary.sourcesRemoved },
      { key: "backup.result.state", count: summary.stateKeys.length },
    ];
    return rows.filter((row) => row.count > 0);
  });

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/settings");
  }

  async function onExport() {
    if (busy() || !backupSupported()) return;
    setExporting(true);
    setRunning(null);
    setLastExport(null);
    try {
      const done = await exportBackup(includeCredentials(), (progress) =>
        setRunning({ phase: "export", progress }),
      );
      if (!done) return;
      setLastExport(done);
      showToast(
        t("backup.export.done", {
          name: done.fileName,
          size: formatBytes(done.bytes),
        }),
      );
    } catch (error) {
      reportFailure(t("backup.export.failed"), error);
    } finally {
      setExporting(false);
      setRunning(null);
    }
  }

  async function onPick() {
    if (busy() || !backupSupported()) return;
    setPicking(true);
    setResult(null);
    try {
      const archive = await pickBackupArchive();
      setPicked(archive ?? null);
      setReplaceConfirming(false);
    } catch (error) {
      reportFailure(t("backup.import.readFailed"), error);
    } finally {
      setPicking(false);
    }
  }

  function dismissPicked() {
    setPicked(null);
    setReplaceConfirming(false);
  }

  /** 导入：覆盖恢复需要连点两次（第一次只是进入确认态） */
  async function onImport(mode: BackupImportMode) {
    const archive = picked();
    if (!archive || busy()) return;
    if (mode === "replace" && !replaceConfirming()) {
      setReplaceConfirming(true);
      window.clearTimeout(confirmTimer);
      confirmTimer = window.setTimeout(() => setReplaceConfirming(false), 3000);
      return;
    }
    window.clearTimeout(confirmTimer);
    setReplaceConfirming(false);
    setImporting(true);
    setRunning(null);
    try {
      const summary = await importBackup(archive.path, mode, (progress) =>
        setRunning({ phase: "import", progress }),
      );
      setResult(summary);
      setPicked(null);
      showToast(t("backup.result.title"));
    } catch (error) {
      reportFailure(t("backup.import.failed"), error);
    } finally {
      setImporting(false);
      setRunning(null);
    }
  }

  return (
    <div class="page">
      <PageHeader
        title={t("backup.title")}
        subtitle={t("backup.subtitle")}
        onBack={goBack}
      />

      <div class="px-[18px] pb-[calc(36px+env(safe-area-inset-bottom))] pt-2">
        {/* 导出 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            {t("backup.section.export")}
          </h2>
          <div class="overflow-hidden rounded-[14px] border border-border bg-surface">
            <Show
              when={backupSupported()}
              fallback={
                <p class="px-4 py-[13px] text-[12.5px] text-text-3">
                  {t("backup.appOnly")}
                </p>
              }
            >
              <div class="border-b border-border px-4 py-[13px]">
                <div class="flex items-center gap-3">
                  <span
                    class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-accent-weak text-accent"
                    aria-hidden="true"
                  >
                    <DownloadIcon size={18} />
                  </span>
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="text-[14.5px] font-medium">
                      {t("backup.export.credentials")}
                    </span>
                    <span class="text-[11.5px] text-text-3">
                      {t("backup.export.credentialsDesc")}
                    </span>
                  </span>
                  <ToggleSwitch
                    on={includeCredentials()}
                    label={t("backup.export.credentials")}
                    onChange={() => setIncludeCredentials(!includeCredentials())}
                  />
                </div>
                <p class="mt-2.5 text-[11.5px] leading-[1.6] text-text-3">
                  {t("backup.export.desc")}
                </p>
              </div>

              <div class="px-4 py-[13px]">
                <button
                  class="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-[10px] text-[13.5px] font-semibold text-on-accent shadow-lg shadow-accent/25 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90 disabled:opacity-60"
                  type="button"
                  disabled={busy()}
                  onClick={() => void onExport()}
                >
                  <DownloadIcon size={16} />
                  {exporting() ? t("backup.export.busy") : t("backup.export.action")}
                </button>
                <Show when={running()?.phase === "export" ? running() : null}>
                  {(state) => <ProgressBar state={state()} />}
                </Show>
                <Show when={lastExport()}>
                  {(done) => (
                    <p class="mt-2.5 text-[11.5px] leading-[1.6] text-text-3">
                      {t("backup.export.done", {
                        name: done().fileName,
                        size: formatBytes(done().bytes),
                      })}
                    </p>
                  )}
                </Show>
              </div>
            </Show>
          </div>
        </section>

        {/* 导入 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            {t("backup.section.import")}
          </h2>
          <div class="overflow-hidden rounded-[14px] border border-border bg-surface">
            <Show
              when={backupSupported()}
              fallback={
                <p class="px-4 py-[13px] text-[12.5px] text-text-3">
                  {t("backup.appOnly")}
                </p>
              }
            >
              <div class="border-b border-border px-4 py-[13px]">
                <button
                  class="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-bg px-4 py-[10px] text-[13.5px] font-medium text-text transition-colors active:bg-surface-2 disabled:opacity-50"
                  type="button"
                  disabled={busy()}
                  onClick={() => void onPick()}
                >
                  <RestoreBackIcon size={16} />
                  {picking() ? t("backup.import.picking") : t("backup.import.pick")}
                </button>
                <p class="mt-2.5 text-[11.5px] leading-[1.6] text-text-3">
                  {t("backup.import.desc")}
                </p>
              </div>

              {/* 选中备份后的预览 + 两种导入方式 */}
              <Show when={picked()}>
                {(archive) => (
                  <div class="border-b border-border px-4 py-[13px]">
                    <p class="text-[13.5px] font-semibold">
                      {t("backup.preview.title")}
                    </p>
                    <div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-text-3">
                      <span>
                        {t("backup.preview.books", {
                          count: archive().preview.books,
                        })}
                      </span>
                      <Show when={archive().preview.images > 0}>
                        <span>
                          {t("backup.preview.images", {
                            count: archive().preview.images,
                          })}
                        </span>
                      </Show>
                      <span>
                        {t("backup.preview.sources", {
                          count: archive().preview.sources,
                        })}
                      </span>
                      <Show when={archive().preview.bytes > 0}>
                        <span>
                          {t("backup.preview.size", {
                            size: formatBytes(archive().preview.bytes),
                          })}
                        </span>
                      </Show>
                      <Show when={archive().preview.createdAt > 0}>
                        <span>
                          {t("backup.preview.time", {
                            time: formatDateTime(archive().preview.createdAt),
                          })}
                        </span>
                      </Show>
                    </div>
                    <Show when={archive().preview.credentials}>
                      <p class="mt-2 text-[11.5px] leading-[1.6] text-text-2">
                        {t("backup.preview.credentials")}
                      </p>
                    </Show>

                    <div class="mt-3 flex flex-col gap-2">
                      <button
                        class="w-full rounded-xl bg-accent px-4 py-[10px] text-[13.5px] font-semibold text-on-accent shadow-lg shadow-accent/25 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90 disabled:opacity-60"
                        type="button"
                        disabled={busy()}
                        onClick={() => void onImport("merge")}
                      >
                        {t("backup.mode.merge")}
                      </button>
                      <p class="text-[11.5px] leading-[1.6] text-text-3">
                        {t("backup.mode.mergeDesc")}
                      </p>
                      <button
                        class="w-full rounded-xl border border-border bg-bg px-4 py-[10px] text-[13.5px] font-medium transition-colors active:bg-surface-2 disabled:opacity-50"
                        classList={{
                          "border-danger text-danger": replaceConfirming(),
                          "text-text-2": !replaceConfirming(),
                        }}
                        type="button"
                        disabled={busy()}
                        onClick={() => void onImport("replace")}
                      >
                        {replaceConfirming()
                          ? t("backup.mode.replaceConfirm")
                          : t("backup.mode.replace")}
                      </button>
                      <p class="text-[11.5px] leading-[1.6] text-text-3">
                        {t("backup.mode.replaceDesc")}
                      </p>
                      <button
                        class="w-full rounded-xl px-4 py-[8px] text-[13px] text-text-3 transition-colors active:bg-surface-2 disabled:opacity-50"
                        type="button"
                        disabled={busy()}
                        onClick={dismissPicked}
                      >
                        {t("backup.preview.dismiss")}
                      </button>
                    </div>
                  </div>
                )}
              </Show>

              <Show when={running()?.phase === "import" ? running() : null}>
                {(state) => (
                  <div class="px-4 py-[13px]">
                    <ProgressBar state={state()} />
                  </div>
                )}
              </Show>

              {/* 导入结果 */}
              <Show when={resultRows().length > 0}>
                <div class="px-4 py-[13px]">
                  <p class="text-[13.5px] font-semibold">
                    {t("backup.result.title")}
                  </p>
                  <div class="mt-1.5 flex flex-col gap-1 text-[11.5px] leading-[1.6] text-text-3">
                    <For each={resultRows()}>
                      {(row) => <span>{t(row.key, { count: row.count })}</span>}
                    </For>
                  </div>
                </div>
              </Show>
            </Show>
          </div>
        </section>
      </div>
    </div>
  );
}

function ProgressBar(props: { state: RunningProgress }) {
  const percent = () => {
    const { done, total } = props.state.progress;
    if (total <= 0) return 0;
    return Math.min(100, Math.round((done / total) * 100));
  };
  const label = () => {
    const phase = props.state.phase === "export" ? "backup.progress.exporting" : "backup.progress.importing";
    return t(phase, {
      step: t(STEP_KEYS[props.state.progress.step]),
      done: props.state.progress.done,
      total: props.state.progress.total,
    });
  };
  return (
    <div class="mt-2.5">
      <p class="text-[11.5px] text-text-3">{label()}</p>
      <div
        class="mt-1 h-[6px] overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuenow={percent()}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          class="h-full rounded-full bg-accent transition-[width] duration-150"
          style={{ width: `${percent()}%` }}
        />
      </div>
    </div>
  );
}

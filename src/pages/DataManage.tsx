import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { useNavigate } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import {
  CheckIcon,
  ChevronRightIcon,
  HeadphonesIcon,
  PackageIcon,
  TrashIcon,
} from "../components/icons";
import { bookDisplayTitle } from "../lib/bookDisplay";
import { bookMetaById, ensureLocalBooksLoaded } from "../lib/books";
import { reportFailure } from "../lib/errorReport";
import { hanText } from "../lib/hanDisplay";
import { t, type MessageKey } from "../lib/i18n";
import { createAndroidBackHandler } from "../lib/androidBack";
import { resetReadingProgress } from "../lib/store";
import {
  CLEANUP_KINDS,
  cleanupStorage,
  loadStorageUsage,
  type BookStorage,
  type CleanupKind,
  type StorageReport,
} from "../lib/storageUsage";
import { showToast } from "../lib/toast";
import { noteTranslationsCleared } from "../lib/translation/engine";
import { translatedBookTitle } from "../lib/translation/title";
import { formatBytes } from "../lib/webdav";

const UNSCOPED = "__unscoped__";

const CATEGORY_KEYS: Record<string, MessageKey> = {
  library: "settings.data.category.library",
  images: "settings.data.category.images",
  tts: "settings.data.category.tts",
  sources: "settings.data.category.sources",
  sync: "settings.data.category.sync",
  logs: "settings.data.category.logs",
  state: "settings.data.category.state",
  migrated: "settings.data.category.migrated",
  other: "settings.data.category.other",
};

const KIND_KEYS: Record<CleanupKind, MessageKey> = {
  images: "settings.data.kind.images",
  tts: "settings.data.kind.tts",
  translation: "settings.data.kind.translation",
  migrated: "settings.data.kind.migrated",
};

function formatSize(bytes: number): string {
  if (bytes <= 0) return t("settings.data.zero");
  return formatBytes(bytes) || t("settings.data.zero");
}

function bookLabel(id: string): string {
  const meta = bookMetaById(id);
  if (!meta) return id;
  return hanText(translatedBookTitle(meta) || bookDisplayTitle(meta.title));
}

function bookParts(book: BookStorage): string {
  const parts: string[] = [];
  if (book.contentBytes > 0) {
    parts.push(t("settings.data.bookContent", { size: formatSize(book.contentBytes) }));
  }
  if (book.imagesBytes > 0) {
    parts.push(t("settings.data.bookImages", { size: formatSize(book.imagesBytes) }));
  }
  if (book.ttsBytes > 0) {
    parts.push(t("settings.data.bookTts", { size: formatSize(book.ttsBytes) }));
  }
  if (book.translationBytes > 0) {
    parts.push(t("settings.data.bookTranslation", { size: formatSize(book.translationBytes) }));
  }
  if (book.migratedBytes > 0) {
    parts.push(t("settings.data.bookMigrated", { size: formatSize(book.migratedBytes) }));
  }
  return parts.join(t("settings.data.listSeparator"));
}

function releasableBytes(book: BookStorage, kinds: ReadonlySet<string>): number {
  let total = 0;
  if (kinds.has("images")) total += book.imagesExclusiveBytes;
  if (kinds.has("tts")) total += book.ttsBytes;
  if (kinds.has("translation")) total += book.translationBytes;
  if (kinds.has("migrated")) total += book.migratedBytes;
  return total;
}

function ConfirmModal(props: {
  title: string;
  label: string;
  confirm: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children: import("solid-js").JSX.Element;
}) {
  return (
    <Portal>
      <div
        class="fixed inset-0 z-[85] grid place-items-center px-8"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
      >
        <div
          class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
          onClick={() => {
            if (!props.busy) props.onCancel();
          }}
        />
        <div class="relative w-full max-w-[340px] animate-pop-in overflow-hidden rounded-[18px] border border-border bg-surface p-4 shadow-[0_18px_50px_rgb(0_0_0/0.3)]">
          <p class="text-[15px] font-bold leading-snug">{props.title}</p>
          <div class="mt-2 space-y-2 text-[12.5px] leading-[1.7] text-text-2">{props.children}</div>
          <div class="mt-3.5 flex items-center gap-2.5">
            <button
              class="flex-1 rounded-xl border border-border bg-bg px-4 py-[10px] text-[13.5px] font-medium text-text-2 transition-colors active:bg-surface-2 disabled:opacity-40"
              type="button"
              disabled={props.busy}
              onClick={props.onCancel}
            >
              {t("common.cancel")}
            </button>
            <button
              class="flex-1 rounded-xl bg-danger px-4 py-[10px] text-[13.5px] font-semibold text-white transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90 disabled:opacity-40"
              type="button"
              disabled={props.busy}
              onClick={props.onConfirm}
            >
              {props.confirm}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

export default function DataManagePage() {
  const navigate = useNavigate();
  const [report, setReport] = createSignal<StorageReport | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [kinds, setKinds] = createSignal<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [resetOpen, setResetOpen] = createSignal(false);

  createAndroidBackHandler(
    () => confirmOpen() || resetOpen(),
    () => {
      setConfirmOpen(false);
      setResetOpen(false);
    },
  );

  createEffect(() => {
    if (!confirmOpen() && !resetOpen()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy()) return;
      setConfirmOpen(false);
      setResetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/settings");
  }

  const unscopedVisible = (value: StorageReport) =>
    value.unscoped.imagesBytes > 0 || value.unscoped.migratedBytes > 0;

  const rowIds = createMemo(() => {
    const current = report();
    if (!current) return [] as string[];
    const ids = current.books.map((book) => book.bookId);
    if (unscopedVisible(current)) ids.push(UNSCOPED);
    return ids;
  });

  async function refresh() {
    setLoading(true);
    try {
      await ensureLocalBooksLoaded();
      const next = await loadStorageUsage();
      setReport(next);
      const alive = new Set(next.books.map((book) => book.bookId));
      if (unscopedVisible(next)) alive.add(UNSCOPED);
      setSelected((prev) => {
        const kept = new Set([...prev].filter((id) => alive.has(id)));
        return kept.size === prev.size ? prev : kept;
      });
    } catch (error) {
      reportFailure(t("settings.data.loadFailed"), error);
    } finally {
      setLoading(false);
    }
  }

  onMount(() => {
    void refresh();
  });

  function toggleKind(kind: CleanupKind) {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(rowIds()));
  }

  function invertSelection() {
    const ids = rowIds();
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  const selectedBooks = createMemo(
    () => report()?.books.filter((book) => selected().has(book.bookId)) ?? [],
  );

  const releaseBytes = createMemo(() => {
    const current = report();
    if (!current) return 0;
    const chosen = kinds();
    let total = selectedBooks().reduce((sum, book) => sum + releasableBytes(book, chosen), 0);
    if (selected().has(UNSCOPED)) {
      if (chosen.has("images")) total += current.unscoped.imagesBytes;
      if (chosen.has("migrated")) total += current.unscoped.migratedBytes;
    }
    return total;
  });

  const canCleanup = () => !busy() && !loading() && kinds().size > 0 && selected().size > 0 && releaseBytes() > 0;

  const kindLabel = () =>
    CLEANUP_KINDS.filter((kind) => kinds().has(kind))
      .map((kind) => t(KIND_KEYS[kind]))
      .join(t("settings.data.listSeparator"));

  const includesMigrated = () => {
    if (!kinds().has("migrated")) return false;
    if (selected().has(UNSCOPED) && (report()?.unscoped.migratedBytes ?? 0) > 0) return true;
    return selectedBooks().some((book) => book.migratedBytes > 0);
  };

  async function runCleanup() {
    if (!canCleanup()) return;
    setBusy(true);
    const chosen = [...kinds()];
    const bookIds = selectedBooks().map((book) => book.bookId);
    const includeUnscoped = selected().has(UNSCOPED);
    try {
      const result = await cleanupStorage(bookIds, chosen, includeUnscoped);
      if (chosen.includes("translation")) noteTranslationsCleared();
      setConfirmOpen(false);
      showToast(t("settings.data.cleaned", { size: formatSize(result.removedBytes) }));
      await refresh();
    } catch (error) {
      reportFailure(t("settings.data.cleanupFailed"), error);
    } finally {
      setBusy(false);
    }
  }

  function runReset() {
    resetReadingProgress();
    setResetOpen(false);
  }

  const previewBooks = () => selectedBooks().slice(0, 6);
  const extraBooks = () => Math.max(0, selectedBooks().length - previewBooks().length);

  return (
    <div class="page">
      <PageHeader title={t("settings.data.title")} subtitle={t("settings.data.subtitle")} onBack={goBack} />

      <div class="px-[18px] pb-[calc(36px+env(safe-area-inset-bottom))] pt-2">
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            {t("settings.data.usage")}
          </h2>
          <div class="overflow-hidden rounded-[14px] border border-border bg-surface">
            <Show
              when={!loading() || report()}
              fallback={<p class="px-4 py-3 text-[12.5px] text-text-3">{t("settings.data.loading")}</p>}
            >
              <Show
                when={(report()?.totalBytes ?? 0) > 0}
                fallback={<p class="px-4 py-3 text-[12.5px] text-text-3">{t("settings.data.emptyUsage")}</p>}
              >
                <div class="px-4 py-3">
                  <p class="text-[20px] font-bold tracking-[0.02em]">
                    {t("settings.data.total", { size: formatSize(report()?.totalBytes ?? 0) })}
                  </p>
                </div>
                <div class="divide-y divide-border border-t border-border">
                  <For each={report()?.categories ?? []}>
                    {(category) => {
                      const total = () => report()?.totalBytes ?? 0;
                      const width = () => (total() > 0 ? `${(category.bytes / total()) * 100}%` : "0%");
                      const label = CATEGORY_KEYS[category.id];
                      return (
                        <div class="px-4 py-3">
                          <div class="mb-1.5 flex items-baseline justify-between gap-3">
                            <span class="text-[14px] font-medium">{label ? t(label) : category.id}</span>
                            <span class="flex-none text-[12px] text-text-3">{formatSize(category.bytes)}</span>
                          </div>
                          <div class="h-1.5 overflow-hidden rounded-full bg-surface-2">
                            <div class="h-full rounded-full bg-accent" style={{ width: width() }} />
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>
                <Show when={(report()?.translationBytes ?? 0) > 0}>
                  <p class="border-t border-border px-4 py-3 text-[11.5px] leading-[1.6] text-text-3">
                    {t("settings.data.translationIncluded", {
                      size: formatSize(report()?.translationBytes ?? 0),
                    })}
                  </p>
                </Show>
              </Show>
            </Show>
          </div>
        </section>

        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            {t("settings.data.tools")}
          </h2>
          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <button
              class="flex w-full items-center gap-3 px-4 py-[13px] text-left transition-colors duration-150 active:bg-surface-2"
              type="button"
              onClick={() => navigate("/data-backup")}
            >
              <span class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-surface-2 text-text-2">
                <PackageIcon size={18} />
              </span>
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">{t("settings.data.backup")}</span>
                <span class="text-[11.5px] text-text-3">{t("settings.data.backupDesc")}</span>
              </span>
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </button>
            <button
              class="flex w-full items-center gap-3 px-4 py-[13px] text-left transition-colors duration-150 active:bg-surface-2"
              type="button"
              onClick={() => navigate("/tts-cache")}
            >
              <span class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-surface-2 text-text-2">
                <HeadphonesIcon size={18} />
              </span>
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">{t("settings.data.ttsCache")}</span>
                <span class="text-[11.5px] text-text-3">{t("settings.data.ttsCacheDesc")}</span>
              </span>
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </button>
            <button
              class="flex w-full items-center gap-3 px-4 py-[13px] text-left text-danger transition-colors duration-150 active:bg-surface-2"
              type="button"
              onClick={() => setResetOpen(true)}
            >
              <span class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-danger-weak text-danger">
                <TrashIcon size={18} />
              </span>
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">{t("settings.data.resetProgress")}</span>
                <span class="text-[11.5px] text-text-3">{t("settings.data.resetProgressDesc")}</span>
              </span>
            </button>
          </div>
        </section>

        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            {t("settings.data.cleanup")}
          </h2>
          <p class="mx-1 mb-2 text-[11.5px] leading-[1.6] text-text-3">{t("settings.data.cleanupDesc")}</p>
          <div class="mb-3 flex flex-wrap gap-2">
            <For each={CLEANUP_KINDS}>
              {(kind) => (
                <button
                  class="rounded-full px-3 py-[7px] text-[13px] transition-colors duration-150 disabled:opacity-40"
                  classList={{
                    "bg-accent font-semibold text-on-accent": kinds().has(kind),
                    "border border-border bg-surface text-text-2": !kinds().has(kind),
                  }}
                  type="button"
                  aria-pressed={kinds().has(kind)}
                  disabled={busy()}
                  onClick={() => toggleKind(kind)}
                >
                  {t(KIND_KEYS[kind])}
                </button>
              )}
            </For>
          </div>

          <Show
            when={rowIds().length > 0}
            fallback={
              <div class="overflow-hidden rounded-[14px] border border-border bg-surface px-4 py-3 text-[12.5px] text-text-3">
                {loading() ? t("settings.data.loading") : t("settings.data.emptyBooks")}
              </div>
            }
          >
            <div class="mb-2 flex items-center justify-end gap-1">
              <button
                class="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-accent disabled:opacity-40"
                type="button"
                disabled={busy()}
                onClick={selectAll}
              >
                {t("common.selectAll")}
              </button>
              <button
                class="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-accent disabled:opacity-40"
                type="button"
                disabled={busy()}
                onClick={invertSelection}
              >
                {t("settings.data.invert")}
              </button>
            </div>
            <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
              <For each={report()?.books ?? []}>
                {(book) => {
                  const on = () => selected().has(book.bookId);
                  const free = () => releasableBytes(book, kinds());
                  return (
                    <button
                      class="flex w-full items-center gap-3 px-4 py-[13px] text-left transition-colors duration-150 active:bg-surface-2 disabled:opacity-40"
                      type="button"
                      role="checkbox"
                      aria-checked={on()}
                      disabled={busy()}
                      onClick={() => toggleRow(book.bookId)}
                    >
                      <span
                        class="grid h-5 w-5 flex-none place-items-center rounded-md border"
                        classList={{
                          "border-accent bg-accent text-on-accent": on(),
                          "border-border bg-bg text-transparent": !on(),
                        }}
                      >
                        <CheckIcon size={14} />
                      </span>
                      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="truncate text-[14px] font-medium">{bookLabel(book.bookId)}</span>
                        <span class="text-[11.5px] leading-[1.5] text-text-3">{bookParts(book)}</span>
                        <Show when={kinds().size > 0 && free() > 0}>
                          <span class="text-[11.5px] text-accent">
                            {t("settings.data.releasable", { size: formatSize(free()) })}
                          </span>
                        </Show>
                      </span>
                    </button>
                  );
                }}
              </For>
              <Show when={report() && unscopedVisible(report()!)}>
                <button
                  class="flex w-full items-center gap-3 px-4 py-[13px] text-left transition-colors duration-150 active:bg-surface-2 disabled:opacity-40"
                  type="button"
                  role="checkbox"
                  aria-checked={selected().has(UNSCOPED)}
                  disabled={busy()}
                  onClick={() => toggleRow(UNSCOPED)}
                >
                  <span
                    class="grid h-5 w-5 flex-none place-items-center rounded-md border"
                    classList={{
                      "border-accent bg-accent text-on-accent": selected().has(UNSCOPED),
                      "border-border bg-bg text-transparent": !selected().has(UNSCOPED),
                    }}
                  >
                    <CheckIcon size={14} />
                  </span>
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="truncate text-[14px] font-medium">{t("settings.data.unscoped")}</span>
                    <span class="text-[11.5px] leading-[1.5] text-text-3">{t("settings.data.unscopedDesc")}</span>
                  </span>
                </button>
              </Show>
            </div>
          </Show>

          <button
            class="mt-3 w-full rounded-xl bg-danger px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-40"
            type="button"
            disabled={!canCleanup()}
            onClick={() => setConfirmOpen(true)}
          >
            {t("settings.data.cleanupAction")}
          </button>
        </section>
      </div>

      <Show when={confirmOpen()}>
        <ConfirmModal
          title={t("settings.data.confirmTitle")}
          label={t("settings.data.confirmLabel")}
          confirm={t("settings.data.confirmAction")}
          busy={busy()}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void runCleanup()}
        >
          <p>{t("settings.data.confirmBody", { count: selected().size })}</p>
          <p>{t("settings.data.confirmKinds", { kinds: kindLabel() })}</p>
          <Show when={previewBooks().length > 0}>
            <ul class="overflow-hidden rounded-[12px] bg-bg p-2.5">
              <For each={previewBooks()}>
                {(book) => <li class="truncate text-[11.5px] text-text-3">{bookLabel(book.bookId)}</li>}
              </For>
            </ul>
          </Show>
          <Show when={extraBooks() > 0}>
            <p class="text-[12px] text-text-3">{t("settings.data.moreBooks", { count: extraBooks() })}</p>
          </Show>
          <Show when={selected().has(UNSCOPED)}>
            <p>{t("settings.data.confirmUnscoped")}</p>
          </Show>
          <Show when={includesMigrated()}>
            <p>{t("settings.data.confirmMigrated")}</p>
          </Show>
          <p class="text-[12px] text-text-3">{t("settings.data.confirmKeep")}</p>
        </ConfirmModal>
      </Show>

      <Show when={resetOpen()}>
        <ConfirmModal
          title={t("settings.data.resetTitle")}
          label={t("settings.data.resetLabel")}
          confirm={t("settings.data.resetAction")}
          onCancel={() => setResetOpen(false)}
          onConfirm={runReset}
        >
          <p>{t("settings.data.resetBody")}</p>
        </ConfirmModal>
      </Show>
    </div>
  );
}

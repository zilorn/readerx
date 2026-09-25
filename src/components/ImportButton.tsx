import { createSignal, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { useNavigate } from "@solidjs/router";
import {
  ensureLocalBooksLoaded,
  findSameNameImportedBook,
  importLocalDraftAsNew,
  parseBookFile,
  replaceBookContent,
  type BookDraft,
} from "../lib/books";
import { pickBookFile } from "../lib/backend";
import { isDesktopShell } from "../lib/platform";
import type { BookMeta, LocalBook } from "../lib/booksTypes";
import {
  previewBookmarkInheritance,
  type BookmarkInheritPreview,
} from "../lib/bookmarks";
import { showToast } from "../lib/toast";
import { t } from "../lib/i18n";
import { BookmarkRiskDialog } from "./BookmarkRiskDialog";
import { closeOnRouteChange } from "../lib/keptPage";
import { ChevronRightIcon, CloseIcon, FileTextIcon, ServerIcon } from "./icons";

interface ImportButtonProps {
  class?: string;
  ariaLabel: string;
  children?: JSX.Element;
  /** 导入成功后的额外动作（默认：书已进书架，停留在当前页） */
  onImported?: (book: LocalBook) => void;
}

interface SameNameConflict {
  /** 书架中已存在的同名书（重新导入的目标；元数据即可，正文整本被新草稿替换） */
  existing: BookMeta;
  /** 已解析好、尚未落库的新文件草稿 */
  draft: BookDraft;
}

interface PendingRisk {
  existing: BookMeta;
  draft: BookDraft;
  preview: BookmarkInheritPreview;
}

/** base64 → 字节：桌面端原生选择器读回的字节经 IPC 以 base64 传输 */
function base64ToBytes(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

/** 导入入口：点击呼出底部菜单，选择「导入本地书」或「从 WebDAV 导入」 */
export function ImportButton(props: ImportButtonProps) {
  const navigate = useNavigate();
  const [busy, setBusy] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  const [conflict, setConflict] = createSignal<SameNameConflict | null>(null);
  const [conflictBusy, setConflictBusy] = createSignal(false);
  const [risk, setRisk] = createSignal<PendingRisk | null>(null);
  const [riskBusy, setRiskBusy] = createSignal(false);
  // 菜单 / 冲突弹窗挂在 Portal 上，不随页面隐藏：路由离开（如系统返回）时收起
  closeOnRouteChange(() => {
    setOpen(false);
    setConflict(null);
    setRisk(null);
  });
  let input: HTMLInputElement | undefined;

  async function handleFile(file: File | undefined | null) {
    if (!file || busy() || conflict() || risk()) return;
    setBusy(true);
    try {
      showToast(t("shelf.import.importing"));
      await ensureLocalBooksLoaded();
      const draft = await parseBookFile(file);
      // 书架已存在同名书：交由用户选择“重新导入 / 作为新书 / 取消”
      const existing = findSameNameImportedBook(draft);
      if (existing) {
        setConflict({ existing, draft });
        return;
      }
      const book = await importLocalDraftAsNew(draft);
      showToast(t("shelf.import.imported", { title: book.title }));
      props.onImported?.(book);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t("shelf.import.failedCheckFile"),
        true,
      );
    } finally {
      setBusy(false);
    }
  }

  /** 冲突弹窗：确认重新导入 → 先预演书签继承，再决定是否落库替换 */
  async function confirmReimport() {
    const c = conflict();
    if (!c || conflictBusy()) return;
    setConflictBusy(true);
    try {
      const preview = await previewBookmarkInheritance(c.existing, c.draft.chapters);
      setConflict(null);
      if (preview.failedCount > 0) {
        // 书签无法全部继承：交给用户决定是否放弃重新导入
        setRisk({ existing: c.existing, draft: c.draft, preview });
        return;
      }
      const book = await replaceBookContent(c.existing, c.draft);
      showToast(t("shelf.import.reimported", { title: book.title }));
      props.onImported?.(book);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t("shelf.import.reimportFailed"),
        true,
      );
    } finally {
      setConflictBusy(false);
    }
  }

  /** 冲突弹窗：保留原书，本次文件作为一本新书加入书架 */
  async function confirmImportAsNew() {
    const c = conflict();
    if (!c || conflictBusy()) return;
    setConflictBusy(true);
    try {
      const book = await importLocalDraftAsNew(c.draft);
      setConflict(null);
      showToast(t("shelf.import.added", { title: book.title }));
      props.onImported?.(book);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("shelf.import.failed"), true);
    } finally {
      setConflictBusy(false);
    }
  }

  /** 书签失效风险弹窗：用户仍决定重新导入 */
  async function confirmProceedWithRisk() {
    const r = risk();
    if (!r || riskBusy()) return;
    setRiskBusy(true);
    try {
      const book = await replaceBookContent(r.existing, r.draft);
      setRisk(null);
      showToast(t("shelf.import.reimported", { title: book.title }));
      props.onImported?.(book);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t("shelf.import.reimportFailed"),
        true,
      );
    } finally {
      setRiskBusy(false);
    }
  }

  /**
   * 选择本地书：桌面端走系统文件选择器（原生对话框给的是文件路径，WebView 打不开，
   * 由 Rust 读成字节后包成 `File`）；手机端仍是 WebView 的 `<input type="file">`（SAF）。
   */
  function openLocalPicker() {
    setOpen(false);
    if (isDesktopShell()) {
      void pickAndImport();
      return;
    }
    input?.click();
  }

  async function pickAndImport(): Promise<void> {
    if (busy()) return;
    try {
      const picked = await pickBookFile();
      // 用户取消：什么都不做
      if (!picked) return;
      const file = new File([base64ToBytes(picked.dataBase64)], picked.fileName);
      await handleFile(file);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t("shelf.import.readFailed"),
        true,
      );
    }
  }

  function openWebDav() {
    setOpen(false);
    navigate("/webdav-import");
  }

  return (
    <>
      <input
        ref={input}
        class="sr-only"
        type="file"
        accept=".txt,.epub,.equb,.pdf,text/plain,application/epub+zip,application/pdf"
        aria-hidden="true"
        tabindex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          void handleFile(file);
        }}
      />
      <button
        class={props.class}
        type="button"
        aria-label={props.ariaLabel}
        disabled={busy()}
        onClick={() => setOpen(true)}
      >
        {props.children}
      </button>

      <Show when={open()}>
        <Portal>
          <div
            class="fixed inset-0 z-[60]"
            role="dialog"
            aria-label={t("shelf.import.title")}
          >
            <div
              class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
              onClick={() => setOpen(false)}
            />
            <div class="absolute inset-x-0 bottom-0 z-[61] flex animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]">
              <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
                <span class="flex-1 text-[15px] font-bold">
                  {t("shelf.import.title")}
                </span>
                <button
                  class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                  aria-label={t("common.close")}
                  onClick={() => setOpen(false)}
                >
                  <CloseIcon />
                </button>
              </div>
              <div class="flex flex-col px-0 py-1.5 pb-2.5">
                <MenuRow
                  icon={<FileTextIcon size={19} />}
                  label={t("shelf.import.local")}
                  desc={t("shelf.import.localDesc")}
                  onClick={openLocalPicker}
                />
                <MenuRow
                  icon={<ServerIcon size={19} />}
                  label={t("shelf.import.webdav")}
                  desc={t("shelf.import.webdavDesc")}
                  onClick={openWebDav}
                />
              </div>
            </div>
          </div>
        </Portal>
      </Show>

      {/* 同名书籍冲突：选择重新导入 / 作为新书 / 取消 */}
      <Show when={conflict()}>
        {(c) => (
          <Portal>
            <div
              class="fixed inset-0 z-[80] grid place-items-center px-8"
              role="dialog"
              aria-modal="true"
              aria-label={t("shelf.import.conflictTitle", {
                title: c().existing.title,
              })}
            >
              <div
                class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
                onClick={() => setConflict(null)}
              />
              <div class="relative w-full max-w-[340px] animate-pop-in overflow-hidden rounded-[18px] border border-border bg-surface p-4 shadow-[0_18px_50px_rgb(0_0_0/0.3)]">
                <p class="text-[15px] font-bold leading-snug">
                  {t("shelf.import.conflictTitle", {
                    title: c().existing.title,
                  })}
                </p>
                <p class="mt-2 text-[12.5px] leading-[1.7] text-text-2">
                  {t("shelf.import.conflictDesc")}
                </p>
                <div class="mt-4 flex flex-col gap-2">
                  <button
                    class="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-[10px] text-[13.5px] font-semibold text-on-accent shadow-lg shadow-accent/25 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90 disabled:opacity-60"
                    type="button"
                    disabled={conflictBusy()}
                    onClick={() => void confirmReimport()}
                  >
                    <Show
                      when={conflictBusy()}
                      fallback={t("shelf.import.reimport")}
                    >
                      <span
                        class="size-3.5 flex-none animate-spin rounded-full border-2 border-on-accent/40 border-t-on-accent"
                        aria-hidden="true"
                      />
                      {t("shelf.import.checkingBookmarks")}
                    </Show>
                  </button>
                  <button
                    class="w-full rounded-xl border border-border bg-bg px-4 py-[10px] text-[13.5px] font-medium text-text-2 transition-colors active:bg-surface-2 disabled:opacity-50"
                    type="button"
                    disabled={conflictBusy()}
                    onClick={() => void confirmImportAsNew()}
                  >
                    {t("shelf.import.addAsNew")}
                  </button>
                  <button
                    class="w-full rounded-xl px-4 py-[8px] text-[13px] text-text-3 transition-colors active:bg-surface-2"
                    type="button"
                    disabled={conflictBusy()}
                    onClick={() => setConflict(null)}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            </div>
          </Portal>
        )}
      </Show>

      {/* 书签继承失效：仍可放弃本次重新导入 */}
      <Show when={risk()}>
        {(r) => (
          <BookmarkRiskDialog
            bookTitle={r().existing.title}
            preview={r().preview}
            busy={riskBusy()}
            onCancel={() => {
              setRisk(null);
              showToast(t("shelf.import.reimportCancelled"));
            }}
            onProceed={() => void confirmProceedWithRisk()}
          />
        )}
      </Show>
    </>
  );
}

function MenuRow(props: {
  icon: JSX.Element;
  label: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      class="flex w-full items-center gap-3.5 px-5 py-[13px] text-left transition-colors active:bg-surface-2"
      onClick={props.onClick}
    >
      <span class="grid h-10 w-10 flex-none place-items-center rounded-[12px] bg-accent-weak text-accent">
        {props.icon}
      </span>
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-[15px] font-semibold">{props.label}</span>
        <span class="text-[12px] text-text-3">{props.desc}</span>
      </span>
      <ChevronRightIcon size={17} class="flex-none text-text-3" />
    </button>
  );
}

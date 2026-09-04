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
import type { LocalBook } from "../lib/booksTypes";
import {
  previewBookmarkInheritance,
  type BookmarkInheritPreview,
} from "../lib/bookmarks";
import { showToast } from "../lib/toast";
import { BookmarkRiskDialog } from "./BookmarkRiskDialog";
import { ChevronRightIcon, CloseIcon, FileTextIcon, ServerIcon } from "./icons";

interface ImportButtonProps {
  class?: string;
  ariaLabel: string;
  children?: JSX.Element;
  /** 导入成功后的额外动作（默认：书已进书架，停留在当前页） */
  onImported?: (book: LocalBook) => void;
}

interface SameNameConflict {
  /** 书架中已存在的同名书（重新导入的目标） */
  existing: LocalBook;
  /** 已解析好、尚未落库的新文件草稿 */
  draft: BookDraft;
}

interface PendingRisk {
  existing: LocalBook;
  draft: BookDraft;
  preview: BookmarkInheritPreview;
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
  let input: HTMLInputElement | undefined;

  async function handleFile(file: File | undefined | null) {
    if (!file || busy() || conflict() || risk()) return;
    setBusy(true);
    try {
      showToast("正在导入…");
      await ensureLocalBooksLoaded();
      const draft = await parseBookFile(file);
      // 书架已存在同名书：交由用户选择“重新导入 / 作为新书 / 取消”
      const existing = findSameNameImportedBook(draft);
      if (existing) {
        setConflict({ existing, draft });
        return;
      }
      const book = await importLocalDraftAsNew(draft);
      showToast(`已导入《${book.title}》`);
      props.onImported?.(book);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "导入失败，请检查文件", true);
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
      showToast(`已重新导入《${book.title}》`);
      props.onImported?.(book);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "重新导入失败", true);
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
      showToast(`已新增《${book.title}》`);
      props.onImported?.(book);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "导入失败", true);
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
      showToast(`已重新导入《${book.title}》`);
      props.onImported?.(book);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "重新导入失败", true);
    } finally {
      setRiskBusy(false);
    }
  }

  function openLocalPicker() {
    setOpen(false);
    input?.click();
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
        accept=".txt,.epub,.equb,text/plain,application/epub+zip"
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
          <div class="fixed inset-0 z-[60]" role="dialog" aria-label="导入书籍">
            <div
              class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
              onClick={() => setOpen(false)}
            />
            <div class="absolute inset-x-0 bottom-0 z-[61] flex animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]">
              <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
                <span class="flex-1 text-[15px] font-bold">导入书籍</span>
                <button
                  class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                  aria-label="关闭"
                  onClick={() => setOpen(false)}
                >
                  <CloseIcon />
                </button>
              </div>
              <div class="flex flex-col px-0 py-1.5 pb-2.5">
                <MenuRow
                  icon={<FileTextIcon size={19} />}
                  label="导入本地书"
                  desc="从设备选择 TXT / EPUB"
                  onClick={openLocalPicker}
                />
                <MenuRow
                  icon={<ServerIcon size={19} />}
                  label="从 WebDAV 导入"
                  desc="浏览 WebDAV 云盘书库"
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
              aria-label={`《${c().existing.title}》已在书架中`}
            >
              <div
                class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
                onClick={() => setConflict(null)}
              />
              <div class="relative w-full max-w-[340px] animate-pop-in overflow-hidden rounded-[18px] border border-border bg-surface p-4 shadow-[0_18px_50px_rgb(0_0_0/0.3)]">
                <p class="text-[15px] font-bold leading-snug">
                  《{c().existing.title}》已在书架中
                </p>
                <p class="mt-2 text-[12.5px] leading-[1.7] text-text-2">
                  重新导入会用所选文件替换这本书的内容，阅读进度、分组与书签会尝试继承；
                  也可以保留原书，把所选文件作为一本新书加入书架。
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
                      fallback="重新导入"
                    >
                      <span
                        class="size-3.5 flex-none animate-spin rounded-full border-2 border-on-accent/40 border-t-on-accent"
                        aria-hidden="true"
                      />
                      正在检查书签…
                    </Show>
                  </button>
                  <button
                    class="w-full rounded-xl border border-border bg-bg px-4 py-[10px] text-[13.5px] font-medium text-text-2 transition-colors active:bg-surface-2 disabled:opacity-50"
                    type="button"
                    disabled={conflictBusy()}
                    onClick={() => void confirmImportAsNew()}
                  >
                    作为新书加入书架
                  </button>
                  <button
                    class="w-full rounded-xl px-4 py-[8px] text-[13px] text-text-3 transition-colors active:bg-surface-2"
                    type="button"
                    disabled={conflictBusy()}
                    onClick={() => setConflict(null)}
                  >
                    取消
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
              showToast("已取消重新导入");
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

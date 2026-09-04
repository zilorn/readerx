/**
 * 书籍元信息编辑抽屉（书籍详情页）：
 * 编辑书名 / 作者 / 简介，并可更换或移除自定义封面。
 * 每次打开都会重新挂载，故内部表单初值即当前书籍内容。
 */
import { Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { updateBookInfo } from "../lib/books";
import type { LocalBook } from "../lib/booksTypes";
import { fileToCoverThumb } from "../lib/coverImage";
import { showToast } from "../lib/toast";
import { CloseIcon, ImageIcon, TrashIcon } from "./icons";

interface BookMetaSheetProps {
  book: LocalBook;
  onClose: () => void;
}

export function BookMetaSheet(props: BookMetaSheetProps) {
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [titleDraft, setTitleDraft] = createSignal(props.book.title);
  const [authorDraft, setAuthorDraft] = createSignal(props.book.author);
  const [introDraft, setIntroDraft] = createSignal(props.book.intro ?? "");
  /** null = 无自定义封面（回退程序化封面） */
  const [coverDraft, setCoverDraft] = createSignal<string | null>(
    props.book.cover ?? null,
  );

  let coverInput: HTMLInputElement | undefined;

  function close() {
    if (saving()) return;
    props.onClose();
  }

  async function onPickCover(file: File | undefined | null) {
    if (!file) return;
    const thumb = await fileToCoverThumb(file);
    if (!thumb) {
      showToast("无法读取该图片，请换一张 JPG / PNG", true);
      return;
    }
    setCoverDraft(thumb);
  }

  async function onSave() {
    if (saving()) return;
    if (!titleDraft().trim()) {
      setError("书名不能为空");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await updateBookInfo(props.book.id, {
        title: titleDraft(),
        author: authorDraft(),
        intro: introDraft(),
        cover: coverDraft(),
      });
      props.onClose();
      showToast("已保存");
    } catch {
      setError("保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[70] animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
        onClick={close}
      />
      <div
        class="fixed inset-x-0 bottom-0 z-[71] mx-auto flex max-h-[88%] max-w-[480px] animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
        role="dialog"
        aria-modal="true"
        aria-label="编辑书籍信息"
      >
        <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
          <span class="text-[15px] font-bold">编辑书籍信息</span>
          <span class="flex-1 text-xs text-text-3">保存后书架同步更新</span>
          <button
            class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label="关闭"
            onClick={close}
          >
            <CloseIcon />
          </button>
        </div>

        <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 pb-2">
          {/* 封面 */}
          <div class="flex gap-4">
            <Show
              when={coverDraft()}
              fallback={
                <div class="grid h-[120px] w-[88px] flex-none place-items-center overflow-hidden rounded-[10px] border border-dashed border-border bg-bg text-text-3">
                  <div class="flex flex-col items-center gap-1.5 text-[10px]">
                    <ImageIcon size={26} />
                    无封面
                  </div>
                </div>
              }
            >
              <img
                src={coverDraft()!}
                alt=""
                draggable={false}
                class="h-[120px] w-[88px] flex-none rounded-[10px] object-cover shadow-[0_4px_10px_rgb(0_0_0/0.18)]"
              />
            </Show>
            <div class="flex min-w-0 flex-1 flex-col justify-center gap-2">
              <button
                class="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-bg px-4 py-[10px] text-[13.5px] font-medium text-text-2 transition-colors active:bg-surface-2 disabled:opacity-50"
                type="button"
                onClick={() => coverInput?.click()}
              >
                <ImageIcon size={17} />
                更换封面
              </button>
              <Show when={coverDraft() !== null}>
                <button
                  class="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-bg px-4 py-[10px] text-[13.5px] font-medium text-danger transition-colors active:bg-surface-2"
                  type="button"
                  onClick={() => setCoverDraft(null)}
                >
                  <TrashIcon size={16} />
                  移除封面
                </button>
              </Show>
            </div>
          </div>

          <label class="flex min-w-0 flex-col gap-[5px]">
            <span class="text-[11.5px] font-semibold tracking-[0.03em] text-text-3">
              书名
            </span>
            <input
              class="w-full rounded-[10px] border border-border bg-bg px-[11px] py-[9px] text-[13.5px] text-text outline-none transition-colors focus:border-accent placeholder:text-text-3"
              value={titleDraft()}
              placeholder="书名"
              onInput={(e) => setTitleDraft(e.currentTarget.value)}
            />
          </label>
          <label class="flex min-w-0 flex-col gap-[5px]">
            <span class="text-[11.5px] font-semibold tracking-[0.03em] text-text-3">
              作者
            </span>
            <input
              class="w-full rounded-[10px] border border-border bg-bg px-[11px] py-[9px] text-[13.5px] text-text outline-none transition-colors focus:border-accent placeholder:text-text-3"
              value={authorDraft()}
              placeholder="作者"
              onInput={(e) => setAuthorDraft(e.currentTarget.value)}
            />
          </label>
          <label class="flex min-w-0 flex-col gap-[5px]">
            <span class="text-[11.5px] font-semibold tracking-[0.03em] text-text-3">
              简介
            </span>
            <textarea
              class="min-h-[120px] w-full resize-none rounded-[10px] border border-border bg-bg px-[11px] py-[9px] text-[13px] leading-[1.6] text-text outline-none transition-colors focus:border-accent placeholder:text-text-3"
              rows={6}
              value={introDraft()}
              placeholder="书籍简介（可留空）"
              onInput={(e) => setIntroDraft(e.currentTarget.value)}
            />
          </label>

          <Show when={error()}>
            <p
              class="rounded-[10px] bg-danger-weak px-[13px] py-2.5 text-[12.5px] leading-[1.5] text-danger"
              role="alert"
            >
              {error()}
            </p>
          </Show>

          <button
            class="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-[22px] py-[11px] text-sm font-semibold text-on-accent shadow-lg shadow-accent/30 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90 disabled:opacity-60"
            type="button"
            disabled={saving()}
            onClick={() => void onSave()}
          >
            <Show
              when={saving()}
              fallback="保存"
            >
              <span
                class="size-3.5 flex-none animate-spin rounded-full border-2 border-on-accent/40 border-t-on-accent"
                aria-hidden="true"
              />
              正在保存…
            </Show>
          </button>
        </div>
      </div>

      <input
        ref={coverInput}
        class="sr-only"
        type="file"
        accept="image/*"
        aria-hidden="true"
        tabindex={-1}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          void onPickCover(file);
        }}
      />
    </Portal>
  );
}

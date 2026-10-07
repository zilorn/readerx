import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Drawer } from "./Drawer";
import { ScrollArea } from "./ScrollArea";
import { AnnotationIcon, CloseIcon, EditIcon, PlusIcon } from "./icons";
import {
  ANNOTATION_MAX_LENGTH, annotationsFor, ensureAnnotationsLoaded,
  saveAnnotationNote, type ParagraphAnchor,
} from "../lib/annotations";
import { t } from "../lib/i18n";
import { isDesktopShell } from "../lib/platform";
import { showToast } from "../lib/toast";
import { createAndroidBackHandler } from "../lib/androidBack";

export interface AnnotationTarget {
  anchor: ParagraphAnchor;
  paragraphId: string | null;
  text: string;
  add: boolean;
}
export interface AnnotationSheetProps {
  bookId: string;
  target: AnnotationTarget;
  onClose: () => void;
}

export function AnnotationSheet(props: AnnotationSheetProps) {
  const [ready, setReady] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [editing, setEditing] = createSignal(props.target.add);
  const [noteId, setNoteId] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  const paragraph = () => annotationsFor(props.bookId).find((item) =>
    props.target.paragraphId
      ? item.id === props.target.paragraphId
      : item.chapterCid === props.target.anchor.chapterCid &&
        item.unitIndex === props.target.anchor.unitIndex &&
        item.fingerprint === props.target.anchor.fingerprint,
  );
  const close = () => { if (!busy()) props.onClose(); };
  createAndroidBackHandler(() => true, close);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      setReady(await ensureAnnotationsLoaded(props.bookId));
    } finally {
      setLoading(false);
    }
  }
  onMount(() => {
    void load();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", escape);
    onCleanup(() => window.removeEventListener("keydown", escape));
  });

  async function save(): Promise<void> {
    if (busy() || !draft().trim() || !ready()) return;
    setBusy(true);
    try {
      const saved = await saveAnnotationNote(
        props.bookId, props.target.anchor, paragraph()?.id ?? null, noteId(), draft(),
      );
      if (saved) {
        setEditing(false);
        setDraft("");
        setNoteId(null);
        showToast(t("readerChrome.annotation.saved"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      onClose={close}
      label={t("readerChrome.annotation.title")}
      position="absolute"
      layer={52}
      sizeClass={isDesktopShell() ? "h-full" : "h-[72%]"}
      readerUi
    >
      <div class="flex flex-none items-center gap-2 border-b border-border px-4 py-3">
        <AnnotationIcon size={20} class="text-accent" />
        <span class="flex-1 text-[15px] font-bold">{t("readerChrome.annotation.title")}</span>
        <button
          class="grid h-10 w-10 cursor-pointer place-items-center rounded-xl text-text-2 active:bg-surface-2"
          aria-label={t("common.close")}
          disabled={busy()}
          onClick={close}
        >
          <CloseIcon />
        </button>
      </div>
      <ScrollArea
        class="min-h-0 flex-1"
        contentClass="space-y-3 px-4 pt-3 pb-[calc(18px+env(safe-area-inset-bottom))]"
      >
        <p class="line-clamp-3 rounded-xl bg-bg p-3 text-sm leading-relaxed text-text-3">
          {props.target.text}
        </p>
        <Show
          when={ready()}
          fallback={
            <button
              class="w-full cursor-pointer rounded-xl border border-border p-3 text-text-2"
              disabled={loading()}
              onClick={() => void load()}
            >
              {loading() ? t("common.loading") : t("readerChrome.annotation.retry")}
            </button>
          }
        >
          <For each={paragraph()?.notes ?? []}>
            {(note) => (
              <div class="flex items-start gap-2 rounded-xl border border-border bg-bg p-3">
                <p class="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {note.text}
                </p>
                <button
                  class="grid h-10 w-10 flex-none cursor-pointer place-items-center rounded-lg text-text-3 active:bg-surface-2"
                  aria-label={t("readerChrome.annotation.edit")}
                  disabled={busy()}
                  onClick={() => {
                    setNoteId(note.id);
                    setDraft(note.text);
                    setEditing(true);
                  }}
                >
                  <EditIcon size={18} />
                </button>
              </div>
            )}
          </For>
          <Show
            when={editing()}
            fallback={
              <button
                class="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-accent/40 bg-accent-weak p-3 text-sm font-semibold text-accent"
                onClick={() => {
                  setNoteId(null);
                  setDraft("");
                  setEditing(true);
                }}
              >
                <PlusIcon size={17} />
                {t("readerChrome.annotation.add")}
              </button>
            }
          >
            <label class="block text-sm text-text-2">
              {noteId() ? t("readerChrome.annotation.edit") : t("readerChrome.annotation.add")}
              <textarea
                class="mt-2 w-full resize-y rounded-xl border border-border bg-bg p-3 text-sm text-text outline-none focus:border-accent"
                rows={4}
                maxLength={ANNOTATION_MAX_LENGTH}
                value={draft()}
                placeholder={t("readerChrome.annotation.placeholder")}
                disabled={busy()}
                onInput={(e) => setDraft(e.currentTarget.value)}
              />
            </label>
            <div class="flex gap-2">
              <button
                class="flex-1 cursor-pointer rounded-xl border border-border p-3 text-sm text-text-2"
                disabled={busy()}
                onClick={() => setEditing(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                class="flex-1 cursor-pointer rounded-xl bg-accent p-3 text-sm font-semibold text-on-accent disabled:opacity-50"
                disabled={busy() || !draft().trim()}
                onClick={() => void save()}
              >
                {t("common.save")}
              </button>
            </div>
          </Show>
        </Show>
      </ScrollArea>
    </Drawer>
  );
}

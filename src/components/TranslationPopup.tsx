import { Show, createSignal, onMount, onCleanup } from "solid-js";
import { t } from "../lib/i18n";
import {
  selectionMenuTop,
  type SelectionMenuGeometry,
} from "../lib/selectionMenuPosition";
import { createAndroidBackHandler } from "../lib/androidBack";
import { writeClipboardText } from "../lib/clipboard";
import { reportFailure } from "../lib/errorReport";
import { CloseIcon, CopyIcon, RefreshIcon } from "./icons";
export interface TranslationPopupTarget {
  text: string;
  geometry: SelectionMenuGeometry;
  x: number;
}
export function TranslationPopup(props: {
  target: TranslationPopupTarget;
  root: () => HTMLElement | undefined;
  translate: (signal: AbortSignal) => Promise<string>;
  onClose: () => void;
  insets: { top: number; bottom: number };
}) {
  const [text, setText] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [pos, setPos] = createSignal({ left: 0, top: 0 });
  let panel!: HTMLDivElement;
  let controller = new AbortController();
  function position() {
    const root = props.root();
    if (!root || !panel) return;
    const h = panel.getBoundingClientRect().height,
      w = panel.getBoundingClientRect().width;
    setPos({
      left: Math.max(
        12,
        Math.min(props.target.x - w / 2, root.clientWidth - w - 12),
      ),
      top: selectionMenuTop(
        props.target.geometry,
        h,
        props.insets.top,
        Math.max(props.insets.top, root.clientHeight - h - props.insets.bottom),
      ),
    });
  }
  async function load() {
    controller.abort();
    controller = new AbortController();
    const current = controller;
    setBusy(true);
    setError("");
    try {
      const result = await props.translate(current.signal);
      if (!current.signal.aborted) setText(result);
    } catch (err) {
      if (!current.signal.aborted) {
        setError(err instanceof Error ? err.message : t("translation.failed"));
        reportFailure(t("translation.failed"), err);
      }
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }
  createAndroidBackHandler(() => true, props.onClose);
  onMount(() => {
    const observer = new ResizeObserver(position);
    observer.observe(panel);
    if (props.root()) observer.observe(props.root()!);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener("keydown", escape);
    position();
    void load();
    onCleanup(() => {
      controller.abort();
      observer.disconnect();
      window.removeEventListener("keydown", escape);
    });
  });
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={t("translation.translate")}
      data-reader-ui
      class="absolute z-[70] flex max-h-[min(55%,420px)] w-[min(340px,calc(100%-24px))] flex-col rounded-2xl border border-border bg-surface shadow-lg"
      style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div class="flex flex-none items-center justify-between border-b border-border px-4 py-2">
        <span class="text-[13px] font-medium">
          {t("translation.translate")}
        </span>
        <div class="flex gap-1">
          <Show when={text()}>
            <button
              class="grid size-9 place-items-center rounded-lg text-text-2 active:bg-surface-2"
              aria-label={t("translation.copy")}
              onClick={() =>
                void writeClipboardText(text()).catch((err) =>
                  reportFailure(t("translation.failed"), err),
                )
              }
            >
              <CopyIcon size={17} />
            </button>
          </Show>
          <button
            class="grid size-9 place-items-center rounded-lg text-text-2 active:bg-surface-2"
            aria-label={t("translation.close")}
            onClick={props.onClose}
          >
            <CloseIcon size={18} />
          </button>
        </div>
      </div>
      <div
        class="min-h-0 overflow-y-auto whitespace-pre-wrap px-4 py-3 text-[14px] leading-relaxed"
        aria-live="polite"
      >
        <Show
          when={busy()}
          fallback={
            <Show when={error()} fallback={text()}>
              <p class="text-danger">{error()}</p>
              <button
                class="mt-3 flex items-center gap-2 text-accent"
                onClick={() => void load()}
              >
                <RefreshIcon size={16} />
                {t("translation.retry")}
              </button>
            </Show>
          }
        >
          <span class="text-text-3">{t("translation.loading")}</span>
        </Show>
      </div>
    </div>
  );
}

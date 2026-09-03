import { createSignal, type JSX } from "solid-js";
import { importLocalBookFile } from "../lib/books";
import { showToast } from "../lib/toast";
import type { LocalBook } from "../lib/booksTypes";

interface ImportButtonProps {
  class?: string;
  ariaLabel: string;
  children?: JSX.Element;
  /** 导入成功后的额外动作（默认：书已进书架，停留在当前页） */
  onImported?: (book: LocalBook) => void;
}

/** 一键导入：点击直接唤起系统文件选择，解析后立即入书架，不跳页面 */
export function ImportButton(props: ImportButtonProps) {
  const [busy, setBusy] = createSignal(false);
  let input: HTMLInputElement | undefined;

  async function handleFile(file: File | undefined | null) {
    if (!file || busy()) return;
    setBusy(true);
    try {
      showToast("正在导入…");
      const book = await importLocalBookFile(file);
      showToast(`已导入《${book.title}》`);
      props.onImported?.(book);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "导入失败，请检查文件", true);
    } finally {
      setBusy(false);
    }
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
        onClick={() => input?.click()}
      >
        {props.children}
      </button>
    </>
  );
}

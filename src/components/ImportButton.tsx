import { createSignal, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { useNavigate } from "@solidjs/router";
import { importLocalBookFile } from "../lib/books";
import { showToast } from "../lib/toast";
import type { LocalBook } from "../lib/booksTypes";
import { ChevronRightIcon, CloseIcon, FileTextIcon, ServerIcon } from "./icons";

interface ImportButtonProps {
  class?: string;
  ariaLabel: string;
  children?: JSX.Element;
  /** 导入成功后的额外动作（默认：书已进书架，停留在当前页） */
  onImported?: (book: LocalBook) => void;
}

/** 导入入口：点击呼出底部菜单，选择「导入本地书」或「从 WebDAV 导入」 */
export function ImportButton(props: ImportButtonProps) {
  const navigate = useNavigate();
  const [busy, setBusy] = createSignal(false);
  const [open, setOpen] = createSignal(false);
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

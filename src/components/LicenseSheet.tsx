/**
 * “关于 → 开源许可”弹层（全屏弹出页面）。
 * 首次打开时经 Rust command 读取随应用打包为 resource 的 LICENSE 全文，
 * 读入后在同一会话内复用缓存文本。
 */
import { Show, createEffect, createSignal } from "solid-js";
import { readLicenseText } from "../lib/backend";
import { CloseIcon, FileTextIcon } from "./icons";

interface LicenseSheetProps {
  open: boolean;
  onClose: () => void;
}

export function LicenseSheet(props: LicenseSheetProps) {
  const [text, setText] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);

  createEffect(() => {
    if (props.open && text() === null && !failed()) {
      void readLicenseText().then((value) => {
        if (value !== null) setText(value);
        else setFailed(true);
      });
    }
  });

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[70] animate-page-in-right bg-bg">
        <div class="mx-auto flex h-full w-full max-w-[480px] flex-col overflow-hidden bg-bg min-[521px]:border-x min-[521px]:border-border min-[521px]:shadow-[0_0_44px_rgb(0_0_0/0.16)]">
          <header class="flex flex-none items-center gap-2.5 border-b border-border px-[18px] pb-2.5 pt-[max(env(safe-area-inset-top),12px)]">
            <span class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-accent-weak text-accent">
              <FileTextIcon size={18} />
            </span>
            <div class="flex min-w-0 flex-1 flex-col">
              <h1 class="text-[16px] font-bold leading-tight tracking-[0.02em]">
                MIT License
              </h1>
              <span class="text-[11px] text-text-3">ReaderX 开源许可</span>
            </div>
            <button
              class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
              type="button"
              aria-label="关闭开源许可"
              onClick={props.onClose}
            >
              <CloseIcon />
            </button>
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto scrollbar-none px-[18px] pb-[calc(28px+env(safe-area-inset-bottom))] pt-4">
            <Show
              when={text() !== null}
              fallback={
                <div class="grid h-full place-items-center text-[12.5px] text-text-3">
                  {failed() ? "无法读取许可文本" : "加载中…"}
                </div>
              }
            >
              <pre class="whitespace-pre-wrap break-words text-[12.5px] leading-[1.8] text-text-2">
                {text()}
              </pre>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}

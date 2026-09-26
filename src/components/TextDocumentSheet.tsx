/**
 * “关于”里随包文本（开源许可 LICENSE、开源库使用声明 THIRD-PARTY-NOTICES.md）的通用弹层
 * （全屏弹出页面）。首次打开时经 Rust command 读取随应用打包为 resource 的文本，
 * 读入后在同一会话内复用缓存（各弹层各缓存一份）。
 */
import { Show, createEffect, createSignal, type JSX } from "solid-js";
import { CloseIcon } from "./icons";
import { ScrollArea } from "./ScrollArea";
import { t } from "../lib/i18n";

export interface TextDocumentSheetProps {
  open: boolean;
  onClose: () => void;
  /** 头部标题，如 “GNU General Public License v3.0” */
  title: string;
  /** 标题下的一行说明 */
  subtitle: string;
  /** 头部图标（尺寸由调用方给定） */
  icon: JSX.Element;
  /** 关闭按钮的无障碍标签 */
  closeLabel: string;
  /** 文本加载器：返回 null 视为读取失败 */
  load: () => Promise<string | null>;
  /** 读取失败时的兜底文案 */
  errorText: string;
}

export function TextDocumentSheet(props: TextDocumentSheetProps) {
  const [text, setText] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);

  createEffect(() => {
    if (props.open && text() === null && !failed()) {
      void props.load().then((value) => {
        if (value !== null) setText(value);
        else setFailed(true);
      });
    }
  });

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[70] animate-page-in-right bg-bg">
        <div class="mx-auto flex h-full w-full max-w-[var(--app-column)] flex-col overflow-hidden bg-bg min-[521px]:border-x min-[521px]:border-border min-[521px]:shadow-[0_0_44px_rgb(0_0_0/0.16)]">
          <header class="flex flex-none items-center gap-2.5 border-b border-border px-[18px] pb-2.5 pt-[max(env(safe-area-inset-top),12px)]">
            <span class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-accent-weak text-accent">
              {props.icon}
            </span>
            <div class="flex min-w-0 flex-1 flex-col">
              <h1 class="text-[16px] font-bold leading-tight tracking-[0.02em]">
                {props.title}
              </h1>
              <span class="text-[11px] text-text-3">{props.subtitle}</span>
            </div>
            <button
              class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
              type="button"
              aria-label={props.closeLabel}
              onClick={props.onClose}
            >
              <CloseIcon />
            </button>
          </header>

          <ScrollArea
            class="min-h-0 flex-1"
            contentClass="px-[18px] pb-[calc(28px+env(safe-area-inset-bottom))] pt-4"
          >
            <Show
              when={text() !== null}
              fallback={
                <div class="grid h-full place-items-center text-[12.5px] text-text-3">
                  {failed() ? props.errorText : t("common.loading")}
                </div>
              }
            >
              <pre class="whitespace-pre-wrap break-words text-[12.5px] leading-[1.8] text-text-2">
                {text()}
              </pre>
            </Show>
          </ScrollArea>
        </div>
      </div>
    </Show>
  );
}

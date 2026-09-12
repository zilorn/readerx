/**
 * 书源管理页的「粘贴导入」抽屉：
 * - 打开即静默读一次剪贴板预填，读不到也照样能长按输入框自己粘贴 / 手打；
 * - 文本既可以是书源 JSON（单条或数组），也可以是返回书源 JSON 的 http(s) 网址，
 *   由父级判断走解析还是网络拉取，因此这里不做 JSON 校验；
 * - 导入失败（JSON 解析不了 / 没有可导入的书源 / 拉取失败）留在本抽屉内提示，
 *   成功后由父级接管进入「确认导入」。
 */
import { Show, createSignal, onMount } from "solid-js";
import { ClipboardIcon, CloseIcon, DownloadIcon } from "./icons";

export interface PasteImportResult {
  ok: boolean;
  /** ok 为 false 时的错误文案 */
  message?: string;
}

interface SourcePasteImportSheetProps {
  /** 是否看起来像指向书源 JSON 的网址（决定按钮文案与提示） */
  detectUrl: (text: string) => boolean;
  /** 提交导入：解析 / 拉取成功返回 ok（父级已切到确认弹层），失败返回错误文案 */
  onSubmit: (text: string) => Promise<PasteImportResult>;
  onClose: () => void;
}

/** 网址形态的判定与父级共用同一套（只认 http(s) 前缀） */
export function looksLikeSourceUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

export function SourcePasteImportSheet(props: SourcePasteImportSheetProps) {
  const [text, setText] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [reading, setReading] = createSignal(false);
  let inputRef: HTMLTextAreaElement | undefined;

  /** 打开时预填剪贴板内容；失败（无权限 / 空剪贴板）不打扰用户 */
  async function readClipboard(silent: boolean): Promise<void> {
    if (reading() || busy()) return;
    // 自动预填（silent）只在输入框还空着时落笔，避免读到一半把用户已输入的内容冲掉
    if (silent && text().trim()) return;
    setReading(true);
    const clip = await navigator.clipboard.readText().catch(() => "");
    setReading(false);
    if (clip.trim()) {
      setText(clip);
      setError("");
      return;
    }
    if (!silent) setError("剪贴板里没有可导入的内容，可直接粘贴或输入 JSON");
  }

  /**
   * 打开时预填一次剪贴板内容；失败（无权限 / 空剪贴板）不打扰用户。
   * 只读一次：读取状态与文本都是响应式的，若放进 createEffect 会被自身写入反复触发，
   * 既让按钮卡在「读取中」，也会把用户正在输入的内容冲掉。
   */
  onMount(() => {
    void readClipboard(true).then(() => inputRef?.focus());
  });

  async function submit(): Promise<void> {
    const value = text().trim();
    if (!value || busy()) return;
    setBusy(true);
    setError("");
    try {
      const result = await props.onSubmit(value);
      if (result.ok) props.onClose();
      else setError(result.message ?? "导入失败");
    } finally {
      setBusy(false);
    }
  }

  const isUrl = () => props.detectUrl(text());

  return (
    <div class="fixed inset-0 z-50" role="dialog" aria-label="粘贴导入书源">
      <div
        class="absolute inset-0 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
        onClick={() => {
          if (!busy()) props.onClose();
        }}
      />
      <div class="absolute inset-x-0 bottom-0 z-[51] flex max-h-[88%] animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]">
        <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
          <span class="text-[15px] font-bold">粘贴导入</span>
          <span class="flex-1 text-xs text-text-3">书源 JSON 或 JSON 网址</span>
          <button
            class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label="关闭"
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <div class="flex min-h-0 flex-1 flex-col px-4 pb-[calc(16px+env(safe-area-inset-bottom))] pt-3.5">
          <textarea
            ref={inputRef}
            rows={7}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            placeholder={'[{"name": "书源名", "bookSourceUrl": "https://…"}]'}
            class="min-h-[132px] w-full flex-1 resize-none rounded-[12px] border border-border bg-bg px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-text outline-none transition-colors placeholder:text-text-3 focus:border-accent"
            value={text()}
            onInput={(e) => {
              setText(e.currentTarget.value);
              setError("");
            }}
          />
          <div class="mt-1.5 flex items-center gap-2">
            <button
              class="inline-flex flex-none items-center gap-1.5 rounded-[10px] bg-surface-2 px-3 py-2 text-[12.5px] font-semibold text-text-2 transition-[scale] duration-100 active:scale-[0.97] disabled:opacity-50"
              disabled={reading() || busy()}
              onClick={() => void readClipboard(false)}
            >
              <ClipboardIcon size={15} />
              {reading() ? "读取中…" : "读剪贴板"}
            </button>
            <Show when={text().length > 0}>
              <span class="min-w-0 flex-1 truncate text-right text-[11px] text-text-3">
                {isUrl() ? "网址" : `${text().length} 字符`}
              </span>
            </Show>
          </div>

          <Show when={error()}>
            <p class="mt-2 rounded-[10px] bg-danger-weak px-3 py-2 text-[12px] leading-[1.5] text-danger">
              {error()}
            </p>
          </Show>

          <div class="mt-3.5 flex gap-2.5">
            <button
              class="flex-1 rounded-xl bg-surface-2 px-4 py-2.5 text-[13.5px] font-semibold text-text-2 disabled:opacity-50"
              disabled={busy()}
              onClick={props.onClose}
            >
              取消
            </button>
            <button
              class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-on-accent disabled:pointer-events-none disabled:opacity-50"
              disabled={busy() || text().trim().length === 0}
              onClick={() => void submit()}
            >
              <DownloadIcon size={16} />
              {busy() ? "处理中…" : isUrl() ? "拉取并导入" : "解析并导入"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 书源 JS 代码编辑器（整页尺寸）
 * ------------------------------------------------
 * 三层层叠，全部共用同一套字体度量（字号 / 行高 / 内边距），保证像素级对齐：
 * 1. 行号槽（左侧，独立纵向平移）；
 * 2. 高亮层 `<pre>`：由 jsHighlight 生成的 HTML 一次性 innerHTML 写入，
 *    随输入层滚动做 translate（不重排、不逐 token 建响应式节点）；
 * 3. 输入层 `<textarea>`：真实输入与选区、原生软键盘 / 中文输入法，
 *    文字透明只留光标（见 index.css 的 code-input）。
 *
 * 采用「原生 textarea + 高亮层」而不是 contenteditable 编辑器内核：移动端
 * WebView 里只有原生输入控件能稳定拿到 IME、长按选词、自动填充与系统撤销。
 */
import { createEffect, createMemo, type JSX } from "solid-js";
import { highlightJsHtml, jsLineCount } from "../lib/jsHighlight";

export interface JsCodeEditorProps {
  /** 受控值：仅在外部改动（如「填入模板」）时回写输入框，不打断用户输入与输入法组合 */
  value: string;
  onInput: (value: string) => void;
  /** 外层尺寸类（如 min-h-0 flex-1） */
  class?: string;
  /** 无障碍标签 */
  label?: string;
}

/** 行高固定成 px：行号槽与高亮层必须与输入层整除对齐 */
const SHARED_FONT = "font-mono leading-[21px] tracking-normal tab-4";

/**
 * 超长脚本（>160KB，正常书源远小于此）退回纯文本渲染：
 * 高亮的词法扫描 + 一次 HTML 解析在软键盘下会拖慢输入，宁可少一层配色。
 */
const HIGHLIGHT_LIMIT = 160 * 1024;

export function JsCodeEditor(props: JsCodeEditorProps): JSX.Element {
  let preEl: HTMLPreElement | undefined;
  let gutterEl: HTMLPreElement | undefined;
  let inputEl: HTMLTextAreaElement | undefined;

  const lineCount = createMemo(() => jsLineCount(props.value));
  /** 行号槽宽度：按最大行号的位数留位（至少两位，避免个位数时抖动） */
  const gutterWidth = createMemo(() => `${Math.max(2, String(lineCount()).length) + 1}ch`);

  function syncScroll(): void {
    if (!inputEl) return;
    const x = inputEl.scrollLeft;
    const y = inputEl.scrollTop;
    if (preEl) preEl.style.transform = `translate(${-x}px, ${-y}px)`;
    if (gutterEl) gutterEl.style.transform = `translateY(${-y}px)`;
  }

  // 高亮层：整段重写（token 变化即整段变化，浏览器只需一次 HTML 解析）
  createEffect(() => {
    if (!preEl) return;
    const code = props.value;
    if (code.length > HIGHLIGHT_LIMIT) preEl.textContent = code;
    else preEl.innerHTML = highlightJsHtml(code);
  });

  // 行号：仅在行数变化时重建，内容是单个文本节点
  createEffect(() => {
    const count = lineCount();
    if (!gutterEl) return;
    let text = "1";
    for (let i = 2; i <= count; i++) text += `\n${i}`;
    gutterEl.textContent = text;
    syncScroll();
  });

  // 外部改动（填入模板 / 切换到别的书源）时回写输入框；相同则不写，避免打断输入法
  createEffect(() => {
    const value = props.value;
    if (inputEl && inputEl.value !== value) {
      inputEl.value = value;
      syncScroll();
    }
  });

  return (
    <div class={`relative flex min-h-0 overflow-hidden bg-surface ${props.class ?? ""}`}>
      {/* 行号槽 */}
      <div
        class="relative flex-none select-none overflow-hidden border-r border-border bg-surface-2"
        style={{ width: gutterWidth() }}
        aria-hidden="true"
      >
        <pre
          ref={gutterEl}
          class={`absolute left-0 top-0 m-0 w-full whitespace-pre py-3 pr-2 text-right text-[11px] text-text-3 ${SHARED_FONT}`}
        />
      </div>

      {/* 代码区：高亮层在下、输入层在上，滚动位置由 syncScroll 对齐 */}
      <div class="relative min-w-0 flex-1 overflow-hidden">
        <pre
          ref={preEl}
          aria-hidden="true"
          class={`pointer-events-none absolute left-0 top-0 m-0 w-max min-w-full whitespace-pre px-3 py-3 text-[12.5px] text-text ${SHARED_FONT}`}
        />
        <textarea
          ref={inputEl}
          class={`code-input absolute inset-0 h-full w-full resize-none overflow-auto overscroll-contain whitespace-pre bg-transparent px-3 py-3 text-[12.5px] outline-none scrollbar-none ${SHARED_FONT}`}
          wrap="off"
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          aria-label={props.label ?? "JS 代码"}
          onInput={(e) => {
            props.onInput(e.currentTarget.value);
            syncScroll();
          }}
          onScroll={syncScroll}
        />
      </div>
    </div>
  );
}

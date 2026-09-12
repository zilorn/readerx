/**
 * 书源编辑页「测试」面板
 * ------------------------------------------------
 * 入口函数选择 / 参数输入 / 保存并测试 / 导出 JSON 与结果展示。
 * 入口函数与参数由 SourceEditor 持有：切到 JS 代码 Tab 改完再切回来，选择不丢。
 */
import { For, Show } from "solid-js";
import { TestIcon } from "./icons";
import { ENTRY_FUNCTION_META, type BookSourceCapabilities } from "../lib/bookSourcesTypes";

export interface SourceTestResult {
  text: string;
  error: boolean;
}

export interface SourceTestPanelProps {
  caps: BookSourceCapabilities;
  fnName: string;
  onFnName: (name: string) => void;
  argsText: string;
  onArgsText: (value: string) => void;
  testing: boolean;
  result: SourceTestResult | null;
  onRun: () => void;
  onExportJson: () => void;
}

/** 各入口函数的示例参数（用作切换函数时的预填值） */
export function defaultArgs(fnName: string): string {
  switch (fnName) {
    case "searchBook":
      return '["搜索关键词"]';
    case "discoverBooks":
      return '[{ "name": "", "url": "" }]';
    case "discoverCategories":
      return "[]";
    case "bookDetail":
      return '[{ "bookName": "书名", "bookUrl": "https://" }]';
    case "bookToc":
      return '[{ "bookName": "书名", "bookUrl": "https://" }]';
    case "bookContent":
      return '[\n  { "chapterName": "第一章", "chapterUrl": "https://" },\n  { "bookName": "书名", "bookUrl": "https://" }\n]';
  }
  return "[]";
}

export function SourceTestPanel(props: SourceTestPanelProps) {
  return (
    <div class="rounded-[14px] border border-border bg-surface">
      <div class="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span class="text-[13px] font-bold">测试</span>
        <span class="text-[11px] text-text-3">保存当前代码后运行</span>
      </div>
      <div class="space-y-2.5 px-4 py-3">
        <div class="flex flex-wrap gap-1.5">
          <For each={ENTRY_FUNCTION_META}>
            {(meta) => (
              <button
                type="button"
                class="rounded-lg px-2.5 py-1.5 text-[12px] font-semibold"
                classList={{
                  "bg-accent text-on-accent": props.fnName === meta.fnName,
                  "bg-surface-2 text-text-2": props.fnName !== meta.fnName,
                  "opacity-45": !props.caps[meta.capability],
                }}
                onClick={() => {
                  props.onFnName(meta.fnName);
                  props.onArgsText(defaultArgs(meta.fnName));
                }}
              >
                {meta.label}
              </button>
            )}
          </For>
        </div>
        <textarea
          class="min-h-12 w-full resize-y rounded-[10px] border border-border bg-surface px-3 py-2 font-mono text-[11.5px] leading-[1.5] outline-none focus:border-accent"
          rows={2}
          value={props.argsText}
          onInput={(e) => props.onArgsText(e.currentTarget.value)}
        />
        <div class="flex items-center gap-2.5">
          <button
            type="button"
            class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-on-accent active:scale-[0.98] disabled:opacity-50"
            disabled={props.testing}
            onClick={props.onRun}
          >
            <TestIcon size={16} />
            {props.testing ? "运行中…" : "保存并测试"}
          </button>
          <button
            type="button"
            class="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[13px] font-semibold text-text-2 active:scale-[0.98]"
            onClick={props.onExportJson}
          >
            导出 JSON
          </button>
        </div>
        <Show when={props.result}>
          {(result) => (
            <pre
              class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[10px] px-3 py-2.5 text-[11px] leading-[1.6]"
              classList={{
                "bg-danger-weak text-danger": result().error,
                "bg-surface-2 text-text-2": !result().error,
              }}
            >
              {result().text}
            </pre>
          )}
        </Show>
      </div>
    </div>
  );
}

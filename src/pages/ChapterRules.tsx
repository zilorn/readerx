import { For, Show, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import {
  CloseIcon,
  PlusIcon,
  RegexIcon,
  TrashIcon,
} from "../components/icons";
import {
  addChapterRule,
  chapterRuleList,
  removeChapterRule,
} from "../lib/chapterRules";

const SAMPLE_PATTERN = String.raw`^\s*第\s*[0-9一二三四五六七八九十百千万零〇两]+\s*章[^\n]{0,50}`;

export default function ChapterRulesPage() {
  const navigate = useNavigate();
  const [ruleOpen, setRuleOpen] = createSignal(false);
  const [ruleName, setRuleName] = createSignal("");
  const [rulePattern, setRulePattern] = createSignal("");
  const [ruleError, setRuleError] = createSignal("");

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/settings");
  }

  function openRuleSheet() {
    setRuleName("");
    setRulePattern("");
    setRuleError("");
    setRuleOpen(true);
  }

  function onAddRule() {
    const result = addChapterRule(ruleName(), rulePattern());
    if (!result.ok) {
      setRuleError(result.error ?? "添加失败");
      return;
    }
    setRuleOpen(false);
  }

  function onDeleteRule(id: string) {
    removeChapterRule(id);
  }

  return (
    <div class="page">
      <PageHeader
        title="分章规则"
        subtitle="导入 TXT 时生效"
        onBack={goBack}
      />

      <div class="px-[18px] pb-[calc(36px+env(safe-area-inset-bottom))] pt-2">
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            自动分章（按列表顺序尝试）
          </h2>
          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <For each={chapterRuleList()}>
              {(rule) => (
                <div class="flex w-full cursor-default items-center gap-3 px-4 py-[13px]">
                  <span
                    class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-surface-2 text-text-2"
                    aria-hidden="true"
                  >
                    <RegexIcon size={18} />
                  </span>
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="inline-flex items-center gap-[7px] text-[14.5px] font-medium">
                      {rule.name}
                      {rule.builtin && (
                        <i class="not-italic rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-semibold text-text-3">
                          内置
                        </i>
                      )}
                    </span>
                    <code class="block max-w-[260px] truncate font-mono text-[11px] text-text-3">
                      {rule.pattern}
                    </code>
                  </span>
                  <Show when={!rule.builtin}>
                    <button
                      class="grid h-[34px] w-[34px] flex-none place-items-center rounded-xl text-text-3 transition-colors active:text-danger"
                      aria-label={`删除规则「${rule.name}」`}
                      onClick={() => onDeleteRule(rule.id)}
                    >
                      <TrashIcon size={17} />
                    </button>
                  </Show>
                </div>
              )}
            </For>
            <button
              class="flex w-full items-center justify-center gap-1 px-4 py-[13px] text-[13.5px] font-semibold text-accent transition-colors active:bg-surface-2"
              onClick={openRuleSheet}
            >
              <PlusIcon size={16} />
              添加分章规则
            </button>
          </div>
        </section>

        <p class="-mt-2 mb-2.5 text-center text-[11px] text-text-3">
          内置规则不可删除；全部规则未命中时自动按字数分章
        </p>
      </div>

      {/* 添加规则抽屉 */}
      <Show when={ruleOpen()}>
        <div
          class="fixed inset-0 z-40 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
          onClick={() => setRuleOpen(false)}
        />
        <div
          class="fixed inset-x-0 bottom-0 z-[41] mx-auto flex max-h-[72%] max-w-[480px] animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
          role="dialog"
          aria-label="添加分章规则"
        >
          <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
            <span class="text-[15px] font-bold">添加分章规则</span>
            <span class="flex-1 text-xs text-text-3">正则匹配标题</span>
            <button
              class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
              aria-label="关闭"
              onClick={() => setRuleOpen(false)}
            >
              <CloseIcon />
            </button>
          </div>
          <div class="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-4">
            <label class="flex min-w-0 flex-col gap-[5px]">
              <span class="text-[11.5px] font-semibold tracking-[0.03em] text-text-3">
                规则名称
              </span>
              <input
                class="w-full rounded-[10px] border border-border bg-surface px-[11px] py-[9px] text-[13.5px] text-text outline-none transition-colors focus:border-accent placeholder:text-text-3"
                value={ruleName()}
                placeholder="如：第X集"
                onInput={(e) => setRuleName(e.currentTarget.value)}
              />
            </label>
            <label class="flex min-w-0 flex-col gap-[5px]">
              <span class="text-[11.5px] font-semibold tracking-[0.03em] text-text-3">
                正则表达式
              </span>
              <textarea
                class="min-h-16 w-full resize-y rounded-[10px] border border-border bg-surface px-[11px] py-[9px] font-mono text-[12.5px] leading-[1.5] text-text outline-none transition-colors focus:border-accent placeholder:text-text-3"
                rows={3}
                value={rulePattern()}
                placeholder={SAMPLE_PATTERN}
                onInput={(e) => setRulePattern(e.currentTarget.value)}
              />
            </label>
            <p class="text-[11.5px] leading-[1.65] text-text-3">
              命中后整行作为章节标题，行首用{" "}
              <code class="rounded bg-surface-2 px-1 py-0.5 text-[10.5px]">
                ^
              </code>{" "}
              更稳妥；自动以忽略大小写 + 多行模式匹配。
            </p>
            <button
              class="self-start rounded-lg bg-accent-weak px-2 py-1.5 text-xs text-accent"
              onClick={() => setRulePattern(SAMPLE_PATTERN)}
            >
              填入示例：中文章节标题
            </button>
            <Show when={ruleError()}>
              <p
                class="mt-3 rounded-[10px] bg-danger-weak px-[13px] py-2.5 text-[12.5px] leading-[1.5] text-danger"
                role="alert"
              >
                {ruleError()}
              </p>
            </Show>
            <button
              class="mt-3.5 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-[22px] py-[11px] text-sm font-semibold text-on-accent shadow-lg shadow-accent/30 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
              onClick={onAddRule}
            >
              保存规则
            </button>
            <p class="-mt-2 mb-2.5 text-center text-[11px] text-text-3">
              新增规则会立即用于之后导入的 TXT 文件
            </p>
          </div>
        </div>
      </Show>
    </div>
  );
}

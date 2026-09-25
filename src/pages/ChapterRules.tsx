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
  chapterRuleDisplayName,
  chapterRuleList,
  removeChapterRule,
} from "../lib/chapterRules";
import { ScrollArea } from "../components/ScrollArea";
import { t } from "../lib/i18n";

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
      setRuleError(result.error ?? t("chapterRules.error.addFailed"));
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
        title={t("chapterRules.title")}
        subtitle={t("chapterRules.subtitle")}
        onBack={goBack}
      />

      <div class="px-[18px] pb-[calc(36px+env(safe-area-inset-bottom))] pt-2">
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            {t("chapterRules.section.auto")}
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
                      {chapterRuleDisplayName(rule)}
                      {rule.builtin && (
                        <i class="not-italic rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-semibold text-text-3">
                          {t("chapterRules.badge.builtin")}
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
                      aria-label={t("chapterRules.action.deleteAria", {
                        name: chapterRuleDisplayName(rule),
                      })}
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
              {t("chapterRules.action.add")}
            </button>
          </div>
        </section>

        <p class="-mt-2 mb-2.5 text-center text-[11px] text-text-3">
          {t("chapterRules.hint.builtinLocked")}
        </p>
      </div>

      {/* 添加规则抽屉 */}
      <Show when={ruleOpen()}>
        <div
          class="fixed inset-0 z-40 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
          onClick={() => setRuleOpen(false)}
        />
        <div
          class="fixed inset-x-0 bottom-0 z-[41] mx-auto flex max-h-[72%] max-w-[var(--app-column)] animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
          role="dialog"
          aria-label={t("chapterRules.action.add")}
        >
          <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
            <span class="text-[15px] font-bold">
              {t("chapterRules.action.add")}
            </span>
            <span class="flex-1 text-xs text-text-3">
              {t("chapterRules.sheet.patternHint")}
            </span>
            <button
              class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
              aria-label={t("common.close")}
              onClick={() => setRuleOpen(false)}
            >
              <CloseIcon />
            </button>
          </div>
          <ScrollArea
            class="min-h-0 flex-1"
            contentClass="space-y-2.5 px-4 py-4"
          >
            <label class="flex min-w-0 flex-col gap-[5px]">
              <span class="text-[11.5px] font-semibold tracking-[0.03em] text-text-3">
                {t("chapterRules.form.name")}
              </span>
              <input
                class="w-full rounded-[10px] border border-border bg-surface px-[11px] py-[9px] text-[13.5px] text-text outline-none transition-colors focus:border-accent placeholder:text-text-3"
                value={ruleName()}
                placeholder={t("chapterRules.form.namePlaceholder")}
                onInput={(e) => setRuleName(e.currentTarget.value)}
              />
            </label>
            <label class="flex min-w-0 flex-col gap-[5px]">
              <span class="text-[11.5px] font-semibold tracking-[0.03em] text-text-3">
                {t("chapterRules.form.pattern")}
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
              {t("chapterRules.form.hintBefore")}{" "}
              <code class="rounded bg-surface-2 px-1 py-0.5 text-[10.5px]">
                ^
              </code>{" "}
              {t("chapterRules.form.hintAfter")}
            </p>
            <button
              class="self-start rounded-lg bg-accent-weak px-2 py-1.5 text-xs text-accent"
              onClick={() => setRulePattern(SAMPLE_PATTERN)}
            >
              {t("chapterRules.form.fillSample")}
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
              {t("chapterRules.action.save")}
            </button>
            <p class="-mt-2 mb-2.5 text-center text-[11px] text-text-3">
              {t("chapterRules.hint.appliesToImports")}
            </p>
          </ScrollArea>
        </div>
      </Show>
    </div>
  );
}

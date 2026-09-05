/**
 * 文本替换抽屉（阅读器内）：
 * - 入口一：阅读设置抽屉里的「文本替换」行 → 列表视图（全局规则 + 仅当前书的规则）；
 * - 入口二：正文长按/拖选菜单的「替换」→ 直接进入新建表单，查找框预填所选文字；
 * - 列表视图：点击某条进入编辑；每条可改 查找/替换为/正则/作用域，可删除；
 * - 新建/编辑保存后立即生效（只影响阅读显示，不改动原文文件）。
 */
import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import {
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  PlusIcon,
  RegexIcon,
  ReplaceIcon,
  TrashIcon,
} from "./icons";
import {
  addReplaceRule,
  newReplaceRuleId,
  normalizeFindInput,
  removeReplaceRule,
  replaceRuleList,
  updateReplaceRule,
  validateReplaceRule,
  type ReplaceScope,
  type TextReplaceRule,
} from "../lib/textReplacements";
import { showToast } from "../lib/toast";

export interface ReplaceRulesSheetProps {
  open: boolean;
  /** 当前阅读的书 id：新建规则默认「仅本书」，并把作用域绑到它 */
  bookId: string;
  bookTitle?: string;
  /** 从选区菜单进入：传入选中的文字，直接进入新建表单并预填查找框 */
  seedFind?: string | null;
  onClose: () => void;
}

const SCOPE_OPTIONS: { value: ReplaceScope; label: string; hint: string }[] = [
  { value: "book", label: "仅本书", hint: "只作用于当前这本书" },
  { value: "global", label: "全局", hint: "对书架里所有书生效" },
];

interface Draft {
  find: string;
  replace: string;
  regex: boolean;
  scope: ReplaceScope;
}

function draftFrom(seed: string): Draft {
  return { find: seed, replace: "", regex: false, scope: "book" };
}

const inputCls =
  "w-full rounded-[10px] border border-border bg-bg px-[11px] py-[9px] text-[13.5px] text-text outline-none transition-colors focus:border-accent placeholder:text-text-3";

function Label(props: { children: JSX.Element; right?: JSX.Element }) {
  return (
    <div class="mb-[5px] flex items-center justify-between">
      <span class="text-[11.5px] font-semibold tracking-[0.03em] text-text-3">
        {props.children}
      </span>
      {props.right}
    </div>
  );
}

function Card(props: { children: JSX.Element }) {
  return (
    <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-bg">
      {props.children}
    </div>
  );
}

export function ReplaceRulesSheet(props: ReplaceRulesSheetProps) {
  // 编辑目标：null=列表视图；"__new__"=新建；其它=正在编辑的规则 id。
  // 组件随 open 每次重新挂载，初始值按入口类型确定（选区入口直接进新建表单）。
  const [editingId, setEditingId] = createSignal<string | null>(
    props.seedFind ? "__new__" : null,
  );
  const [draft, setDraft] = createSignal<Draft>(
    draftFrom(props.seedFind ?? ""),
  );
  const [error, setError] = createSignal("");

  // 列表数据：全局规则在前、本书规则在后（均保持创建顺序），响应式跟随存储
  const globalRules = createMemo(() =>
    replaceRuleList().filter((rule) => rule.scope === "global"),
  );
  const bookRules = createMemo(() =>
    replaceRuleList().filter(
      (rule) => rule.scope === "book" && rule.bookId === props.bookId,
    ),
  );
  const totalCount = createMemo(() => globalRules().length + bookRules().length);
  const editingRule = createMemo(() =>
    editingId() === null || editingId() === "__new__"
      ? null
      : replaceRuleList().find((rule) => rule.id === editingId()) ?? null,
  );
  const isNew = () => editingId() === "__new__";
  const isEditing = () => editingId() !== null;

  function enterEdit(rule: TextReplaceRule): void {
    setError("");
    setDraft({
      find: rule.find,
      replace: rule.replace,
      regex: rule.regex,
      scope: rule.scope,
    });
    setEditingId(rule.id);
  }

  function beginNew(): void {
    setError("");
    setDraft(draftFrom(""));
    setEditingId("__new__");
  }

  function backToList(): void {
    setError("");
    setEditingId(null);
  }

  function onSave(): void {
    const regex = draft().regex;
    const find = normalizeFindInput(draft().find, regex);
    const invalid = validateReplaceRule(find, regex);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (draft().scope === "book" && !props.bookId) {
      setError("缺少目标书籍，无法保存为「仅本书」");
      return;
    }
    const base = editingRule();
    const rule: TextReplaceRule = {
      id: base ? base.id : newReplaceRuleId(),
      scope: draft().scope,
      bookId: draft().scope === "book" ? props.bookId : "",
      find,
      replace: draft().replace,
      regex,
      createdAt: base ? base.createdAt : Date.now(),
    };
    if (base) {
      updateReplaceRule(rule);
      showToast("已保存替换");
    } else {
      addReplaceRule(rule);
      showToast("已添加替换");
    }
    backToList();
  }

  function onDelete(): void {
    const current = editingRule();
    if (!current) return;
    removeReplaceRule(current.id);
    showToast("已删除替换");
    backToList();
  }

  function scopeLabel(scope: ReplaceScope): string {
    return scope === "global" ? "全局" : "本书";
  }

  return (
    <Show when={props.open}>
      <div
        data-reader-ui
        class="absolute inset-0 z-[52] animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
        onClick={props.onClose}
      />
      <div
        data-reader-ui
        class="absolute inset-x-0 bottom-0 z-[53] flex max-h-[76%] animate-sheet-up select-none flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
        role="dialog"
        aria-label="文本替换"
      >
        {/* 标题栏 */}
        <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
          <Show
            when={isEditing()}
            fallback={<ReplaceIcon size={19} class="text-accent" />}
          >
            <button
              class="grid h-10 w-10 -ml-1 flex-none cursor-pointer place-items-center rounded-xl text-text-2 transition-colors active:bg-surface-2"
              aria-label="返回替换列表"
              onClick={backToList}
            >
              <ChevronRightIcon size={20} class="rotate-180" />
            </button>
          </Show>
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="text-[15px] font-bold">
              {isNew() ? "新建替换" : isEditing() ? "编辑替换" : "文本替换"}
            </span>
            <Show when={!isEditing()}>
              <span class="text-[10.5px] leading-tight text-text-3">
                仅影响阅读显示，不改动原文
              </span>
            </Show>
          </div>
          <button
            class="grid h-10 w-10 flex-none cursor-pointer place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label="关闭文本替换"
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </div>

        {/* 内容区 */}
        <Show
          when={isEditing()}
          fallback={
            <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(18px+env(safe-area-inset-bottom))] pt-3 scrollbar-none">
              <Show
                when={totalCount() > 0}
                fallback={
                  <div class="rounded-[14px] border border-dashed border-border bg-bg px-4 py-10 text-center text-[12.5px] text-text-3">
                    还没有文本替换
                  </div>
                }
              >
                <Show when={globalRules().length > 0}>
                  <h3 class="mx-1 mb-1.5 text-[11px] font-semibold tracking-[0.05em] text-text-3">
                    全局（所有书生效）
                  </h3>
                  <div class="mb-3">
                    <Card>
                      <For each={globalRules()}>
                        {(rule) => (
                          <RuleRow
                            rule={rule}
                            scopeLabel={scopeLabel(rule.scope)}
                            onEdit={() => enterEdit(rule)}
                            onDelete={() => {
                              removeReplaceRule(rule.id);
                              showToast("已删除替换");
                            }}
                          />
                        )}
                      </For>
                    </Card>
                  </div>
                </Show>
                <Show when={bookRules().length > 0}>
                  <h3 class="mx-1 mb-1.5 text-[11px] font-semibold tracking-[0.05em] text-text-3">
                    {props.bookTitle ? `仅《${props.bookTitle}》` : "仅当前这本书"}
                  </h3>
                  <div class="mb-3">
                    <Card>
                      <For each={bookRules()}>
                        {(rule) => (
                          <RuleRow
                            rule={rule}
                            scopeLabel={scopeLabel(rule.scope)}
                            onEdit={() => enterEdit(rule)}
                            onDelete={() => {
                              removeReplaceRule(rule.id);
                              showToast("已删除替换");
                            }}
                          />
                        )}
                      </For>
                    </Card>
                  </div>
                </Show>
              </Show>

              <button
                class="flex w-full items-center justify-center gap-1.5 rounded-[14px] border border-accent/40 bg-accent-weak px-4 py-[12px] text-[13.5px] font-semibold text-accent transition-colors active:bg-surface-2"
                onClick={beginNew}
              >
                <PlusIcon size={16} />
                新建替换
              </button>
            </div>
          }
        >
          {/* 编辑 / 新建表单 */}
          <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-[calc(18px+env(safe-area-inset-bottom))] pt-3.5 scrollbar-none">
            <div class="space-y-3">
              <label class="block min-w-0">
                <Label
                  right={
                    <button
                      type="button"
                      class="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-accent transition-colors active:bg-surface-2"
                      classList={{ "text-text-3": !draft().regex }}
                      onClick={() =>
                        setDraft((d) => ({ ...d, regex: !d.regex }))
                      }
                      aria-pressed={draft().regex}
                    >
                      <RegexIcon size={13} />
                      正则
                    </button>
                  }
                >
                  查找
                </Label>
                <input
                  class={inputCls}
                  value={draft().find}
                  placeholder="要被替换的文字"
                  onInput={(e) => {
                    setDraft((d) => ({ ...d, find: e.currentTarget.value }));
                    if (error()) setError("");
                  }}
                />
              </label>

              <label class="block min-w-0">
                <Label>替换为</Label>
                <input
                  class={inputCls}
                  value={draft().replace}
                  placeholder="留空 = 删除匹配文字"
                  onInput={(e) =>
                    setDraft((d) => ({
                      ...d,
                      replace: e.currentTarget.value,
                    }))
                  }
                />
              </label>

              <div class="block min-w-0">
                <Label>作用范围</Label>
                <div class="flex gap-2">
                  <For each={SCOPE_OPTIONS}>
                    {(opt) => (
                      <button
                        type="button"
                        class="flex-1 cursor-pointer rounded-[10px] border px-3 py-[9px] text-left transition-colors"
                        classList={{
                          "border-accent bg-accent-weak": draft().scope === opt.value,
                          "border-border bg-bg": draft().scope !== opt.value,
                        }}
                        onClick={() =>
                          setDraft((d) => ({ ...d, scope: opt.value }))
                        }
                        aria-pressed={draft().scope === opt.value}
                      >
                        <span
                          class="flex items-center justify-between text-[13px] font-semibold"
                          classList={{
                            "text-accent": draft().scope === opt.value,
                            "text-text-2": draft().scope !== opt.value,
                          }}
                        >
                          {opt.label}
                          <Show when={draft().scope === opt.value}>
                            <CheckIcon size={14} />
                          </Show>
                        </span>
                        <span class="mt-0.5 block text-[10.5px] leading-snug text-text-3">
                          {draft().scope === opt.value && props.bookTitle && opt.value === "book"
                            ? `只作用《${props.bookTitle}》`
                            : opt.hint}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>

            <Show when={draft().regex}>
              <p class="-mt-1 text-[11px] leading-[1.65] text-text-3">
                按正则表达式查找并全部替换，替换内容支持{" "}
                <code class="rounded bg-surface-2 px-1 py-0.5 text-[10px]">$1</code>{" "}
                等捕获组引用；去掉正则即按普通文字匹配。
              </p>
            </Show>

            <Show when={error()}>
              <p
                class="rounded-[10px] bg-danger-weak px-[13px] py-2.5 text-[12.5px] leading-[1.5] text-danger"
                role="alert"
              >
                {error()}
              </p>
            </Show>

            <div class="space-y-2.5 pt-0.5">
              <button
                class="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-[22px] py-[11px] text-sm font-semibold text-on-accent shadow-lg shadow-accent/30 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                onClick={onSave}
              >
                <CheckIcon size={17} />
                保存替换
              </button>
              <Show when={editingRule()}>
                <button
                  class="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-danger/40 bg-danger-weak px-[22px] py-[11px] text-sm font-semibold text-danger transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                  onClick={onDelete}
                >
                  <TrashIcon size={17} />
                  删除此替换
                </button>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
}

/** 列表里的单条替换 */
function RuleRow(props: {
  rule: TextReplaceRule;
  scopeLabel: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const rule = () => props.rule;
  return (
    <div
      role="button"
      tabIndex={0}
      class="flex w-full cursor-pointer items-center gap-3 px-4 py-[11px] text-left transition-colors active:bg-surface-2"
      onClick={props.onEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onEdit();
        }
      }}
      aria-label={`编辑替换：${rule().find}`}
    >
      <span class="grid h-[36px] w-[36px] flex-none place-items-center rounded-[10px] bg-surface-2 text-accent">
        <ReplaceIcon size={18} />
      </span>
      <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span class="flex items-center gap-1.5">
          <i class="not-italic rounded-full bg-accent-weak px-1.5 py-px text-[9.5px] font-semibold text-accent">
            {props.scopeLabel}
          </i>
          <Show when={rule().regex}>
            <i class="not-italic inline-flex items-center gap-0.5 rounded-full bg-surface-2 px-1.5 py-px text-[9.5px] font-semibold text-text-3">
              <RegexIcon size={10} />
              正则
            </i>
          </Show>
        </span>
        <span class="max-w-full truncate text-[13.5px] font-medium text-text">
          {rule().find}
        </span>
        <span
          class="max-w-full truncate text-[11.5px] text-text-3"
          classList={{ "italic": !rule().replace }}
        >
          {rule().replace || "删除匹配文字"}
        </span>
      </span>
      <span class="flex flex-none items-center gap-1">
        <button
          type="button"
          tabIndex={-1}
          aria-label={`删除替换：${rule().find}`}
          class="grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-text-3 transition-colors active:bg-danger-weak active:text-danger"
          onClick={(e) => {
            e.stopPropagation();
            props.onDelete();
          }}
        >
          <TrashIcon size={16} />
        </button>
        <ChevronRightIcon size={16} class="text-text-3" />
      </span>
    </div>
  );
}

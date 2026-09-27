import { createSignal, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  currentSourcePrompt,
  queuedSourcePromptCount,
  submitSourcePrompt,
  validatePromptValues,
  type SourcePromptField,
  type SourcePromptRequest,
} from "../lib/sourcePrompt";
import { showToast } from "../lib/toast";
import { t } from "../lib/i18n";

/**
 * 书源输入表单弹层（`input.prompt`）。
 *
 * 显示队首表单：书源那边正阻塞等这份输入，所以弹层挂在全局（Portal 到 body），
 * 不受当前页面 / 抽屉影响；提交或取消后自动切到下一张排队的表单。
 */
export function SourcePromptDialog() {
  return (
    <Show when={currentSourcePrompt()} keyed>
      {(request) => <PromptCard request={request} />}
    </Show>
  );
}

function PromptCard(props: { request: SourcePromptRequest }) {
  const [values, setValues] = createSignal<Record<string, string>>(initialValues(props.request));
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let firstInput: HTMLInputElement | undefined;

  onMount(() => {
    // 弹层出现就聚焦第一个字段：手机上直接弹键盘，桌面端不必先点一下
    firstInput?.focus();
  });

  const pending = () => Math.max(0, queuedSourcePromptCount() - 1);

  async function submit() {
    if (busy()) return;
    const invalid = validatePromptValues(props.request, values());
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    const failure = await submitSourcePrompt(props.request.id, values(), false);
    setBusy(false);
    if (!failure) return;
    setError(
      failure.code === "expired" ? t("prompt.error.expired") : t("prompt.error.invalid"),
    );
    if (failure.code === "expired") showToast(t("prompt.error.expired"), true);
  }

  async function cancel() {
    if (busy()) return;
    setBusy(true);
    await submitSourcePrompt(props.request.id, null, true);
    setBusy(false);
  }

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[95] grid place-items-center overflow-y-auto px-6 py-8"
        role="dialog"
        aria-modal="true"
        aria-label={props.request.title || t("prompt.title")}
      >
        {/* 表单里可能有用户已经敲了一半的内容：点遮罩不取消，只能显式点「取消」 */}
        <div class="absolute inset-0 animate-sheet-fade bg-black/50 backdrop-blur-[2px]" />
        <form
          class="relative w-full max-w-[360px] animate-pop-in rounded-[18px] border border-border bg-surface p-4 shadow-[0_18px_50px_rgb(0_0_0/0.35)]"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p class="text-[15px] font-bold leading-snug">
            {props.request.title || t("prompt.title")}
          </p>
          <p class="mt-1 text-[11.5px] text-text-3">
            {t("prompt.fromSource", { name: props.request.sourceName })}
          </p>
          <Show when={props.request.message}>
            <p class="mt-2 text-[12.5px] leading-[1.7] text-text-2">{props.request.message}</p>
          </Show>

          <div class="mt-3 flex flex-col gap-3">
            <For each={props.request.fields}>
              {(field, index) => (
                <Field
                  field={field}
                  value={values()[field.key] ?? ""}
                  onInput={(value) => {
                    setError(null);
                    setValues((current) => ({ ...current, [field.key]: value }));
                  }}
                  ref={(element) => {
                    if (index() === 0) firstInput = element;
                  }}
                />
              )}
            </For>
          </div>

          <Show when={error()}>
            {(message) => (
              <p class="mt-3 text-[12px] leading-[1.6] text-danger">{message()}</p>
            )}
          </Show>

          <Show when={pending() > 0}>
            <p class="mt-3 text-[11.5px] text-text-3">
              {t("prompt.queued", { count: pending() })}
            </p>
          </Show>

          <div class="mt-3.5 flex items-center gap-2.5">
            <button
              class="flex-1 rounded-xl border border-border bg-bg px-4 py-[10px] text-[13.5px] font-medium text-text-2 transition-colors active:bg-surface-2"
              type="button"
              disabled={busy()}
              onClick={() => void cancel()}
            >
              {t("common.cancel")}
            </button>
            <button
              class="flex-1 rounded-xl bg-accent px-4 py-[10px] text-[13.5px] font-semibold text-on-accent shadow-lg shadow-accent/25 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
              type="submit"
              disabled={busy()}
            >
              {t("prompt.submit")}
            </button>
          </div>
        </form>
      </div>
    </Portal>
  );
}

/** 各字段的初始值（书源给的预填值，没有就空串） */
function initialValues(request: SourcePromptRequest): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of request.fields) values[field.key] = field.defaultValue ?? "";
  return values;
}

function Field(props: {
  field: SourcePromptField;
  value: string;
  onInput: (value: string) => void;
  ref: (element: HTMLInputElement) => void;
}) {
  return (
    <label class="flex flex-col gap-1">
      <span class="flex items-center gap-1.5 text-[12.5px] font-medium text-text-2">
        {props.field.label}
        <Show when={props.field.required}>
          <span class="text-[11px] font-normal text-text-3">{t("prompt.required")}</span>
        </Show>
      </span>
      <input
        class="rounded-[10px] border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors placeholder:text-text-3 focus:border-accent"
        type={props.field.type === "number" ? "number" : props.field.type}
        value={props.value}
        placeholder={props.field.placeholder ?? ""}
        maxlength={props.field.maxLength && props.field.maxLength > 0 ? props.field.maxLength : undefined}
        min={props.field.type === "number" ? props.field.min : undefined}
        max={props.field.type === "number" ? props.field.max : undefined}
        inputmode={props.field.type === "number" ? "decimal" : undefined}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck={false}
        ref={(element) => props.ref(element)}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  );
}

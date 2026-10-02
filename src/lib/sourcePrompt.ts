/**
 * 书源「用户输入表单」（`input.prompt`）的前端接线。
 *
 * 书源在引擎里阻塞等用户填写，Rust 侧把表单推给这里（`readerx-source-prompt` 事件）：
 * - 表单进队列，一次只显示一张（多书源并发调用时不会一屏接一屏地跳）；
 * - 提交 / 取消经 `readerx_source_prompt_submit` 回传，引擎那次调用随即继续；
 * - 订阅之前发出的表单由 `readerx_source_prompt_pending` 补拉，不依赖事件到达顺序。
 *
 * 界面上只做「必填 / 数字范围 / 长度」的即时校验（与 Rust 侧同一套口径，Rust 还会再校验一次）。
 */
import { createSignal } from "solid-js";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createLogger } from "./logger";
import { t } from "./i18n";

const log = createLogger("source-prompt");

/** 表单推送事件（与 Rust 侧 `source_prompt::SourcePromptEvent` 一一对应） */
const PROMPT_EVENT = "readerx-source-prompt";
/** 表单作废（等待超时）事件：界面据此收起弹层 */
const PROMPT_CLOSE_EVENT = "readerx-source-prompt-close";

export type SourcePromptFieldType = "text" | "password" | "number";

export interface SourcePromptField {
  key: string;
  label: string;
  type: SourcePromptFieldType;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
}

export interface SourcePromptRequest {
  id: number;
  sourceId: string;
  sourceName: string;
  title: string;
  message: string;
  fields: SourcePromptField[];
}

/** 提交失败的结构化原因（与 Rust 侧 `PromptSubmitError` 对应） */
export interface SourcePromptSubmitError {
  code?: "invalid" | "expired";
  message?: string;
}

/** 待显示的表单队列（队首正在显示） */
const [queue, setQueue] = createSignal<SourcePromptRequest[]>([]);

/** 队首表单（没有则为 null） */
export function currentSourcePrompt(): SourcePromptRequest | null {
  return queue()[0] ?? null;
}

/** 排队等待的表单数量（界面用来提示「还有 N 张」） */
export function queuedSourcePromptCount(): number {
  return queue().length;
}

/**
 * 安装事件订阅（启动时调用一次，幂等）。
 *
 * 订阅成功后再补拉一次「仍在等待的表单」：应用刚启动就触发的书源调用（如自动同步）
 * 可能在订阅之前就把表单推出来了，只靠事件会漏掉，引擎那边一直等到超时。
 */
const listening = { started: false };

export async function initSourcePrompts(): Promise<void> {
  if (!isTauri() || listening.started) return;
  listening.started = true;
  try {
    await listen<SourcePromptRequest>(PROMPT_EVENT, (event) => enqueue(event.payload));
    await listen<number>(PROMPT_CLOSE_EVENT, (event) => dismiss(event.payload));
    const pending = await invoke<SourcePromptRequest[]>("readerx_source_prompt_pending");
    for (const request of pending) enqueue(request);
  } catch (error) {
    // 订阅失败只影响这次运行里的表单（引擎侧会等到超时），记一条日志即可
    listening.started = false;
    log.warn("订阅书源输入表单失败", error);
  }
}

function enqueue(request: SourcePromptRequest): void {
  if (!request || typeof request.id !== "number" || !Array.isArray(request.fields)) {
    log.warn("收到无法识别的输入表单", request);
    return;
  }
  setQueue((list) => (list.some((item) => item.id === request.id) ? list : [...list, request]));
  log.debug("弹出输入表单", `source=${request.sourceId} fields=${request.fields.length}`);
}

function dismiss(id: number): void {
  setQueue((list) => list.filter((item) => item.id !== id));
}

/**
 * 回传一张表单：`values` 为字段值（取消时传 null、`cancelled` 为 true）。
 *
 * 返回 `null` 表示已受理；返回错误则说明这次提交没被接受：
 * `expired`（表单已作废，界面要收起）或 `invalid`（值不合法，界面留在原地让用户改）。
 */
export async function submitSourcePrompt(
  id: number,
  values: Record<string, string> | null,
  cancelled: boolean,
): Promise<SourcePromptSubmitError | null> {
  try {
    await invoke("readerx_source_prompt_submit", { id, values, cancelled });
    dismiss(id);
    return null;
  } catch (error) {
    const failure = normalizeSubmitError(error);
    if (failure.code === "expired") dismiss(id);
    // 具体原因（Rust 侧文案）只进日志：界面按 code 出本地化文案
    log.warn("提交输入表单失败", failure.code ?? "unknown", failure.message ?? "");
    return failure;
  }
}

/** 归一化 invoke 的拒绝值：Rust 侧给结构化对象，被中间层转成字符串时按文案兜底判断 */
function normalizeSubmitError(error: unknown): SourcePromptSubmitError {
  if (typeof error === "string") {
    return error.includes("失效") ? { code: "expired", message: error } : { code: "invalid", message: error };
  }
  if (error && typeof error === "object") {
    const detail = error as SourcePromptSubmitError;
    if (detail.code === "expired" || detail.code === "invalid") return detail;
    return { code: "invalid", message: detail.message };
  }
  return { code: "invalid" };
}

/** 一次校验的结果：`null` = 通过；否则是可直接显示的文案 */
export function validatePromptValues(
  request: SourcePromptRequest,
  values: Record<string, string>,
): string | null {
  for (const field of request.fields) {
    const value = values[field.key] ?? "";
    if (field.required && value.trim() === "") {
      return t("prompt.error.required", { label: field.label });
    }
    if (field.type === "number" && value.trim() !== "") {
      const number = Number(value.trim());
      if (!Number.isFinite(number)) return t("prompt.error.number", { label: field.label });
      const { min, max } = field;
      if (typeof min === "number" && typeof max === "number" && (number < min || number > max)) {
        return t("prompt.error.range", { label: field.label, min, max });
      }
      if (typeof min === "number" && number < min) {
        return t("prompt.error.min", { label: field.label, min });
      }
      if (typeof max === "number" && number > max) {
        return t("prompt.error.max", { label: field.label, max });
      }
    }
    const limit = field.maxLength;
    if (typeof limit === "number" && limit > 0 && [...value].length > limit) {
      return t("prompt.error.tooLong", { label: field.label, count: limit });
    }
  }
  return null;
}

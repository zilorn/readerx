import { createSignal } from "solid-js";

export interface ToastState {
  text: string;
  error: boolean;
}

const [toastState, setToastState] = createSignal<ToastState | null>(null);
let toastTimer: number | undefined;

/** 轻量全局提示（导入成功/失败等操作反馈）；错误提示默认停留更久 */
export function showToast(text: string, error = false, durationMs?: number): void {
  window.clearTimeout(toastTimer);
  setToastState({ text, error });
  toastTimer = window.setTimeout(() => setToastState(null), durationMs ?? (error ? 3200 : 2200));
}

export function currentToast(): ToastState | null {
  return toastState();
}

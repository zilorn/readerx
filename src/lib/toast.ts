import { createSignal } from "solid-js";

/** 提示里的操作按钮（如入架后的「加入分组」），用强调色渲染 */
export interface ToastAction {
  label: string;
  /** 点击回调；提示会先收起，避免遮住随后弹出的抽屉 / 弹层 */
  onClick: () => void;
}

export interface ToastState {
  text: string;
  error: boolean;
  action?: ToastAction;
}

const [toastState, setToastState] = createSignal<ToastState | null>(null);
let toastTimer: number | undefined;

function present(state: ToastState, durationMs: number): void {
  window.clearTimeout(toastTimer);
  setToastState(state);
  toastTimer = window.setTimeout(() => setToastState(null), durationMs);
}

/** 轻量全局提示（导入成功/失败等操作反馈）；错误提示默认停留更久 */
export function showToast(text: string, error = false, durationMs?: number): void {
  present({ text, error }, durationMs ?? (error ? 3200 : 2200));
}

/**
 * 带操作按钮的提示（如「已放入书架」+「加入分组」）。
 * 停留时间更长，留出看清文字并点按按钮的时间。
 */
export function showActionToast(text: string, action: ToastAction, durationMs = 6000): void {
  present({ text, error: false, action }, durationMs);
}

/** 立即收起当前提示（按钮点击后、或提示该被界面盖住时用） */
export function dismissToast(): void {
  window.clearTimeout(toastTimer);
  setToastState(null);
}

export function currentToast(): ToastState | null {
  return toastState();
}

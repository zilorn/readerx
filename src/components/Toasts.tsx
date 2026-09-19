/**
 * 全局提示条（Toast）：操作反馈（导入成功 / 失败、已放入书架…）。
 *
 * 由两个外壳（手机 / 桌面）共同渲染——提示属于整个应用，不属于某一页，
 * 所以它挂在路由出口之外，切页不打断。
 */
import { Show } from "solid-js";
import { currentToast, dismissToast } from "../lib/toast";

export function Toasts() {
  return (
    <Show when={currentToast()}>
      {(toast) => (
        <div
          class="absolute bottom-[calc(84px+env(safe-area-inset-bottom))] left-1/2 z-[95] max-w-[calc(100%-48px)] animate-toast-in text-[13px] leading-[1.4] shadow-lg shadow-black/20 [transform:translateX(-50%)]"
          classList={{
            "rounded-full px-4 py-[9px] text-center": !toast().action,
            "bg-text text-bg": !toast().action && !toast().error,
            "bg-danger text-white": !toast().action && toast().error,
            "flex items-center gap-1.5 rounded-[14px] border border-border bg-surface py-1.5 pl-3.5 pr-1.5 text-text":
              !!toast().action,
          }}
          role={toast().error ? "alert" : "status"}
        >
          <span class="min-w-0">{toast().text}</span>
          <Show when={toast().action}>
            {(action) => (
              <button
                class="flex-none rounded-[10px] bg-accent-weak px-2.5 py-1 font-semibold text-accent transition-[scale,opacity] duration-100 active:scale-[0.96] active:opacity-80"
                onClick={() => {
                  const run = action().onClick;
                  dismissToast();
                  run();
                }}
              >
                {action().label}
              </button>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

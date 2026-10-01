import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CloseIcon, WindowMaximizeIcon, WindowMinimizeIcon, WindowRestoreIcon } from "../components/icons";
import { reportFailure } from "../lib/errorReport";
import { createLogger } from "../lib/logger";
import { t } from "../lib/i18n";

const log = createLogger("DesktopTitleBar");

/** 桌面宿主窗口控件独立于响应式外壳，窄窗口仍可操作。 */
export function DesktopTitleBar() {
  const appWindow = getCurrentWindow();
  const [maximized, setMaximized] = createSignal(false);
  const [fullscreen, setFullscreen] = createSignal(false);
  let disposed = false;
  let revision = 0;
  let unlisten: (() => void) | undefined;
  onCleanup(() => { disposed = true; unlisten?.(); });

  async function syncState() {
    const current = ++revision;
    const [max, full] = await Promise.all([appWindow.isMaximized(), appWindow.isFullscreen()]);
    if (disposed || current !== revision) return;
    setMaximized(max);
    setFullscreen(full);
  }
  onMount(() => {
    void (async () => {
      const stop = await appWindow.onResized(() => {
        void syncState().catch((error) => log.warn("读取窗口状态失败", error));
      });
      if (disposed) { stop(); return; }
      unlisten = stop;
      await syncState();
    })().catch((error) => log.warn("监听窗口状态失败", error));
  });

  async function run(action: () => Promise<void>) {
    try { await action(); }
    catch (error) { reportFailure(t("shell.window.failed"), error); }
  }
  const maximizeLabel = () => t(maximized() ? "shell.window.restore" : "shell.window.maximize");
  const buttonClass = "grid h-9 w-11 flex-none place-items-center text-text-2 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2";

  return (
    <Show when={!fullscreen()}>
      <header class="flex h-9 flex-none select-none items-center border-b border-border bg-surface">
        <div
          class="flex h-full min-w-0 flex-1 items-center px-4 text-xs font-medium text-text-2"
          onMouseDown={(event) => {
            if (event.button === 0 && event.detail === 1) void run(() => appWindow.startDragging());
          }}
          onDblClick={() => void run(() => appWindow.toggleMaximize())}
        >ReaderX</div>
        <button type="button" class={buttonClass} title={t("shell.window.minimize")} aria-label={t("shell.window.minimize")} onClick={() => void run(() => appWindow.minimize())}>
          <WindowMinimizeIcon size={16} />
        </button>
        <button type="button" class={buttonClass} title={maximizeLabel()} aria-label={maximizeLabel()} onClick={() => void run(() => appWindow.toggleMaximize())}>
          <Show when={maximized()} fallback={<WindowMaximizeIcon size={16} />}><WindowRestoreIcon size={16} /></Show>
        </button>
        <button type="button" class={buttonClass} title={t("shell.window.close")} aria-label={t("shell.window.close")} onClick={() => void run(() => appWindow.close())}>
          <CloseIcon size={16} />
        </button>
      </header>
    </Show>
  );
}

import { useLocation } from "@solidjs/router";
import { pageTitleForPath, usesWindowPageTitle } from "./pageTitle";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronLeftIcon, CloseIcon, WindowMaximizeIcon, WindowMinimizeIcon, WindowRestoreIcon } from "../components/icons";
import { reportFailure } from "../lib/errorReport";
import { createLogger } from "../lib/logger";
import { t } from "../lib/i18n";

const log = createLogger("DesktopTitleBar");

/** 桌面宿主窗口控件独立于响应式外壳，窄窗口仍可操作。 */
export function DesktopTitleBar() {
  const location = useLocation();
  const page = createMemo(() => usesWindowPageTitle() ? pageTitleForPath(location.pathname) : undefined);
  const title = () => page()?.title ? t("shell.window.pageTitle", { title: page()!.title }) : "ReaderX";
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
  const buttonClass = () => `${usesWindowPageTitle() ? "h-11" : "h-9"} grid w-11 flex-none place-items-center text-text-2 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2`;

  return (
    <Show when={!fullscreen() || usesWindowPageTitle()}>
      <header data-window-titlebar class="flex flex-none select-none items-center border-b border-border bg-surface" classList={{ "h-11": usesWindowPageTitle(), "h-9": !usesWindowPageTitle() }}>
        <Show when={page()?.onBack}>
          <button type="button" class={buttonClass()} title={page()?.backLabel ?? t("common.back")} aria-label={page()?.backLabel ?? t("common.back")} onClick={() => page()?.onBack?.()}>
            <ChevronLeftIcon size={21} />
          </button>
        </Show>
        <div
          class="flex h-full min-w-0 flex-1 items-center"
          onMouseDown={(event) => {
            if ((event.target as Element).closest("button")) return;
            if (!fullscreen() && event.button === 0 && event.detail === 1) void run(() => appWindow.startDragging());
          }}
          onDblClick={(event) => { if (!(event.target as Element).closest("button") && !fullscreen()) void run(() => appWindow.toggleMaximize()); }}
        >
          <div
            class="flex min-w-0 items-center px-4 text-xs font-medium text-text-2"
            title={page()?.subtitle ? `${title()} · ${page()!.subtitle}` : title()}
            aria-label={title()}
          >
            <span class="truncate">{title()}</span>
            <Show when={page()?.subtitle}><span class="ml-2 truncate text-text-3">· {page()!.subtitle}</span></Show>
          </div>
          {page()?.afterTitle}
        </div>
        <div class="flex min-w-0 flex-none items-center gap-1 px-1">{page()?.right}</div>
        <Show when={fullscreen()} fallback={<>
          <button type="button" class={buttonClass()} title={t("shell.window.minimize")} aria-label={t("shell.window.minimize")} onClick={() => void run(() => appWindow.minimize())}>
            <WindowMinimizeIcon size={16} />
          </button>
          <button type="button" class={buttonClass()} title={maximizeLabel()} aria-label={maximizeLabel()} onClick={() => void run(() => appWindow.toggleMaximize())}>
            <Show when={maximized()} fallback={<WindowMaximizeIcon size={16} />}><WindowRestoreIcon size={16} /></Show>
          </button>
          <button type="button" class={buttonClass()} title={t("shell.window.close")} aria-label={t("shell.window.close")} onClick={() => void run(() => appWindow.close())}>
            <CloseIcon size={16} />
          </button>
        </>}>
          <button type="button" class={buttonClass()} title={t("shell.window.exitFullscreen")} aria-label={t("shell.window.exitFullscreen")} onClick={() => void run(async () => { await appWindow.setFullscreen(false); await syncState(); })}>
            <WindowRestoreIcon size={16} />
          </button>
        </Show>
      </header>
    </Show>
  );
}

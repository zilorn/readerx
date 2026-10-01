import { invoke, isTauri } from "@tauri-apps/api/core";
import { readState } from "./backend";
import { t } from "./i18n";
import { createLogger } from "./logger";
import { reportFailure } from "./errorReport";
import { openExternal } from "./external";
import { showActionToast, showToast } from "./toast";
import { appUpdateChecking, autoAppUpdate, setAutoAppUpdate, setAppUpdateChecking,
  setAvailableAppUpdate, type AppUpdate } from "./store";
const log = createLogger("app-updates");
let notifiedVersion = "";
let lastAutoCheck = 0;
export async function checkAppUpdate(manual = true): Promise<void> {
  if (appUpdateChecking()) return;
  if (!isTauri()) {
    if (manual) showToast(t("settings.update.appOnly"));
    return;
  }
  setAppUpdateChecking(true);
  try {
    const update = await invoke<AppUpdate | null>("readerx_update_check");
    setAvailableAppUpdate(update);
    if (update && (manual || (autoAppUpdate() && notifiedVersion !== update.version))) {
      notifiedVersion = update.version;
      showActionToast(t("settings.update.found", { version: update.version }), {
        label: t("settings.update.view"),
        onClick: () => { void openExternal("https://github.com/zilorn/readerx/releases/latest"); },
      }, 8000);
    } else if (!update && manual) showToast(t("settings.update.latest"));
  } catch (error) {
    if (manual) reportFailure(t("settings.update.failed"), error);
    else log.debug("自动检查更新失败", error);
  } finally { setAppUpdateChecking(false); }
}
export function startAppUpdateDiscovery(): () => void {
  let disposed = false;
  const check = () => {
    if (!autoAppUpdate() || appUpdateChecking() || Date.now() - lastAutoCheck < 6 * 60 * 60 * 1000) return;
    lastAutoCheck = Date.now();
    void checkAppUpdate(false);
  };
  void readState<boolean>("readerx.autoAppUpdate").then(value => {
    if (disposed) return;
    setAutoAppUpdate(value !== false);
    check();
  });
  const timer = window.setInterval(check, 6 * 60 * 60 * 1000);
  const visible = () => { if (document.visibilityState === "visible") check(); };
  document.addEventListener("visibilitychange", visible);
  return () => { disposed = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
}
export async function downloadAppUpdate(url: string): Promise<void> {
  try { await openExternal(url); }
  catch (error) { reportFailure(t("settings.update.downloadFailed"), error); }
}

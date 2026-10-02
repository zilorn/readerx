import { invoke } from "@tauri-apps/api/core";
import { isAndroidPlatform } from "./platform";
import { reportFailure } from "./errorReport";
import { t } from "./i18n";

// 顺序发送：快速开关、跨页卸载时，最后一次禁用不能被较早的启用覆盖。
let writeQueue: Promise<void> = Promise.resolve();

export function setVolumeKeysActive(enabled: boolean): void {
  if (!isAndroidPlatform()) return;
  writeQueue = writeQueue.then(async () => {
    try {
      await invoke("readerx_volume_keys_set_enabled", { enabled });
    } catch (error) {
      reportFailure(t("readerChrome.reading.volumeKeysFailed"), error);
    }
  });
}

/**
 * 安卓实体返回键接管。
 *
 * Tauri 的 app 插件在安卓上提供 `back-button` 事件（见 tauri 的 AppPlugin.kt）：
 * 前端注册了监听就由前端消费返回键，没有监听才走默认的 WebView 历史返回。
 * 因此只在页面确实能消费返回时（[`createAndroidBackHandler`] 的 `active` 为真）注册，
 * 其余情况注销监听、把返回键交还系统，避免出现按了没反应的返回。
 */
import { createEffect, onCleanup } from "solid-js";
import { onBackButtonPress } from "@tauri-apps/api/app";
import type { PluginListener } from "@tauri-apps/api/core";
import { isAndroidPlatform } from "./platform";
import { createLogger } from "./logger";

const log = createLogger("android-back");

/**
 * 让 `handler` 接管安卓返回键：`active` 为真时返回键交给 `handler`（不再回退历史），
 * 为假时撤销监听、恢复系统默认返回；非安卓环境不注册。`active` 会被追踪。
 */
export function createAndroidBackHandler(
  active: () => boolean,
  handler: () => void,
): void {
  let listener: PluginListener | undefined;
  let registered = false;
  let disposed = false;

  const unregisterListener = (target: PluginListener) =>
    target.unregister().catch((error) => log.warn("撤销安卓返回键监听失败", error));

  function unregister(): void {
    const current = listener;
    listener = undefined;
    if (current) void unregisterListener(current);
  }

  createEffect(() => {
    const shouldHandle = isAndroidPlatform() && active();
    if (shouldHandle === registered) return;
    registered = shouldHandle;
    if (!shouldHandle) {
      unregister();
      return;
    }
    void onBackButtonPress(() => {
      // 注销与事件到达之间可能已经不需要接管：以注册状态为准，别吃掉返回键
      if (registered) handler();
    })
      .then((created) => {
        if (registered && !disposed) listener = created;
        else void unregisterListener(created);
      })
      .catch((error) => {
        registered = false;
        log.warn("注册安卓返回键监听失败", error);
      });
  });

  onCleanup(() => {
    disposed = true;
    registered = false;
    unregister();
  });
}

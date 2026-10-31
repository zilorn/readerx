/**
 * HarmonyOS / 浏览器 PWA 接线（只用标准 Web API，不引第三方包）。
 *
 * - Service Worker 缓存应用外壳与构建产物，安装后离线也能打开；
 * - `beforeinstallprompt` 保存浏览器的安装事件，设置页据此提供「安装到桌面」；
 * - 首次启动请求持久化存储，尽量避免系统在空间紧张时清掉 IndexedDB 里的书库。
 *
 * Tauri 宿主（Android / Linux / Windows）不走这里：它们由原生安装包与文件系统负责。
 */
import { createSignal } from "solid-js";
import { createLogger } from "./logger";
import {
  isHarmonyHap,
  isHarmonyPlatform,
  isStandaloneWebApp,
  isTauriHost,
} from "./platform";

const log = createLogger("pwa");

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const [installEvent, setInstallEvent] = createSignal<InstallPromptEvent | null>(null);
let initialized = false;

/** 当前浏览器是否给出了可用的安装事件（HarmonyOS 桌面菜单安装不触发时为空）。 */
export function canInstallPwa(): boolean {
  return !isTauriHost() && installEvent() !== null;
}

/** 拉起系统安装确认框；用户接受返回 true。 */
export async function installPwa(): Promise<boolean> {
  const event = installEvent();
  if (!event) return false;
  setInstallEvent(null);
  try {
    await event.prompt();
    const choice = await event.userChoice;
    if (choice.outcome === "accepted") {
      log.info("用户已安装 PWA");
      return true;
    }
    return false;
  } catch (error) {
    log.warn("拉起 PWA 安装失败", error);
    return false;
  }
}

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  const base = import.meta.env.BASE_URL;
  navigator.serviceWorker
    .register(`${base}sw.js`, { scope: base })
    .then(() => log.info("PWA Service Worker 已注册"))
    .catch((error) => log.warn("PWA Service Worker 注册失败", error));
}

export function initPwa(): void {
  if (initialized || isTauriHost() || typeof window === "undefined") return;
  initialized = true;
  if (isHarmonyHap()) {
    // HAP 已把 dist 打进安装包，离线由 rawfile 提供；Service Worker 在拦截响应下
    // 既没有稳定的网络来源，也没有必要，跳过注册与安装提示。
    log.info("HarmonyOS HAP 内置资源，跳过 PWA 安装流程");
    return;
  }
  log.info(
    isHarmonyPlatform() ? "HarmonyOS Web 环境" : "浏览器环境",
    isStandaloneWebApp() ? "独立窗口" : "普通标签页",
  );

  window.addEventListener("beforeinstallprompt", (event) => {
    // 默认横幅会遮住阅读界面；交给设置页里的明确入口。
    event.preventDefault();
    setInstallEvent(event as InstallPromptEvent);
  });
  window.addEventListener("appinstalled", () => {
    setInstallEvent(null);
    log.info("PWA 已安装");
  });

  if (import.meta.env.PROD) {
    registerServiceWorker();
    // 书库与译文都在 IndexedDB；能拿到持久化配额就别让系统随手回收。
    if (navigator.storage?.persist) {
      navigator.storage
        .persist()
        .then((granted) => {
          if (granted) log.info("浏览器已授予持久化存储");
          else log.debug("浏览器未授予持久化存储，数据仍会尽量保留");
        })
        .catch((error) => log.debug("请求持久化存储失败", error));
    }
  }
}

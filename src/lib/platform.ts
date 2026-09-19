/**
 * 运行环境判断：手机外壳（底部 Tab + 页面栈动画）还是桌面外壳（侧边导航 + 内容区）。
 *
 * 口径：
 * - 统一按**窗口宽度**决定（而不是编译期分支）：Tauri 里 Android 的窗口宽度就是屏幕宽度，
 *   手机永远走手机外壳；桌面窗口拉窄时自动回到手机外壳，等于一个响应式断点；
 * - 断点（[`DESKTOP_MIN_WIDTH`]）比手机列宽（480px）宽不少：侧边栏自己要占位，
 *   太窄的窗口用侧边栏反而更挤；
 * - 非 Tauri 环境（浏览器里 `pnpm dev`）同样按宽度判断，方便在桌面上直接调桌面布局。
 *
 * 信号在 `createRoot` 里建立并常驻（只监听一次，与调用方组件的生命周期无关），
 * 因此页面组件里直接调用 [`isDesktopShell`] 即可被追踪。
 */
import { createRoot, createSignal } from "solid-js";

/** 桌面外壳的最小窗口宽度（px） */
export const DESKTOP_MIN_WIDTH = 900;

function query(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`);
}

const desktop = createRoot(() => {
  const [value, setValue] = createSignal(query()?.matches ?? false);
  const media = query();
  if (media) {
    const sync = () => setValue(media.matches);
    media.addEventListener("change", sync);
    // 某些 WebView 的 matchMedia change 事件不可靠，窗口尺寸变化时兜底对账一次
    window.addEventListener("resize", sync);
  }
  return value;
});

/** 当前是否使用桌面外壳（响应式；窗口跨过断点会自动切换） */
export function isDesktopShell(): boolean {
  return desktop();
}

/** 是否运行在 Tauri 宿主内（浏览器里调试时为 false） */
export function isTauriHost(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 是否是移动端平台（由 UA 判定，与窗口宽度无关）。
 * 用于「只在手机上才有意义」的能力：系统文件选择器给出的临时路径等。
 */
export function isMobilePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/**
 * 是否是桌面平台（Tauri 宿主且 UA 不是移动端，与窗口宽度无关）。
 * 用于「只有桌面端才有」的系统能力：桌面窗口拉窄回退成手机外壳时这些能力依然在，
 * 所以这里看平台而不是 [`isDesktopShell`]（例如开发者工具，Android 的 WebView 不提供）。
 */
export function isDesktopPlatform(): boolean {
  return isTauriHost() && !isMobilePlatform();
}

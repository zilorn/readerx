import { createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js";

export interface ReaderAutoPageOptions {
  enabled: () => boolean;
  ready: () => boolean;
  interval: () => number;
  /** 阅读位置、排版和翻页模式改变时重新计时。 */
  position: () => unknown;
  /** false 表示已到书末；暂时不能翻页时返回 true，留待下次。 */
  advance: () => boolean;
  onEnd: () => void;
}

/** 每次只安排一次翻页；暂停恢复后完整计时，不补翻后台期间的页面。 */
export function createReaderAutoPage(options: ReaderAutoPageOptions): void {
  const [foreground, setForeground] = createSignal(!document.hidden);
  const [selected, setSelected] = createSignal(false);
  const [tick, setTick] = createSignal(0);
  onMount(() => {
    const onVisibility = () => setForeground(!document.hidden);
    const onBlur = () => setForeground(false);
    const onFocus = () => setForeground(!document.hidden);
    const onSelection = () => {
      const selection = window.getSelection();
      setSelected(!!selection && !selection.isCollapsed && !!selection.toString().trim());
    };
    onSelection();
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("selectionchange", onSelection);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("selectionchange", onSelection);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    });
  });
  createEffect(() => {
    options.position();
    tick();
    const seconds = options.interval();
    if (!options.enabled() || !options.ready() || !foreground() || selected()) return;
    const timer = window.setTimeout(() => {
      untrack(() => {
        if (!document.hidden && foreground() && !selected() && options.enabled() && options.ready()) {
          if (!options.advance()) options.onEnd();
        }
        setTick((value) => value + 1);
      });
    }, seconds * 1000);
    onCleanup(() => window.clearTimeout(timer));
  });
}

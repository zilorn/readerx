/** 阅读器纸张折叠层：只复制当前屏 DOM，不改变正文、选区或阅读进度。 */
export function createReaderPageTurn() {
  let root: HTMLDivElement | undefined;
  let front: HTMLDivElement | undefined;
  let back: HTMLDivElement | undefined;
  let shade: HTMLDivElement | undefined;
  let crease: HTMLDivElement | undefined;
  let frame = 0;
  let progress = 0;
  let width = 1;
  let direction: 1 | -1 = 1;
  let settling = false;
  let onSettled: (() => void) | undefined;

  function cancel(): void {
    window.cancelAnimationFrame(frame);
    frame = 0;
    root?.remove();
    root = front = back = shade = crease = undefined;
    settling = false;
    onSettled = undefined;
    progress = 0;
  }

  /** 新输入立即结束收尾动画，先落实已确认的翻页或回弹，再接受下一次操作。 */
  function interrupt(): boolean {
    if (!settling) return false;
    const done = onSettled;
    cancel();
    done?.();
    return true;
  }

  function snapshot(source: HTMLElement): HTMLDivElement {
    const copy = source.cloneNode(true) as HTMLDivElement;
    copy.removeAttribute("id");
    copy.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
    copy.style.opacity = "1";
    copy.style.visibility = "visible";
    copy.style.animation = "none";
    copy.style.background = "var(--bg)";
    return copy;
  }

  function layer(): HTMLDivElement {
    const el = document.createElement("div");
    Object.assign(el.style, { position: "absolute", inset: "0", overflow: "hidden" });
    return el;
  }

  function draw(value: number): void {
    progress = Math.max(0, Math.min(1, value));
    if (!front || !back || !shade || !crease) return;
    // 折线随拖动推进；翻起的纸背反射在折线另一侧。
    const edge = width * (direction > 0 ? 1 - progress : progress);
    const folded = Math.min(width * progress, width * (1 - progress));
    const left = direction > 0 ? edge - folded : edge;
    const right = direction > 0 ? edge : edge + folded;
    front.style.clipPath = direction > 0
      ? `inset(0 ${width - edge}px 0 0)`
      : `inset(0 0 0 ${edge}px)`;
    back.style.clipPath = `inset(0 ${Math.max(0, width - right)}px 0 ${Math.max(0, left)}px)`;
    const paper = back.firstElementChild as HTMLElement;
    paper.style.transform = `translateX(${2 * edge - width}px) scaleX(-1)`;
    const strength = Math.sin(Math.PI * progress);
    shade.style.opacity = `${strength * 0.22}`;
    shade.style.background = `linear-gradient(${direction > 0 ? "to right" : "to left"}, transparent, var(--text))`;
    Object.assign(shade.style, { left: `${left}px`, width: `${folded}px`, right: "auto" });
    Object.assign(crease.style, {
      left: `${edge - 18}px`, width: "36px", right: "auto", opacity: `${strength * 0.28}`,
      background: "linear-gradient(to right, transparent, var(--text), transparent)",
    });
  }

  function begin(surface: HTMLElement, preview: HTMLElement | undefined, dir: 1 | -1): boolean {
    if (settling) return false;
    cancel();
    width = surface.clientWidth;
    if (width <= 0 || !surface.parentElement) return false;
    direction = dir;
    root = layer();
    root.setAttribute("aria-hidden", "true");
    root.setAttribute("data-reader-turn", "");
    root.inert = true;
    Object.assign(root.style, { pointerEvents: "none", zIndex: "15", background: "var(--bg)" });
    if (preview) root.append(snapshot(preview));
    front = layer();
    front.append(snapshot(surface));
    back = layer();
    const paper = snapshot(surface);
    // 薄纸背面隐约透出镜像文字，底下的目标页保持正常阅读方向。
    const tint = layer();
    tint.style.background = "var(--bg)";
    tint.style.opacity = "0.88";
    paper.append(tint);
    back.append(paper);
    shade = layer();
    crease = layer();
    root.append(front, back, shade, crease);
    surface.parentElement.append(root);
    draw(0);
    return true;
  }

  function finish(commit: boolean, done: () => void): void {
    if (!root) { done(); return; }
    window.cancelAnimationFrame(frame);
    settling = true;
    onSettled = done;
    const from = progress;
    const target = commit ? 1 : 0;
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0 : Math.max(140, Math.abs(target - from) * 320);
    const start = performance.now();
    const tick = (now: number) => {
      const t = duration === 0 ? 1 : Math.min(1, (now - start) / duration);
      draw(from + (target - from) * (1 - (1 - t) ** 3));
      if (t < 1) frame = window.requestAnimationFrame(tick);
      else interrupt();
    };
    frame = window.requestAnimationFrame(tick);
  }

  return { begin, draw, finish, cancel, interrupt, active: () => !!root };
}

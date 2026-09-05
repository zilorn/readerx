/**
 * 阅读页选区的 DOM 工具：
 * - 把光标/选区边界映射到正文单元（data-u=data-c 标注的元素）内的精确字符偏移；
 * - 对某单元内的一段字符做短暂高亮（跳转书签/新增书签的视觉反馈）；
 * - 剪贴板复制（带 execCommand 降级）。
 *
 * 约定：阅读页渲染正文 p/h 元素时打上
 *   data-u  = 该元素在 chapterUnits 中的单元序号
 *   data-c  = 该元素文本在单元原文中的起始字符偏移
 * 被书签下划线包裹产生的嵌套 span 不影响这些偏移（span 不产生文本）。
 */
export interface DataAnchor {
  el: HTMLElement;
  /** 单元序号（chapterUnits 下标） */
  unit: number;
  /** 该元素文本在单元原文中的起始字符偏移 */
  cstart: number;
}

/** 由任意节点向上找最近带 data-u 的正文元素 */
export function dataAnchorOf(node: Node | null): DataAnchor | null {
  if (!node) return null;
  const startEl =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const el = startEl?.closest?.("[data-u]") as HTMLElement | null;
  if (!el) return null;
  const unit = Number(el.dataset.u ?? "");
  const cstart = Number(el.dataset.c ?? "0");
  if (!Number.isFinite(unit) || unit < 0 || !Number.isFinite(cstart) || cstart < 0) {
    return null;
  }
  return { el, unit, cstart };
}

/** 节点子树内的文本总长 */
function textLengthOf(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.length;
  let total = 0;
  node.childNodes.forEach((child) => {
    total += textLengthOf(child);
  });
  return total;
}

/** 元素子树内的文本总长（含书签/朗读等嵌套 span 的文本） */
export function elementTextLength(el: Element): number {
  return textLengthOf(el);
}

/**
 * 元素内字符偏移 → 所在的（文本节点, 节点内偏移）。
 * 与 charOffsetInElement 互为逆向：偏移落在嵌套 span（书签下划线）内也正确。
 * 供“滚动模式按字符滚动定位”使用；找不到（偏移越界）返回 null。
 */
export function charNodeAtOffset(
  el: Element,
  offset: number,
): { node: Text; offset: number } | null {
  const target = Math.max(0, Math.floor(offset));
  let acc = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let cur: Node | null;
  while ((cur = walker.nextNode())) {
    const text = cur as Text;
    const len = text.data.length;
    if (target <= acc + len) {
      return { node: text, offset: Math.min(len, Math.max(0, target - acc)) };
    }
    acc += len;
  }
  return null;
}

/**
 * 计算「el 内从开头到 (node, offset) 边界点」的字符数。
 * node 需为 el 的后代（或 el 本身）。边界落在嵌套 span（书签下划线）内也正确。
 */
export function charOffsetInElement(
  el: Element,
  node: Node,
  offset: number,
): number {
  if (node === el) {
    let acc = 0;
    const children = node.childNodes;
    for (let i = 0; i < offset && i < children.length; i++) {
      acc += textLengthOf(children[i]);
    }
    return acc;
  }
  const isText = node.nodeType === Node.TEXT_NODE;
  let acc = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let cur: Node | null;
  while ((cur = walker.nextNode())) {
    if (isText) {
      if (cur === node) return acc + offset;
      acc += (cur as Text).data.length;
    } else if (el.contains(node) && node.contains(cur)) {
      // 边界落在某个中间元素内：其前内容计数，再按子节点下标取边界前文本
      return acc + offsetInNodeChildren(node, offset);
    } else {
      acc += (cur as Text).data.length;
    }
  }
  return acc + (isText ? offset : 0);
}

/** node 是中间元素时：其前 offset 个子节点包含的文本总长 */
function offsetInNodeChildren(node: Node, offset: number): number {
  let acc = 0;
  const children = node.childNodes;
  for (let i = 0; i < offset && i < children.length; i++) {
    acc += textLengthOf(children[i]);
  }
  return acc;
}

/**
 * 在容器内对 (unit, 全局字符区间) 做短暂高亮并（可选）滚动到可见。
 * unitBase：该单元文本在章节镜像文本中的起始偏移（由 buildTextMirror 提供）。
 * 返回是否找到覆盖该区间的元素。
 */
export interface FlashOptions {
  /** 高亮保持毫秒数，默认 1700 */
  ms?: number;
  /** 是否滚动到可见，默认 true（分页模式传 false） */
  scroll?: boolean;
}

export function flashUnitRange(
  root: ParentNode | null,
  unit: number,
  unitBase: number,
  fromGlobal: number,
  toGlobal: number,
  options: FlashOptions = {},
): boolean {
  if (!root || toGlobal <= fromGlobal) return false;
  const ms = options.ms ?? 1700;
  const scroll = options.scroll ?? true;
  const els = root.querySelectorAll<HTMLElement>(`[data-u="${unit}"]`);
  for (const el of els) {
    const cstart = Number(el.dataset.c ?? "0");
    const base = unitBase + cstart;
    const len = textLengthOf(el);
    if (toGlobal <= base || fromGlobal >= base + len) continue;
    const lo = Math.max(0, fromGlobal - base);
    const hi = Math.min(len, toGlobal - base);
    const mark = wrapTextRange(el, lo, hi);
    if (!mark) return false;
    if (scroll) {
      try {
        el.scrollIntoView({ block: "center" });
      } catch {
        /* 旧 WebView 忽略 options 即可 */
      }
    }
    window.setTimeout(() => {
      mark.replaceWith(...Array.from(mark.childNodes));
    }, ms);
    return true;
  }
  return false;
}

/** 把一个元素文本的 [from,to) 字符段包进高亮 span，返回该 span */
function wrapTextRange(el: Element, from: number, to: number): HTMLSpanElement | null {
  const range = textNodesRange(el, from, to);
  if (!range) return null;
  const mark = document.createElement("span");
  mark.className = "readerx-bm-flash";
  try {
    const fragment = range.extractContents();
    mark.appendChild(fragment);
    range.insertNode(mark);
    return mark;
  } catch {
    return null;
  }
}

/** 取元素内文本覆盖 [from,to) 的 Range（支持跨多个文本节点/书签 span） */
function textNodesRange(el: Element, from: number, to: number): Range | null {
  let acc = 0;
  let startNode: Text | null = null;
  let startOff = 0;
  let endNode: Text | null = null;
  let endOff = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let cur: Node | null;
  while ((cur = walker.nextNode())) {
    const text = cur as Text;
    const nodeLen = text.data.length;
    const a = Math.max(0, from - acc);
    const b = Math.min(nodeLen, to - acc);
    if (b > a) {
      if (!startNode) {
        startNode = text;
        startOff = a;
      }
      endNode = text;
      endOff = b;
    }
    acc += nodeLen;
    if (acc >= to) break;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  return range;
}

/**
 * 在根容器内把「镜像文本全局偏移」定位到已渲染字符上的（折叠）Range。
 * unitStart：该章 buildTextMirror 得到的单元起始偏移表。
 * offset 必须落在根容器内某个 [data-u] 元素的文本范围里（含恰好在其末尾），
 * 否则返回 null —— 用于：选区手柄定位、选区菜单锚点、朗读起点。
 */
export function caretRangeAtGlobalOffset(
  root: ParentNode | null,
  unitStart: number[],
  offset: number,
): Range | null {
  if (!root) return null;
  const target = Math.max(0, Math.floor(offset) || 0);
  const els = root.querySelectorAll<HTMLElement>("[data-u]");
  for (const el of els) {
    const unit = Number(el.dataset.u ?? "");
    const cstart = Number(el.dataset.c ?? "0");
    const base = unitStart[unit];
    if (!Number.isFinite(base)) continue;
    const spanStart = base + cstart;
    const spanEnd = spanStart + elementTextLength(el);
    if (target < spanStart || target > spanEnd) continue;
    const pt = charNodeAtOffset(el, target - spanStart);
    if (!pt) continue;
    const range = document.createRange();
    range.setStart(pt.node, Math.min(pt.offset, pt.node.data.length));
    range.collapse(true);
    return range;
  }
  return null;
}

/**
 * 高亮一段可能跨多个正文单元（段落/标题）的镜像字符区间 [fromGlobal, toGlobal)。
 * 只影响根容器内已渲染的单元；滚动模式下还可定位到首个覆盖单元。
 * 返回是否至少覆盖了一个元素。
 */
export function flashSpan(
  root: ParentNode | null,
  unitStart: number[],
  fromGlobal: number,
  toGlobal: number,
  options: FlashOptions = {},
): boolean {
  if (!root || toGlobal <= fromGlobal) return false;
  const ms = options.ms ?? 1700;
  const scroll = options.scroll ?? true;
  const marks: HTMLSpanElement[] = [];
  let firstEl: HTMLElement | null = null;
  const els = root.querySelectorAll<HTMLElement>("[data-u]");
  for (const el of els) {
    const unit = Number(el.dataset.u ?? "");
    const cstart = Number(el.dataset.c ?? "0");
    const base = unitStart[unit];
    if (!Number.isFinite(base)) continue;
    const spanStart = base + cstart;
    const spanEnd = spanStart + elementTextLength(el);
    if (toGlobal <= spanStart || fromGlobal >= spanEnd) continue;
    if (!firstEl) firstEl = el;
    const lo = Math.max(0, fromGlobal - spanStart);
    const hi = Math.min(elementTextLength(el), toGlobal - spanStart);
    const mark = wrapTextRange(el, lo, hi);
    if (mark) marks.push(mark);
  }
  if (marks.length === 0) return false;
  if (scroll && firstEl) {
    try {
      firstEl.scrollIntoView({ block: "center" });
    } catch {
      /* 旧 WebView 忽略 options 即可 */
    }
  }
  window.setTimeout(() => {
    for (const mark of marks) {
      mark.replaceWith(...Array.from(mark.childNodes));
    }
  }, ms);
  return true;
}

/** 复制纯文本；Clipboard API 失败时退回 execCommand */
export async function copyPlainText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续尝试降级 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

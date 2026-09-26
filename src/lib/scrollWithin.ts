/**
 * 「只滚元素自己所在的那个滚动容器」的定位工具。
 *
 * 不要用 `el.scrollIntoView()` 做这件事：它顺着包含块链把每一层可滚动祖先一起滚，
 * `overflow-hidden` 的祖先也照滚不误。浮层的入场动画是 transform 位移
 * （见 index.css 的 sheet-up / sheet-in-right），动画期间浮层会临时探出阅读区 24px，
 * 阅读区因此多出 24px 的可滚动溢出 —— scrollIntoView 顺手把这个量滚掉，等动画结束、
 * 溢出消失，滚动位置又被夹回 0：看起来就是打开目录时整屏上下（手机底部抽屉）/
 * 左右（桌面右侧栏）抖一下。
 *
 * 这里用矩形差求目标位置：入场动画的位移同时加在容器与元素上，相减自然抵消，
 * 所以浮层动画没跑完也不会算错。
 */
export function centerInScroller(scroller: HTMLElement, el: HTMLElement): void {
  const box = scroller.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  // 越界量由浏览器夹取：列表首尾的条目自然贴边，不会滚出留白
  scroller.scrollTop += rect.top - box.top - (box.height - rect.height) / 2;
}

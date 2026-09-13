/**
 * 应用内容滚动容器注册表（模块级，非响应式）。
 * 页面栈 RouteStage 始终把「最上层页面」的滚动容器注册在这里，
 * 页面在需要读写列表滚动位置时可（在自身处于最上层时）通过 appScrollEl() 拿到容器。
 * 注：常驻（保活）页面切走时不会卸载，滚动位置天然保留，无需自己存取。
 */
let scrollEl: HTMLElement | null = null;

export function registerAppScrollEl(el: HTMLElement | null): void {
  scrollEl = el;
}

export function appScrollEl(): HTMLElement | null {
  return scrollEl;
}

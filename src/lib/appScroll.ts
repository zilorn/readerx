/**
 * 应用内容滚动容器注册表（模块级，非响应式）。
 * AppShell 在布局挂载后注册其唯一的滚动容器；
 * 页面在需要保存/恢复列表滚动位置时（如从阅读页返回 WebDAV 导入页）通过
 * appScrollEl() 拿到容器并读写 scrollTop。
 */
let scrollEl: HTMLElement | null = null;

export function registerAppScrollEl(el: HTMLElement | null): void {
  scrollEl = el;
}

export function appScrollEl(): HTMLElement | null {
  return scrollEl;
}

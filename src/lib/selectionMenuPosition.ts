/** 阅读区容器坐标中的可见选区几何；手柄只包含屏内的真实端点。 */
export interface SelectionMenuGeometry {
  top: number;
  bottom: number;
  /** 按阅读顺序的首个可见选中行，双页时不取两页纵坐标的最小值。 */
  firstLineTop: number;
  pageTop: number;
  lineHeight: number;
  handles: Array<{ x: number; y: number; r: number }>;
}

/** 固定方向贴放；空间不足时只夹取到安全区，不再翻面或落到选区中间。 */
export function selectionMenuTop(
  geometry: SelectionMenuGeometry,
  barHeight: number,
  topMin: number,
  topMax: number,
): number {
  const gap = 10;
  const below = geometry.firstLineTop - geometry.pageTop < 4 * geometry.lineHeight;
  // 覆盖可见文字和手柄的外缘，双页及单端手柄也不会在正常空间下被菜单压住。
  let upper = geometry.top;
  let lower = geometry.bottom;
  for (const handle of geometry.handles) {
    upper = Math.min(upper, handle.y - handle.r);
    lower = Math.max(lower, handle.y + handle.r);
  }
  const preferred = below ? lower + gap : upper - barHeight - gap;
  return Math.max(topMin, Math.min(preferred, topMax));
}

/**
 * 离场快照要不要做。判断不碰 DOM，便于单独核对边界。
 *
 * 上限来自 Chromium 153、视口 390×844 的一次测量：约 1500 个节点时帧间隔已超过 30ms，
 * 约 6000 个节点时导航出现约 80ms 长任务。1200 取在这次测量的安全侧。
 * 计数与滚动容器的 `getElementsByTagName("*").length` 一致，不含容器自身。
 */
export const MAX_EXIT_SNAPSHOT_NODES = 1_200;

/** 节点数不超过上限时才克隆离场快照；超过则直接切换。 */
export function shouldSnapshot(nodeCount: number): boolean {
  return nodeCount <= MAX_EXIT_SNAPSHOT_NODES;
}

/**
 * `useBeforeLeave` 的 `to` 与当前 pathname 是否同一路径。
 * 仅 query / hash 变化时页面栈不会推进，不必克隆。
 * `to` 为 history delta（数字）时提交前不知道目标路径，返回 false。
 */
export function leaveTargetsSamePath(
  to: string | number,
  currentPathname: string,
): boolean {
  if (typeof to !== "string" || !currentPathname.startsWith("/")) return false;
  const current = pathnameOf(currentPathname, "/");
  const next = pathnameOf(to, currentPathname);
  return current !== undefined && next === current;
}

/** 取出 pathname，并解码百分号编码，避免同一路径因编码形式不同被当成换页。 */
function pathnameOf(input: string, basePathname: string): string | undefined {
  try {
    const url = new URL(input, `https://readerx.local${basePathname}`);
    return decodeURI(url.pathname);
  } catch {
    return undefined;
  }
}

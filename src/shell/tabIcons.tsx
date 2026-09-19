/**
 * 主 Tab 的图标：底部导航（手机端 `components/TabBar.tsx`）与侧边导航（桌面端
 * `shell/DesktopStage.tsx`）共用同一份，避免两处各写一遍 icon 映射而走偏。
 */
import type { JSX } from "solid-js";
import { BookIcon, CompassIcon, SettingsIcon } from "../components/icons";

export function tabIcon(path: string, size: number): JSX.Element {
  if (path === "/discover") return <CompassIcon size={size} />;
  if (path === "/settings") return <SettingsIcon size={size} />;
  return <BookIcon size={size} />;
}

/**
 * 内联 SVG 图标集（24px 线性风格，跟随 currentColor）。
 * 避免为图标额外引入依赖，保证首屏与懒加载体积。
 */
import type { JSX } from "solid-js";

export type SvgIconProps = { size?: number; class?: string };

function Icon(props: SvgIconProps & { children?: JSX.Element }) {
  const { size = 22, class: cls } = props;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      class={cls}
      fill="none"
      stroke="currentColor"
      stroke-width={1.8}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

/** 书架（一本书） */
export function BookIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </Icon>
  );
}

/** 翻开书 */
export function BookOpenIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </Icon>
  );
}

/** 发现（指南针） */
export function CompassIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88" />
    </Icon>
  );
}

/** 设置（齿轮） */
export function SettingsIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

/** 返回 */
export function ChevronLeftIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <polyline points="15 18 9 12 15 6" />
    </Icon>
  );
}

/** 前进 / 右箭头 */
export function ChevronRightIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <polyline points="9 18 15 12 9 6" />
    </Icon>
  );
}

/** 搜索 */
export function SearchIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </Icon>
  );
}

/** 加号 */
export function PlusIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Icon>
  );
}

/** 对勾 */
export function CheckIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <polyline points="20 6 9 17 4 12" />
    </Icon>
  );
}

/** 关闭 */
export function CloseIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Icon>
  );
}

/** 目录（列表） */
export function ListIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </Icon>
  );
}

/** 垃圾桶 */
export function TrashIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Icon>
  );
}

/** 空书架提示用大图标 */
export function LibraryIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="m16 6 4 14" />
      <path d="M12 6v14" />
      <path d="M8 8v12" />
      <path d="M4 4v16" />
    </Icon>
  );
}

/** 导入（箭头落入托盘） */
export function DownloadIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M12 3v11" />
      <polyline points="7 9.5 12 14.5 17 9.5" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </Icon>
  );
}

/** 文档（TXT/EPUB 格式说明） */
export function FileTextIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="14" y2="17" />
    </Icon>
  );
}

/** 正则（. * 示意） */
export function RegexIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M6 6h12" />
      <path d="M6 12h8" />
      <path d="M6 18h12" />
      <circle cx="17" cy="6" r="1" />
      <circle cx="15" cy="18" r="1" />
    </Icon>
  );
}

/** 链接 / 书源 */
export function LinkIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Icon>
  );
}

/** 刷新 */
export function RefreshIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </Icon>
  );
}

/** 文件夹（书架分组） */
export function FolderIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Icon>
  );
}

/** 编辑（铅笔） */
export function EditIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </Icon>
  );
}

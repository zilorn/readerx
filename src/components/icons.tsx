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

/** GitHub（猫头剪影） */
export function GitHubIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
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

/** 图片（封面占位） */
export function ImageIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="9" cy="10" r="1.7" />
      <path d="m5.2 17.5 4.5-4.5a1.6 1.6 0 0 1 2.3 0l2.8 2.8" />
      <path d="m14.5 17.5 1.3-1.3a1.6 1.6 0 0 1 2.3 0l.7.7" />
    </Icon>
  );
}

/** 复制（双层矩形） */
export function CopyIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <rect x="9" y="9" width="12" height="12" rx="2.5" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  );
}

/** 喇叭（朗读本句） */
export function SpeakerIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M11 4.7 5.8 8.6H3.4v6.8h2.4L11 19.3z" />
      <path d="M15.8 9.4l4 5.2" />
      <path d="M19.8 9.4l-4 5.2" />
    </Icon>
  );
}

/** 耳机（听书） */
export function HeadphonesIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M3 14v-2a9 9 0 0 1 18 0v2" />
      <path d="M21 15a2 2 0 0 1-2 2h-1a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h1a2 2 0 0 1 2 2z" />
      <path d="M3 15a2 2 0 0 0 2 2h1a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1H5a2 2 0 0 0-2 2z" />
    </Icon>
  );
}

/** 播放（三角） */
export function PlayIcon(p: SvgIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={p.size ?? 22}
      height={p.size ?? 22}
      class={p.class}
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
    >
      <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86z" />
    </svg>
  );
}

/** 暂停（双竖条） */
export function PauseIcon(p: SvgIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={p.size ?? 22}
      height={p.size ?? 22}
      class={p.class}
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
    >
      <rect x="6" y="4" width="4" height="16" rx="1.2" />
      <rect x="14" y="4" width="4" height="16" rx="1.2" />
    </svg>
  );
}

/** 上一句（跳回） */
export function SkipBackIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <polygon points="19 5 11 12 19 19 19 5" fill="currentColor" stroke="none" />
      <line x1="5" y1="5" x2="5" y2="19" />
    </Icon>
  );
}

/** 下一句（跳过） */
export function SkipForwardIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <polygon points="5 5 13 12 5 19 5 5" fill="currentColor" stroke="none" />
      <line x1="19" y1="5" x2="19" y2="19" />
    </Icon>
  );
}

/** 定时（钟表） */
export function TimerIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <circle cx="12" cy="13" r="8" />
      <polyline points="12 9 12 13 15 15" />
      <line x1="9" y1="2" x2="15" y2="2" />
    </Icon>
  );
}

/** 定位朗读句（返回跟读）：四向准星 + 中心点 */
export function FollowBackIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <circle cx="12" cy="12" r="6.5" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** 服务器 / WebDAV（双叠机架） */
export function ServerIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <rect x="2.5" y="3" width="19" height="7" rx="2" />
      <rect x="2.5" y="14" width="19" height="7" rx="2" />
      <line x1="6" y1="6.5" x2="6.01" y2="6.5" />
      <line x1="6" y1="17.5" x2="6.01" y2="17.5" />
      <line x1="10" y1="6.5" x2="18" y2="6.5" />
      <line x1="10" y1="17.5" x2="18" y2="17.5" />
    </Icon>
  );
}

/** 云盘（WebDAV 空态 / 目录归属） */
export function CloudIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M17.5 19a4.5 4.5 0 0 0 .42-8.98 6 6 0 0 0-11.7 1.45A4 4 0 0 0 6.5 19z" />
    </Icon>
  );
}

/** 返回原进度（弧形回转箭头） */
export function RestoreBackIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </Icon>
  );
}

/** 书签（丝带）；filled 时实心填充 */
export function BookmarkIcon(p: SvgIconProps & { filled?: boolean }) {
  if (p.filled) {
    const { size = 22, class: cls } = p;
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        class={cls}
        fill="currentColor"
        stroke="none"
        aria-hidden="true"
      >
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
    );
  }
  return (
    <Icon {...p}>
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </Icon>
  );
}

/** 书源（堆叠图层 / 数据源） */
export function SourceIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M4 7l8-4 8 4-8 4-8-4z" />
      <path d="M4 12.5l8 4 8-4" />
      <path d="M4 18l8 4 8-4" />
    </Icon>
  );
}

/** 保存（软盘） */
export function SaveIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M8 3v5h7V3" />
      <rect x="7" y="13" width="10" height="8" rx="1" />
    </Icon>
  );
}

/** 替换（左右交换箭头） */
export function ReplaceIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="m16 3 4 4-4 4" />
      <path d="M20 7H5" />
      <path d="m8 21-4-4 4-4" />
      <path d="M4 17h15" />
    </Icon>
  );
}

/** 测试（烧瓶） */
export function TestIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M9 3h6" />
      <path d="M10 3v5.5L4.8 17a2 2 0 0 0 1.8 3h10.8a2 2 0 0 0 1.8-3L14 8.5V3" />
      <path d="M7.5 15h9" />
    </Icon>
  );
}

/** 网页登录（地球 + 钥匙） */
export function GlobeKeyIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.2 12h17.6" />
      <path d="M12 3a15.4 15.4 0 0 1 3.6 9 15.4 15.4 0 0 1-3.6 9 15.4 15.4 0 0 1-3.6-9A15.4 15.4 0 0 1 12 3z" />
    </Icon>
  );
}

/** 清空（垃圾桶 + 循环箭头） */
export function ClearIcon(p: SvgIconProps) {
  return (
    <Icon {...p}>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </Icon>
  );
}

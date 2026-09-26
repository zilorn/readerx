/**
 * 数据备份 / 恢复（前端接线）。
 *
 * 后端实现在 `src-tauri/src/data_transfer/`：整库导出成**一个 zip**（书架与正文、书签、
 * 章节插图、书源、分组与规则、界面偏好），导入时按「合并」或「覆盖恢复」两种语义写回。
 * 落盘的真相全在 Rust 侧，这里只做三件事：调命令、把进度事件转成界面状态、导入完
 * **按依赖顺序重载前端缓存**（与同步落地后的重载口径一致，见 `lib/sync.ts`）。
 *
 * 与「局域网同步」的分工见 `docs/backup.md`：同步是两台设备自动合并元信息，
 * 备份是把整台设备（含正文）搬到一个文件里，由用户显式导出与导入。
 */
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { invalidateBookmarkCache } from "./bookmarks";
import { reloadLocalBooks } from "./books";
import { refreshBookSources } from "./bookSources";
import { reloadChapterRules } from "./chapterRules";
import { reloadGroups } from "./groups";
import { reloadReadingProgress } from "./store";
import { reloadSourceGroups } from "./sourceGroups";
import { reloadTextReplacements } from "./textReplacements";
import { t } from "./i18n";

/** 归档清单的摘要（导出完成后 / 导入前的预览都用它） */
export interface BackupPreview {
  appVersion: string;
  createdAt: number;
  /** 归档里是否含书源登录态与 WebDAV 密码 */
  credentials: boolean;
  books: number;
  images: number;
  sources: number;
  stateKeys: number;
  bytes: number;
}

/** 导出结果 */
export interface BackupExportResult {
  fileName: string;
  bytes: number;
  books: number;
  images: number;
  sources: number;
  stateKeys: number;
  credentials: boolean;
}

/** 选中的归档：确认导入时把 path 原样传回后端 */
export interface PickedBackup {
  path: string;
  preview: BackupPreview;
}

/** 导入语义 */
export type BackupImportMode = "merge" | "replace";

/** 导入结果 */
export interface BackupImportResult {
  mode: BackupImportMode;
  booksAdded: number;
  booksUpdated: number;
  booksSkipped: number;
  booksRemoved: number;
  imagesAdded: number;
  sourcesAdded: number;
  sourcesUpdated: number;
  sourcesSkipped: number;
  sourcesRemoved: number;
  stateKeys: string[];
}

/** 进度类别（与后端 `DataProgress` 的 `step` 一致；文案由界面按当前语言取） */
export type BackupStep = "state" | "books" | "images" | "sources" | "sessions";

export interface BackupProgress {
  step: BackupStep;
  done: number;
  total: number;
}

/** 后端进度事件的线格式 */
interface DataProgressEvent {
  kind: "step";
  step: BackupStep;
  done: number;
  total: number;
}

type ProgressHandler = (progress: BackupProgress) => void;

function openChannel(onProgress: ProgressHandler): Channel<DataProgressEvent> {
  const channel = new Channel<DataProgressEvent>();
  channel.onmessage = (event) => {
    if (event.kind === "step") {
      onProgress({ step: event.step, done: event.done, total: event.total });
    }
  };
  return channel;
}

/** 当前环境是否支持备份（纯浏览器开发环境没有文件系统与原生选择器） */
export function backupSupported(): boolean {
  return isTauri();
}

/**
 * 导出全部数据：后端弹原生保存框，用户取消返回 null。
 * `includeCredentials` 为真时把书源登录态与 WebDAV 密码一并写进归档（默认否）。
 */
export async function exportBackup(
  includeCredentials: boolean,
  onProgress: ProgressHandler,
): Promise<BackupExportResult | null> {
  if (!isTauri()) throw new Error(t("backup.appOnly"));
  return await invoke<BackupExportResult | null>("readerx_data_export", {
    includeCredentials,
    onProgress: openChannel(onProgress),
  });
}

/** 选一个备份文件并读清单（不解压正文）；用户取消返回 null */
export async function pickBackupArchive(): Promise<PickedBackup | null> {
  if (!isTauri()) throw new Error(t("backup.appOnly"));
  return await invoke<PickedBackup | null>("readerx_data_import_pick");
}

/** 按指定语义导入备份，并在结束后重载前端缓存 */
export async function importBackup(
  path: string,
  mode: BackupImportMode,
  onProgress: ProgressHandler,
): Promise<BackupImportResult> {
  if (!isTauri()) throw new Error(t("backup.appOnly"));
  const result = await invoke<BackupImportResult>("readerx_data_import", {
    path,
    mode,
    onProgress: openChannel(onProgress),
  });
  await reloadAfterImport();
  return result;
}

/**
 * 导入后重载前端缓存：顺序与依赖方向一致（分组先于书库，书源分组先于书源）。
 *
 * 落盘已经是最终结果，这里只是把界面上的物化视图取回来；书签是**按书懒加载**的，
 * 因此先把内存缓存整批作废，下次打开那本书时按磁盘重读。
 */
async function reloadAfterImport(): Promise<void> {
  invalidateBookmarkCache();
  await reloadGroups();
  await reloadSourceGroups();
  await reloadLocalBooks();
  await reloadReadingProgress();
  await reloadTextReplacements();
  await reloadChapterRules();
  await refreshBookSources();
}

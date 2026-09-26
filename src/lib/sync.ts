/**
 * 局域网同步（前端接线）。
 *
 * 与 Rust 侧 `src/sync/` 一一对应：
 * - 状态是一个模块级 signal，由后端事件 `readerx-sync-status` 持续刷新 —— 自动同步、
 *   对端连进来、冲突数变化都会推到界面上，不需要页面轮询；
 * - 同步改了本地数据时，后端发 `readerx-sync-applied` 并说明改了哪几类，这里负责
 *   **重载对应的前端缓存**（进度 / 书签 / 分组 / 书库元信息 / 书源）。落盘的真相在
 *   Rust 侧，前端只是物化视图，重载顺序与依赖方向一致（分组先于书库）。
 *
 * 同步本身（协议、合并、冲突）全在 Rust；这里只做「开关 + 展示 + 把结果搬回界面」。
 */
import { createSignal } from "solid-js";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { reloadBookContent, reloadLocalBooks } from "./books";
import { reloadBookBookmarks } from "./bookmarks";
import { reloadChapterRules } from "./chapterRules";
import { refreshBookSources } from "./bookSources";
import { describeError, reportFailure } from "./errorReport";
import { reloadGroups } from "./groups";
import { reloadReadingProgress } from "./store";
import { reloadTextReplacements } from "./textReplacements";
import { t, type MessageKey } from "./i18n";
import { createLogger } from "./logger";
import { showActionToast } from "./toast";

const log = createLogger("sync");

/** 状态事件名（与 src-tauri/src/sync/service.rs 的 `SYNC_EVENT` 一致） */
const SYNC_EVENT = "readerx-sync-status";
/** 落地事件名（与 service.rs 的 `SYNC_APPLIED_EVENT` 一致） */
const SYNC_APPLIED_EVENT = "readerx-sync-applied";

/** 自动同步间隔档位（秒）；后端只校验范围，档位由界面决定 */
export const SYNC_INTERVAL_PRESETS = [60, 300, 900, 1800, 3600] as const;

/** 后端同步状态 */
export interface SyncStatus {
  activated: boolean;
  enabled: boolean;
  autoSync: boolean;
  autoIntervalSecs: number;
  deviceName: string;
  deviceId: string;
  groupId: string;
  listenAddr: string | null;
  syncing: boolean;
  lastSyncMs: number;
  lastError: string | null;
  pendingConflicts: number;
  entities: number;
  ops: number;
  peers: number;
  /** 被本机删除（拒绝接入）的设备数 */
  removedPeers: number;
}

/** 已同步过的设备 */
export interface SyncPeer {
  deviceId: string;
  name: string;
  addr: string | null;
  lastSyncMs: number;
  syncCount: number;
  lastError: string | null;
  isSelf: boolean;
}

/** 局域网扫描到的设备 */
export interface DiscoveredPeer {
  deviceId: string;
  name: string;
  addr: string;
  known: boolean;
  /** 被本机删除过（界面上给「重新接受」，而不是当成新设备） */
  removed: boolean;
}

/** 一次同步的结果 */
export interface SyncOutcome {
  synced: string[];
  failed: string[];
  pulled: number;
  pushed: number;
  conflicts: number;
  applied: AppliedChanges | null;
}

/** 同步改了哪些本地数据 */
export interface AppliedChanges {
  books: boolean;
  progress: boolean;
  groups: boolean;
  sources: boolean;
  /** 文本替换规则有变化 → 重新读回规则清单 */
  textReplaces: boolean;
  /** 分章规则有变化 → 重新读回规则清单 */
  chapterRules: boolean;
  /** 章节目录 / 正文有变化的本机书 id → 重载这几本的正文缓存 */
  chapters: string[];
  bookmarks: string[];
  deletedBooks: string[];
}

/** 冲突记录 */
export interface SyncConflict {
  id: string;
  kind: string;
  field: string;
  title: string;
  reason: string;
  local: string | null;
  remote: string | null;
  detectedAtMs: number;
  note: string | null;
  peer: string | null;
}

/** 裁决方式 */
export type ConflictChoice = "local" | "remote" | "dismiss";

/**
 * 同步失败码（与 Rust 侧 `readerx_sync::error::Code` 的 `as_str` 一一对应）。
 *
 * 后端把「怎么失败」当码发过来（`码|提示`），界面据此给出**可操作的引导**并翻成当前
 * 语言 —— 中文提示是给日志看的，不能直接端给英语用户。新增码时两边一起改：
 * Rust 的 `Code::as_str` 与这里的 `CODE_MESSAGES` 表（类型上互相约束，漏一个会编译报错）。
 */
export type SyncErrorCode =
  | "group_mismatch"
  | "removed_by_peer"
  | "not_trusted"
  | "protocol_mismatch"
  | "busy"
  | "auth_failed"
  | "unexpected_message"
  | "unsupported_version"
  | "not_readerx";

/** 错误码 → 界面文案 key（全部按码映射，漏一个 key 会在类型检查时报错） */
const CODE_MESSAGES: Record<SyncErrorCode, MessageKey> = {
  group_mismatch: "sync.error.groupMismatch",
  removed_by_peer: "sync.error.removedByPeer",
  not_trusted: "sync.error.notTrusted",
  protocol_mismatch: "sync.error.protocolMismatch",
  busy: "sync.error.busy",
  auth_failed: "sync.error.authFailed",
  unexpected_message: "sync.error.unexpectedMessage",
  unsupported_version: "sync.error.unsupportedVersion",
  not_readerx: "sync.error.notReaderx",
};

/**
 * 同步失败的展示文本：后端错误串是 `码|提示`，有码就翻成当前语言的**可操作提示**，
 * 否则原样返回（网络错误、磁盘错误这类诊断信息）。
 */
export function syncErrorText(error: unknown): string {
  const text = describeError(error);
  const separator = text.indexOf("|");
  if (separator <= 0) return text;
  const code = text.slice(0, separator);
  const message = CODE_MESSAGES[code as SyncErrorCode];
  return message ? t(message) : text;
}

const EMPTY_STATUS: SyncStatus = {
  activated: false,
  enabled: false,
  autoSync: true,
  autoIntervalSecs: 900,
  deviceName: "",
  deviceId: "",
  groupId: "",
  listenAddr: null,
  syncing: false,
  lastSyncMs: 0,
  lastError: null,
  pendingConflicts: 0,
  entities: 0,
  ops: 0,
  peers: 0,
  removedPeers: 0,
};

const [status, setStatus] = createSignal<SyncStatus>(EMPTY_STATUS);
/** 本地数据被同步改动的次数（页面可据此刷新自己的临时状态） */
const [appliedTick, setAppliedTick] = createSignal(0);

let listening = false;
/** 上次已知的待裁决冲突数：只在「变多」时提示，避免反复打扰 */
let lastConflictCount = 0;
/** 由 AppShell 注入的导航函数（冲突提示里的按钮要跨页面跳转） */
let navigateTo: ((path: string) => void) | null = null;

/**
 * 注入导航函数（AppShell 挂载时调用）。
 * 提示条是全局的、可能在任何页面弹出，而 `useNavigate` 只能在组件里取，
 * 所以由外壳把导航能力交给这里。
 */
export function attachSyncNavigator(navigate: (path: string) => void): void {
  navigateTo = navigate;
}

/** 响应式同步状态 */
export function syncStatus(): SyncStatus {
  return status();
}

/** 响应式「同步改动本地数据」计数 */
export function syncAppliedTick(): number {
  return appliedTick();
}

/** 自动同步间隔 → 界面文案（整小时按小时说，其余按分钟） */
export function formatSyncInterval(secs: number): string {
  if (secs >= 3600 && secs % 3600 === 0) {
    return t("sync.interval.hours", { count: secs / 3600 });
  }
  return t("sync.interval.minutes", { count: Math.max(1, Math.round(secs / 60)) });
}

/**
 * 启动时调用（幂等）：读一次状态并订阅后端事件。
 * 后端在应用启动时就建好了服务，这里只是把状态接进界面。
 */
export async function initSync(): Promise<void> {
  if (!isTauri() || listening) return;
  listening = true;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<SyncStatus>(SYNC_EVENT, (event) => {
      applyStatus(event.payload);
    });
    await listen<AppliedChanges>(SYNC_APPLIED_EVENT, (event) => {
      void applyChanges(event.payload);
    });
  } catch (error) {
    // 订阅失败不影响同步本身，只影响界面的实时刷新（下次启动再试）
    log.warn("订阅同步事件失败", error);
  }
  await refreshSyncStatus();
}

/** 重新拉一次状态（页面进入时用） */
export async function refreshSyncStatus(): Promise<SyncStatus> {
  if (!isTauri()) return status();
  try {
    const next = await invoke<SyncStatus>("readerx_sync_status");
    applyStatus(next);
    return next;
  } catch (error) {
    log.warn("读取同步状态失败", error);
    return status();
  }
}

function applyStatus(next: SyncStatus): void {
  const previous = status();
  setStatus(next);
  const conflicts = next.pendingConflicts;
  if (conflicts > lastConflictCount && previous.activated) {
    // 「冲突提示」：多出来的待裁决项要让用户看见，并给一个直接去处理的入口
    showActionToast(
      t("sync.conflict.toast", { count: conflicts }),
      {
        label: t("sync.conflict.toastAction"),
        onClick: () => navigateTo?.("/sync-conflicts"),
      },
      8000,
    );
  }
  lastConflictCount = conflicts;
}

/** 同步改了本地数据：按类别重载前端缓存（顺序与依赖方向一致） */
async function applyChanges(changes: AppliedChanges): Promise<void> {
  log.info(
    "同步已更新本地数据",
    `books=${changes.books}`,
    `progress=${changes.progress}`,
    `groups=${changes.groups}`,
    `sources=${changes.sources}`,
    `textReplaces=${changes.textReplaces}`,
    `chapterRules=${changes.chapterRules}`,
    `chapters=${changes.chapters.length}`,
    `bookmarks=${changes.bookmarks.length}`,
    `deleted=${changes.deletedBooks.length}`,
  );
  try {
    // 分组必须排在书库前面：书的分组归属要按本机分组 id 落
    if (changes.groups) await reloadGroups();
    if (changes.books || changes.deletedBooks.length > 0) await reloadLocalBooks();
    // 目录 / 正文变了：丢掉这几本的物化缓存，下次打开阅读页重新读回
    if (changes.chapters.length > 0) await reloadBookContent(changes.chapters);
    if (changes.progress) await reloadReadingProgress();
    if (changes.bookmarks.length > 0) {
      for (const bookId of changes.bookmarks) await reloadBookBookmarks(bookId);
    }
    if (changes.sources) await refreshBookSources();
    if (changes.textReplaces) await reloadTextReplacements();
    if (changes.chapterRules) await reloadChapterRules();
    setAppliedTick((n) => n + 1);
  } catch (error) {
    reportFailure(t("sync.applied.reloadFailed"), error);
  }
}

// ---------------------------------------------------------------------------
// 开关与设置
// ---------------------------------------------------------------------------

/** 开启 / 关闭同步：关闭后本地改动仍会记账，重新开启时一起同步出去 */
export async function setSyncEnabled(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const next = await invoke<SyncStatus>("readerx_sync_enable", { enabled });
    applyStatus(next);
  } catch (error) {
    reportFailure(t("sync.enable.failed"), error);
  }
}

/** 自动同步开关与间隔 */
export async function setSyncAuto(enabled: boolean, intervalSecs: number): Promise<void> {
  if (!isTauri()) return;
  try {
    const next = await invoke<SyncStatus>("readerx_sync_set_auto", {
      enabled,
      intervalSecs,
    });
    applyStatus(next);
  } catch (error) {
    reportFailure(t("sync.auto.failed"), error);
  }
}

/** 改本机设备名 */
export async function setSyncDeviceName(name: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const next = await invoke<SyncStatus>("readerx_sync_set_device_name", { name });
    applyStatus(next);
  } catch (error) {
    reportFailure(t("sync.deviceName.failed"), error);
  }
}

/** 本机配对码（失败返回 null，由调用方决定怎么提示） */
export async function syncPairingCode(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string>("readerx_sync_pairing_code");
  } catch (error) {
    reportFailure(t("sync.pairing.failed"), error);
    return null;
  }
}

/** 用配对码加入其它设备的同步群组 */
export async function joinSyncGroup(code: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const next = await invoke<SyncStatus>("readerx_sync_join", { code });
    applyStatus(next);
    return true;
  } catch (error) {
    reportFailure(t("sync.join.failed"), error);
    return false;
  }
}

/** 立即同步（先试已知设备，没有就扫局域网）；返回 null 表示失败 */
export async function syncNow(): Promise<SyncOutcome | null> {
  if (!isTauri()) return null;
  try {
    const outcome = await invoke<SyncOutcome>("readerx_sync_now");
    await refreshSyncStatus();
    return outcome;
  } catch (error) {
    // 失败原因按码翻成当前语言的可操作提示（见 syncErrorText）
    reportFailure(t("sync.now.failed"), error, 4_200, "warn", syncErrorText(error));
    await refreshSyncStatus();
    return null;
  }
}

/** 与指定地址（`ip:port`）同步一次 */
export async function syncWithAddr(addr: string): Promise<SyncOutcome | null> {
  if (!isTauri()) return null;
  try {
    const outcome = await invoke<SyncOutcome>("readerx_sync_sync_addr", { addr });
    await refreshSyncStatus();
    return outcome;
  } catch (error) {
    reportFailure(t("sync.now.failed"), error, 4_200, "warn", syncErrorText(error));
    await refreshSyncStatus();
    return null;
  }
}

/** 扫描局域网里同群组的设备 */
export async function discoverSyncPeers(): Promise<DiscoveredPeer[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<DiscoveredPeer[]>("readerx_sync_discover");
  } catch (error) {
    reportFailure(t("sync.discover.failed"), error);
    return [];
  }
}

/** 已同步过的设备列表（含本机） */
export async function listSyncPeers(): Promise<SyncPeer[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<SyncPeer[]>("readerx_sync_peers");
  } catch (error) {
    log.warn("读取同步设备列表失败", error);
    return [];
  }
}

/**
 * 本机对外的局域网地址（同步界面「本机地址」展示用）。
 *
 * 后端按 `0.0.0.0:47821` 监听全部网卡，`0.0.0.0` 只是绑定意图、不是能连的地址：
 * 展示真实网卡地址，取不到就返回空数组（界面按「暂无地址」处理），
 * **绝不回退成通配地址** —— 那正是用户照着填却连不上的原因。
 */
export async function listSyncLanAddrs(): Promise<string[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<string[]>("readerx_sync_lan_addrs");
  } catch (error) {
    log.warn("读取本机局域网地址失败", error);
    return [];
  }
}

/**
 * 删除（移除）一台已配对设备：本机不再与它同步，并拒绝它连进来。
 *
 * 只影响本机：对端仍持有它那份数据与群组密钥，也不会收到通知；
 * 它下次主动同步会拿到「设备已被对端移除」。要恢复同步，需要在「查找局域网设备」
 * 里对这台设备点「重新接受」（本质是本机主动与它同步一次）。
 *
 * @returns 删除后的设备列表；失败返回 null（错误已按统一口径提示）
 */
export async function removeSyncPeer(deviceId: string): Promise<SyncPeer[] | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<SyncPeer[]>("readerx_sync_remove_peer", { deviceId });
  } catch (error) {
    reportFailure(t("sync.peer.removeFailed"), error);
    return null;
  }
}

/**
 * 重新接受一台被删除的设备：撤销本机的拒绝。
 *
 * 这是撤销「删除设备」的**唯一**途径 —— 自动同步与手动同步都不会把删除悄悄撤销。
 * 撤销之后再与对方同步一次（`syncWithAddr`），它才会回到设备列表。
 */
export async function acceptSyncPeer(deviceId: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const next = await invoke<SyncStatus>("readerx_sync_accept_peer", { deviceId });
    applyStatus(next);
    return true;
  } catch (error) {
    reportFailure(t("sync.peer.acceptFailed"), error);
    return false;
  }
}

/** 冲突列表；includeSettled 为真时连已裁决的一起返回 */
export async function listSyncConflicts(includeSettled = false): Promise<SyncConflict[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<SyncConflict[]>("readerx_sync_conflicts", { includeSettled });
  } catch (error) {
    reportFailure(t("sync.conflict.loadFailed"), error);
    return [];
  }
}

/** 裁决一条冲突 */
export async function resolveSyncConflict(id: string, choice: ConflictChoice): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const next = await invoke<SyncStatus>("readerx_sync_resolve", { id, keep: choice });
    applyStatus(next);
    return true;
  } catch (error) {
    reportFailure(t("sync.conflict.resolveFailed"), error);
    return false;
  }
}

/** 清空同步数据（换群组 / 排障）；本地书库、书源、进度不受影响 */
export async function resetSyncData(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const next = await invoke<SyncStatus>("readerx_sync_reset");
    applyStatus(next);
    return true;
  } catch (error) {
    reportFailure(t("sync.reset.failed"), error);
    return false;
  }
}

/** 冲突原因码 → 界面文案 */
export function conflictReasonLabel(reason: string): string {
  switch (reason) {
    case "concurrent_write":
      return t("sync.conflict.reason.concurrentWrite");
    case "multi_value":
      return t("sync.conflict.reason.multiValue");
    case "unique_key":
      return t("sync.conflict.reason.uniqueKey");
    case "delete_vs_update":
      return t("sync.conflict.reason.deleteVsUpdate");
    case "frozen_write":
      return t("sync.conflict.reason.frozenWrite");
    case "list_move":
      return t("sync.conflict.reason.listMove");
    case "duplicate_entity":
      return t("sync.conflict.reason.duplicateEntity");
    case "cascade_blocked":
      return t("sync.conflict.reason.cascadeBlocked");
    default:
      return t("sync.conflict.reason.unknown");
  }
}

/** 冲突字段 → 界面文案（未知字段原样显示，不隐藏信息） */
export function conflictFieldLabel(field: string): string {
  switch (field) {
    case "title":
      return t("sync.field.title");
    case "author":
      return t("sync.field.author");
    case "intro":
      return t("sync.field.intro");
    case "tags":
      return t("sync.field.tags");
    case "source_tags":
      return t("sync.field.sourceTags");
    case "group":
      return t("sync.field.group");
    case "name":
      return t("sync.field.name");
    case "json":
      return t("sync.field.sourceJson");
    case "note":
      return t("sync.field.note");
    case "":
      return t("sync.field.entity");
    default:
      return field;
  }
}

/** 冲突涉及对象类型 → 界面文案 */
export function conflictKindLabel(kind: string): string {
  switch (kind) {
    case "book":
      return t("sync.kind.book");
    case "book_source":
      return t("sync.kind.source");
    case "group":
      return t("sync.kind.group");
    case "bookmark":
      return t("sync.kind.bookmark");
    case "reading_progress":
      return t("sync.kind.progress");
    default:
      return kind;
  }
}

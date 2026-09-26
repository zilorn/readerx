/**
 * 书架分组（本地书 / 云端书共用）。
 * - 用户分组列表作为偏好由 Rust 后端持久化（readerx.groups）；
 * - 内置隐藏分组不落库（固定 id），书籍的归属通过各自 book 上的 groupId 字段记录；
 * - 归入隐藏分组的书不出现在书架常规视图与书架搜索，只在「隐藏」分组内可见；
 * - 另提供「入架后加入分组」的全局开关（见文件末尾）：提示条按钮 → 移入分组抽屉。
 */
import { createSignal } from "solid-js";
import { readState, writeState } from "./backend";
import { clearLocalGroup, bookMetaById, setLocalBookGroup } from "./books";
import { t } from "./i18n";
import { showActionToast, showToast } from "./toast";

export interface Group {
  id: string;
  name: string;
  createdAt: number;
}

/** 内置隐藏分组：书归入后从书架常规视图 / 搜索中隐藏 */
export const HIDDEN_GROUP_ID = "__hidden__";
export const HIDDEN_GROUP_NAME = "隐藏";

/** 内置隐藏分组对象（不入库；不可重命名 / 删除） */
export function hiddenGroup(): Group {
  return { id: HIDDEN_GROUP_ID, name: HIDDEN_GROUP_NAME, createdAt: 0 };
}

/** 某分组 id 是否指向内置隐藏分组 */
export function isHiddenGroupId(id?: string | null): boolean {
  return id === HIDDEN_GROUP_ID;
}

const GROUPS_KEY = "readerx.groups";

const [groups, setGroupsSignal] = createSignal<Group[]>([]);
let initialized = false;

export function groupList(): Group[] {
  return groups();
}

export function groupsReady(): boolean {
  return initialized;
}

/** 应用启动时载入分组（幂等） */
export async function initGroups(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const stored = await readState<Group[]>(GROUPS_KEY);
  if (Array.isArray(stored)) setGroupsSignal(stored);
}

/**
 * 重新从后端读回分组清单（**同步改了分组**时调用）。
 * 后端落地时会按名字补齐对端的分组，这里只负责把结果取回内存。
 */
export async function reloadGroups(): Promise<void> {
  const stored = await readState<Group[]>(GROUPS_KEY);
  if (Array.isArray(stored)) setGroupsSignal(stored);
}

function persist(): void {
  const snapshot = [...groups()];
  void writeState(GROUPS_KEY, snapshot);
}

export function groupById(id: string): Group | undefined {
  if (id === HIDDEN_GROUP_ID) return hiddenGroup();
  return groups().find((group) => group.id === id);
}

export function groupName(id?: string | null): string {
  if (!id) return "";
  if (id === HIDDEN_GROUP_ID) return HIDDEN_GROUP_NAME;
  return groups().find((group) => group.id === id)?.name ?? "";
}

/**
 * 分组的显示名：内置隐藏分组的名字是保留名（HIDDEN_GROUP_NAME 参与比较，不随语言变化），
 * 只在展示时翻译；用户自建分组名原样返回。
 */
export function groupDisplayName(id?: string | null): string {
  if (id === HIDDEN_GROUP_ID) return t("book.groups.hidden");
  return groupName(id);
}

function newGroupId(): string {
  return `grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 创建分组；同名直接返回已有分组。内置名「隐藏」已保留，直接返回内置隐藏分组 */
export function createGroup(name: string): Group {
  const trimmed = name.trim();
  if (trimmed === HIDDEN_GROUP_NAME) return hiddenGroup();
  const existing = groups().find((group) => group.name === trimmed);
  if (existing) return existing;
  const group: Group = { id: newGroupId(), name: trimmed, createdAt: Date.now() };
  setGroupsSignal((prev) => [...prev, group]);
  persist();
  return group;
}

export function renameGroup(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed || trimmed === HIDDEN_GROUP_NAME) return;
  setGroupsSignal((prev) =>
    prev.map((group) => (group.id === id ? { ...group, name: trimmed } : group)),
  );
  persist();
}

/** 删除分组，并把该书架内书籍退回未分组 */
export async function deleteGroup(id: string): Promise<void> {
  setGroupsSignal((prev) => prev.filter((group) => group.id !== id));
  persist();
  await clearLocalGroup(id);
}

// ---------------------------------------------------------------------------
// 入架后的「加入分组」入口
// 提示条上的按钮点亮「待移入分组」的书，抽屉由 AppShell 统一渲染：
// 在线书入架后常常紧接着跳转（书架 / 阅读页），开关放模块级 signal 才能跨页面可用。
// ---------------------------------------------------------------------------

const [assignBookId, setAssignBookId] = createSignal<string | null>(null);

/** 当前待移入分组的书 id（null = 抽屉关闭） */
export function groupAssignBookId(): string | null {
  return assignBookId();
}

export function openGroupAssign(bookId: string): void {
  setAssignBookId(bookId);
}

export function closeGroupAssign(): void {
  setAssignBookId(null);
}

/** 把书移入分组（groupId 为 null 表示移出分组）并提示结果 */
export async function assignBookGroup(bookId: string, groupId: string | null): Promise<void> {
  // 提示还在屏幕上时书可能已被删掉：别报「已移入」却什么都没发生
  if (!bookMetaById(bookId)) {
    showToast(t("book.groups.bookMissing"), true);
    return;
  }
  try {
    await setLocalBookGroup(bookId, groupId);
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), true);
    return;
  }
  showToast(
    groupId
      ? t("book.groups.movedTo", { name: groupDisplayName(groupId) })
      : t("book.groups.movedOut"),
  );
}

/** 书籍入架成功的提示：右侧「加入分组」按钮打开移入分组抽屉 */
export function notifyAddedToShelf(bookId: string): void {
  showActionToast(t("book.groups.addedToShelf"), {
    label: t("book.groups.joinGroup"),
    onClick: () => openGroupAssign(bookId),
  });
}

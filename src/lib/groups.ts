/**
 * 书架分组（本地书 / 云端书共用）。
 * - 分组列表作为偏好由 Rust 后端持久化（readerx.groups）；
 * - 书籍的归属通过各自 book 上的 groupId 字段记录。
 */
import { createSignal } from "solid-js";
import { readState, writeState } from "./backend";
import { clearLocalGroup } from "./books";

export interface Group {
  id: string;
  name: string;
  createdAt: number;
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

function persist(): void {
  const snapshot = [...groups()];
  void writeState(GROUPS_KEY, snapshot);
}

export function groupById(id: string): Group | undefined {
  return groups().find((group) => group.id === id);
}

export function groupName(id?: string | null): string {
  if (!id) return "";
  return groups().find((group) => group.id === id)?.name ?? "";
}

function newGroupId(): string {
  return `grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 创建分组；同名直接返回已有分组 */
export function createGroup(name: string): Group {
  const trimmed = name.trim();
  const existing = groups().find((group) => group.name === trimmed);
  if (existing) return existing;
  const group: Group = { id: newGroupId(), name: trimmed, createdAt: Date.now() };
  setGroupsSignal((prev) => [...prev, group]);
  persist();
  return group;
}

export function renameGroup(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
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

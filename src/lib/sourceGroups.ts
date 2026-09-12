/**
 * 书源分组（书源管理 / 发现页 / 书源编辑页共用）。
 * - 分组清单作为偏好由 Rust 后端持久化（readerx.sourceGroups，与书架分组的存法一致）；
 * - 书源自身只在各自的 book_sources/<id>.json 里记 groupId（本地归属 id，导出时不外带）；
 * - 删除分组时把组内书源退回未分组：源文件的改写交给 Rust（readerx_source_group_clear）。
 */
import { createSignal } from "solid-js";
import { clearRemoteSourceGroup, readState, writeState } from "./backend";

export interface SourceGroup {
  id: string;
  name: string;
  createdAt: number;
}

/** 筛选值：全部书源 */
export const SOURCE_FILTER_ALL = "all";
/** 筛选值：未归入任何分组的书源（含归属分组已被删除的书源） */
export const SOURCE_FILTER_NONE = "none";

/** 分组名上限（筛选条 chip 要放得下；与书源名 60 字的口径无关） */
export const SOURCE_GROUP_NAME_MAX = 24;

const SOURCE_GROUPS_KEY = "readerx.sourceGroups";

const [sourceGroups, setSourceGroups] = createSignal<SourceGroup[]>([]);
let initialized = false;
/** 串行落盘：连续改名 / 新建时后写覆盖先写，避免顺序错乱 */
let writeQueue: Promise<void> = Promise.resolve();

export function sourceGroupList(): SourceGroup[] {
  return sourceGroups();
}

export function sourceGroupsReady(): boolean {
  return initialized;
}

function normalizeName(name: string): string {
  return name.trim().slice(0, SOURCE_GROUP_NAME_MAX);
}

function isStoredGroup(value: unknown): value is SourceGroup {
  const group = value as SourceGroup | null;
  return (
    !!group &&
    typeof group.id === "string" &&
    group.id.trim().length > 0 &&
    typeof group.name === "string" &&
    group.name.trim().length > 0
  );
}

/** 进入书源管理 / 发现 / 书源编辑页时调用（幂等） */
export async function ensureSourceGroupsLoaded(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const stored = await readState<unknown>(SOURCE_GROUPS_KEY);
  if (!Array.isArray(stored)) return;
  const seen = new Set<string>();
  const groups: SourceGroup[] = [];
  for (const raw of stored) {
    if (!isStoredGroup(raw) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    groups.push({
      id: raw.id,
      name: normalizeName(raw.name),
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    });
  }
  setSourceGroups(groups);
}

function persist(): void {
  const snapshot = sourceGroups().map((group) => ({ ...group }));
  writeQueue = writeQueue.then(() => writeState(SOURCE_GROUPS_KEY, snapshot));
}

export function sourceGroupById(id?: string | null): SourceGroup | undefined {
  if (!id) return undefined;
  return sourceGroups().find((group) => group.id === id);
}

/** 分组名；未分组 / 分组已删除时返回空串 */
export function sourceGroupName(id?: string | null): string {
  return sourceGroupById(id)?.name ?? "";
}

function newSourceGroupId(): string {
  return `sg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 新建分组；同名则直接返回已有分组（不重复建） */
export function createSourceGroup(name: string): SourceGroup | null {
  const trimmed = normalizeName(name);
  if (!trimmed) return null;
  const existing = sourceGroups().find((group) => group.name === trimmed);
  if (existing) return existing;
  const group: SourceGroup = {
    id: newSourceGroupId(),
    name: trimmed,
    createdAt: Date.now(),
  };
  setSourceGroups((prev) => [...prev, group]);
  persist();
  return group;
}

/** 按名称取分组，没有就建一个（导入时按 groupName 复用 / 建立分组） */
export function ensureSourceGroup(name: string): SourceGroup | null {
  return createSourceGroup(name);
}

/** 重命名分组；名称为空或与其它分组同名时不动并返回 false */
export function renameSourceGroup(id: string, name: string): boolean {
  const trimmed = normalizeName(name);
  if (!trimmed) return false;
  const group = sourceGroupById(id);
  if (!group || group.name === trimmed) return false;
  if (sourceGroups().some((item) => item.id !== id && item.name === trimmed)) return false;
  setSourceGroups((prev) =>
    prev.map((item) => (item.id === id ? { ...item, name: trimmed } : item)),
  );
  persist();
  return true;
}

/** 删除分组并把组内书源退回未分组，返回被退回的书源数量 */
export async function deleteSourceGroup(id: string): Promise<number> {
  const cleared = await clearRemoteSourceGroup(id);
  setSourceGroups((prev) => prev.filter((group) => group.id !== id));
  persist();
  return cleared;
}

/**
 * 把记忆的筛选值还原为当前有效值：分组已删 / 值非法 → 全部。
 * 书源清单与分组清单由不同入口载入，页面用筛选值前先过一道这里。
 */
export function resolveSourceFilter(key: string): string {
  if (key === SOURCE_FILTER_ALL || key === SOURCE_FILTER_NONE) return key;
  return sourceGroupById(key) ? key : SOURCE_FILTER_ALL;
}

/** 按筛选值过滤书源（管理页与发现页共用同一套口径） */
export function filterSourcesByGroup<T extends { groupId?: string }>(
  sources: readonly T[],
  filter: string,
): T[] {
  if (filter === SOURCE_FILTER_ALL) return [...sources];
  if (filter === SOURCE_FILTER_NONE) {
    return sources.filter((source) => !sourceGroupById(source.groupId));
  }
  return sources.filter((source) => source.groupId === filter);
}

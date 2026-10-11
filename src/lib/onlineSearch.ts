import type { BookItem, BookSourceSummary } from "./bookSourcesTypes";
import { normalizeBookTags } from "./booksTypes";

export interface SourceCandidate { source: BookSourceSummary; item: BookItem }
export interface SearchGroup extends SourceCandidate { candidates: SourceCandidate[] }

/** 把书源返回的裸记录归一化成 BookItem（bookName/bookUrl 必填，其余字段过滤后透传） */
export function toItem(raw: unknown): BookItem | null {
  const item = raw as Record<string, unknown> | null;
  if (!item || typeof item.bookName !== "string" || typeof item.bookUrl !== "string") {
    return null;
  }
  const bookName = item.bookName.trim();
  const bookUrl = item.bookUrl.trim();
  if (!bookName || !bookUrl) return null;
  const str = (key: string): string | undefined =>
    typeof item[key] === "string" ? (item[key] as string) : undefined;
  const tags = normalizeBookTags(item.tags);
  return {
    bookName,
    bookUrl,
    author: str("author"),
    cover: str("cover"),
    intro: str("intro"),
    latest: str("latest"),
    updateTime: str("updateTime"),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/** 上限按书名计；达到上限后仍补齐已有书名的来源。 */
export function mergeSearchResults(previous: SearchGroup[], batch: SourceCandidate[], limit = 120): SearchGroup[] {
  const groups = previous.map((entry) => ({ ...entry, candidates: [...entry.candidates] }));
  const byName = new Map(groups.map((entry) => [entry.item.bookName.trim(), entry]));
  for (const candidate of batch) {
    const name = candidate.item.bookName.trim();
    if (!name) continue;
    const group = byName.get(name);
    if (group) {
      if (!group.candidates.some((other) => other.source.id === candidate.source.id && other.item.bookUrl === candidate.item.bookUrl)) group.candidates.push(candidate);
    } else if (groups.length < limit) {
      const entry = { ...candidate, candidates: [candidate] };
      groups.push(entry);
      byName.set(name, entry);
    }
  }
  return groups;
}

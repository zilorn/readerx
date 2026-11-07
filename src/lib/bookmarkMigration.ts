/**
 * 目录变化后的书签迁移与修复。
 *
 * 在线书目录可能在中段增删、重排或换章节地址。增量目录更新会保留仍能对应的章节 cid，
 * 但旧版本曾经整本覆盖目录、按新下标重排过 cid，导致书签落在“同下标但不同章节”上。
 * 这里用三条证据重新确定书签所属章节：
 *
 * 1. cid 仍存在时先信 cid；正文里能找回书签原文则确认命中；
 * 2. cid 指向的章节标题与书签记录不一致时，改按「章节名 + 卷名」查找；
 * 3. 章节名也变了 / 缺失时，在已缓存正文里找书签原文；只有唯一命中或标题高度相似才迁移。
 *
 * 找不到可靠章节的书签原样保留（不把书签改到猜测的位置），并计入 unresolved。
 * 目录更新与「检查更新但目录无变化」都会调用本模块，因此旧版本留下的错位书签会在
 * 下一次检查更新时自动修复。
 */
import { chapterUnits } from "./pagination";
import { normalizeSearchText } from "./fuzzy";
import type { LocalBookChapter } from "./booksTypes";
import {
  BOOKMARK_CONTEXT,
  bestMatchStart,
  bookmarksFor,
  buildTextMirror,
  ensureBookmarksLoaded,
  replaceBookmarksForBook,
  unitAtGlobalOffset,
  type Bookmark,
  type TextMirror,
} from "./bookmarks";

/** 迁移 / 修复结果：repaired 是记录有变化的条数，migrated 是换到其它章节的条数。 */
export interface BookmarkTocMigrationResult {
  total: number;
  repaired: number;
  migrated: number;
  unresolved: number;
}

/** 迁移时需要的书签定位字段（导入外部书签也复用同一套定位逻辑）。 */
export interface BookmarkPlacementInput {
  chapterCid: string;
  chapterIndex: number;
  chapterTitle: string;
  chapterVolume?: string;
  unitIndex: number;
  charStart: number;
  charEnd: number;
  text: string;
  before: string;
  after: string;
}

export interface BookmarkPlacement {
  chapter: LocalBookChapter;
  chapterIndex: number;
  unitIndex: number;
  charStart: number;
  charEnd: number;
  before: string;
  after: string;
  /** 书签从原 cid 换到了另一章 */
  movedChapter: boolean;
  /** 在新章节正文里找到了书签原文（而不是保留原偏移） */
  anchored: boolean;
}

interface Candidate {
  chapter: LocalBookChapter;
  index: number;
  titleKey: string;
  volumeKey: string;
  /** 懒构建：只有真正参与正文比对的章节才拼镜像文本（大书目录可能上万章） */
  mirror?: TextMirror | null;
}

function hasContent(chapter: LocalBookChapter): boolean {
  return chapter.blocks !== undefined || (chapter.paragraphs?.length ?? 0) > 0;
}

function titleKeyOf(title: string | undefined): string {
  return normalizeSearchText(title ?? "");
}

function volumeKeyOf(volume: string | undefined): string {
  return normalizeSearchText(volume ?? "");
}

/** 两段标题的二元组 Dice 相似度（0..1），用于标题被轻微改写时兜底 */
function titleSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.85;
  const bigrams = (value: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i + 1 < value.length; i++) out.add(value.slice(i, i + 2));
    return out;
  };
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** 书签文本在章节里大部分仍能找回时给分；只用于「标题也像」的候选，避免常见短句误判。 */
function sampledTextCoverage(haystack: string, needle: string): number {
  if (needle.length < 12 || !haystack) return 0;
  const size = Math.min(24, Math.max(8, Math.floor(needle.length / 3)));
  const starts = [0, Math.max(0, Math.floor((needle.length - size) / 2)), Math.max(0, needle.length - size)];
  let hits = 0;
  for (const start of starts) if (haystack.includes(needle.slice(start, start + size))) hits++;
  return hits / starts.length;
}

function prepareCandidates(chapters: readonly LocalBookChapter[]): Candidate[] {
  return chapters.map((chapter, index) => ({
    chapter,
    index,
    titleKey: titleKeyOf(chapter.title),
    volumeKey: volumeKeyOf(chapter.volume),
  }));
}

function mirrorOf(candidate: Candidate): TextMirror | null {
  if (candidate.mirror !== undefined) return candidate.mirror;
  candidate.mirror = hasContent(candidate.chapter)
    ? buildTextMirror(chapterUnits(candidate.chapter))
    : null;
  return candidate.mirror;
}

function textEvidence(
  candidate: Candidate,
  ref: BookmarkPlacementInput,
): { exact: boolean; score: number } {
  const mirror = mirrorOf(candidate);
  if (!mirror || !ref.text) return { exact: false, score: 0 };
  if (mirror.text.includes(ref.text)) return { exact: true, score: 1200 };
  return { exact: false, score: sampledTextCoverage(mirror.text, ref.text) * 400 };
}

/** 回填篇章内偏移；有正文时优先按原文 + 前后锚定位，找不到则把旧偏移夹进正文范围。 */
function placeInChapter(
  candidate: Candidate,
  ref: BookmarkPlacementInput,
  anchored: boolean,
): BookmarkPlacement {
  let unitIndex = ref.unitIndex;
  let charStart = ref.charStart;
  let charEnd = ref.charEnd;
  let before = ref.before;
  let after = ref.after;
  let found = false;
  const mirror = mirrorOf(candidate);
  if (mirror) {
    const match = bestMatchStart(mirror, ref);
    if (match) {
      const placed = unitAtGlobalOffset(mirror, match.start);
      if (placed) {
        const length = Math.max(1, ref.charEnd - ref.charStart);
        charStart = match.start;
        charEnd = Math.min(mirror.text.length, match.start + length);
        unitIndex = placed.unit;
        before = mirror.text.slice(Math.max(0, charStart - BOOKMARK_CONTEXT), charStart);
        after = mirror.text.slice(charEnd, charEnd + BOOKMARK_CONTEXT);
        found = true;
      }
    }
    if (!found) {
      const length = Math.max(1, ref.charEnd - ref.charStart);
      charStart = Math.max(0, Math.min(ref.charStart, Math.max(0, mirror.text.length - 1)));
      charEnd = Math.min(mirror.text.length, Math.max(charStart + 1, charStart + length));
      const placed = unitAtGlobalOffset(mirror, charStart);
      if (placed) unitIndex = placed.unit;
      before = mirror.text.slice(Math.max(0, charStart - BOOKMARK_CONTEXT), charStart);
      after = mirror.text.slice(charEnd, charEnd + BOOKMARK_CONTEXT);
    }
  }
  return {
    chapter: candidate.chapter,
    chapterIndex: candidate.index,
    unitIndex,
    charStart,
    charEnd,
    before,
    after,
    movedChapter: candidate.chapter.cid !== ref.chapterCid,
    anchored: anchored || found,
  };
}

/** 同一标题下挑最可信的一章：卷名一致优先，其次离原下标近。 */
function pickClosest(
  candidates: Candidate[],
  ref: BookmarkPlacementInput,
  volumeKey: string,
): Candidate {
  let best = candidates[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    let score = 0;
    if (volumeKey && candidate.volumeKey === volumeKey) score += 40;
    score -= Math.min(200, Math.abs(candidate.index - ref.chapterIndex)) * 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * 复用同一份候选章节 / 正文镜像的解析器：整本书的书签或导入文件逐条解析时，
 * 只准备一次目录与已缓存正文，避免每条书签都重扫全书。
 */
export interface BookmarkPlacementResolver {
  resolve(ref: BookmarkPlacementInput): BookmarkPlacement | null;
}

export interface BookmarkPlacementOptions {
  /**
   * 导入外部文件时使用：章节 ID 仍存在、但标题 / 卷名与文件不一致且没有更可靠的同名章节时，
   * 按章节 ID 落位（用户可能手动改过 ID，或章节名在源头被改写）。目录自动迁移不启用，
   * 以免把旧版本遗留的错位 cid 当成可靠身份、覆盖书签原来的章节名提示。
   */
  fallbackToCid?: boolean;
}

function resolveWithCandidates(
  candidates: Candidate[],
  ref: BookmarkPlacementInput,
  options?: BookmarkPlacementOptions,
): BookmarkPlacement | null {
  if (candidates.length === 0) return null;
  const titleKey = titleKeyOf(ref.chapterTitle);
  const volumeKey = volumeKeyOf(ref.chapterVolume);
  const currentIndex = candidates.findIndex(
    (candidate) => candidate.chapter.cid === ref.chapterCid,
  );
  const current = currentIndex >= 0 ? candidates[currentIndex] : null;
  const currentText = current ? textEvidence(current, ref) : null;
  const currentTitleMatches = !!titleKey && current?.titleKey === titleKey;

  // 1) 原 cid 仍在，且正文能找回书签原文：最可靠的直接命中。
  if (current && currentText?.exact) return placeInChapter(current, ref, true);

  // 2) 另有一章标题一致且正文能找回原文：这是旧覆盖更新后最常见的错位形态。
  const titleMatches = titleKey
    ? candidates.filter((candidate) => candidate.titleKey === titleKey && candidate.index !== currentIndex)
    : [];
  const exactTitleMatches = titleMatches.filter((candidate) => textEvidence(candidate, ref).exact);
  if (exactTitleMatches.length > 0) {
    return placeInChapter(pickClosest(exactTitleMatches, ref, volumeKey), ref, true);
  }

  // 3) 原 cid 仍可信：标题一致，或旧记录没有标题字段。
  if (current && (currentTitleMatches || !titleKey)) {
    return placeInChapter(current, ref, !!currentText?.exact);
  }

  // 4) 标题被改写，但原章节正文大部分仍能对上：留在原章节。
  if (current && (currentText?.score ?? 0) >= 240) {
    return placeInChapter(current, ref, false);
  }

  // 5) 在已缓存正文里找原文。唯一命中才迁移，避免“说道”这类常见短句把书签带到别的章。
  const exactTextMatches = candidates.filter(
    (candidate) => mirrorOf(candidate) !== null && textEvidence(candidate, ref).exact,
  );
  if (exactTextMatches.length === 1) {
    return placeInChapter(exactTextMatches[0], ref, true);
  }
  if (exactTextMatches.length > 1) {
    const best = pickClosest(exactTextMatches, ref, volumeKey);
    const titleSimilarityValue = titleSimilarity(titleKey, best.titleKey);
    if (titleSimilarityValue >= 0.5) return placeInChapter(best, ref, true);
  }

  // 5b) 正文没有逐字命中，但书名 / 章节名被改写、正文大部分仍相似：只在标题也相近时迁移。
  if (titleKey) {
    const similarMatches = candidates
      .map((candidate) => ({ candidate, evidence: textEvidence(candidate, ref) }))
      .filter(
        ({ candidate, evidence }) =>
          !evidence.exact &&
          evidence.score >= 240 &&
          titleSimilarity(titleKey, candidate.titleKey) >= 0.4,
      );
    if (similarMatches.length > 0) {
      let best = similarMatches[0];
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const match of similarMatches) {
        const score =
          match.evidence.score +
          titleSimilarity(titleKey, match.candidate.titleKey) * 200 -
          Math.min(200, Math.abs(match.candidate.index - ref.chapterIndex)) * 0.2;
        if (score > bestScore) {
          bestScore = score;
          best = match;
        }
      }
      if (
        similarMatches.length === 1 ||
        titleSimilarity(titleKey, best.candidate.titleKey) >= 0.6
      ) {
        return placeInChapter(best.candidate, ref, false);
      }
    }
  }

  // 6) 原 cid 已不存在、或指向别的章，但有唯一同名章节（正文尚未缓存）：按标题迁移。
  if (titleMatches.length === 1) {
    return placeInChapter(titleMatches[0], ref, false);
  }
  if (titleMatches.length > 1) {
    return placeInChapter(pickClosest(titleMatches, ref, volumeKey), ref, false);
  }

  // 导入文件可以信任仍然存在的章节 ID；目录自动迁移则保留原记录，等更有力的证据。
  if (current && options?.fallbackToCid) return placeInChapter(current, ref, false);
  return null;
}

export function createBookmarkPlacementResolver(
  chapters: readonly LocalBookChapter[],
  options?: BookmarkPlacementOptions,
): BookmarkPlacementResolver {
  const candidates = prepareCandidates(chapters);
  return { resolve: (ref) => resolveWithCandidates(candidates, ref, options) };
}

/**
 * 为一条书签确定在新目录中的章节与偏移（单条查询的便捷入口）。
 * 返回 null 表示没有可靠依据：调用方应保留原记录，等待下次更新再试。
 */
export function resolveBookmarkPlacement(
  chapters: readonly LocalBookChapter[],
  ref: BookmarkPlacementInput,
): BookmarkPlacement | null {
  return createBookmarkPlacementResolver(chapters).resolve(ref);
}

/** 迁移后字段是否真的变了（用于决定是否写盘）。 */
function sameBookmark(left: Bookmark, right: Bookmark): boolean {
  return (
    left.chapterCid === right.chapterCid &&
    left.chapterIndex === right.chapterIndex &&
    left.chapterTitle === right.chapterTitle &&
    left.chapterVolume === right.chapterVolume &&
    left.unitIndex === right.unitIndex &&
    left.charStart === right.charStart &&
    left.charEnd === right.charEnd &&
    left.before === right.before &&
    left.after === right.after
  );
}

function bookmarkForPlacement(bookmark: Bookmark, placement: BookmarkPlacement): Bookmark {
  const next: Bookmark = {
    ...bookmark,
    chapterCid: placement.chapter.cid,
    chapterIndex: placement.chapterIndex,
    chapterTitle: placement.chapter.title,
    ...(placement.chapter.volume ? { chapterVolume: placement.chapter.volume } : {}),
    unitIndex: placement.unitIndex,
    charStart: placement.charStart,
    charEnd: placement.charEnd,
    before: placement.before,
    after: placement.after,
  };
  if (!placement.chapter.volume && "chapterVolume" in next) delete next.chapterVolume;
  return next;
}

/**
 * 按当前目录修复一本书的全部书签并落盘。
 * 目录更新后调用；「检查更新」发现目录没变时也调用一次，以修复旧版本遗留的错位书签。
 */
export async function migrateBookmarksForToc(
  bookId: string,
  chapters: readonly LocalBookChapter[],
): Promise<BookmarkTocMigrationResult> {
  await ensureBookmarksLoaded(bookId);
  const list = bookmarksFor(bookId);
  const result: BookmarkTocMigrationResult = {
    total: list.length,
    repaired: 0,
    migrated: 0,
    unresolved: 0,
  };
  if (list.length === 0) return result;

  let changed = false;
  const resolver = createBookmarkPlacementResolver(chapters);
  const next = list.map((bookmark) => {
    const placement = resolver.resolve(bookmark);
    if (!placement) {
      result.unresolved++;
      return bookmark;
    }
    const migrated = bookmarkForPlacement(bookmark, placement);
    if (sameBookmark(bookmark, migrated)) return bookmark;
    changed = true;
    result.repaired++;
    if (placement.movedChapter) result.migrated++;
    return migrated;
  });
  if (changed) await replaceBookmarksForBook(bookId, next);
  return result;
}

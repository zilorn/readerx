/** 段落级注释。锚点来自原书，显示替换/简繁转换不改动其身份。 */
import { createSignal } from "solid-js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { readRemoteAnnotations, saveRemoteAnnotations } from "./backend";
import type { ReaderBlock } from "./pagination";
import { reportFailure } from "./errorReport";
import { t } from "./i18n";
import { createLogger } from "./logger";

export const ANNOTATION_MAX_LENGTH = 2000;
export interface ParagraphAnchor {
  chapterCid: string;
  unitIndex: number;
  fingerprint: string;
  before: string;
  after: string;
}
export interface AnnotationNote {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}
export interface ParagraphAnnotation extends ParagraphAnchor {
  id: string;
  notes: AnnotationNote[];
}
const log = createLogger("annotations");
const [records, setRecords] = createSignal<Record<string, ParagraphAnnotation[]>>({});
const loaded = new Set<string>();
const loading = new Map<string, Promise<boolean>>();
let queue = Promise.resolve();
let generation = 0;
const bookGenerations = new Map<string, number>();
const [cacheVersion, setCacheVersion] = createSignal(0);
export const annotationCacheVersion = cacheVersion;
const epochFor = (bookId: string) => `${generation}:${bookGenerations.get(bookId) ?? 0}`;

function validRecords(value: unknown): value is ParagraphAnnotation[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) =>
    item && typeof item.id === "string" && typeof item.chapterCid === "string" &&
    Number.isInteger(item.unitIndex) && item.unitIndex >= 0 &&
    typeof item.fingerprint === "string" && /^[a-f0-9]{64}$/.test(item.fingerprint) &&
    typeof item.before === "string" && typeof item.after === "string" &&
    Array.isArray(item.notes) && item.notes.every((note: AnnotationNote) =>
      note && typeof note.id === "string" && typeof note.text === "string" &&
      Number.isFinite(note.createdAt) && Number.isFinite(note.updatedAt),
    ),
  );
}

const fingerprints = new WeakMap<ReaderBlock, string>();
function fingerprint(unit: ReaderBlock | undefined): string {
  if (unit?.kind !== "p") return "";
  const cached = fingerprints.get(unit);
  if (cached) return cached;
  const value = bytesToHex(sha256(new TextEncoder().encode(unit.text)));
  fingerprints.set(unit, value);
  return value;
}
export function paragraphAnchor(
  chapterCid: string,
  units: ReaderBlock[],
  unitIndex: number,
): ParagraphAnchor | null {
  const unit = units[unitIndex];
  if (!chapterCid || unit?.kind !== "p" || !unit.text.trim()) return null;
  return {
    chapterCid, unitIndex, fingerprint: fingerprint(unit),
    before: fingerprint(units[unitIndex - 1]),
    after: fingerprint(units[unitIndex + 1]),
  };
}

/** 原段仍在时直接命中；正文改变后只采用唯一的指纹/邻段匹配，歧义时不误挂。 */
export function resolveAnnotationUnit(anchor: ParagraphAnchor, units: ReaderBlock[]): number | null {
  const candidates = units.flatMap((unit, i) => fingerprint(unit) === anchor.fingerprint ? [i] : []);
  if (candidates.length === 1) return candidates[0];
  const contextual = candidates.filter((i) =>
    fingerprint(units[i - 1]) === anchor.before && fingerprint(units[i + 1]) === anchor.after,
  );
  if (contextual.includes(anchor.unitIndex)) return anchor.unitIndex;
  return contextual.length === 1 ? contextual[0] : null;
}
export function annotationsFor(bookId: string): ParagraphAnnotation[] {
  return records()[bookId] ?? [];
}
export function ensureAnnotationsLoaded(bookId: string): Promise<boolean> {
  if (loaded.has(bookId)) return Promise.resolve(true);
  const pending = loading.get(bookId);
  if (pending) return pending;
  const epoch = epochFor(bookId);
  const task = (async () => {
    const stored = await readRemoteAnnotations<ParagraphAnnotation>(bookId);
    if (stored === null || epoch !== epochFor(bookId)) return false;
    if (!validRecords(stored)) {
      reportFailure(t("readerChrome.annotation.readFailed"), new Error(t("readerChrome.annotation.invalid")));
      return false;
    }
    setRecords((prev) => ({ ...prev, [bookId]: stored }));
    loaded.add(bookId);
    return true;
  })().finally(() => {
    if (loading.get(bookId) === task) loading.delete(bookId);
  });
  loading.set(bookId, task);
  return task;
}
export function invalidateAnnotationCache(bookId?: string): void {
  if (bookId) {
    bookGenerations.set(bookId, (bookGenerations.get(bookId) ?? 0) + 1);
    loaded.delete(bookId);
    loading.delete(bookId);
    setRecords((prev) => {
      const next = { ...prev };
      delete next[bookId];
      return next;
    });
    setCacheVersion((value) => value + 1);
    return;
  }
  generation++;
  loaded.clear();
  loading.clear();
  setRecords({});
  setCacheVersion((value) => value + 1);
}

function newAnnotationId(): string {
  // 与书签/替换规则同样的本地身份生成方式，兼容没有 randomUUID 的 WebView。
  return `an-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 串行读改写；读取/写入失败时保留磁盘和草稿，不发布虚假的保存成功。 */
export function saveAnnotationNote(
  bookId: string,
  anchor: ParagraphAnchor,
  paragraphId: string | null,
  noteId: string | null,
  text: string,
): Promise<boolean> {
  const value = text.trim();
  if (!value || value.length > ANNOTATION_MAX_LENGTH) return Promise.resolve(false);
  const epoch = epochFor(bookId);
  let result = false;
  const task = queue.then(async () => {
    if (epoch !== epochFor(bookId) || !await ensureAnnotationsLoaded(bookId)) return;
    if (epoch !== epochFor(bookId)) return;
    const list = annotationsFor(bookId);
    const existing = paragraphId
      ? list.find((item) => item.id === paragraphId)
      : list.find((item) => item.chapterCid === anchor.chapterCid &&
        item.unitIndex === anchor.unitIndex && item.fingerprint === anchor.fingerprint);
    if (paragraphId && !existing) return;
    const previous = noteId ? existing?.notes.find((note) => note.id === noteId) : null;
    if (noteId && !previous) return;
    const now = Date.now();
    const note: AnnotationNote = {
      ...previous,
      id: previous?.id ?? newAnnotationId(), text: value,
      createdAt: previous?.createdAt ?? now, updatedAt: now,
    };
    const paragraph: ParagraphAnnotation = {
      ...existing, ...anchor, id: existing?.id ?? newAnnotationId(),
      notes: previous
        ? existing!.notes.map((item) => item.id === note.id ? note : item)
        : [...(existing?.notes ?? []), note],
    };
    const next = existing
      ? list.map((item) => item.id === existing.id ? paragraph : item)
      : [...list, paragraph];
    if (!await saveRemoteAnnotations(bookId, next) || epoch !== epochFor(bookId)) return;
    setRecords((prev) => ({ ...prev, [bookId]: next }));
    log.info(previous ? "注释更新完成" : "注释添加完成", { bookId, paragraphs: next.length });
    result = true;
  });
  queue = task.catch(() => {});
  return task.then(() => result);
}

/** 备份/删书开始前等待正在进行的注释保存，避免随后用旧数据覆盖恢复结果。 */
export function flushAnnotationWrites(): Promise<void> {
  return queue;
}

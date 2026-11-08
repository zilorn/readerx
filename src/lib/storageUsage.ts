/**
 * 数据占用与按书清理。统计和删除都在 Rust 侧完成，这里只转发命令。
 * 浏览器开发环境没有应用数据目录，返回空报告，清理为无操作。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

export type StorageCategoryId =
  | "library"
  | "images"
  | "tts"
  | "sources"
  | "sync"
  | "logs"
  | "state"
  | "migrated"
  | "other";

export interface StorageCategory {
  id: string;
  bytes: number;
}

export interface BookStorage {
  bookId: string;
  imagesBytes: number;
  imagesExclusiveBytes: number;
  ttsBytes: number;
  translationBytes: number;
  migratedBytes: number;
  contentBytes: number;
}

export interface UnscopedStorage {
  imagesBytes: number;
  migratedBytes: number;
}

export interface StorageReport {
  totalBytes: number;
  categories: StorageCategory[];
  translationBytes: number;
  books: BookStorage[];
  unscoped: UnscopedStorage;
}

export interface CleanupResult {
  removedBytes: number;
  books: number;
  images: number;
  translationRows: number;
  migratedFiles: number;
}

export const CLEANUP_KINDS = ["images", "tts", "translation", "migrated"] as const;
export type CleanupKind = (typeof CLEANUP_KINDS)[number];

const EMPTY_REPORT: StorageReport = {
  totalBytes: 0,
  categories: [],
  translationBytes: 0,
  books: [],
  unscoped: { imagesBytes: 0, migratedBytes: 0 },
};

export async function loadStorageUsage(): Promise<StorageReport> {
  if (!isTauri()) return EMPTY_REPORT;
  return invoke<StorageReport>("readerx_storage_usage");
}

export async function cleanupStorage(
  bookIds: string[],
  kinds: string[],
  includeUnscoped: boolean,
): Promise<CleanupResult> {
  if (!isTauri()) {
    return { removedBytes: 0, books: bookIds.length, images: 0, translationRows: 0, migratedFiles: 0 };
  }
  return invoke<CleanupResult>("readerx_storage_cleanup", {
    bookIds,
    kinds,
    includeUnscoped,
  });
}

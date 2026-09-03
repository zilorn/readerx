/**
 * 听书音频缓存（Rust 后端磁盘缓存）前端桥。
 *
 * 缓存的是一句一句合成好的音频字节（按“书籍 + 声源指纹 + 句子”寻址），
 * 由 Rust 存到应用数据目录 tts-audio/<bookId>/ 下，书籍删除/手动清理时移除。
 * 纯浏览器 dev（非 Tauri）时全部 no-op，避免打断播放。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

export interface CachedAudioHit {
  data: string; // base64
  mime: string;
}

export interface TtsCacheStat {
  bookId: string;
  files: number;
  bytes: number;
}

const tauri = isTauri();

/** 读取一句缓存音频（未命中或不可用返回 null） */
export async function readTtsAudioCache(
  bookId: string,
  key: string,
): Promise<CachedAudioHit | null> {
  if (!tauri || !bookId || !key) return null;
  try {
    const hit = await invoke<CachedAudioHit | null>("readerx_tts_cache_get", { bookId, key });
    return hit ?? null;
  } catch (err) {
    console.error("[tts-cache] 读取缓存失败", err);
    return null;
  }
}

/** 写入一句缓存音频（失败只记日志，不影响朗读） */
export async function writeTtsAudioCache(
  bookId: string,
  key: string,
  data: string,
  mime: string,
): Promise<void> {
  if (!tauri || !bookId || !key) return;
  try {
    await invoke("readerx_tts_cache_put", { bookId, key, data, mime });
  } catch (err) {
    console.error("[tts-cache] 写入缓存失败", err);
  }
}

/** 各书籍缓存统计（设置页展示） */
export async function listTtsAudioCaches(): Promise<TtsCacheStat[]> {
  if (!tauri) return [];
  try {
    return await invoke<TtsCacheStat[]>("readerx_tts_cache_stats");
  } catch (err) {
    console.error("[tts-cache] 读取统计失败", err);
    return [];
  }
}

/** 清除缓存：bookId 省略时清空全部 */
export async function clearTtsAudioCache(bookId?: string): Promise<void> {
  if (!tauri) return;
  try {
    await invoke("readerx_tts_cache_clear", { bookId: bookId ?? null });
  } catch (err) {
    console.error("[tts-cache] 清理失败", err);
  }
}

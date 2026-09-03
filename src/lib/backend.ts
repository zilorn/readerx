/**
 * 前端与 Rust 后端的唯一通道。
 * - Tauri 环境：通过 invoke 读写 Rust 管理的 JSON 文件；
 * - 纯浏览器开发环境：只使用内存 Map 降级，不写任何 WebView 持久化存储。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { LocalBook } from "./booksTypes";

const tauri = isTauri();

const memoryState = new Map<string, unknown>();
const memoryBooks = new Map<string, LocalBook>();

/** 读取一条状态（readerx.* 前缀）；不存在或纯浏览器环境返回 null */
export async function readState<T>(key: string): Promise<T | null> {
  if (!tauri) {
    return (memoryState.get(key) as T | undefined) ?? null;
  }
  try {
    const value = await invoke<T | null>("readerx_state_get", { key });
    return value ?? null;
  } catch (err) {
    console.error(`[backend] 读取状态 ${key} 失败`, err);
    return null;
  }
}

/** 写入一条状态；Tauri 环境失败时降级为日志，不打断当前操作 */
export async function writeState(key: string, value: unknown): Promise<void> {
  if (!tauri) {
    memoryState.set(key, value);
    return;
  }
  try {
    await invoke("readerx_state_set", { key, value });
  } catch (err) {
    console.error(`[backend] 写入状态 ${key} 失败`, err);
  }
}

export async function removeState(key: string): Promise<void> {
  if (!tauri) {
    memoryState.delete(key);
    return;
  }
  try {
    await invoke("readerx_state_remove", { key });
  } catch (err) {
    console.error(`[backend] 删除状态 ${key} 失败`, err);
  }
}

export async function listRemoteBooks(): Promise<LocalBook[]> {
  if (!tauri) {
    return [...memoryBooks.values()];
  }
  return invoke<LocalBook[]>("readerx_book_list");
}

export async function saveRemoteBook(book: LocalBook): Promise<void> {
  if (!tauri) {
    memoryBooks.set(book.id, book);
    return;
  }
  await invoke("readerx_book_put", { book });
}

export async function deleteRemoteBook(id: string): Promise<void> {
  if (!tauri) {
    memoryBooks.delete(id);
    return;
  }
  await invoke("readerx_book_delete", { id });
}

export async function clearRemoteBooks(): Promise<void> {
  if (!tauri) {
    memoryBooks.clear();
    return;
  }
  const books = await listRemoteBooks();
  await Promise.all(books.map((book) => deleteRemoteBook(book.id)));
}

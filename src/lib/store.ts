/**
 * 轻量全局状态（模块级 signal，无额外依赖）：
 * - 主题：light / dark / sepia（护眼）
 * - 书架：记录每本书的阅读进度，均持久化到 localStorage
 */
import { createSignal } from "solid-js";

export type ThemeMode = "light" | "dark" | "sepia";

const THEME_KEY = "readerx.theme";
const SHELF_KEY = "readerx.shelf";
const FONT_KEY = "readerx.fontSize";

export const FONT_MIN = 15;
export const FONT_MAX = 28;
// 首次进入时预置到书架的书
const SEED_SHELF = ["b01", "b04", "b06", "b09"];

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 忽略隐私模式等写入失败 */
  }
}

function normalizeTheme(value: string | null): ThemeMode {
  return value === "dark" || value === "sepia" ? value : "light";
}

function systemTheme(): ThemeMode {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

/** 初始化（html[data-theme]），返回当前主题；供入口在 render 前调用防止闪色 */
export function initTheme(): ThemeMode {
  const mode = normalizeTheme(readRaw(THEME_KEY)) || systemTheme();
  document.documentElement.dataset.theme = mode;
  return mode;
}

const [theme, setThemeSignal] = createSignal<ThemeMode>(
  normalizeTheme(readRaw(THEME_KEY)) || systemTheme(),
);

/** 响应式主题值 */
export function currentTheme(): ThemeMode {
  return theme();
}

/** 切换主题并持久化 */
export function setTheme(next: ThemeMode): void {
  setThemeSignal(next);
  document.documentElement.dataset.theme = next;
  writeRaw(THEME_KEY, next);
}

// ---------------------------------------------------------------------------

export interface ShelfEntry {
  bookId: string;
  /** 当前读到的章节索引（0 起） */
  chapter: number;
  /** 最近一次进度更新时间戳 */
  updatedAt: number;
}

function loadShelf(): Record<string, ShelfEntry> {
  const raw = readRaw(SHELF_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as Record<string, ShelfEntry>;
    } catch {
      /* 数据损坏时回退到种子数据 */
    }
  }
  const seeded: Record<string, ShelfEntry> = {};
  const now = Date.now();
  SEED_SHELF.forEach((id, i) => {
    seeded[id] = { bookId: id, chapter: 0, updatedAt: now - i * 86_400_000 };
  });
  return seeded;
}

const [shelfMap, setShelfMap] = createSignal<Record<string, ShelfEntry>>(
  loadShelf(),
);

function persistShelf(): void {
  writeRaw(SHELF_KEY, JSON.stringify(shelfMap()));
}

/** 响应式书架记录表 */
export function shelfEntries(): Record<string, ShelfEntry> {
  return shelfMap();
}

/** 按最近阅读排序的书架条目 */
export function shelfOrder(): ShelfEntry[] {
  return Object.values(shelfMap()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function isOnShelf(bookId: string): boolean {
  return Object.prototype.hasOwnProperty.call(shelfMap(), bookId);
}

/** 加入 / 移出书架 */
export function toggleShelf(bookId: string): void {
  const map = { ...shelfMap() };
  if (bookId in map) {
    delete map[bookId];
  } else {
    map[bookId] = { bookId, chapter: 0, updatedAt: Date.now() };
  }
  setShelfMap(map);
  persistShelf();
}

/** 更新某本书的阅读进度 */
export function setReadingChapter(bookId: string, chapter: number): void {
  const map = { ...shelfMap() };
  const entry = map[bookId];
  if (!entry) return;
  map[bookId] = { ...entry, chapter, updatedAt: Date.now() };
  setShelfMap(map);
  persistShelf();
}

/** 清空书架 */
export function clearShelf(): void {
  setShelfMap({});
  persistShelf();
}

// ---------------------------------------------------------------------------
// 阅读字号（全局偏好，设置页与阅读页共用）

function clampFont(value: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(value)));
}

function loadFont(): number {
  const raw = readRaw(FONT_KEY);
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) return clampFont(n);
  }
  return 19;
}

const [fontSize, setFontSizeSignal] = createSignal<number>(loadFont());

/** 响应式正文字号（px） */
export function currentFontSize(): number {
  return fontSize();
}

/** 调整正文字号（自动 clamp 并持久化） */
export function setFontSize(value: number): void {
  const next = clampFont(value);
  setFontSizeSignal(next);
  writeRaw(FONT_KEY, String(next));
}

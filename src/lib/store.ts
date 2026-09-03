/**
 * 轻量全局状态（模块级 signal，无额外依赖）：
 * - 主题：light / dark / sepia（护眼）
 * - 书架：记录每本本地书的阅读进度
 * - 阅读字号
 * - 段落间距（em，相对正文字号）
 * 持久化统一交给 Rust 后端（readerx.* key），WebView 不落盘。
 */
import { createSignal } from "solid-js";
import { readState, writeState } from "./backend";

export type ThemeMode = "light" | "dark" | "sepia";

const THEME_KEY = "readerx.theme";
const SHELF_KEY = "readerx.shelf";
const FONT_KEY = "readerx.fontSize";
const PARA_SPACING_KEY = "readerx.paragraphSpacing";

export const FONT_MIN = 15;
export const FONT_MAX = 28;
export const PARA_SPACING_MIN = 0.5;
export const PARA_SPACING_MAX = 2.5;
export const PARA_SPACING_STEP = 0.05;
export const PARA_SPACING_DEFAULT = 1.05;

function normalizeTheme(value: string | null): ThemeMode | null {
  return value === "dark" || value === "sepia" ? value : value === "light" ? "light" : null;
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

function clampFont(value: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(value)));
}

function clampParaSpacing(value: number): number {
  const raw = Math.min(PARA_SPACING_MAX, Math.max(PARA_SPACING_MIN, value));
  return Math.round(raw / PARA_SPACING_STEP) * PARA_SPACING_STEP;
}

let initialized = false;

/**
 * 应用启动时从 Rust 后端载入全部偏好（幂等）。
 * 入口在 render 前 await，避免主题闪色。
 */
export async function initReaderState(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const [storedTheme, storedShelf, storedFont, storedSpacing] = await Promise.all([
    readState<string>(THEME_KEY),
    readState<Record<string, ShelfEntry>>(SHELF_KEY),
    readState<number>(FONT_KEY),
    readState<number>(PARA_SPACING_KEY),
  ]);
  await initTransbookConfig();

  const mode = normalizeTheme(storedTheme) ?? systemTheme();
  setThemeSignal(mode);
  document.documentElement.dataset.theme = mode;

  if (storedShelf && typeof storedShelf === "object") {
    setShelfMap(storedShelf);
  }
  if (typeof storedFont === "number" && Number.isFinite(storedFont)) {
    setFontSizeSignal(clampFont(storedFont));
  }
  if (typeof storedSpacing === "number" && Number.isFinite(storedSpacing)) {
    setParaSpacingSignal(clampParaSpacing(storedSpacing));
  }
}

// ---------------------------------------------------------------------------
// 主题

const [theme, setThemeSignal] = createSignal<ThemeMode>(systemTheme());
let themeWriteQueue: Promise<void> = Promise.resolve();

/** 响应式主题值 */
export function currentTheme(): ThemeMode {
  return theme();
}

function persistTheme(next: ThemeMode): void {
  themeWriteQueue = themeWriteQueue.then(() => writeState(THEME_KEY, next));
}

/** 切换主题并持久化 */
export function setTheme(next: ThemeMode): void {
  setThemeSignal(next);
  document.documentElement.dataset.theme = next;
  persistTheme(next);
}

// ---------------------------------------------------------------------------
// 书架进度

export interface ShelfEntry {
  bookId: string;
  /** 当前读到的章节索引（0 起） */
  chapter: number;
  /** 最近一次进度更新时间戳 */
  updatedAt: number;
}

const [shelfMap, setShelfMap] = createSignal<Record<string, ShelfEntry>>({});
let shelfWriteQueue: Promise<void> = Promise.resolve();

function persistShelf(): void {
  const snapshot = { ...shelfMap() };
  shelfWriteQueue = shelfWriteQueue.then(() => writeState(SHELF_KEY, snapshot));
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

/** 导入书籍后自动建档（已有则保留进度） */
export function ensureShelfEntry(bookId: string, chapter = 0): void {
  const map = { ...shelfMap() };
  if (bookId in map) return;
  map[bookId] = { bookId, chapter, updatedAt: Date.now() };
  setShelfMap(map);
  persistShelf();
}

/** 更新某本书的阅读进度 */
export function setReadingChapter(bookId: string, chapter: number): void {
  const map = { ...shelfMap() };
  const entry = map[bookId];
  if (!entry) {
    ensureShelfEntry(bookId, chapter);
    return;
  }
  map[bookId] = { ...entry, chapter, updatedAt: Date.now() };
  setShelfMap(map);
  persistShelf();
}

/** 从书架移除某本书（通常在删除本地书时调用） */
export function removeShelfEntry(bookId: string): void {
  const map = { ...shelfMap() };
  if (!(bookId in map)) return;
  delete map[bookId];
  setShelfMap(map);
  persistShelf();
}

/** 重置全部阅读进度（书籍本身保留） */
export function resetReadingProgress(): void {
  const next: Record<string, ShelfEntry> = {};
  for (const entry of Object.values(shelfMap())) {
    next[entry.bookId] = { ...entry, chapter: 0 };
  }
  setShelfMap(next);
  persistShelf();
}

// ---------------------------------------------------------------------------
// 阅读字号（全局偏好，设置页与阅读页共用）

const [fontSize, setFontSizeSignal] = createSignal<number>(19);
let fontSizeWriteQueue: Promise<void> = Promise.resolve();

/** 响应式正文字号（px） */
export function currentFontSize(): number {
  return fontSize();
}

function persistFontSize(next: number): void {
  fontSizeWriteQueue = fontSizeWriteQueue.then(() => writeState(FONT_KEY, next));
}

/** 调整正文字号（自动 clamp 并持久化） */
export function setFontSize(value: number): void {
  const next = clampFont(value);
  setFontSizeSignal(next);
  persistFontSize(next);
}

// ---------------------------------------------------------------------------
// 段落间距（全局偏好，设置页与阅读页共用；单位 em）

const [paraSpacing, setParaSpacingSignal] = createSignal<number>(PARA_SPACING_DEFAULT);
let paraSpacingWriteQueue: Promise<void> = Promise.resolve();

/** 响应式段落间距（em） */
export function currentParaSpacing(): number {
  return paraSpacing();
}

function persistParaSpacing(next: number): void {
  paraSpacingWriteQueue = paraSpacingWriteQueue.then(() => writeState(PARA_SPACING_KEY, next));
}

/** 调整段落间距（自动 clamp + 步进取整并持久化） */
export function setParaSpacing(value: number): void {
  const next = clampParaSpacing(value);
  setParaSpacingSignal(next);
  persistParaSpacing(next);
}

// ---------------------------------------------------------------------------
// TransBook 书源（跨页共享偏好：设置页与发现页实时联动）

const TRANSBOOK_URL_KEY = "readerx.transbookUrl";
const [transbookUrl, setTransbookUrlSignal] = createSignal<string>("");
const [transbookUrlReady, setTransbookUrlReady] = createSignal(false);
let transbookInitialized = false;

/** 归一化用户输入：补协议、去尾部斜杠 */
export function normalizeTransbookUrl(input: string): string {
  let value = (input || "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return value.replace(/\/+$/, "").replace(/\/openapi\.json$/i, "");
}

/** 响应式 TransBook 服务器地址（已是规范化形式，无尾部斜杠） */
export function currentTransbookUrl(): string {
  return transbookUrl();
}

/** 地址是否已从后端载入（避免首屏误判“未配置”） */
export function transbookReady(): boolean {
  return transbookUrlReady();
}

/** 应用启动时载入已保存地址（幂等） */
export async function initTransbookConfig(): Promise<void> {
  if (transbookInitialized) return;
  transbookInitialized = true;
  const stored = await readState<string>(TRANSBOOK_URL_KEY);
  setTransbookUrlSignal(normalizeTransbookUrl(stored ?? ""));
  setTransbookUrlReady(true);
}

/** 保存并立即生效；空串等价于清除 */
export async function saveTransbookUrl(input: string): Promise<void> {
  const next = normalizeTransbookUrl(input);
  setTransbookUrlSignal(next);
  await writeState(TRANSBOOK_URL_KEY, next || null);
}

/** 清除连接 */
export async function clearTransbookUrl(): Promise<void> {
  setTransbookUrlSignal("");
  await writeState(TRANSBOOK_URL_KEY, null);
}

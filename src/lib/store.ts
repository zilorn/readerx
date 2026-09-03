/**
 * 轻量全局状态（模块级 signal，无额外依赖）：
 * - 主题：light / dark / sepia（护眼）
 * - 书架：记录每本本地书的阅读进度（章节 cid + 章节正文镜像文本内偏移）
 * - 阅读字号
 * - 段落间距（em，相对正文字号）
 * 持久化统一交给 Rust 后端（readerx.* key），WebView 不落盘。
 */
import { createSignal } from "solid-js";
import { readState, writeState } from "./backend";

export type ThemeMode = "light" | "dark" | "sepia";
export type PageMode = "paged" | "scroll";
/** 阅读页底部状态栏的进度百分比口径：整本书 / 当前章节 */
export type ProgressScope = "book" | "chapter";

const THEME_KEY = "readerx.theme";
const SHELF_KEY = "readerx.shelf";
const FONT_KEY = "readerx.fontSize";
const PARA_SPACING_KEY = "readerx.paragraphSpacing";
const PAGE_MODE_KEY = "readerx.pageMode";
const STATUS_BAR_KEY = "readerx.statusBar";
const PROGRESS_SCOPE_KEY = "readerx.progressScope";

export const FONT_MIN = 15;
export const FONT_MAX = 28;
export const PARA_SPACING_MIN = 0.5;
export const PARA_SPACING_MAX = 2.5;
export const PARA_SPACING_STEP = 0.05;
export const PARA_SPACING_DEFAULT = 1.05;

function normalizeTheme(value: string | null): ThemeMode | null {
  return value === "dark" || value === "sepia" ? value : value === "light" ? "light" : null;
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
  const [storedTheme, storedShelf, storedFont, storedSpacing, storedPageMode, storedStatusBar, storedScope] =
    await Promise.all([
      readState<string>(THEME_KEY),
      readState<Record<string, ShelfEntry>>(SHELF_KEY),
      readState<number>(FONT_KEY),
      readState<number>(PARA_SPACING_KEY),
      readState<PageMode>(PAGE_MODE_KEY),
      readState<boolean>(STATUS_BAR_KEY),
      readState<ProgressScope>(PROGRESS_SCOPE_KEY),
    ]);

  // 未保存过偏好时默认护眼(sepia)，不再跟随系统深浅色
  const mode = normalizeTheme(storedTheme) ?? "sepia";
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
  if (storedPageMode === "paged" || storedPageMode === "scroll") {
    setPageModeSignal(storedPageMode);
  }
  if (typeof storedStatusBar === "boolean") {
    setStatusBarEnabledSignal(storedStatusBar);
  }
  if (storedScope === "book" || storedScope === "chapter") {
    setProgressScopeSignal(storedScope);
  }
}

// ---------------------------------------------------------------------------
// 主题

// 默认护眼(sepia)；initReaderState 加载用户已保存的偏好后覆盖
const [theme, setThemeSignal] = createSignal<ThemeMode>("sepia");
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
  /** 当前读到的章节索引（0 起；始终与 chapterCid 指向同一章） */
  chapter: number;
  /** 精确进度：当前章节的稳定 cid（章节身份，不随目录序号变动） */
  chapterCid?: string;
  /**
   * 精确进度：该章节正文镜像文本（p/h 正文按序拼接，不含图片）内的全局字符偏移。
   * 文本级定位：字号 / 窗口宽度 / 翻页方式都改变它；绝不落页码。
   * 同一段文字在文中重复出现也不影响定位（定位不靠搜索文字，只靠结构偏移）。
   */
  charOffset?: number;
  /** 定位校验快照：charOffset 处往后的一段原文（≤48 字），内容漂移时作兜底比对 */
  context?: string;
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

/**
 * 更新某本书的精确阅读位置（章节 + 该章节正文镜像文本内的字符偏移）。
 * 阅读页在翻页 / 滚动位置变化时调用；context 为偏移处往后一小段原文快照。
 */
export function updateReadingLocation(
  bookId: string,
  chapterIndex: number,
  chapterCid: string,
  charOffset: number,
  context: string,
): void {
  if (!bookId || !chapterCid) return;
  const chapter = Math.max(0, Math.floor(chapterIndex) || 0);
  const offset =
    Number.isFinite(charOffset) && charOffset > 0 ? Math.max(0, Math.floor(charOffset)) : 0;
  const map = { ...shelfMap() };
  const prev = map[bookId] ?? { bookId, chapter, updatedAt: Date.now() };
  map[bookId] = {
    ...prev,
    chapter,
    chapterCid,
    charOffset: offset,
    context: context || undefined,
    updatedAt: Date.now(),
  };
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

/** 重置全部阅读进度（书籍本身保留），清空章节内偏移定位 */
export function resetReadingProgress(): void {
  const next: Record<string, ShelfEntry> = {};
  for (const entry of Object.values(shelfMap())) {
    next[entry.bookId] = { bookId: entry.bookId, chapter: 0, updatedAt: Date.now() };
  }
  setShelfMap(next);
  persistShelf();
}

// ---------------------------------------------------------------------------
// 阅读字号（全局偏好，设置页与阅读页共用）

const [fontSize, setFontSizeSignal] = createSignal<number>(24);
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
// 阅读翻页方式（全局偏好，设置页与阅读页共用）

const [pageModeSignal, setPageModeSignal] = createSignal<PageMode>("paged");
let pageModeWriteQueue: Promise<void> = Promise.resolve();

/** 响应式翻页方式（paged=左右翻页，scroll=上下滚动） */
export function currentPageMode(): PageMode {
  return pageModeSignal();
}

function persistPageMode(next: PageMode): void {
  pageModeWriteQueue = pageModeWriteQueue.then(() => writeState(PAGE_MODE_KEY, next));
}

/** 切换翻页方式并持久化 */
export function setPageMode(mode: PageMode): void {
  setPageModeSignal(mode);
  persistPageMode(mode);
}

// ---------------------------------------------------------------------------
// 阅读页底部状态栏（全局偏好：入口在阅读页菜单顶栏的「阅读设置」）
// 开关控制状态栏是否常驻显示；进度口径决定百分比按全书还是当前章节统计。

const [statusBarEnabled, setStatusBarEnabledSignal] = createSignal<boolean>(true);
let statusBarWriteQueue: Promise<void> = Promise.resolve();

/** 响应式：阅读页底部状态栏是否开启 */
export function currentStatusBarEnabled(): boolean {
  return statusBarEnabled();
}

function persistStatusBarEnabled(on: boolean): void {
  statusBarWriteQueue = statusBarWriteQueue.then(() => writeState(STATUS_BAR_KEY, on));
}

/** 开启 / 关闭阅读页底部状态栏并持久化 */
export function setStatusBarEnabled(on: boolean): void {
  setStatusBarEnabledSignal(on);
  persistStatusBarEnabled(on);
}

const [progressScope, setProgressScopeSignal] = createSignal<ProgressScope>("book");
let progressScopeWriteQueue: Promise<void> = Promise.resolve();

/** 响应式进度口径（book=整本书百分比，chapter=当前章节百分比） */
export function currentProgressScope(): ProgressScope {
  return progressScope();
}

function persistProgressScope(scope: ProgressScope): void {
  progressScopeWriteQueue = progressScopeWriteQueue.then(() =>
    writeState(PROGRESS_SCOPE_KEY, scope),
  );
}

/** 切换进度口径并持久化 */
export function setProgressScope(scope: ProgressScope): void {
  setProgressScopeSignal(scope);
  persistProgressScope(scope);
}

// ---------------------------------------------------------------------------
// 书架多选（仅 UI 临时态，不持久化）
// 选中书籍模式下 AppShell 隐藏底部 Tab，把屏幕最底部让给操作条。

const [shelfSelecting, setShelfSelectingSignal] = createSignal<boolean>(false);

/** 书架是否处于多选（选中书籍）模式 */
export function shelfSelectingMode(): boolean {
  return shelfSelecting();
}

/** 进入 / 退出书架多选模式 */
export function setShelfSelecting(on: boolean): void {
  setShelfSelectingSignal(on);
}

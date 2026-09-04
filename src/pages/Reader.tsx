import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { LoadingScreen } from "../components/LoadingScreen";
import { ReaderSettingsSheet } from "../components/ReaderSettingsSheet";
import { isOnlineBook } from "../lib/booksTypes";
import {
  LAZY_WINDOW,
  cancelOnlineRun,
  chapterHasContent,
  downloadRemainingChapters,
  ensureReadingWindow,
  onlineRunState,
  reloadChapterContent,
} from "../lib/online";
import {
  BookSearchPanel,
  type BookSearchOpenTarget,
} from "../components/BookSearchPanel";
import type { BookSearchHit } from "../lib/bookSearch";
import { BookmarkPanel } from "../components/BookmarkPanel";
import { SelectionMenu } from "../components/SelectionMenu";
import { TtsBubble } from "../components/TtsBubble";
import { TtsSheet } from "../components/TtsSheet";
import {
  BookmarkIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  DownloadIcon,
  FollowBackIcon,
  HeadphonesIcon,
  ListIcon,
  RefreshIcon,
  RestoreBackIcon,
  SearchIcon,
  SettingsIcon,
} from "../components/icons";
import {
  ensureLocalBooksLoaded,
  localBookById,
  localBooksReady,
} from "../lib/books";
import {
  BOOKMARK_MAX_LEN,
  addBookmark,
  bookmarkAtExactRange,
  buildTextMirror,
  ensureBookmarksLoaded,
  makeBookmark,
  removeBookmark,
  resolveBookmarkTarget,
  sortedBookmarks,
  unitAtGlobalOffset,
  type Bookmark,
  type TextMirror,
} from "../lib/bookmarks";
import {
  MISSING_IMAGE_HEIGHT,
  READING_LINE_HEIGHT,
  chapterUnits,
  decodeImageSize,
  figureStyle,
  headingStyle,
  paragraphStyle,
  readingBaseStyle,
  startChapterPagination,
  titleAuthorStyle,
  titleTextStyle,
  titleWrapperStyle,
  type CssRecord,
  type PageFragment,
  type PaginateLayout,
  type PaginatedChapter,
  type ReaderBlock,
} from "../lib/pagination";
import {
  currentFontSize,
  currentPageMode,
  currentParaSpacing,
  currentProgressScope,
  currentStatusBarEnabled,
  ensureShelfEntry,
  shelfEntries,
  updateReadingLocation,
} from "../lib/store";
import { progressContextAt, readingPercent, resolveReadingTarget } from "../lib/progress";
import { showToast } from "../lib/toast";
import {
  charNodeAtOffset,
  charOffsetInElement,
  copyPlainText,
  dataAnchorOf,
  flashUnitRange,
} from "../lib/textAnchor";
import {
  createTtsPlayer,
  type TtsFocus,
} from "../lib/ttsPlayer";
import { currentTtsEngine, ensureTtsPrefsLoaded } from "../lib/ttsSettings";

const PAD_X = 24; // 阅读区左右留白
const PAD_TOP = 14; // 正文顶部留白
const PAD_BOTTOM_PAGED = 30; // 分页底部留白（容纳页号）
const PAD_BOTTOM_SCROLL = 28; // 滚动底部留白

// 大章节加载优化阈值与节奏
const PAGED_BUSY_DELAY_MS = 150; // 分页排版超过该时长才盖“正在加载”（普通章节不闪烁）
const SCROLL_FIRST_BLOCKS = 160; // 滚动模式首片挂载的正文单元数（先出首屏，避免空首帧）
const SCROLL_APPEND_BLOCKS = 240; // 滚动模式之后每帧追加的正文单元数

// 安全区（刘海/系统手势条）探针：用 env(safe-area-inset-*) 解析成像素
let safeInsetsCache: { top: number; bottom: number } | null = null;
function safeInsets(): { top: number; bottom: number } {
  if (safeInsetsCache) return safeInsetsCache;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;left:0;top:-9999px;width:1px;height:1px;pointer-events:none;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const num = (v: string) => Math.max(0, parseFloat(v) || 0);
  safeInsetsCache = { top: num(cs.paddingTop), bottom: num(cs.paddingBottom) };
  probe.remove();
  return safeInsetsCache;
}

const topPad = () => safeInsets().top + PAD_TOP;
const bottomPadPaged = () => safeInsets().bottom + PAD_BOTTOM_PAGED;
const bottomPadScroll = () => safeInsets().bottom + PAD_BOTTOM_SCROLL;

// 顶部工具栏上缘留白：env(safe-area-inset-top) 不可用/为 0 的设备回退到 8px 最小间距
const topbarPadTop = () => Math.max(safeInsets().top, 8);
// 底部状态栏下缘留白：env() 失效时也至少保留 10px
const statusBarPadBottom = () => Math.max(safeInsets().bottom, 10);
// 底部菜单栏下缘留白：10px 内容间距 + env() 失效时至少 16px 安全区
const menuBarPadBottom = () => 10 + Math.max(safeInsets().bottom, 16);

/** 分页引擎的行内样式记录 → Solid 样式对象 */
function asCss(record: CssRecord): JSX.CSSProperties {
  return record as JSX.CSSProperties;
}

// ---------------------------------------------------------------------------
// 书签下划线：按单元内字符区间把文本切段渲染
// ---------------------------------------------------------------------------

/** 标记的视觉语义：书签=下划线，朗读中=浅橙底，搜索模式命中=强调底 */
export type MarkKind = "bookmark" | "speak" | "search" | "searchCurrent";

/** 单元内被标记覆盖的字符区间（局部于该单元文本） */
export interface UnitMark {
  unit: number;
  s: number;
  e: number;
  /** 缺省视为书签下划线 */
  kind?: MarkKind;
}

/** 待定位高亮的字符区间（镜像文本全局坐标） */
interface PendingFlash {
  chapter: number;
  unit: number;
  charStart: number;
  charEnd: number;
}

interface TextSegment {
  text: string;
  bookmark: boolean;
  speak: boolean;
  search: boolean;
  searchCurrent: boolean;
}

/** 把文本按覆盖区间切段（窗口 [winStart, winStart+text.length) 之外的标记忽略） */
function splitMarkedText(
  text: string,
  winStart: number,
  unit: number,
  marks: UnitMark[],
): TextSegment[] {
  const spans: { s: number; e: number; kind: MarkKind }[] = [];
  for (const mark of marks) {
    if (mark.unit !== unit) continue;
    const winEnd = winStart + text.length;
    const s = Math.max(mark.s, winStart);
    const e = Math.min(mark.e, winEnd);
    if (e <= s) continue;
    spans.push({ s: s - winStart, e: e - winStart, kind: mark.kind ?? "bookmark" });
  }
  if (spans.length === 0) {
    return [{ text, bookmark: false, speak: false, search: false, searchCurrent: false }];
  }
  const points = [0, text.length];
  for (const sp of spans) {
    points.push(sp.s, sp.e);
  }
  points.sort((a, b) => a - b);
  const uniq: number[] = [];
  for (const p of points) {
    if (uniq.length === 0 || uniq[uniq.length - 1] !== p) uniq.push(p);
  }
  const segments: TextSegment[] = [];
  for (let i = 0; i + 1 < uniq.length; i++) {
    const a = uniq[i];
    const b = uniq[i + 1];
    if (b <= a) continue;
    let bookmark = false;
    let speak = false;
    let search = false;
    let searchCurrent = false;
    for (const sp of spans) {
      if (sp.e > a && sp.s < b) {
        if (sp.kind === "speak") speak = true;
        else if (sp.kind === "search") search = true;
        else if (sp.kind === "searchCurrent") searchCurrent = true;
        else bookmark = true;
      }
    }
    segments.push({ text: text.slice(a, b), bookmark, speak, search, searchCurrent });
  }
  return segments;
}

/** 合并两组区间标记（书签 + 朗读高亮），供正文切段渲染共用 */
function combineMarks(...lists: UnitMark[][]): UnitMark[] {
  const out: UnitMark[] = [];
  for (const list of lists) {
    for (const m of list) {
      if (m.e <= m.s) continue;
      out.push(m);
    }
  }
  out.sort((a, b) => a.unit - b.unit || a.s - b.s || a.e - b.e);
  return out;
}

/** 渲染切段：命中书签/朗读/搜索标记的片段包对应样式 span */
function renderMarkedText(
  text: string,
  winStart: number,
  unit: number,
  marks: UnitMark[],
): JSX.Element {
  const segments = splitMarkedText(text, winStart, unit, marks);
  if (
    segments.length === 1 &&
    !segments[0].bookmark &&
    !segments[0].speak &&
    !segments[0].search &&
    !segments[0].searchCurrent
  ) {
    return segments[0].text;
  }
  return (
    <>
      {segments.map((seg) => {
        if (
          !seg.bookmark &&
          !seg.speak &&
          !seg.search &&
          !seg.searchCurrent
        ) {
          return seg.text;
        }
        return (
          <span
            classList={{
              "readerx-bookmark": seg.bookmark,
              "readerx-speak": seg.speak,
              "readerx-search": seg.search,
              "readerx-search-current": seg.searchCurrent,
            }}
          >
            {seg.text}
          </span>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// 阅读片段渲染（分页与滚动共用同一套版式样式）
// ---------------------------------------------------------------------------

function TitleBlock(props: {
  layout: PaginateLayout;
  title: string;
  author?: string | null;
}) {
  return (
    <div style={asCss(titleWrapperStyle())}>
      <p style={asCss(titleTextStyle(props.layout))}>{props.title}</p>
      <Show when={props.author}>
        <p style={asCss(titleAuthorStyle(props.layout))}>{props.author}</p>
      </Show>
    </div>
  );
}

/** 图片：分页按已计算尺寸渲染；滚动按自然比例自适配 */
function ImageBlock(props: {
  src: string;
  alt?: string;
  /** 分页模式的展示尺寸（px）；0 表示未知/缺失 */
  w?: number;
  h?: number;
  /** 滚动模式：交给 CSS 自适应 */
  natural?: boolean;
}) {
  return (
    <figure style={asCss(figureStyle())}>
      <Show
        when={props.src && (props.natural || (props.w ?? 0) > 0)}
        fallback={
          <div
            class="mx-auto flex max-w-full items-center justify-center rounded-md border border-dashed border-border bg-surface-2 px-4 text-[12px] text-text-3"
            style={{ height: `${MISSING_IMAGE_HEIGHT}px` }}
          >
            {props.alt || "图片缺失"}
          </div>
        }
      >
        <img
          src={props.src}
          alt={props.alt ?? ""}
          draggable={false}
          class="mx-auto max-w-full rounded-md object-contain"
          classList={{ "max-h-[62vh]": props.natural }}
          style={
            props.natural
              ? undefined
              : { width: `${props.w}px`, height: `${props.h}px` }
          }
        />
      </Show>
    </figure>
  );
}

/** 分页视图里的单个片段 */
function PagedFragment(props: {
  fragment: PageFragment;
  layout: PaginateLayout;
  marks: UnitMark[];
}) {
  const fragment = props.fragment;
  const layout = props.layout;
  if (fragment.kind === "title") {
    return <TitleBlock layout={layout} title={fragment.title} author={fragment.author} />;
  }
  if (fragment.kind === "p") {
    return (
      <p
        data-u={fragment.unit}
        data-c={fragment.cstart}
        style={asCss(paragraphStyle(layout, fragment.indent, fragment.end))}
      >
        {renderMarkedText(fragment.text, fragment.cstart, fragment.unit, props.marks)}
      </p>
    );
  }
  if (fragment.kind === "h") {
    return (
      <h3 data-u={fragment.unit} data-c={fragment.cstart} style={asCss(headingStyle(layout, fragment.level))}>
        {renderMarkedText(fragment.text, fragment.cstart, fragment.unit, props.marks)}
      </h3>
    );
  }
  return <ImageBlock src={fragment.src} alt={fragment.alt} w={fragment.w} h={fragment.h} />;
}

/** 滚动模式下的正文单元 */
function ScrollBlock(props: {
  layout: PaginateLayout;
  block: ReaderBlock;
  unit: number;
  marks: UnitMark[];
}) {
  const block = props.block;
  const layout = props.layout;
  if (block.kind === "p") {
    return (
      <p data-u={props.unit} data-c={0} style={asCss(paragraphStyle(layout, true, true))}>
        {renderMarkedText(block.text, 0, props.unit, props.marks)}
      </p>
    );
  }
  if (block.kind === "h") {
    return (
      <h3 data-u={props.unit} data-c={0} style={asCss(headingStyle(layout, block.level))}>
        {renderMarkedText(block.text, 0, props.unit, props.marks)}
      </h3>
    );
  }
  return <ImageBlock src={block.src} alt={block.alt} natural />;
}

// ---------------------------------------------------------------------------
// 搜索模式会话：从全书搜索结果逐条查看时的上下文
// ---------------------------------------------------------------------------

interface ReaderSearchSession {
  /** 当前搜索词 */
  term: string;
  /** 打开该书搜索时的全部命中（与结果列表顺序一致） */
  hits: BookSearchHit[];
  /** 正在查看的命中序号（0 起） */
  index: number;
  /** 进入搜索模式前的阅读位置（章节号 + 章节镜像文本字符偏移） */
  prev: { ci: number; cid: string; char: number } | null;
}

// ---------------------------------------------------------------------------
// 阅读页
// ---------------------------------------------------------------------------

export default function ReaderPage() {
  const navigate = useNavigate();
  const params = useParams();
  const bookId = () => params.id ?? "";

  createEffect(() => {
    void ensureLocalBooksLoaded();
  });

  const book = createMemo(() => localBookById(bookId()));
  const [chapterIdx, setChapterIdx] = createSignal(0);
  const [pageIdx, setPageIdx] = createSignal(0);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [tocOpen, setTocOpen] = createSignal(false);
  const [bmPanelOpen, setBmPanelOpen] = createSignal(false);
  const [readerSettingsOpen, setReaderSettingsOpen] = createSignal(false);
  // 全书搜索抽屉（阅读器内，不占路由历史）
  const [bookSearchOpen, setBookSearchOpen] = createSignal(false);
  // 搜索模式：点中搜索结果后进入，正文持续高亮命中词，点屏中间呼出搜索模式菜单
  const [searchSession, setSearchSession] =
    createSignal<ReaderSearchSession | null>(null);
  // 当前阅读位置（章节正文镜像偏移：分页=页首行，滚动=视口顶部），状态栏百分比用
  const [viewOffset, setViewOffset] = createSignal(0);

  // 精确恢复目标：打开书时按存档的“章节 cid + 文本偏移”置位，就绪后跳到该处一次
  const [resumeTarget, setResumeTarget] = createSignal<{ cid: string; char: number } | null>(
    null,
  );
  let resumeTick: number | undefined;
  // 阅读位置提交（章节 + 章节正文镜像文本内偏移），去抖合并
  let locationTimer: number | undefined;
  let locationPending: { ci: number; cid: string; off: number; ctx: string } | null = null;
  let scrollFrame = 0;
  let scrollRef: HTMLDivElement | undefined;

  const isPaged = () => currentPageMode() === "paged";

  // 书签数据（跨页面载入一次）
  createEffect(() => {
    void ensureBookmarksLoaded();
  });

  // 书载入后：补建档案、按存档的精确文本位置（cid+偏移）恢复章节
  createEffect(
    on(book, (current) => {
      if (!current) return;
      ensureShelfEntry(current.id);
      const entry = shelfEntries()[current.id];
      const target = entry ? resolveReadingTarget(current, entry) : null;
      const max = Math.max(0, current.chapters.length - 1);
      setChapterIdx(
        Math.min(max, Math.max(0, target?.chapterIndex ?? entry?.chapter ?? 0)),
      );
      setPageIdx(0);
      // 进入章节开头后，等排版/正文就绪再把视口精确滚动到存档文本位置
      const t = target && target.charOffset > 0 ? target : null;
      const onCid =
        t && t.chapterCid === current.chapters[Math.min(t.chapterIndex, max)]?.cid
          ? { cid: t.chapterCid, char: t.charOffset }
          : null;
      setResumeTarget(onCid);
    }),
  );

  // 恢复目标置位期间定时尝试落地（分页等重排、滚动正文等挂载/图片加载）
  createEffect(() => {
    const pending = resumeTarget() !== null;
    if (pending) {
      window.clearInterval(resumeTick);
      resumeTick = window.setInterval(applyResume, 160);
    } else if (resumeTick !== undefined) {
      window.clearInterval(resumeTick);
      resumeTick = undefined;
    }
  });

  const chapter = createMemo(() => {
    const current = book();
    const list = current?.chapters;
    if (!list || list.length === 0) return undefined;
    return list[Math.min(chapterIdx(), list.length - 1)];
  });

  const isFirstChapter = () => chapterIdx() <= 0;
  const isLastChapter = () => {
    const current = book();
    return current ? chapterIdx() + 1 >= current.chapters.length : true;
  };

  // -------------------------------------------------------------------
  // 在线书：按「当前章 ±5」窗口懒加载正文 + 缺失章节 gate 覆盖层 + 下载面板
  // -------------------------------------------------------------------

  const isRemoteBook = createMemo(() => {
    const current = book();
    return !!current && isOnlineBook(current);
  });
  const remoteRun = createMemo(() => onlineRunState(bookId()));
  const [downloadOpen, setDownloadOpen] = createSignal(false);

  /** 在线书拉取中仍待获取的章节下标集合（目录“下载中”徽标用；空闲为 null） */
  const remotePendingSet = createMemo(() => {
    const run = remoteRun();
    return run.busy && run.pending.length > 0 ? new Set(run.pending) : null;
  });

  /** 当前章正文缺失（需覆盖层等待/重试） */
  const remoteMissing = createMemo(() => {
    if (!isRemoteBook()) return false;
    const ch = chapter();
    return !!ch && !chapterHasContent(ch);
  });
  /** 当前章是否已有失败记录（不自动重试，给重试按钮） */
  const remoteGateFailed = createMemo(() => {
    const idx = chapterIdx();
    return remoteRun().failed.some((f) => f.index === idx);
  });
  /** 覆盖层失败详情文本 */
  const remoteGateFailedText = createMemo(() => {
    const f = remoteRun().failed.find((x) => x.index === chapterIdx());
    return f?.error ?? "未知错误";
  });

  /** 阅读设置「重新加载本章」：在线书清掉当前章缓存后从书源强制重取 */
  async function reloadCurrentChapter(): Promise<void> {
    const current = book();
    if (!current || !isOnlineBook(current)) return;
    if (remoteRun().busy) return; // 其它拉取进行中（入口已禁用，双保险）
    setReaderSettingsOpen(false);
    setMenuOpen(false);
    // 重载后回到本章开头（旧正文的偏移/页码已无意义）
    setResumeTarget(null);
    setPageIdx(0);
    setViewOffset(0);
    await reloadChapterContent(current.id, chapterIdx());
  }

  // 进入/切换章节时：若窗口内存在缺正文章节则后台预取（当前章失败过的不自动重试）
  createEffect(() => {
    const current = book();
    if (!current || !isOnlineBook(current)) return;
    const idx = chapterIdx();
    void current.chapters.length;
    const run = onlineRunState(current.id);
    void run.busy;
    void run.phase;
    if (run.busy || run.phase !== "idle") return;
    const needAny = current.chapters.some(
      (c, i) =>
        Math.abs(i - idx) <= LAZY_WINDOW &&
        !chapterHasContent(c) &&
        !run.failed.some((f) => f.index === i),
    );
    if (!needAny) return;
    void ensureReadingWindow(current.id, idx);
  });

  // 阅读区几何（分页排版依赖真实尺寸；书就绪且元素挂载后测量）
  const [area, setArea] = createSignal({ w: 0, h: 0 });
  let areaRef: HTMLDivElement | undefined;
  let areaObserver: ResizeObserver | null = null;
  createEffect(
    on(book, () => {
      const el = areaRef;
      if (!el || areaObserver) return;
      const measure = () => setArea({ w: el.clientWidth, h: el.clientHeight });
      measure();
      areaObserver = new ResizeObserver(measure);
      areaObserver.observe(el);
      onCleanup(() => {
        areaObserver?.disconnect();
        areaObserver = null;
      });
    }),
  );

  const layout = createMemo<PaginateLayout | null>(() => {
    const a = area();
    if (a.w < 100 || a.h < 140) return null;
    return {
      textWidth: a.w - PAD_X * 2,
      pageHeight: a.h - topPad() - bottomPadPaged(),
      fontSize: currentFontSize(),
      paraSpacingEm: currentParaSpacing(),
      imageCapHeight: Math.max(180, Math.min(a.h * 0.5, 460)),
    };
  });

  // 当前章节内容单元（稳定引用，分页/滚动共用）
  const units = createMemo<ReaderBlock[]>(() => {
    const ch = chapter();
    return ch ? chapterUnits(ch) : [];
  });

  // 滚动模式：正文单元分片挂载数量（0 起逐片增长）。超大章节整章一次建 DOM 会
  // 长时间卡住首屏，这里先挂一片（≥首屏），之后每帧追加一片，直到整章挂完。
  const [scrollShown, setScrollShown] = createSignal(0);
  let scrollChunkToken = 0;
  let scrollChunkRaf = 0;
  createEffect(() => {
    const pagedMode = isPaged();
    const list = units();
    if (pagedMode || !chapter() || list.length === 0) {
      scrollChunkToken++;
      window.cancelAnimationFrame(scrollChunkRaf);
      setScrollShown(0);
      return;
    }
    const total = list.length;
    const token = ++scrollChunkToken;
    window.cancelAnimationFrame(scrollChunkRaf);
    // 先在同一帧内挂出首片（普通章节 ≤ 首片即一次挂完，与原先行为一致）
    setScrollShown(Math.min(SCROLL_FIRST_BLOCKS, total));
    if (total <= SCROLL_FIRST_BLOCKS) return;
    const grow = (): void => {
      if (scrollChunkToken !== token) return;
      let next = 0;
      setScrollShown((cur) => {
        next = Math.min(total, cur + SCROLL_APPEND_BLOCKS);
        return next;
      });
      if (next < total) {
        scrollChunkRaf = window.requestAnimationFrame(grow);
      }
    };
    scrollChunkRaf = window.requestAnimationFrame(grow);
    onCleanup(() => {
      scrollChunkToken++;
      window.cancelAnimationFrame(scrollChunkRaf);
    });
  });

  // 章节文本镜像（单元文本按序拼接 + 单元起始偏移），书签偏移换算基准
  const mirror = createMemo(() => buildTextMirror(units()));

  // 滚动模式精确恢复进度期间正文保持隐藏：若恢复目标所在分片尚未挂载，盖“正在加载”
  // （分片追加会驱动本 memo 重算；目标挂出后 applyResume 立即落位并解除隐藏）
  const scrollResumePending = createMemo(() => {
    if (isPaged()) return false;
    const target = resumeTarget();
    if (!target) return false;
    const shown = scrollShown();
    const mir = mirror();
    if (!mir || mir.text.length === 0) return true;
    const pos = unitAtGlobalOffset(mir, target.char);
    if (!pos) {
      // 存档偏移落在正文末尾边界：需等整章挂完才能滚到底
      return shown < units().length;
    }
    return pos.unit >= shown;
  });

  // 本书记签（按位置排序，响应式）
  const bookBookmarks = createMemo(() => sortedBookmarks(bookId()));

  // 当前章节内、书签覆盖的单元内字符区间（供下划线渲染）
  const unitMarks = createMemo<UnitMark[]>(() => {
    const bms = bookBookmarks();
    const ch = chapter();
    const mir = mirror();
    if (!ch || bms.length === 0) return [];
    const out: UnitMark[] = [];
    for (const bm of bms) {
      if (bm.chapterCid !== ch.cid) continue;
      const base = mir.unitStart[bm.unitIndex] ?? -1;
      if (base < 0) continue;
      out.push({ unit: bm.unitIndex, s: bm.charStart - base, e: bm.charEnd - base });
    }
    out.sort((a, b) => a.unit - b.unit || a.s - b.s || a.e - b.e);
    return out;
  });

  function toBookDetailPage() {
    navigate(`/detail/${bookId()}`)
  }

  // -------------------------------------------------------------------
  // 听书：播放控制器（逐句合成），朗读高亮 + 跟随阅读位置
  // -------------------------------------------------------------------

  /** 当前阅读位置（镜像偏移）：分页用当前页首行，滚动用最近上报位置 */
  function ttsReadingOffset(): number | null {
    if (isPaged()) {
      const offsets = pageTopOffsets();
      const pi = pageIdx();
      if (offsets.length > 0 && pi >= 0 && pi < offsets.length) return offsets[pi];
    }
    const p = locationPending;
    if (p && p.cid === chapter()?.cid) return p.off;
    return null;
  }

  const ttsPlayer = createTtsPlayer({
    bookId,
    chapterIndex: chapterIdx,
    chapterAt: (idx) => book()?.chapters[idx],
    chapterCount: () => book()?.chapters.length ?? 0,
    navigateChapter: (idx) => goToChapter(idx),
    readingOffset: ttsReadingOffset,
    notify: (message, isError) => showToast(message, !!isError),
  });
  const [ttsSettingsOpen, setTtsSettingsOpen] = createSignal(false);
  const [prewarmText, setPrewarmText] = createSignal<string | null>(null);

  // -------------------------------------------------------------------
  // 跟读跟随：语音激活期间视图默认跟随朗读句自动翻页/滚动（避免读到屏幕外）。
  // 用户手动翻页 / 滚动 / 切章会解除跟随（语音继续朗读，页面停在手动位置），
  // 呼出菜单后可通过底栏上方的「返回跟读」把视图跳回当前朗读句并恢复跟随。
  // -------------------------------------------------------------------
  const [followEnabled, setFollowEnabled] = createSignal(true);
  /** 程序化定位引发的滚动窗口：此期间内的 scroll 事件不算用户手动滚动 */
  let suppressFollowCancelUntil = 0;

  const ttsActive = (): boolean => ttsPlayer.status() !== "stopped";

  /** 用户手动翻页/滚动/切章时调用：解除“视图跟随朗读句”，语音不受影响 */
  function cancelFollowIfActive(): void {
    if (followEnabled() && ttsActive()) setFollowEnabled(false);
  }

  /** 「返回跟读」：恢复跟随，并把视图跳回当前正在朗读的句子 */
  function resumeFollow(): void {
    if (!ttsActive()) return;
    setFollowEnabled(true);
    const f = ttsPlayer.focus();
    if (f && f.cid === chapter()?.cid) ensureSpeakVisible(f);
  }

  // 朗读停止（手动停止 / 整本读完）后复位跟随，保证下一次朗读默认从跟读开始
  createEffect(() => {
    if (ttsPlayer.status() === "stopped") setFollowEnabled(true);
  });

  /** 批量预热整本书（HTTP 源）：逐句合成写入按书籍的磁盘缓存 */
  async function runPrewarmBook(): Promise<void> {
    if (prewarmText() !== null) return; // 已在预热
    setPrewarmText("准备中…");
    const done = await ttsPlayer.warmBook((d, total) => {
      setPrewarmText(`${d} / ${total}`);
    });
    setPrewarmText(null);
    if (done > 0) showToast(`预热完成：${done} 句已写入缓存`);
  }

  // 预热：HTTP 自定义源下，停止状态时把当前章节后续句子合成进按书籍的缓存，
  // 之后播放/下次同声源直接命中缓存，不再请求服务端
  createEffect(() => {
    void chapter()?.cid;
    void currentTtsEngine();
    void bookId();
    if (ttsPlayer.status() === "stopped") {
      void ensureTtsPrefsLoaded().then(() => {
        if (ttsPlayer.status() === "stopped") ttsPlayer.warmup();
      });
    }
  });

  /** 当前朗读句在“本视图章节”内的高亮区间（单元局部坐标） */
  const speakMarks = createMemo<UnitMark[]>(() => {
    const f = ttsPlayer.focus();
    if (!f || f.cid !== chapter()?.cid) return [];
    const item = f.item;
    const unitLen = mirror().unitLength[item.unit];
    if (item.ls < 0 || item.le <= item.ls || item.le > (unitLen ?? -1)) return [];
    return [{ unit: item.unit, s: item.ls, e: item.le, kind: "speak" }];
  });

  /** 搜索模式：当前章节内所有命中词（正文）的单元局部区间，当前查看项更醒目 */
  const searchMarks = createMemo<UnitMark[]>(() => {
    const s = searchSession();
    const ch = chapter();
    const mir = mirror();
    if (!s || !ch || !mir || s.hits.length === 0) return [];
    const active = s.hits[s.index];
    const out: UnitMark[] = [];
    for (const hit of s.hits) {
      if (hit.kind !== "body" || hit.chapterCid !== ch.cid) continue;
      const kind: MarkKind = hit === active ? "searchCurrent" : "search";
      for (let u = 0; u < mir.unitLength.length; u++) {
        const len = mir.unitLength[u];
        if (len <= 0) continue;
        const base = mir.unitStart[u];
        const lo = Math.max(hit.start, base);
        const hi = Math.min(hit.end, base + len);
        if (hi <= lo) continue;
        out.push({ unit: u, s: lo - base, e: hi - base, kind });
      }
    }
    out.sort((a, b) => a.unit - b.unit || a.s - b.s || a.e - b.e);
    return out;
  });

  /** 当前正在查看的搜索命中（搜索模式菜单展示章节名用） */
  const currentSearchHit = createMemo<BookSearchHit | null>(() => {
    const s = searchSession();
    if (!s) return null;
    return s.hits[s.index] ?? null;
  });

  /** 当前命中序号（0 起） */
  const searchHitIndex = createMemo(() => searchSession()?.index ?? 0);
  /** 命中总数 */
  const searchHitTotal = createMemo(() => searchSession()?.hits.length ?? 0);

  /** 正文渲染用：书签下划线 + 朗读高亮 + 搜索命中高亮的并集 */
  const renderMarks = createMemo<UnitMark[]>(() =>
    combineMarks(unitMarks(), speakMarks(), searchMarks()),
  );

  // 视图切章（用户翻章 / 引擎自动跨章）后让播放控制器跟随。
  // 翻页跨章浏览（browse）不打断语音：语音继续读原章，读完再由引擎自动跨章；
  // 引擎自动跨章 / 定点跳章（目录/书签等）才在切章时重锚朗读句。
  createEffect(() => {
    void chapterIdx();
    const browse = browseChapterPending;
    browseChapterPending = false;
    ttsPlayer.noteViewChapter(browse);
  });

  /** 把某朗读句滚动到可见（分页翻页 / 滚动定位），返回是否已就位 */
  function ensureSpeakVisible(f: TtsFocus): boolean {
    if (f.item.start < 0) return true; // 章节标题句没有正文位置，无需定位
    const mir = mirror();
    if (!mir || mir.text.length === 0) return false;
    if (isPaged()) {
      const pg = paged();
      if (!pg) return false;
      const page = pageIndexOfChar(pg.pages, mir, f.item.start);
      if (page < 0) return false;
      if (page !== pageIdx()) {
        setPageIdx(page);
      }
      return true;
    }
    const root = scrollRef;
    if (!root) return false;
    return scrollToCharOffset(root, f.item.start);
  }

  // 听书激活期间跟随当前朗读句（自动翻页/滚动），避免读到屏幕外；
  // 用户手动翻页/滚动/切章会先取消跟随（cancelFollowIfActive），此后不再自动跳页
  let ttsFollowTimer: number | undefined;
  createEffect(() => {
    window.clearInterval(ttsFollowTimer);
    ttsFollowTimer = undefined;
    if (!followEnabled()) return;
    const f = ttsPlayer.focus();
    if (!f || ttsPlayer.status() === "stopped" || f.cid !== chapter()?.cid) return;
    const step = (): void => {
      const cur = ttsPlayer.focus();
      if (
        !cur ||
        cur.cid !== chapter()?.cid ||
        ttsPlayer.status() === "stopped" ||
        ttsPlayer.status() === "error"
      ) {
        window.clearInterval(ttsFollowTimer);
        ttsFollowTimer = undefined;
        return;
      }
      if (ensureSpeakVisible(cur)) {
        window.clearInterval(ttsFollowTimer);
        ttsFollowTimer = undefined;
      }
    };
    step();
    if (ttsFollowTimer === undefined) {
      ttsFollowTimer = window.setInterval(step, 180);
    }
  });
  onCleanup(() => {
    window.clearInterval(ttsFollowTimer);
    ttsPlayer.dispose();
  });

  // -------------------------------------------------------------------
  // 分页结果：图片解码后做时间分片排版，避免超大章节整章同步测量卡死页面；
  // 排版超过阈值仍未见结果时盖一层“正在加载”，替代长时间空白/无响应。
  // -------------------------------------------------------------------
  const [paged, setPaged] = createSignal<PaginatedChapter | null>(null);
  const [pagedBusy, setPagedBusy] = createSignal(false);
  let pagedBusyTimer: number | undefined;
  function armPagedBusy(): void {
    if (pagedBusyTimer !== undefined) return;
    pagedBusyTimer = window.setTimeout(() => setPagedBusy(true), PAGED_BUSY_DELAY_MS);
  }
  function disarmPagedBusy(): void {
    if (pagedBusyTimer !== undefined) {
      window.clearTimeout(pagedBusyTimer);
      pagedBusyTimer = undefined;
    }
    setPagedBusy(false);
  }
  let paginateTask: ReturnType<typeof startChapterPagination> | null = null;
  createEffect(() => {
    const mode = isPaged();
    const ch = chapter();
    const geo = layout();
    paginateTask?.cancel();
    paginateTask = null;
    disarmPagedBusy();
    if (!mode || !ch || !geo) {
      setPaged(null);
      return;
    }
    setPaged(null);
    let dropped = false;
    onCleanup(() => {
      dropped = true;
      paginateTask?.cancel();
      paginateTask = null;
      disarmPagedBusy();
    });
    const author = book()?.author ?? null;
    armPagedBusy();
    void (async () => {
      const sizes = new Map<string, { w: number; h: number } | null>();
      const imageUnits = chapterUnits(ch).filter((u) => u.kind === "img");
      await Promise.all(
        imageUnits.map((unit) =>
          decodeImageSize((unit as { src: string }).src).then((size) =>
            sizes.set((unit as { src: string }).src, size),
          ),
        ),
      );
      if (dropped || !isPaged() || chapter() !== ch) return;
      const task = startChapterPagination(ch, author, geo, sizes);
      paginateTask = task;
      const result = await task.promise;
      if (paginateTask === task) paginateTask = null;
      if (dropped || !isPaged() || chapter() !== ch) return;
      disarmPagedBusy();
      if (!result) return;
      // 回翻“上一章末页”的挂起目标在此落地（无论新旧章页数是否相同）
      if (wantLastPage) {
        wantLastPage = false;
        setPageIdx(Math.max(0, result.pages.length - 1));
      }
      setPaged(result);
      // 打开书恢复进度：分页一就绪就立即落位，正文首次渲染即为目标页，
      // 不用等轮询 tick；(轮询仍保留，兜底排版再次重排等场景)
      if (resumeTarget() !== null) applyResume();
    })();
  });

  const totalPages = createMemo(() => paged()?.pages.length ?? 0);

  // -------------------------------------------------------------------
  // 底部状态栏：章节名 + 阅读进度（百分比口径可在「阅读设置」切换）
  // 整书百分比沿用进度模块的“正文字符累计”口径（readingPercent，带缓存）
  // -------------------------------------------------------------------
  const statusShown = createMemo(
    () =>
      currentStatusBarEnabled() &&
      !!book() &&
      !!layout() &&
      !!chapter() &&
      !menuOpen() &&
      !tocOpen() &&
      !bmPanelOpen() &&
      !readerSettingsOpen() &&
      !bookSearchOpen(),
  );

  /** 整本书进度百分比（按章节正文累计字符） */
  const bookPercent = createMemo<number | null>(() => {
    const current = book();
    if (!current || current.chapters.length === 0) return null;
    return readingPercent(current, chapterIdx(), viewOffset());
  });

  /** 状态栏显示的百分比（口径可选：整本书 / 当前章节） */
  const statusPercent = createMemo<number | null>(() => {
    if (isPaged() && totalPages() <= 0) return null; // 分页重排中，暂不显示
    let pct: number | null = null;
    if (currentProgressScope() === "book") {
      pct = bookPercent();
    } else {
      const len = mirror().text.length;
      pct = len > 0 ? (Math.min(len, viewOffset()) / len) * 100 : 0;
    }
    return pct === null ? null : Math.min(100, Math.max(0, Math.round(pct)));
  });

  // 需要跳转到上一章最后一页时置位（回翻/工具栏上一章）
  let wantLastPage = false;
  /** 本次切章是否由“翻页跨章浏览”触发（浏览不应打断听书语音） */
  let browseChapterPending = false;

  // 几何/字号变化导致同章重排时，按比例保留阅读位置
  createEffect(
    on(totalPages, (total, prevTotal) => {
      if (total <= 0 || prevTotal === undefined || prevTotal <= 0) return;
      const ratio = pageIdx() / prevTotal;
      const next = Math.min(total - 1, Math.max(0, Math.round(ratio * (total - 1))));
      if (next !== pageIdx()) setPageIdx(next);
    }),
  );

  // 页码越界钳制
  createEffect(() => {
    const total = totalPages();
    const idx = pageIdx();
    if (total > 0 && idx >= total) setPageIdx(total - 1);
  });

  // -------------------------------------------------------------------
  // 精确进度（文本定位）：阅读位置 ↔ 章节 cid + 章节正文镜像文本字符偏移
  // 不用页码记录：字号 / 窗口宽度 / 分页结果变化后，同一偏移仍指同一段文字；
  // 定位不靠“搜索一段可能重复的文字”，因此重复文本不会导致跳错位置。
  // -------------------------------------------------------------------

  // 分页模式：每页顶部对应的镜像文本偏移（页首行起始字符；整页无文本页取其后首个文本）
  const pageTopOffsets = createMemo<number[]>(() => {
    const pg = paged();
    const mir = mirror();
    if (!pg || !mir) return [];
    const out = new Array<number>(pg.pages.length);
    let cursor = 0;
    for (let pi = 0; pi < pg.pages.length; pi++) {
      out[pi] = cursor;
      for (const f of pg.pages[pi]) {
        if (f.kind !== "p" && f.kind !== "h") continue;
        const base = mir.unitStart[f.unit] ?? -1;
        if (base < 0) continue;
        const end = base + f.cstart + f.text.length;
        if (end > cursor) cursor = end;
      }
    }
    return out;
  });

  /** 立即把挂起的阅读位置落库（去抖超时 / 退出阅读页 / 页面隐藏时调用） */
  function flushLocation(): void {
    window.clearTimeout(locationTimer);
    locationTimer = undefined;
    const p = locationPending;
    locationPending = null;
    const current = book();
    const ch = chapter();
    if (!p || !current || !ch || ch.cid !== p.cid) return; // 章节已切换，等待新位置提交
    updateReadingLocation(current.id, p.ci, p.cid, p.off, p.ctx);
  }

  /** 记录当前章节镜像文本 offset 处的阅读位置（去抖合并后落库） */
  function queueLocation(offset: number): void {
    const ch = chapter();
    if (!ch) return;
    const mir = mirror();
    const clamped = Math.min(Math.max(0, Math.floor(offset) || 0), mir.text.length);
    setViewOffset(clamped);
    locationPending = {
      ci: chapterIdx(),
      cid: ch.cid,
      off: clamped,
      ctx: progressContextAt(mir.text, clamped),
    };
    window.clearTimeout(locationTimer);
    locationTimer = window.setTimeout(flushLocation, 150);
  }

  /** 分页模式：翻页 / 重排落定后按“当前页首行字符”记录位置 */
  createEffect(() => {
    if (!isPaged()) return;
    const ch = chapter();
    const offsets = pageTopOffsets();
    const pi = pageIdx();
    if (!ch || offsets.length === 0 || pi < 0 || pi >= offsets.length) return;
    // 精确恢复落定前不覆盖存档位置；搜索模式浏览命中时不提交位置
    if (resumeTarget() !== null || searchSession() !== null) return;
    queueLocation(offsets[pi]);
  });

  /** 视口顶部正在阅读的文本 → 镜像偏移（滚动模式，viewport 坐标采样） */
  function visibleCharAtTop(root: HTMLElement): number | null {
    const mir = mirror();
    if (!mir || mir.text.length === 0) return null;
    const lay = layout();
    if (!lay) return null;
    const rect = root.getBoundingClientRect();
    const lineH = READING_LINE_HEIGHT * lay.fontSize;
    const d = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
    };
    const probe = (x: number, y: number): number | null => {
      const range = d.caretRangeFromPoint?.(x, y) ?? null;
      let node: Node | null = null;
      let off = 0;
      if (range) {
        node = range.startContainer;
        off = range.startOffset;
      } else {
        const pos = d.caretPositionFromPoint?.(x, y);
        if (pos) {
          node = pos.offsetNode;
          off = pos.offset;
        }
      }
      if (!node) return null;
      const anchor = dataAnchorOf(node);
      if (!anchor) return null;
      const base = mir.unitStart[anchor.unit] ?? -1;
      if (base < 0) return null;
      const local = charOffsetInElement(anchor.el, node, off);
      return Math.min(mir.text.length, base + anchor.cstart + local);
    };
    const xs = [
      rect.left + PAD_X + lay.textWidth * 0.5,
      rect.left + PAD_X + lay.textWidth * 0.16,
      rect.left + PAD_X + lay.textWidth * 0.84,
    ];
    for (let row = 0; row < 5; row++) {
      const y = rect.top + topPad() + lineH * (0.35 + row);
      for (const x of xs) {
        const g = probe(x, y);
        if (g !== null) return g;
      }
    }
    return null;
  }

  /** 滚动模式：把镜像偏移 targetChar 滚动到视口顶部附近（精确恢复用） */
  function scrollToCharOffset(root: HTMLElement, targetChar: number): boolean {
    const mir = mirror();
    const lay = layout();
    if (!mir || !lay || mir.text.length === 0) return false;
    const pos = unitAtGlobalOffset(mir, targetChar);
    if (!pos) {
      // 存档偏移落在正文末尾边界（无具体字符可挂靠）：滚到底部视为命中，
      // 避免正文一直保持隐藏等待定位
      if (targetChar >= mir.text.length) {
        suppressFollowCancelUntil = performance.now() + 250;
        root.scrollTop = root.scrollHeight;
        return true;
      }
      return false;
    }
    const el = root.querySelector<HTMLElement>(`[data-u="${pos.unit}"]`);
    if (!el) return false;
    const base = mir.unitStart[pos.unit] ?? -1;
    if (base < 0) return false;
    const cstart = Number(el.dataset.c ?? "0") || 0;
    const local = targetChar - base - cstart;
    if (local < 0) return false;
    const pt = charNodeAtOffset(el, local);
    if (!pt) return false;
    const lineH = READING_LINE_HEIGHT * lay.fontSize;
    const cr = root.getBoundingClientRect();
    try {
      const range = document.createRange();
      range.setStart(pt.node, pt.offset);
      range.collapse(true);
      const r = range.getBoundingClientRect();
      if (r && (r.height > 0 || r.width > 0)) {
        const targetY = cr.top + topPad() + lineH * 0.35;
        suppressFollowCancelUntil = performance.now() + 250;
        root.scrollTop += r.top - targetY;
        return true;
      }
    } catch {
      /* 降级为段落对齐 */
    }
    suppressFollowCancelUntil = performance.now() + 250;
    el.scrollIntoView({ block: "start" });
    return true;
  }

  /** 精确恢复：等章节 / 排版 / 正文就绪后，把视口定位到存档文本位置（仅打开书一次） */
  function applyResume(): void {
    const target = resumeTarget();
    if (!target) return;
    const current = book();
    const ch = chapter();
    if (!current || !ch) return;
    if (ch.cid !== target.cid) {
      setResumeTarget(null); // 用户已切到其它章节，放弃自动恢复
      return;
    }
    const mir = mirror();
    if (mir.text.length === 0) {
      setResumeTarget(null);
      return;
    }
    if (isPaged()) {
      const pg = paged();
      if (!pg) return; // 分页重排中，等下一个 tick
      const page = pageIndexOfChar(pg.pages, mir, target.char);
      const next = page < 0 ? pg.pages.length - 1 : page;
      // 先落到目标页、再解除隐藏：正文首次可见即是恢复位置，不闪章节开头
      if (next !== pageIdx()) setPageIdx(next);
      setResumeTarget(null);
      return;
    }
    const root = scrollRef;
    if (!root) return; // 正文尚未挂载，等下一个 tick
    if (scrollToCharOffset(root, target.char)) setResumeTarget(null);
  }

  /** 滚动模式滚动事件：帧节流后按视口顶部文本提交位置；
      用户手动滚动（浏览器原生 scroll 事件）同时解除跟读跟随 */
  function onScrollBody(e: Event): void {
    if (scrollFrame) return;
    const userScrolled = e.isTrusted === true;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (isPaged() || resumeTarget() !== null || searchSession() !== null)
        return;
      const root = scrollRef;
      if (!root) return;
      if (
        userScrolled &&
        followEnabled() &&
        ttsActive() &&
        performance.now() >= suppressFollowCancelUntil
      ) {
        setFollowEnabled(false);
      }
      const offset = visibleCharAtTop(root);
      if (offset !== null) queueLocation(offset);
    });
  }

  // 滚动模式：章节刚进入 / 精确恢复落定后提交当前位置（无滚动事件也要记录一次）
  createEffect(() => {
    if (isPaged()) return;
    const ch = chapter();
    const root = scrollRef;
    if (!ch || !root) return;
    if (resumeTarget() !== null || searchSession() !== null) return;
    void layout();
    queueLocation(visibleCharAtTop(root) ?? 0);
  });

  // 退出阅读页 / 页面隐藏时冲刷挂起的精确位置，避免丢最后一段进度
  onCleanup(() => {
    window.cancelAnimationFrame(scrollFrame);
    window.clearInterval(resumeTick);
    flushLocation();
  });
  onMount(() => {
    const onHide = () => flushLocation();
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    onCleanup(() => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
    });
  });

  const pageFragments = createMemo<PageFragment[]>(() => {
    if (!isPaged()) return [];
    const pages = paged()?.pages;
    if (!pages || pages.length === 0) return [];
    return pages[Math.min(pageIdx(), pages.length - 1)] ?? [];
  });

  const chapterCount = () => book()?.chapters.length ?? 0;

  // -------------------------------------------------------------------
  // 翻页 / 章节跳转
  // -------------------------------------------------------------------

  /** 切章。browse=true 表示翻页/相邻章节浏览，不打断听书语音 */
  function goToChapter(idx: number, browse = false): void {
    const current = book();
    if (!current) return;
    const clamped = Math.max(0, Math.min(idx, current.chapters.length - 1));
    if (clamped === chapterIdx()) return;
    if (browse) browseChapterPending = true;
    setChapterIdx(clamped);
    setPageIdx(0);
    setViewOffset(0);
  }

  function jumpFromToc(idx: number): void {
    goToChapter(idx);
    cancelFollowIfActive();
    setTocOpen(false);
    setMenuOpen(false);
  }

  // -------------------------------------------------------------------
  // 搜索模式：点中全书搜索结果后进入，正文高亮命中词，可逐条切换 / 返回原进度
  // -------------------------------------------------------------------

  /** 记录进入搜索模式前的阅读位置（章节号 + 章节镜像文本字符偏移） */
  function capturePreSearchReading(): ReaderSearchSession["prev"] {
    const ch = chapter();
    if (!ch) return null;
    const mir = mirror();
    let char = 0;
    if (isPaged()) {
      const offs = pageTopOffsets();
      const pi = pageIdx();
      if (pi >= 0 && pi < offs.length) char = offs[pi];
    } else {
      char = visibleCharAtTop(scrollRef!) ?? viewOffset() ?? 0;
    }
    if (mir) char = Math.max(0, Math.min(char, mir.text.length));
    return { ci: chapterIdx(), cid: ch.cid, char };
  }

  /** 打开一条搜索结果：进入搜索模式并定位（首次进入时记录原阅读位置） */
  function openSearchResult(target: BookSearchOpenTarget): void {
    const current = book();
    if (!current || target.hits.length === 0) return;
    const index = Math.max(0, Math.min(target.index, target.hits.length - 1));
    const existing = searchSession();
    const prev = existing?.prev ?? capturePreSearchReading();
    setBookSearchOpen(false);
    setMenuOpen(false);
    setSearchSession({ term: target.term, hits: target.hits, index, prev });
    cancelFollowIfActive();
    locateSearchHit(index);
  }

  /** 定位到当前会话中的第 index 条命中（标题命中→章首；正文命中→精确区间并闪亮） */
  function locateSearchHit(index: number): void {
    const s = searchSession();
    const current = book();
    if (!s || !current) return;
    const clamped = Math.max(0, Math.min(index, s.hits.length - 1));
    if (clamped !== s.index) setSearchSession({ ...s, index: clamped });
    setPendingFlash(null);
    const hit = s.hits[clamped];
    const target = current.chapters[hit.chapterIndex];
    if (!target) return;

    if (hit.kind !== "body") {
      // 标题命中 → 章首
      if (hit.chapterIndex !== chapterIdx()) {
        goToChapter(hit.chapterIndex);
      } else if (isPaged()) {
        setPageIdx(0);
      } else if (scrollRef) {
        scrollRef.scrollTop = 0;
      }
      return;
    }

    if (hit.chapterIndex !== chapterIdx()) goToChapter(hit.chapterIndex);
    const mir = buildTextMirror(chapterUnits(target));
    const pos = unitAtGlobalOffset(mir, hit.start);
    if (!pos) return;
    setPendingFlash({
      chapter: hit.chapterIndex,
      unit: pos.unit,
      charStart: hit.start,
      charEnd: Math.min(hit.end, mir.text.length),
    });
  }

  /** 切换上一个 / 下一个结果项 */
  function stepSearchHit(dir: 1 | -1): void {
    const s = searchSession();
    if (!s) return;
    const next = s.index + dir;
    if (next < 0 || next >= s.hits.length) return;
    locateSearchHit(next);
  }

  /** 从搜索模式回到搜索结果列表（自动滚动定位到当前结果卡片） */
  function returnToSearchResults(): void {
    setMenuOpen(false);
    setBookSearchOpen(true);
  }

  /** 关闭搜索模式：退出高亮与搜索菜单，停留在当前页面 */
  function exitSearchMode(): void {
    setSearchSession(null);
    setMenuOpen(false);
    setBookSearchOpen(false);
  }

  /** 返回搜索前读到的进度（退出搜索模式并精确回到原位置） */
  function restorePreSearch(): void {
    const s = searchSession();
    if (!s) return;
    const prev = s.prev;
    setSearchSession(null);
    setMenuOpen(false);
    setBookSearchOpen(false);
    if (!prev) return;
    goToChapter(prev.ci);
    if (prev.char > 0) {
      const target = book()?.chapters[prev.ci];
      if (target) setResumeTarget({ cid: target.cid, char: prev.char });
    } else if (isPaged()) {
      setPageIdx(0);
    } else if (scrollRef) {
      scrollRef.scrollTop = 0;
    }
  }

  /** 左右翻页（含章节边界衔接）；返回是否发生了位移 */
  function turnPage(dir: 1 | -1): boolean {
    if (!isPaged()) return false;
    const total = totalPages();
    const idx = pageIdx();
    if (dir > 0) {
      if (idx + 1 < total) {
        // 先解除跟读跟随再翻页：若翻页后才取消，朗读句的自动跟随仍可能
        // 在同一轮把页面拉回朗读句所在页，导致本次手动翻页“无效”（需翻两次）
        cancelFollowIfActive();
        setPageIdx(idx + 1);
        return true;
      }
      if (!isLastChapter()) {
        // 先解除跟读跟随再翻页（同翻章内页面的处理一致）；跨章浏览不打断语音
        cancelFollowIfActive();
        goToChapter(chapterIdx() + 1, true);
        return true;
      }
      return false;
    }
    if (idx > 0) {
      cancelFollowIfActive();
      setPageIdx(idx - 1);
      return true;
    }
    if (!isFirstChapter()) {
      cancelFollowIfActive();
      wantLastPage = true;
      goToChapter(chapterIdx() - 1, true);
      return true;
    }
    return false;
  }

  /**
   * 用户主动翻页（点按左右区 / 横滑 / 方向键）的统一入口。
   * 必须在变更页码**之前**置位动画方向与触发标记：分页动画由页码变化驱动，
   * 若在 turnPage 之后才置位，首次翻页（页面由 0 变化时）会因触发标记尚未生效而丢失动画。
   * 翻页未发生（章节边界）时复位标记，避免污染下一次重排/落位。
   */
  function userFlip(dir: 1 | -1): void {
    animDir = dir;
    animTriggered = true;
    if (!turnPage(dir)) animTriggered = false;
  }

  function goBack(): void {
    if (window.history.length > 1) navigate(-1);
    else navigate("/");
  }

  // -------------------------------------------------------------------
  // 手势：点中间呼出/收起菜单；左右区域翻页；横向滑动翻页
  // -------------------------------------------------------------------

  let gestureStart: { x: number; y: number; t: number } | null = null;
  let animDir: 1 | -1 = 1;
  let animTriggered = false;

  function isUiTarget(e: Event): boolean {
    const target = e.target as HTMLElement | null;
    return !!target?.closest?.("[data-reader-ui]");
  }

  /** 当前是否正处于文本选中状态（选区来自正文） */
  function hasActiveTextSelection(): boolean {
    const sel = window.getSelection();
    return !!sel && !sel.isCollapsed && !!sel.toString().trim();
  }

  function onSurfacePointerDown(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (isUiTarget(e)) return;
    gestureStart = { x: e.clientX, y: e.clientY, t: performance.now() };
  }

  function onSurfacePointerUp(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const start = gestureStart;
    gestureStart = null;
    if (!start || isUiTarget(e)) return;
    const dt = performance.now() - start.t;
    if (dt > 700) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const moved = Math.hypot(dx, dy);
    const rect = areaRef?.getBoundingClientRect();
    if (!rect) return;

    // 菜单/目录展开时：轻点正文任意处先收起，避免误翻页
    if (menuOpen() || tocOpen()) {
      if (moved < 12) {
        setMenuOpen(false);
        setTocOpen(false);
      }
      return;
    }

    // 文本正处于选中状态：本次抬手只结束选取，不翻页、不呼出菜单
    if (hasActiveTextSelection()) return;

    // 横向滑动翻页
    if (isPaged() && moved >= 56 && Math.abs(dx) > Math.abs(dy)) {
      userFlip(dx < 0 ? 1 : -1);
      return;
    }
    if (moved >= 12) return; // 纵向拖动等：不处理

    const x = e.clientX - rect.left;
    const inMiddle = x >= rect.width / 3 && x <= (rect.width * 2) / 3;
    if (!isPaged()) {
      if (inMiddle) setMenuOpen(true);
      return;
    }
    if (x < rect.width / 3) {
      userFlip(-1);
    } else if (x > (rect.width * 2) / 3) {
      userFlip(1);
    } else {
      setMenuOpen(true);
    }
  }

  // 翻页动画：仅用户主动翻页时触发（改字号/重排不触发）
  let pageAnimRef: HTMLDivElement | undefined;
  createEffect(
    on(
      () => (isPaged() ? `${chapterIdx()}:${pageIdx()}` : ""),
      (key, prev) => {
        const el = pageAnimRef;
        if (!el || !key) return;
        if (prev !== undefined && prev !== key && animTriggered) {
          el.style.animation = "none";
          void el.getBoundingClientRect();
          el.style.animation = `${
            animDir > 0 ? "page-in-right" : "page-in-left"
          } 0.3s cubic-bezier(0.22, 1, 0.36, 1)`;
        }
        animTriggered = false;
      },
    ),
  );

  // 键盘左右方向键翻页（桌面便利）
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      if (menuOpen() || tocOpen() || bookSearchOpen() || !isPaged()) return;
      userFlip(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // -------------------------------------------------------------------
  // 选区操作：复制 / 书签（新增、重复选取则移除）
  // -------------------------------------------------------------------

  async function handleCopyText(text: string): Promise<void> {
    const ok = await copyPlainText(text);
    showToast(ok ? "已复制" : "复制失败", !ok);
  }

  function handleBookmarkRange(range: Range): void {
    const b = book();
    const ch = chapter();
    const mir = mirror();
    if (!b || !ch || mir.text.length === 0) {
      showToast("当前内容无法添加书签", true);
      return;
    }
    const anchorStart = dataAnchorOf(range.startContainer);
    const anchorEnd = dataAnchorOf(range.endContainer);
    if (!anchorStart || !anchorEnd || anchorStart.unit !== anchorEnd.unit) {
      showToast("书签需在同一段文字内选取", true);
      return;
    }
    const base = mir.unitStart[anchorStart.unit] ?? -1;
    if (base < 0) {
      showToast("当前内容无法添加书签", true);
      return;
    }
    const os = charOffsetInElement(anchorStart.el, range.startContainer, range.startOffset);
    const oe = charOffsetInElement(anchorEnd.el, range.endContainer, range.endOffset);
    const rawS = base + anchorStart.cstart + os;
    const rawE = base + anchorEnd.cstart + oe;
    if (rawE <= rawS) {
      showToast("请选择要标记的文字", true);
      return;
    }
    const charStart = Math.min(rawS, rawE);
    const charEnd = Math.max(rawS, rawE);
    // 操作完成即收起原生选区
    window.getSelection()?.removeAllRanges();

    const existed = bookmarkAtExactRange(b.id, ch.cid, charStart, charEnd);
    if (existed) {
      removeBookmark(existed.id);
      showToast("已移除书签");
      return;
    }
    if (charEnd - charStart > BOOKMARK_MAX_LEN) {
      showToast("所选文字过长，无法添加书签", true);
      return;
    }
    const bookmark = makeBookmark(
      b.id,
      ch,
      chapterIdx(),
      anchorStart.unit,
      charStart,
      charEnd,
      mir,
    );
    if (!bookmark) {
      showToast("无法添加书签", true);
      return;
    }
    addBookmark(bookmark);
    showToast("已添加书签");
  }

  /** 选区「朗读」：从选区起点所在句子开始朗读（起点无正文锚点时回退章首起读） */
  function handleSpeakFromRange(range: Range): void {
    // 收起原生选区（同时隐藏选择菜单），交给朗读句高亮展示
    window.getSelection()?.removeAllRanges();
    const ch = chapter();
    if (!ch) return;
    const mir = mirror();
    if (mir.text.length > 0) {
      const anchor = dataAnchorOf(range.startContainer);
      if (anchor) {
        const base = mir.unitStart[anchor.unit] ?? -1;
        if (base >= 0) {
          const os = charOffsetInElement(
            anchor.el,
            range.startContainer,
            range.startOffset,
          );
          const offset = Math.min(mir.text.length, base + anchor.cstart + os);
          ttsPlayer.startFromChar(offset);
          return;
        }
      }
    }
    // 选中内容没有正文锚点（如章节标题）：从本章开头读起
    ttsPlayer.startFromChar(-1);
  }

  // -------------------------------------------------------------------
  // 书签跳转：解析 → 切章/翻页 → 定位高亮
  // -------------------------------------------------------------------

  const [pendingFlash, setPendingFlash] = createSignal<PendingFlash | null>(null);
  let flashRaf = 0;

  /** 字符偏移落在哪一页（分页结果片段均带 unit/cstart） */
  function pageIndexOfChar(pages: PageFragment[][], mir: TextMirror, g: number): number {
    for (let pi = 0; pi < pages.length; pi++) {
      const page = pages[pi];
      for (const f of page) {
        if (f.kind !== "p" && f.kind !== "h") continue;
        const base = mir.unitStart[f.unit] ?? -1;
        if (base < 0) continue;
        const s = base + f.cstart;
        if (g >= s && g < s + f.text.length) return pi;
      }
    }
    return -1;
  }

  function jumpToBookmark(bookmark: Bookmark): void {
    const b = book();
    if (!b) return;
    const resolved = resolveBookmarkTarget(b, bookmark);
    if (!resolved) {
      showToast("未能定位该书签", true);
      return;
    }
    setBmPanelOpen(false);
    setMenuOpen(false);
    if (resolved.chapterIndex !== chapterIdx()) {
      goToChapter(resolved.chapterIndex);
    }
    setPendingFlash({
      chapter: resolved.chapterIndex,
      unit: resolved.unitIndex,
      charStart: resolved.charStart,
      charEnd: resolved.charEnd,
    });
  }

  // 等待章节/分页就绪后，把书签字符区间滚动到可见并短暂高亮。
  // 滚动模式下正文分片挂载：目标单元所在分片未挂出时保持等待（依赖 scrollShown
  // 在后续分片追加时重新触发本 effect），直到目标单元出现再定位。
  createEffect(() => {
    const p = pendingFlash();
    if (!p) return;
    const current = chapter();
    const mode = isPaged();
    const pg = paged();
    const pageNow = pageIdx();
    const root = areaRef;
    if (!current || !root) return;
    if (p.chapter !== chapterIdx()) return; // 章节切换尚未落地
    const mir = mirror();
    if (mode) {
      if (!pg) return; // 分页重排中
      const page = pageIndexOfChar(pg.pages, mir, p.charStart);
      if (page < 0) {
        setPendingFlash(null);
        return;
      }
      if (pageNow !== page) {
        setPageIdx(page);
        return;
      }
    } else if (scrollRef && !scrollRef.querySelector(`[data-u="${p.unit}"]`)) {
      void scrollShown(); // 目标分片未挂载：等滚动分段渲染继续追加后重试
      return;
    }
    window.cancelAnimationFrame(flashRaf);
    flashRaf = window.requestAnimationFrame(() => {
      const base = mir.unitStart[p.unit] ?? -1;
      if (base >= 0) {
        flashUnitRange(root, p.unit, base, p.charStart, p.charEnd, { scroll: !mode });
      }
      setPendingFlash(null);
    });
  });
  onCleanup(() => window.cancelAnimationFrame(flashRaf));

  // 首次进入时的操作提示（一次性）
  let hintShown = false;
  createEffect(() => {
    if (hintShown || !book()) return;
    hintShown = true;
    showToast("点屏幕中间唤出菜单");
  });

  // 目录抽屉打开后滚动定位当前章节
  let listRef: HTMLDivElement | undefined;
  createEffect(
    on(tocOpen, (open) => {
      if (!open || !listRef) return;
      const current = listRef.querySelector<HTMLElement>('[data-current="true"]');
      current?.scrollIntoView({ block: "center" });
    }),
  );

  return (
    <div class="relative flex h-full min-h-0 flex-col overflow-hidden bg-bg">
      <Show when={localBooksReady()} fallback={<LoadingScreen label="加载书籍…" />}>
        <Show
          when={book()}
          fallback={
            <div class="flex flex-1 flex-col items-center justify-center gap-4 text-sm text-text-2">
              <p>本地书籍不存在或已被删除</p>
              <button
                class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-[22px] py-[11px] text-sm font-semibold text-on-accent shadow-lg shadow-accent/30 transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90"
                onClick={goBack}
              >
                返回书架
              </button>
            </div>
          }
        >
          <div
            ref={areaRef}
            class="relative min-h-0 flex-1 overflow-hidden [-webkit-touch-callout:none]"
            onPointerDown={onSurfacePointerDown}
            onPointerUp={onSurfacePointerUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            {/* 正文（分页 / 滚动） */}
            <Show
              when={layout() && chapter()}
              fallback={<LoadingScreen label={isPaged() ? "排版中…" : "加载书籍…"} />}
            >
              <Show
                when={!isPaged()}
                fallback={
                  /* 分页模式：左右翻页视图 */
                  <div
                    ref={pageAnimRef}
                    class="absolute inset-0 overflow-hidden"
                    classList={{ invisible: resumeTarget() !== null }}
                    style={{ "touch-action": "none" }}
                  >
                    <div
                      class="mx-auto flex h-full flex-col"
                      style={{
                        width: `${layout()!.textWidth}px`,
                        ...asCss(readingBaseStyle(layout()!)),
                      }}
                    >
                      <div style={{ height: `${topPad()}px`, "flex": "none" }} />
                      <div
                        class="relative w-full overflow-hidden"
                        style={{ height: `${layout()!.pageHeight}px` }}
                      >
                        <For each={pageFragments()}>
                          {(fragment) => (
                            <PagedFragment
                              fragment={fragment}
                              layout={layout()!}
                              marks={renderMarks()}
                            />
                          )}
                        </For>
                      </div>
                      <div
                        class="relative flex-none"
                        style={{ height: `${bottomPadPaged()}px` }}
                      >
                        <Show when={totalPages() > 1 && !menuOpen() && !currentStatusBarEnabled()}>
                          <span
                            class="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 text-[10.5px] tracking-[0.08em] text-text-3 opacity-70 tabular-nums"
                            aria-hidden="true"
                          >
                            {pageIdx() + 1} / {totalPages()}
                          </span>
                        </Show>
                      </div>
                    </div>
                  </div>
                }
              >
                {/* 滚动模式：整章上下滚动 */}
                <div
                  ref={scrollRef}
                  onScroll={onScrollBody}
                  class="absolute inset-0 overflow-y-auto overscroll-contain scrollbar-none"
                  classList={{ invisible: resumeTarget() !== null }}
                  style={{
                    padding: `${topPad()}px ${PAD_X}px ${bottomPadScroll()}px`,
                  }}
                >
                  <div style={asCss(readingBaseStyle(layout()!))}>
                    <TitleBlock
                      layout={layout()!}
                      title={chapter()!.title}
                      author={
                        book()!.author && book()!.author !== "佚名"
                          ? `${book()!.author} 著`
                          : null
                      }
                    />
                    <For each={units().slice(0, scrollShown())}>
                      {(block, idx) => (
                        <ScrollBlock
                          layout={layout()!}
                          block={block}
                          unit={idx()}
                          marks={renderMarks()}
                        />
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </Show>

            {/* 大章节加载中：先给“正在加载”，避免长时间空白 / 页面无响应。
                分页模式 = 分片排版未就绪；滚动模式 = 精确恢复目标分片尚未挂载 */}
            <Show
              when={
                (isPaged() && pagedBusy() && !paged()) ||
                (!isPaged() && scrollResumePending())
              }
            >
              <div
                class="absolute inset-0 z-[16] bg-bg"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <LoadingScreen label="正在加载…" />
              </div>
            </Show>

            {/* 在线书正文缺失：获取章节 gate（阻挡翻页直到正文就绪/失败可重试） */}
            <Show when={remoteMissing()}>
              <div
                class="absolute inset-0 z-[18] grid place-items-center px-8"
                style={{ background: "var(--bg)" }}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                role="alert"
              >
                <div class="flex w-full max-w-[300px] flex-col items-center gap-3 text-center">
                  <Show
                    when={remoteGateFailed() || remoteRun().cancelled}
                    fallback={
                      <>
                        <span class="grid h-11 w-11 place-items-center rounded-full bg-surface-2 text-accent">
                          <RefreshIcon size={22} class="animate-spin [animation-duration:1.2s]" />
                        </span>
                        <p class="text-[14px] font-semibold text-text-2">正在获取章节正文…</p>
                        <p class="text-[12px] leading-[1.6] text-text-3">
                          <Show when={remoteRun().total > 0}>
                            窗口预取 {remoteRun().done} / {remoteRun().total}
                            <br />
                          </Show>
                          已缓存的章节仍可正常阅读
                        </p>
                      </>
                    }
                  >
                    <p class="text-[14px] font-semibold text-text-2">
                      {remoteRun().cancelled ? "获取已取消" : "章节获取失败"}
                    </p>
                    <p class="max-h-24 w-full overflow-y-auto break-all rounded-[10px] bg-danger-weak px-3 py-2 text-[11.5px] leading-[1.5] text-danger">
                      {remoteGateFailedText()}
                    </p>
                    <div class="mt-1 flex w-full items-center justify-center gap-3">
                      <button
                        class="rounded-xl bg-surface-2 px-4 py-2.5 text-[13px] font-semibold text-text-2 active:scale-[0.97]"
                        onClick={() => {
                          cancelOnlineRun(bookId());
                          goBack();
                        }}
                      >
                        返回书架
                      </button>
                      <button
                        class="rounded-xl bg-accent px-4 py-2.5 text-[13px] font-semibold text-on-accent active:scale-[0.97]"
                        onClick={() => {
                          void ensureReadingWindow(bookId(), chapterIdx());
                        }}
                      >
                        重试获取
                      </button>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>

            {/* 底部阅读状态栏：章节名 + 阅读进度（呼出菜单/抽屉时隐藏，避免遮挡） */}
            <Show when={statusShown()}>
              <div
                aria-hidden="true"
                class="pointer-events-none absolute inset-x-0 bottom-0 z-[15] select-none bg-gradient-to-t from-bg via-bg/45 to-transparent"
              >
                <div
                  class="flex items-center justify-between gap-3 px-6 pt-2 text-[10.5px] leading-none text-text-3"
                  style={{ "padding-bottom": `${statusBarPadBottom()}px` }}
                >
                  <span class="min-w-0 flex-1 truncate">{chapter()!.title}</span>
                  <span class="flex-none whitespace-nowrap tabular-nums">
                    <Show when={statusPercent() !== null}>
                      <span>{statusPercent()}%</span>
                    </Show>
                    <Show when={isPaged() && totalPages() > 1}>
                      <span> · {pageIdx() + 1} / {totalPages()} 页</span>
                    </Show>
                  </span>
                </div>
              </div>
            </Show>

            {/* 顶部工具栏（菜单呼出后显示） */}
            <header
              data-reader-ui
              class="absolute inset-x-0 top-0 z-30 select-none border-b border-border bg-topbar-bg backdrop-blur-[14px] transition-transform duration-200"
              classList={{
                "-translate-y-full": !menuOpen(),
                "translate-y-0": menuOpen(),
              }}
              style={{ "pointer-events": menuOpen() ? "auto" : "none" }}
              aria-hidden={!menuOpen()}
            >
              <div
                class="flex items-center gap-1.5 px-3 pb-2"
                style={{ "padding-top": `${topbarPadTop()}px` }}
              >
                {/* 搜索模式：顶部显示当前命中章节，点章节名返回搜索结果列表 */}
                <Show
                  when={!searchSession()}
                  fallback={
                    <>
                      <div class="h-10 w-10 flex-none" />
                      <button
                        type="button"
                        aria-label="返回搜索结果列表"
                        class="flex min-w-0 flex-1 flex-col items-center gap-[1px]"
                        onClick={returnToSearchResults}
                      >
                        <span class="max-w-full truncate text-[10.5px] text-text-3">
                          {`「${searchSession()?.term ?? ""}」搜索中`}
                        </span>
                        <span class="flex max-w-full items-center gap-1 text-[14.5px] font-semibold text-accent">
                          <span class="min-w-0 truncate">
                            {currentSearchHit()?.chapterTitle ?? ""}
                          </span>
                          <ChevronRightIcon
                            size={15}
                            class="flex-none opacity-70"
                          />
                        </span>
                      </button>
                      <div class="h-10 w-10 flex-none" />
                    </>
                  }
                >
                <button
                  class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                  aria-label="返回"
                  onClick={goBack}
                >
                  <ChevronLeftIcon />
                </button>
                <div class="flex min-w-0 flex-1 flex-col items-center gap-[1px]">
                  <span class="max-w-full truncate text-[14.5px] font-semibold" onClick={toBookDetailPage}>
                    {book()!.title}
                  </span>
                  <span class="max-w-full truncate text-[10.5px] text-text-3">
                    {chapter() ? `${chapter()!.cid} · ${chapter()!.title}` : ""}
                  </span>
                </div>
                <div class="flex flex-none items-center gap-1">
                  <Show when={isRemoteBook()}>
                    <button
                      class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                      aria-label="下载正文"
                      onClick={() => {
                        setDownloadOpen(true);
                        setMenuOpen(false);
                      }}
                    >
                      <DownloadIcon size={21} />
                    </button>
                  </Show>
                  <button
                    class="grid h-10 w-10 flex-none place-items-center rounded-xl transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                    classList={{
                      "text-accent": bookBookmarks().length > 0 || bmPanelOpen(),
                      "text-text-2": bookBookmarks().length === 0 && !bmPanelOpen(),
                    }}
                    aria-label="书签"
                    aria-pressed={bmPanelOpen()}
                    onClick={() => setBmPanelOpen((open) => !open)}
                  >
                    <BookmarkIcon
                      size={21}
                      filled={bookBookmarks().length > 0 || bmPanelOpen()}
                    />
                  </button>
                  <button
                    class="grid h-10 w-10 flex-none place-items-center rounded-xl transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                    classList={{
                      "text-accent": ttsPlayer.status() !== "stopped",
                      "text-text-2": ttsPlayer.status() === "stopped",
                    }}
                    aria-label={ttsPlayer.status() === "stopped" ? "听书" : "停止听书"}
                    aria-pressed={ttsPlayer.status() !== "stopped"}
                    onClick={() => {
                      if (ttsPlayer.status() === "stopped") {
                        setMenuOpen(false);
                        setTocOpen(false);
                        setBmPanelOpen(false);
                        ttsPlayer.start();
                      } else {
                        ttsPlayer.stop();
                      }
                    }}
                  >
                    <HeadphonesIcon size={21} />
                  </button>
                  <button
                    class="grid h-10 w-10 flex-none place-items-center rounded-xl transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                    classList={{
                      "text-accent": readerSettingsOpen(),
                      "text-text-2": !readerSettingsOpen(),
                    }}
                    aria-label="阅读设置"
                    aria-pressed={readerSettingsOpen()}
                    onClick={() => setReaderSettingsOpen(true)}
                  >
                    <SettingsIcon size={21} />
                  </button>
                </div>
                </Show>
              </div>
            </header>

            {/* 底部菜单栏 + 听书悬浮球（固定在菜单栏上方，随菜单一同滑入/滑出） */}
            <div
              class="absolute inset-x-0 bottom-0 z-30 transition-transform duration-200"
              classList={{
                "translate-y-full": !menuOpen(),
                "translate-y-0": menuOpen(),
              }}
              style={{ "pointer-events": menuOpen() ? "auto" : "none" }}
              aria-hidden={!menuOpen()}
            >
              {/* 听书悬浮球 + 返回跟读：停靠在底部菜单栏上方 */}
              <Show
                when={
                  ttsPlayer.status() !== "stopped" &&
                  !tocOpen() &&
                  !bmPanelOpen() &&
                  !searchSession()
                }
              >
                <div class="flex items-center gap-2 px-3 pb-1.5 pt-2">
                  <Show when={!followEnabled()}>
                    <button
                      data-reader-ui
                      class="flex flex-none cursor-pointer items-center gap-1.5 rounded-full border border-accent/50 bg-accent-weak py-[7px] pl-3 pr-3.5 text-[12px] font-semibold text-accent transition-[scale] duration-100 active:scale-[0.96]"
                      aria-label="返回跟读"
                      onClick={resumeFollow}
                    >
                      <FollowBackIcon size={15} />
                      返回跟读
                    </button>
                  </Show>
                  <div class="flex min-w-0 flex-1 justify-end">
                    <TtsBubble
                      status={ttsPlayer.status}
                      rate={ttsPlayer.rate}
                      voiceLabel={() => ttsPlayer.voiceName()}
                      error={ttsPlayer.error}
                      onPrev={() => ttsPlayer.prev()}
                      onNext={() => ttsPlayer.next()}
                      onToggle={() => ttsPlayer.togglePlay()}
                      onOpenSettings={() => setTtsSettingsOpen(true)}
                    />
                  </div>
                </div>
              </Show>
              <footer
                data-reader-ui
                class="select-none border-t border-border bg-surface"
              >
                <div
                  class="flex items-center gap-2 px-3.5 pt-2"
                  style={{ "padding-bottom": `${menuBarPadBottom()}px` }}
                >
                {/* 搜索模式：底部显示 返回原进度 / 上一条 / x/y / 下一条 / 关闭 */}
                <Show
                  when={!searchSession()}
                  fallback={
                    <>
                      <div class="flex w-full items-center gap-1">
                        <button
                          class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                          aria-label="返回搜索前进度"
                          onClick={restorePreSearch}
                        >
                          <RestoreBackIcon size={19} />
                        </button>
                        <div class="flex min-w-0 flex-1 items-center justify-center gap-1">
                          <button
                            class="inline-flex h-10 flex-none items-center justify-center gap-1 rounded-[10px] border border-border bg-bg px-2 text-[12.5px] text-text-2 transition-[scale,opacity] duration-100 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-30"
                            aria-label="上一个结果"
                            disabled={searchHitIndex() <= 0}
                            onClick={() => stepSearchHit(-1)}
                          >
                            <ChevronLeftIcon size={15} />
                            上一个
                          </button>
                          <span class="w-[3.6em] flex-none text-center text-[12.5px] font-semibold tabular-nums text-accent">
                            {searchHitIndex() + 1}/{searchHitTotal()}
                          </span>
                          <button
                            class="inline-flex h-10 flex-none items-center justify-center gap-1 rounded-[10px] border border-border bg-bg px-2 text-[12.5px] text-text-2 transition-[scale,opacity] duration-100 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-30"
                            aria-label="下一个结果"
                            disabled={searchHitIndex() + 1 >= searchHitTotal()}
                            onClick={() => stepSearchHit(1)}
                          >
                            下一个
                            <ChevronRightIcon size={15} />
                          </button>
                        </div>
                        <button
                          class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                          aria-label="关闭搜索模式"
                          onClick={exitSearchMode}
                        >
                          <CloseIcon size={20} />
                        </button>
                      </div>
                    </>
                  }
                >
                <button
                  class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-border bg-bg px-0.5 py-[9px] text-[12.5px] text-text-2 disabled:pointer-events-none disabled:opacity-30"
                  disabled={isFirstChapter()}
                  onClick={() => {
                    if (isPaged()) {
                      if (!isFirstChapter()) {
                        wantLastPage = true;
                        goToChapter(chapterIdx() - 1, true);
                      }
                    } else if (!isFirstChapter()) {
                      browseChapterPending = true;
                      setChapterIdx((c) => c - 1);
                      setViewOffset(0);
                    }
                    cancelFollowIfActive();
                  }}
                >
                  <ChevronLeftIcon size={16} />
                  上一章
                </button>
                <button
                  class="inline-flex flex-[1.7] items-center justify-center gap-1.5 rounded-[10px] border border-transparent bg-accent px-0.5 py-[9px] text-[12.5px] font-semibold tabular-nums text-on-accent"
                  onClick={() => setTocOpen(true)}
                >
                  <ListIcon size={17} />
                  <span class="truncate">
                    {chapterIdx() + 1}/{chapterCount()}章
                    {isPaged() && totalPages() > 0
                      ? ` · ${pageIdx() + 1}/${totalPages()}页`
                      : ""}
                  </span>
                </button>
                <button
                  class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-border bg-bg px-0.5 py-[9px] text-[12.5px] text-text-2 disabled:pointer-events-none disabled:opacity-30"
                  disabled={isLastChapter()}
                  onClick={() => {
                    if (isPaged()) {
                      if (!isLastChapter()) goToChapter(chapterIdx() + 1, true);
                    } else if (!isLastChapter()) {
                      browseChapterPending = true;
                      setChapterIdx((c) => c + 1);
                      setViewOffset(0);
                    }
                    cancelFollowIfActive();
                  }}
                >
                  下一章
                  <ChevronRightIcon size={16} />
                </button>
                </Show>
                </div>
              </footer>
            </div>

            {/* 目录抽屉 */}
            <Show when={tocOpen()}>
              <div
                data-reader-ui
                class="absolute inset-0 z-40 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
                onClick={() => setTocOpen(false)}
              />
              <div
                data-reader-ui
                class="absolute inset-x-0 bottom-0 z-[41] flex max-h-[72%] select-none animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
                role="dialog"
                aria-label="目录"
              >
                <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
                  <span class="text-[15px] font-bold">目录</span>
                  <span class="flex-1 text-xs text-text-3">
                    共 {chapterCount()} 章
                  </span>
                  <button
                    class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                    aria-label="全书搜索"
                    onClick={() => {
                      setTocOpen(false);
                      setMenuOpen(false);
                      setBookSearchOpen(true);
                    }}
                  >
                    <SearchIcon size={21} />
                  </button>
                  <button
                    class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                    aria-label="关闭目录"
                    onClick={() => setTocOpen(false)}
                  >
                    <CloseIcon />
                  </button>
                </div>
                <div
                  ref={listRef}
                  class="min-h-0 flex-1 overflow-y-auto px-0 py-1 pb-3.5 scrollbar-none"
                >
                  <For each={book()!.chapters}>
                    {(item, idx) => {
                      const active = idx() === chapterIdx();
                      // 在线书：尚未缓存正文的章节在目录标“下载”，正在拉取的标“下载中”
                      const downloading = remotePendingSet()?.has(idx()) ?? false;
                      const needsDownload =
                        isRemoteBook() && !downloading && !chapterHasContent(item);
                      return (
                        <button
                          class={`flex w-full items-center gap-3 px-[18px] py-[11px] text-left text-[13.5px] transition-colors active:bg-surface-2 ${
                            active
                              ? "bg-accent-weak font-semibold text-accent"
                              : "text-text-2"
                          }`}
                          data-current={active ? "true" : undefined}
                          onClick={() => jumpFromToc(idx())}
                        >
                          <span
                            class={`w-12 flex-none text-[11px] tabular-nums ${
                              active ? "text-accent" : "text-text-3"
                            }`}
                          >
                            {item.cid}
                          </span>
                          <span class="min-w-0 flex-1 truncate">{item.title}</span>
                          <span class="flex flex-none items-center gap-1.5">
                            <Show when={downloading}>
                              <span class="flex-none rounded-full border border-accent/50 px-2 py-0.5 text-[10px] text-accent">
                                下载中
                              </span>
                            </Show>
                            <Show when={needsDownload}>
                              <span class="flex-none rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-text-3">
                                下载
                              </span>
                            </Show>
                            <Show when={active}>
                              <span class="rounded-full bg-accent px-2 py-0.5 text-[10px] text-on-accent">
                                当前
                              </span>
                            </Show>
                          </span>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </div>
            </Show>
            {/* 书签面板 */}
            <BookmarkPanel
              open={bmPanelOpen()}
              bookmarks={bookBookmarks()}
              currentCid={chapter()?.cid}
              onClose={() => setBmPanelOpen(false)}
              onJump={jumpToBookmark}
              onDelete={(bookmark) => removeBookmark(bookmark.id)}
            />

            {/* 长按/拖选文本后的自定义菜单（搜索模式下让位给命中高亮） */}
            <SelectionMenu
              rootRef={() => areaRef}
              active={() =>
                !!book() &&
                !!layout() &&
                !menuOpen() &&
                !tocOpen() &&
                !bmPanelOpen() &&
                !bookSearchOpen() &&
                !searchSession()
              }
              onCopy={(text) => void handleCopyText(text)}
              onBookmark={(range) => handleBookmarkRange(range)}
              onSpeak={(range) => handleSpeakFromRange(range)}
            />

            {/* 听书设置（引擎 / 音色 / 自定义源 / 倍速 / 定时） */}
            <TtsSheet
              open={ttsSettingsOpen()}
              engine={ttsPlayer.engine}
              rate={ttsPlayer.rate}
              voiceId={ttsPlayer.voice}
              timerMode={ttsPlayer.timerMode}
              timerMinutes={ttsPlayer.timerMinutes}
              timerRemainSec={ttsPlayer.timerRemainSec}
              onEngine={(engine) => ttsPlayer.setEngine(engine)}
              onRate={(rate) => ttsPlayer.setRate(rate)}
              onVoice={(voiceId) => ttsPlayer.setVoice(voiceId)}
              onTimer={(mode, minutes) => ttsPlayer.setTimer(mode, minutes)}
              prewarmText={prewarmText}
              onPrewarmBook={() => void runPrewarmBook()}
              onStop={() => ttsPlayer.stop()}
              onClose={() => setTtsSettingsOpen(false)}
            />

            {/* 阅读设置（底部状态栏显示与进度口径） */}
            <ReaderSettingsSheet
              open={readerSettingsOpen()}
              onClose={() => setReaderSettingsOpen(false)}
              onlineReload={
                isRemoteBook()
                  ? {
                      disabled: remoteRun().busy,
                      onReload: () => {
                        void reloadCurrentChapter();
                      },
                    }
                  : undefined
              }
            />

            {/* 在线书：批量下载正文 */}
            <Show when={downloadOpen()}>
              <div
                class="fixed inset-0 z-40 animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
                onClick={() => setDownloadOpen(false)}
              />
              <div
                class="fixed inset-x-0 bottom-0 z-[41] mx-auto flex max-h-[70%] max-w-[480px] animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
                role="dialog"
                aria-label="下载正文"
              >
                <div class="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
                  <span class="text-[15px] font-bold">下载正文</span>
                  <span class="flex-1 text-xs text-text-3">
                    {book()!.chapters.length} 章 · 已下载{" "}
                    {book()!.chapters.filter((c) => chapterHasContent(c)).length} 章
                  </span>
                  <button
                    class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                    aria-label="关闭"
                    onClick={() => setDownloadOpen(false)}
                  >
                    <CloseIcon />
                  </button>
                </div>
                <div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
                  <p class="text-[12px] leading-[1.7] text-text-3">
                    平时阅读只按需缓存「当前章前后 5 章」；这里可把全书正文批量下载到本机，之后断网也能读。
                    请求并行度跟随全局「书源并发」设置（设置 → 书源）。
                  </p>
                  <Show when={remoteRun().busy}>
                    <div class="rounded-[12px] bg-surface-2 px-3.5 py-3">
                      <div class="flex items-center justify-between text-[12px]">
                        <span class="font-semibold text-text-2">
                          {remoteRun().phase === "window" ? "窗口预取中…" : "批量下载中…"}
                        </span>
                        <span class="tabular-nums text-text-3">
                          {remoteRun().done} / {remoteRun().total}
                        </span>
                      </div>
                      <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-bg">
                        <div
                          class="h-full rounded-full bg-accent transition-[width] duration-150"
                          style={{
                            width: `${
                              remoteRun().total > 0
                                ? Math.min(100, (remoteRun().done / remoteRun().total) * 100)
                                : 0
                            }%`,
                          }}
                        />
                      </div>
                      {remoteRun().failed.length > 0 && (
                        <p class="mt-1.5 text-[11px] text-danger">
                          {remoteRun().failed.length} 章失败
                        </p>
                      )}
                    </div>
                  </Show>
                  <Show when={!remoteRun().busy && remoteRun().failed.length > 0}>
                    <p class="rounded-[10px] bg-danger-weak px-3 py-2 text-[11.5px] leading-[1.5] text-danger">
                      上次有 {remoteRun().failed.length} 章未下载成功，可重试。
                    </p>
                  </Show>
                  <div class="flex gap-2.5 pt-0.5">
                    <Show when={remoteRun().busy}>
                      <button
                        class="flex-1 rounded-xl bg-surface-2 px-4 py-2.5 text-[13.5px] font-semibold text-text-2 active:scale-[0.98]"
                        onClick={() => cancelOnlineRun(bookId())}
                      >
                        停止下载
                      </button>
                    </Show>
                    <button
                      class="flex-1 rounded-xl bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-on-accent shadow-lg shadow-accent/25 active:scale-[0.98]"
                      disabled={remoteRun().busy}
                      classList={{ "opacity-50": remoteRun().busy }}
                      onClick={() => {
                        void (async () => {
                          const bookIdNow = bookId();
                          await downloadRemainingChapters(bookIdNow);
                          const st = onlineRunState(bookIdNow);
                          if (st.cancelled) return;
                          const count = st.done;
                          if (st.failed.length === 0 && count > 0) {
                            showToast(`下载完成：${count} 章正文已缓存`);
                          } else if (st.failed.length > 0) {
                            showToast(`下载完成 ${count} 章，${st.failed.length} 章失败`, true);
                          }
                        })();
                      }}
                    >
                      {remoteRun().busy ? "下载中…" : "下载剩余全部"}
                    </button>
                  </div>
                  <p class="pb-1 text-center text-[11px] text-text-3">
                    下载内容同样保存在本机书库，删除书籍时一并清除
                  </p>
                </div>
              </div>
            </Show>

            {/* 全书搜索（阅读器内抽屉，不产生路由历史；命中后进入搜索模式高亮逐条查看） */}
            <BookSearchPanel
              open={bookSearchOpen()}
              book={book()}
              activeIndex={searchSession() ? searchHitIndex() : null}
              focusInput={searchSession() ? false : undefined}
              onClose={() => setBookSearchOpen(false)}
              onOpenResult={openSearchResult}
            />
          </div>
        </Show>
      </Show>
    </div>
  );
}

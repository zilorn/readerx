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
import { BookmarkPanel } from "../components/BookmarkPanel";
import { SelectionMenu } from "../components/SelectionMenu";
import {
  BookmarkIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  ListIcon,
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
  paginateChapter,
  paragraphStyle,
  readingBaseStyle,
  titleAuthorStyle,
  titleTextStyle,
  titleWrapperStyle,
  type CssRecord,
  type PageFragment,
  type PaginateLayout,
  type ReaderBlock,
} from "../lib/pagination";
import {
  FONT_MAX,
  FONT_MIN,
  currentFontSize,
  currentPageMode,
  currentParaSpacing,
  ensureShelfEntry,
  setFontSize,
  shelfEntries,
  updateReadingLocation,
} from "../lib/store";
import { progressContextAt, resolveReadingTarget } from "../lib/progress";
import { showToast } from "../lib/toast";
import {
  charNodeAtOffset,
  charOffsetInElement,
  copyPlainText,
  dataAnchorOf,
  flashUnitRange,
} from "../lib/textAnchor";

const PAD_X = 24; // 阅读区左右留白
const PAD_TOP = 14; // 正文顶部留白
const PAD_BOTTOM_PAGED = 30; // 分页底部留白（容纳页号）
const PAD_BOTTOM_SCROLL = 28; // 滚动底部留白

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

/** 分页引擎的行内样式记录 → Solid 样式对象 */
function asCss(record: CssRecord): JSX.CSSProperties {
  return record as JSX.CSSProperties;
}

// ---------------------------------------------------------------------------
// 书签下划线：按单元内字符区间把文本切段渲染
// ---------------------------------------------------------------------------

/** 单元内被书签覆盖的字符区间（局部于该单元文本） */
export interface UnitMark {
  unit: number;
  s: number;
  e: number;
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
  marked: boolean;
}

/** 把文本按覆盖区间切段（窗口 [winStart, winStart+text.length) 之外的书签忽略） */
function splitMarkedText(
  text: string,
  winStart: number,
  unit: number,
  marks: UnitMark[],
): TextSegment[] {
  const segments: TextSegment[] = [];
  let pos = 0;
  for (const mark of marks) {
    if (mark.unit !== unit) continue;
    if (mark.e <= winStart) continue;
    const winEnd = winStart + text.length;
    if (mark.s >= winEnd) break;
    const s = Math.max(mark.s, winStart) - winStart;
    const e = Math.min(mark.e, winEnd) - winStart;
    if (e <= pos) continue;
    if (s > pos) {
      segments.push({ text: text.slice(pos, s), marked: false });
      pos = s;
    }
    segments.push({ text: text.slice(pos, e), marked: true });
    pos = e;
    if (pos >= text.length) break;
  }
  if (pos < text.length) {
    segments.push({ text: text.slice(pos), marked: false });
  }
  return segments;
}

/** 渲染切段：命中书签的片段包橙色下划线 span */
function renderMarkedText(
  text: string,
  winStart: number,
  unit: number,
  marks: UnitMark[],
): JSX.Element {
  const segments = splitMarkedText(text, winStart, unit, marks);
  if (segments.length === 1 && !segments[0].marked) return segments[0].text;
  return (
    <>
      {segments.map((seg) =>
        seg.marked ? (
          <span
            style={{
              "text-decoration-line": "underline",
              "text-decoration-color": "var(--accent)",
              "text-decoration-thickness": "2px",
              "text-underline-offset": "0.2em",
            }}
          >
            {seg.text}
          </span>
        ) : (
          seg.text
        ),
      )}
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

  // 章节文本镜像（单元文本按序拼接 + 单元起始偏移），书签偏移换算基准
  const mirror = createMemo(() => buildTextMirror(units()));

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

  // 分页结果：图片解码完成后重算
  const [paged, setPaged] = createSignal<ReturnType<typeof paginateChapter>>(null);
  createEffect(() => {
    const mode = isPaged();
    const ch = chapter();
    const geo = layout();
    if (!mode || !ch || !geo) {
      setPaged(null);
      return;
    }
    setPaged(null);
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    const author = book()?.author ?? null;
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
      if (cancelled || !isPaged() || chapter() !== ch) return;
      const result = paginateChapter(ch, author, geo, sizes);
      if (!result || cancelled || !isPaged() || chapter() !== ch) return;
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

  // 需要跳转到上一章最后一页时置位（回翻/工具栏上一章）
  let wantLastPage = false;

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
    if (resumeTarget() !== null) return; // 精确恢复落定前不覆盖存档位置
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
        root.scrollTop += r.top - targetY;
        return true;
      }
    } catch {
      /* 降级为段落对齐 */
    }
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

  /** 滚动模式滚动事件：帧节流后按视口顶部文本提交位置 */
  function onScrollBody(): void {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (isPaged() || resumeTarget() !== null) return;
      const root = scrollRef;
      if (!root) return;
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
    if (resumeTarget() !== null) return;
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

  function goToChapter(idx: number): void {
    const current = book();
    if (!current) return;
    const clamped = Math.max(0, Math.min(idx, current.chapters.length - 1));
    if (clamped === chapterIdx()) return;
    setChapterIdx(clamped);
    setPageIdx(0);
  }

  function jumpFromToc(idx: number): void {
    goToChapter(idx);
    setTocOpen(false);
    setMenuOpen(false);
  }

  /** 左右翻页（含章节边界衔接）；返回是否发生了位移 */
  function turnPage(dir: 1 | -1): boolean {
    if (!isPaged()) return false;
    const total = totalPages();
    const idx = pageIdx();
    if (dir > 0) {
      if (idx + 1 < total) {
        setPageIdx(idx + 1);
        return true;
      }
      if (!isLastChapter()) {
        goToChapter(chapterIdx() + 1);
        return true;
      }
      return false;
    }
    if (idx > 0) {
      setPageIdx(idx - 1);
      return true;
    }
    if (!isFirstChapter()) {
      wantLastPage = true;
      goToChapter(chapterIdx() - 1);
      return true;
    }
    return false;
  }

  function goBack(): void {
    if (window.history.length > 1) navigate(-1);
    else navigate("/");
  }

  function incFont(delta: number): void {
    setFontSize(currentFontSize() + delta);
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
      animDir = dx < 0 ? 1 : -1;
      if (turnPage(animDir)) animTriggered = true;
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
      animDir = -1;
      if (turnPage(-1)) animTriggered = true;
    } else if (x > (rect.width * 2) / 3) {
      animDir = 1;
      if (turnPage(1)) animTriggered = true;
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
      if (menuOpen() || tocOpen() || !isPaged()) return;
      const dir = e.key === "ArrowRight" ? 1 : -1;
      animDir = dir;
      if (turnPage(dir)) animTriggered = true;
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

  // 等待章节/分页就绪后，把书签字符区间滚动到可见并短暂高亮
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
                              marks={unitMarks()}
                            />
                          )}
                        </For>
                      </div>
                      <div
                        class="relative flex-none"
                        style={{ height: `${bottomPadPaged()}px` }}
                      >
                        <Show when={totalPages() > 1 && !menuOpen()}>
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
                    <For each={units()}>
                      {(block, idx) => (
                        <ScrollBlock
                          layout={layout()!}
                          block={block}
                          unit={idx()}
                          marks={unitMarks()}
                        />
                      )}
                    </For>
                  </div>
                </div>
              </Show>
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
              <div class="flex items-center gap-1.5 px-3 pb-2 pt-[max(env(safe-area-inset-top),8px)]">
                <button
                  class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
                  aria-label="返回"
                  onClick={goBack}
                >
                  <ChevronLeftIcon />
                </button>
                <div class="flex min-w-0 flex-1 flex-col items-center gap-[1px]">
                  <span class="max-w-full truncate text-[14.5px] font-semibold">
                    {book()!.title}
                  </span>
                  <span class="max-w-full truncate text-[10.5px] text-text-3">
                    {chapter() ? `${chapter()!.cid} · ${chapter()!.title}` : ""}
                  </span>
                </div>
                <div class="flex flex-none items-center gap-1">
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
                  <div class="flex gap-1" aria-label="调整字号">
                    <button
                      class="grid h-[30px] w-[30px] place-items-center rounded-lg border border-border text-xs font-bold text-text-2 disabled:opacity-30"
                      aria-label="减小字号"
                      disabled={currentFontSize() <= FONT_MIN}
                      onClick={() => incFont(-1)}
                    >
                      A−
                    </button>
                    <button
                      class="grid h-[30px] w-[30px] place-items-center rounded-lg border border-border text-xs font-bold text-text-2 disabled:opacity-30"
                      aria-label="增大字号"
                      disabled={currentFontSize() >= FONT_MAX}
                      onClick={() => incFont(1)}
                    >
                      A+
                    </button>
                  </div>
                </div>
              </div>
            </header>

            {/* 底部工具栏 */}
            <footer
              data-reader-ui
              class="absolute inset-x-0 bottom-0 z-30 select-none border-t border-border bg-surface transition-transform duration-200"
              classList={{
                "translate-y-full": !menuOpen(),
                "translate-y-0": menuOpen(),
              }}
              style={{ "pointer-events": menuOpen() ? "auto" : "none" }}
              aria-hidden={!menuOpen()}
            >
              <div class="flex items-center gap-2 px-3.5 pb-[calc(10px+env(safe-area-inset-bottom))] pt-2">
                <button
                  class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-border bg-bg px-0.5 py-[9px] text-[12.5px] text-text-2 disabled:pointer-events-none disabled:opacity-30"
                  disabled={isFirstChapter()}
                  onClick={() => {
                    if (isPaged()) {
                      if (!isFirstChapter()) {
                        wantLastPage = true;
                        goToChapter(chapterIdx() - 1);
                      }
                    } else if (!isFirstChapter()) {
                      setChapterIdx((c) => c - 1);
                    }
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
                      if (!isLastChapter()) goToChapter(chapterIdx() + 1);
                    } else if (!isLastChapter()) {
                      setChapterIdx((c) => c + 1);
                    }
                  }}
                >
                  下一章
                  <ChevronRightIcon size={16} />
                </button>
              </div>
            </footer>

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
                          {active && (
                            <span class="flex-none rounded-full bg-accent px-2 py-0.5 text-[10px] text-on-accent">
                              当前
                            </span>
                          )}
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

            {/* 长按/拖选文本后的自定义菜单 */}
            <SelectionMenu
              rootRef={() => areaRef}
              active={() =>
                !!book() &&
                !!layout() &&
                !menuOpen() &&
                !tocOpen() &&
                !bmPanelOpen()
              }
              onCopy={(text) => void handleCopyText(text)}
              onBookmark={(range) => handleBookmarkRange(range)}
            />
          </div>
        </Show>
      </Show>
    </div>
  );
}

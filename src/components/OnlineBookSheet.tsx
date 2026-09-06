/**
 * 在线书详情抽屉（发现页内弹出，不切路由，防止发现页状态丢失）：
 * 打开即拉取书源「详情」（bookDetail，富化简介/最新章节等）与「目录」（bookToc），
 * 在抽屉内预览简介、目录，并可「加入书架」或「加入书架并阅读」。
 * 目录加载完成前不可加入书架（书架元数据以目录为骨架）。
 */
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { useNavigate } from "@solidjs/router";
import { callRemoteSource } from "../lib/backend";
import type { BookItem, ChapterItem } from "../lib/bookSourcesTypes";
import { normalizeBookTags } from "../lib/booksTypes";
import { bookMetaList } from "../lib/books";
import { addOnlineBookToShelf, fetchBookToc, mergeBookDetail, type PickedBook } from "../lib/online";
import { showToast } from "../lib/toast";
import { TagChips } from "./TagChips";
import { BookIcon, CloseIcon, ListIcon, RefreshIcon } from "./icons";
import { ScrollArea } from "./ScrollArea";
import { SourceCover } from "./SourceCover";

/** 目录预览默认先渲染的章节数（超出折叠，避免超长书首屏卡顿） */
const TOC_PREVIEW_CAP = 300;

/**
 * 会话级预览缓存：同一本书（sourceId|bookUrl）在一次会话内重复点开抽屉时，
 * 详情 / 目录直接复用上次结果，避免反复拉取超长目录。
 */
const detailCache = new Map<string, BookItem>();
const tocCache = new Map<string, ChapterItem[]>();

export interface OnlineBookSheetProps {
  /** 当前预览的书；null 表示关闭抽屉 */
  pick: PickedBook | null;
  onClose: () => void;
}

export function OnlineBookSheet(props: OnlineBookSheetProps) {
  const navigate = useNavigate();

  /** 当前展示用书籍信息（打开时先取搜索命中项，详情接口返回后合并富化） */
  const [info, setInfo] = createSignal<BookItem | null>(null);
  const [infoBusy, setInfoBusy] = createSignal(false);
  const [infoError, setInfoError] = createSignal("");
  /** 目录章节（null = 尚未取到） */
  const [chapters, setChapters] = createSignal<ChapterItem[] | null>(null);
  const [tocBusy, setTocBusy] = createSignal(false);
  const [tocError, setTocError] = createSignal("");
  /** 书源未启用「目录」能力（重试无意义，隐藏重试按钮） */
  const [tocUnsupported, setTocUnsupported] = createSignal(false);
  const [showAllChapters, setShowAllChapters] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  const [actionError, setActionError] = createSignal("");

  /** 请求序号：换书 / 关闭后使仍在途的旧请求失效 */
  let seq = 0;
  /** 当前详情（bookDetail）拉取中的 Promise；入架前等待它，确保用富化后的信息（含封面）落盘 */
  let pendingDetail: Promise<void> | null = null;

  function beginLoad(p: PickedBook | null) {
    seq += 1;
    pendingDetail = null;
    setInfo(p?.item ?? null);
    setInfoBusy(false);
    setInfoError("");
    setChapters(null);
    setTocBusy(false);
    setTocError("");
    setTocUnsupported(false);
    setShowAllChapters(false);
    setActionError("");
    if (!p) return;
    const run = seq;
    if (p.source.capabilities.detail) {
      setInfoBusy(true);
      pendingDetail = loadDetail(p, run);
    }
    if (p.source.capabilities.toc) {
      setTocBusy(true);
      void loadToc(p, run);
    } else {
      setTocUnsupported(true);
      setTocError("该书源未启用「目录」能力，无法预览章节");
    }
  }

  createEffect(() => {
    beginLoad(props.pick);
  });

  async function loadDetail(p: PickedBook, run: number): Promise<void> {
    const cached = detailCache.get(p.key);
    if (cached) {
      if (run === seq) {
        setInfo(cached);
        setInfoBusy(false);
      }
      return;
    }
    try {
      const r = await callRemoteSource(p.source.id, "bookDetail", [p.item]);
      if (run !== seq) return;
      if (r.ok) {
        const merged = mergeBookDetail(p.item, r.value);
        detailCache.set(p.key, merged);
        setInfo(merged);
      } else if (r.error) {
        setInfoError(r.error);
      }
    } catch (e) {
      if (run === seq) setInfoError(e instanceof Error ? e.message : String(e));
    } finally {
      if (run === seq) setInfoBusy(false);
    }
  }

  async function loadToc(p: PickedBook, run: number): Promise<void> {
    const cached = tocCache.get(p.key);
    if (cached) {
      if (run === seq) {
        setChapters(cached);
        setTocBusy(false);
      }
      return;
    }
    try {
      const list = await fetchBookToc(p.source, p.item);
      if (run !== seq) return;
      tocCache.set(p.key, list);
      setChapters(list);
    } catch (e) {
      if (run === seq) setTocError(e instanceof Error ? e.message : String(e));
    } finally {
      if (run === seq) setTocBusy(false);
    }
  }

  /** 该书是否已在书架（按书源 + 详情页 URL 匹配） */
  const existingBook = createMemo(() => {
    const p = props.pick;
    if (!p) return null;
    return (
      bookMetaList().find(
        (b) => b.bookSourceId === p.source.id && b.bookUrl === p.item.bookUrl,
      ) ?? null
    );
  });

  const inShelf = createMemo(() => existingBook() !== null);

  /** 目录已就绪（可据此加入书架） */
  const tocReady = createMemo(() => {
    const list = chapters();
    return list !== null && list.length > 0;
  });

  const tocCount = createMemo(() => chapters()?.length ?? 0);

  /** 预览展示的标签：已在书架时以书内标签为准（可被详情页编辑），否则用书源返回的 */
  const tags = createMemo(() => {
    const shelf = existingBook();
    if (shelf) return normalizeBookTags(shelf.tags);
    return normalizeBookTags(info()?.tags);
  });

  /** 预览封面：已在书架的书直接用已落盘的封面缩略图；否则用书源搜索/详情返回的 cover */
  const coverSrc = createMemo(() => {
    const shelf = existingBook();
    if (shelf?.cover) return shelf.cover;
    return info()?.cover;
  });

  const visibleChapters = createMemo(() => {
    const all = chapters() ?? [];
    if (showAllChapters() || all.length <= TOC_PREVIEW_CAP) return all;
    return all.slice(0, TOC_PREVIEW_CAP);
  });

  const collapsedCount = createMemo(() =>
    Math.max(0, tocCount() - TOC_PREVIEW_CAP),
  );

  /** 「仅加入书架 / 加入书架并阅读」共用流程 */
  async function addToShelf(openReader: boolean): Promise<void> {
    const p = props.pick;
    if (!p || adding()) return;
    const existing = existingBook();
    let bookId = existing?.id;
    if (!existing) {
      const list = chapters();
      if (!list || list.length === 0) {
        setActionError("目录尚未就绪，暂时无法加入书架");
        return;
      }
      setAdding(true);
      setActionError("");
      try {
        // 详情仍在加载时先等它完成，确保入架用的是富化后的信息（简介 / 封面一并落盘）
        if (p.source.capabilities.detail && pendingDetail) {
          try {
            await pendingDetail;
          } catch {
            /* 详情失败不阻塞入架 */
          }
        }
        // 用富化后的信息入架（简介等一并保存）
        const book = await addOnlineBookToShelf(p.source, info() ?? p.item, list);
        bookId = book.id;
        showToast("已加入书架");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setActionError(msg);
        showToast(msg, true);
        setAdding(false);
        return;
      }
      setAdding(false);
    } else {
      showToast("已在书架中");
    }
    if (openReader && bookId) navigate(`/book/${bookId}`);
  }

  const close = () => {
    if (adding()) return;
    props.onClose();
  };

  return (
    <Show when={props.pick}>
      <Portal>
        <div
          class="fixed inset-0 z-[70] animate-sheet-fade bg-black/45 backdrop-blur-[2px]"
          onClick={close}
        />
        <div
          class="fixed inset-x-0 bottom-0 z-[71] mx-auto flex max-h-[88%] w-full max-w-[480px] animate-sheet-up flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_-10px_34px_rgb(0_0_0/0.22)]"
          role="dialog"
          aria-modal="true"
          aria-label="在线书详情"
        >
          <div class="flex flex-none items-center gap-2 border-b border-border px-4 py-3">
            <span class="text-[15px] font-bold">书籍详情</span>
            <span class="min-w-0 flex-1 truncate text-xs text-text-3">
              {props.pick?.source.name ?? ""}
            </span>
            <button
              class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
              aria-label="关闭"
              onClick={close}
            >
              <CloseIcon />
            </button>
          </div>

          <ScrollArea class="min-h-0 flex-1">
            <div class="px-[18px] pb-2 pt-2.5">
              {/* 封面 + 基本信息 */}
              <div class="flex gap-3.5">
                {/* 书源返回 cover 时展示真实封面（经书源会话下载）；无封面回退首字渐变占位 */}
                <SourceCover
                  variant="sheet"
                  sourceId={props.pick?.source.id ?? ""}
                  url={coverSrc()}
                  referer={info()?.bookUrl}
                  title={info()?.bookName ?? ""}
                />
                <div class="flex min-w-0 flex-1 flex-col justify-center gap-1">
                  <h2 class="text-[17px] font-bold leading-snug">
                    {info()?.bookName ?? ""}
                  </h2>
                  <p class="truncate text-[12.5px] text-text-3">
                    {info()?.author || "佚名"}
                  </p>
                  <Show when={info()?.latest}>
                    <p class="truncate text-[12px] text-accent">
                      最新：{info()!.latest}
                    </p>
                  </Show>
                  <Show when={info()?.updateTime}>
                    <p class="text-[11px] text-text-3">
                      更新：{info()!.updateTime}
                    </p>
                  </Show>
                  <Show when={tags().length > 0}>
                    <div class="mt-0.5 flex flex-wrap gap-1.5">
                      <TagChips tags={tags()} />
                    </div>
                  </Show>
                  <Show when={inShelf()}>
                    <p class="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-accent-weak px-2 py-0.5 text-[11px] font-semibold text-accent">
                      <BookIcon size={12} />
                      已在书架
                    </p>
                  </Show>
                </div>
              </div>

              {/* 简介 */}
              <section class="mt-4">
                <h3 class="mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
                  简介
                </h3>
                <Show
                  when={info()?.intro}
                  fallback={
                    <Show
                      when={infoBusy()}
                      fallback={
                        <div class="flex min-h-[56px] items-center justify-center rounded-[12px] border border-dashed border-border bg-surface px-4 text-center text-[12px] leading-[1.7] text-text-3">
                          <Show when={infoError()} fallback="暂无简介">
                            <span class="text-danger">
                              简介获取失败：{infoError()}
                            </span>
                          </Show>
                        </div>
                      }
                    >
                      <div class="flex items-center justify-center gap-1.5 py-3 text-[12px] text-text-3">
                        <RefreshIcon size={14} class="animate-spin" />
                        简介加载中…
                      </div>
                    </Show>
                  }
                >
                  <p class="whitespace-pre-wrap break-words rounded-[12px] border border-border bg-surface px-3.5 py-3 text-[12.5px] leading-[1.75] text-text-2">
                    {info()!.intro}
                  </p>
                </Show>
              </section>

              {/* 目录 */}
              <section class="mt-4">
                <div class="mb-2 flex items-center gap-1.5">
                  <ListIcon size={15} class="flex-none text-text-3" />
                  <h3 class="text-[12.5px] font-medium tracking-[0.04em] text-text-3">
                    目录
                  </h3>
                  <Show when={tocCount() > 0}>
                    <span class="ml-auto text-[11px] text-text-3">
                      共 {tocCount()} 章
                    </span>
                  </Show>
                </div>
                <Show
                  when={chapters()}
                  fallback={
                    <Show
                      when={tocBusy()}
                      fallback={
                        <Show
                          when={tocError()}
                          fallback={
                            <div class="flex min-h-[56px] items-center justify-center rounded-[12px] border border-dashed border-border bg-surface px-4 text-center text-[12px] text-text-3">
                              目录加载中…
                            </div>
                          }
                        >
                          <div class="flex items-center gap-2 rounded-[12px] border border-border bg-surface px-3.5 py-2.5 text-[12px] text-danger">
                            <span class="min-w-0 flex-1">{tocError()}</span>
                            <Show when={!tocUnsupported()}>
                              <button
                                class="flex-none rounded-lg bg-danger-weak px-2.5 py-1 text-[11.5px] font-semibold text-danger active:opacity-80"
                                onClick={() => beginLoad(props.pick)}
                              >
                                重试
                              </button>
                            </Show>
                          </div>
                        </Show>
                      }
                    >
                      <div class="flex items-center justify-center gap-1.5 py-3 text-[12px] text-text-3">
                        <RefreshIcon size={14} class="animate-spin" />
                        正在获取目录…
                      </div>
                    </Show>
                  }
                >
                  <div class="divide-y divide-border overflow-hidden rounded-[12px] border border-border bg-surface">
                    <For each={visibleChapters()}>
                      {(ch, index) => (
                        <div class="flex items-center gap-2.5 px-3 py-[9px]">
                          <span class="w-9 flex-none text-right text-[11px] tabular-nums text-text-3">
                            {index() + 1}
                          </span>
                          <span class="min-w-0 flex-1 truncate text-[12.5px] text-text">
                            {ch.chapterName}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                  <Show when={collapsedCount() > 0 && !showAllChapters()}>
                    <button
                      class="mt-2 flex w-full items-center justify-center rounded-[10px] border border-border bg-surface py-2 text-[12px] font-medium text-text-2 active:bg-surface-2"
                      onClick={() => setShowAllChapters(true)}
                    >
                      展开全部章节（还有 {collapsedCount()} 章）
                    </button>
                  </Show>
                </Show>
              </section>
            </div>
          </ScrollArea>

          {/* 底部操作 */}
          <div class="flex-none border-t border-border px-[18px] pb-[calc(12px+env(safe-area-inset-bottom))] pt-2.5">
            <Show when={actionError()}>
              <p class="mb-2 text-center text-[11px] text-danger">
                {actionError()}
              </p>
            </Show>
            <div class="flex items-center gap-2.5">
              <Show when={!inShelf()}>
                <button
                  class="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-bg px-3 py-[11px] text-[13.5px] font-medium text-text-2 transition-colors active:bg-surface-2 disabled:opacity-50"
                  disabled={adding() || !tocReady()}
                  onClick={() => void addToShelf(false)}
                >
                  加入书架
                </button>
              </Show>
              <button
                class="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-[11px] text-[13.5px] font-semibold text-on-accent transition-[scale,opacity] duration-100 active:scale-[0.98] active:opacity-90 disabled:opacity-50"
                disabled={adding() || (!inShelf() && !tocReady())}
                onClick={() => void addToShelf(true)}
              >
                <Show when={adding()} fallback={inShelf() ? "开始阅读" : "加入书架并阅读"}>
                  <RefreshIcon size={16} class="animate-spin" />
                  正在加入…
                </Show>
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

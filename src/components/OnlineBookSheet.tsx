/**
 * 在线书详情抽屉（发现页内弹出，不切路由，防止发现页状态丢失）：
 * 打开即拉取书源「详情」（bookDetail，富化简介/最新章节等）与「目录」（bookToc），
 * 在抽屉内预览简介、目录，并可「加入书架」或「加入书架并阅读」。
 * 目录加载完成前不可加入书架（书架元数据以目录为骨架）。
 */
import { Drawer } from "./Drawer";
import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { useNavigate } from "@solidjs/router";
import { buildSourceChapterContent } from "../lib/sourceContent";
import { callRemoteSource, fetchRemoteChapterContents } from "../lib/backend";
import type { BookItem, ChapterItem } from "../lib/bookSourcesTypes";
import { normalizeBookTags } from "../lib/booksTypes";
import { hanText, hanTextList } from "../lib/hanDisplay";
import { bookMetaList } from "../lib/books";
import { addOnlineBookToShelf, fetchBookToc, mergeBookDetail, rememberPicked, switchOnlineBookSource, type PickedBook } from "../lib/online";
import type { SourceCandidate } from "../lib/onlineSearch";
import { reportFailure } from "../lib/errorReport";
import { notifyAddedToShelf } from "../lib/groups";
import { showToast } from "../lib/toast";
import { t } from "../lib/i18n";
import { TagChips } from "./TagChips";
import { QuickSearchText } from "./QuickSearchText";
import { BookIcon, CloseIcon, ListIcon, RefreshIcon } from "./icons";
import { ScrollArea } from "./ScrollArea";
import { SourceCover } from "./SourceCover";
import { isFallbackBookAuthor } from "../lib/bookDisplay";

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
  candidates?: SourceCandidate[];
  targetBookId?: string;
  /** 书名 / 作者 / 标签的快速搜索回调：调用方借此发起搜索（不提供则这些文字仅展示） */
  onQuickSearch?: (keyword: string) => void;
}

export function OnlineBookSheet(props: OnlineBookSheetProps) {
  const navigate = useNavigate();
  const [selected, setSelected] = createSignal<PickedBook | null>(null);
  const [addedBookId, setAddedBookId] = createSignal<string>();
  const [confirmSwitch, setConfirmSwitch] = createSignal<boolean | null>(null);
  createEffect(() => { setSelected(props.pick); setConfirmSwitch(null); setAddedBookId(undefined); });
  onCleanup(() => { seq += 1; contentSeq += 1; });
  const selectSource = (candidate: SourceCandidate) => {
    if (adding()) return;
    setConfirmSwitch(null);
    setSelected({ ...candidate, key: rememberPicked(candidate.source, candidate.item) });
  };


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
  let contentSeq = 0;
  const [previewChapter, setPreviewChapter] = createSignal<ChapterItem | null>(null);
  const [previewText, setPreviewText] = createSignal<string[]>([]);
  const [contentBusy, setContentBusy] = createSignal(false);
  const [contentError, setContentError] = createSignal("");
  async function previewContent(chapter: ChapterItem) {
    const p = selected();
    if (!p || adding()) return;
    const run = ++contentSeq;
    setPreviewChapter(chapter);
    setPreviewText([]);
    setContentError("");
    setContentBusy(true);
    try {
      const results = await fetchRemoteChapterContents(p.source.id, info() ?? p.item, [chapter]);
      if (run !== contentSeq) return;
      const result = results[0];
      if (!result?.ok) throw new Error(result?.error || t("discover.error.chapterFetchFailed"));
      setPreviewText(buildSourceChapterContent(result.text, chapter.chapterUrl).paragraphs);
    } catch (error) {
      if (run === contentSeq) {
        setContentError(error instanceof Error ? error.message : String(error));
        reportFailure(t("discover.error.chapterFetchFailed"), error);
      }
    } finally {
      if (run === contentSeq) setContentBusy(false);
    }
  }

  /** 当前详情（bookDetail）拉取中的 Promise；入架前等待它，确保用富化后的信息（含封面）落盘 */
  let pendingDetail: Promise<void> | null = null;

  function beginLoad(p: PickedBook | null) {
    seq += 1;
    contentSeq += 1;
    setPreviewChapter(null);
    setPreviewText([]);
    setContentBusy(false);
    setContentError("");
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
      setTocError(t("discover.online.tocUnsupported"));
    }
  }

  createEffect(() => {
    beginLoad(selected());
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
    const p = selected();
    if (!p) return null;
    return (
      bookMetaList().find(
        (b) => b.bookSourceId === p.source.id && b.bookUrl === (info()?.bookUrl ?? p.item.bookUrl),
      ) ?? null
    );
  });

  const switchTarget = createMemo(() => {
    const book = bookMetaList().find((b) => b.id === (props.targetBookId ?? addedBookId()) && b.format === "online");
    const p = selected();
    return book && p && (book.bookSourceId !== p.source.id || book.bookUrl !== (info()?.bookUrl ?? p.item.bookUrl)) ? book : null;
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

  /** 展示用标签（简繁转换副本；书源 / 书架里的原始标签不变） */
  const displayTags = createMemo(() => hanTextList(tags()) ?? []);

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
  async function addToShelf(openReader: boolean, confirmed = false): Promise<void> {
    const p = selected();
    if (!p || adding()) return;
    const target = switchTarget();
    if (target && !confirmed) { setConfirmSwitch(openReader); return; }
    const run = seq;
    const existing = target ? null : existingBook();
    let bookId = existing?.id;
    if (!existing) {
      const list = chapters();
      if (!list || list.length === 0) {
        setActionError(t("discover.online.tocNotReady"));
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
        if (run !== seq) { setAdding(false); return; }
        // 用富化后的信息入架（简介等一并保存）
        if (target) {
          await switchOnlineBookSource(target.id, p.source, info() ?? p.item, list);
          bookId = target.id;
          setConfirmSwitch(null);
          showToast(t("discover.sources.switched"));
        } else {
          const book = await addOnlineBookToShelf(p.source, info() ?? p.item, list);
          bookId = book.id;
          setAddedBookId(book.id);
          notifyAddedToShelf(book.id);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setActionError(msg);
        reportFailure(t("discover.sources.actionFailed"), e);
        setAdding(false);
        return;
      }
      setAdding(false);
    } else {
      showToast(t("discover.sheet.alreadyInShelf"));
    }
    if (openReader && bookId) {
      // 抽屉挂在 Portal 上，不随页面一起隐藏：跳转前必须自己收起
      props.onClose();
      navigate(`/book/${bookId}`);
    }
  }

  const close = () => {
    if (adding()) return;
    props.onClose();
  };

  /** 书名 / 作者 / 标签的快速搜索：入架过程中不响应，避免打断正在进行的入架 */
  const quickSearch = (keyword: string): void => {
    if (adding()) return;
    props.onQuickSearch?.(keyword);
  };

  return (
    <Show when={props.pick}>
      <Portal>
        <Drawer
          onClose={close}
          label={t("discover.sheet.aria")}
          layer={70}
          sizeClass="max-h-[88%]"
        >
          <div class="flex flex-none items-center gap-2 border-b border-border px-4 py-3">
            <span class="text-[15px] font-bold">{t("discover.sheet.title")}</span>
            <span class="min-w-0 flex-1 truncate text-xs text-text-3">
              {selected()?.source.name ?? ""}
            </span>
            <button
              class="grid h-10 w-10 flex-none place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
              aria-label={t("common.close")}
              onClick={close}
            >
              <CloseIcon />
            </button>
          </div>

          <Show when={(props.candidates?.length ?? 0) > 1}>
            <label class="flex flex-none items-center gap-2 border-b border-border px-4 py-2 text-xs">
              <span>{t("discover.sources.choose")}</span>
              <select class="min-w-0 flex-1 rounded-lg bg-surface-2 p-2" disabled={adding()}
                value={selected()?.key}
                onChange={(event) => {
                  const candidate = props.candidates?.find((c) => rememberPicked(c.source, c.item) === event.currentTarget.value);
                  if (candidate) selectSource(candidate);
                }}>
                <For each={props.candidates}>{(candidate) => (
                  <option value={rememberPicked(candidate.source, candidate.item)}>
                    {candidate.source.name}{bookMetaList().some((b) => b.bookSourceId === candidate.source.id && b.bookUrl === candidate.item.bookUrl) ? ` · ${t("discover.online.inShelf")}` : ""}
                  </option>
                )}</For>
              </select>
            </label>
          </Show>
          <ScrollArea class="min-h-0 flex-1">
            <div class="px-[18px] pb-2 pt-2.5">
              {/* 封面 + 基本信息 */}
              <div class="flex gap-3.5">
                {/* 书源返回 cover 时展示真实封面（经书源会话下载）；无封面回退首字渐变占位 */}
                <SourceCover
                  variant="sheet"
                  sourceId={selected()?.source.id ?? ""}
                  url={coverSrc()}
                  referer={info()?.bookUrl}
                  title={hanText(info()?.bookName ?? "")}
                />
                <div class="flex min-w-0 flex-1 flex-col justify-center gap-1">
                  <h2 class="text-[17px] font-bold leading-snug">
                    <QuickSearchText
                      text={hanText(info()?.bookName ?? "")}
                      action={t("discover.quickSearch.title")}
                      iconSize={13}
                      iconClass="mt-[5px]"
                      onSearch={props.onQuickSearch ? quickSearch : undefined}
                    />
                  </h2>
                  <p class="truncate text-[12.5px] text-text-3">
                    <Show
                      when={isFallbackBookAuthor(info()?.author) ? "" : info()?.author?.trim()}
                      fallback={<span>{t("common.anonymousAuthor")}</span>}
                    >
                      {(author) => (
                        <QuickSearchText
                          text={hanText(author())}
                          action={t("discover.quickSearch.author")}
                          textClass="truncate"
                          iconSize={12}
                          iconClass="mt-[3px]"
                          onSearch={props.onQuickSearch ? quickSearch : undefined}
                        />
                      )}
                    </Show>
                  </p>
                  <Show when={info()?.latest}>
                    <p class="truncate text-[12px] text-accent">
                      {t("discover.online.latest", { value: hanText(info()!.latest!) })}
                    </p>
                  </Show>
                  <Show when={info()?.updateTime}>
                    <p class="text-[11px] text-text-3">
                      {t("discover.online.updateTime", {
                        value: info()!.updateTime ?? "",
                      })}
                    </p>
                  </Show>
                  <Show when={displayTags().length > 0}>
                    <div class="mt-0.5 flex flex-wrap gap-1.5">
                      <TagChips
                        tags={displayTags()}
                        onTagClick={props.onQuickSearch ? quickSearch : undefined}
                      />
                    </div>
                  </Show>
                  <Show when={inShelf()}>
                    <p class="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-accent-weak px-2 py-0.5 text-[11px] font-semibold text-accent">
                      <BookIcon size={12} />
                      {t("discover.online.inShelf")}
                    </p>
                  </Show>
                </div>
              </div>

              {/* 简介 */}
              <section class="mt-4">
                <h3 class="mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
                  {t("discover.online.intro")}
                </h3>
                <Show
                  when={info()?.intro}
                  fallback={
                    <Show
                      when={infoBusy()}
                      fallback={
                        <div class="flex min-h-[56px] items-center justify-center rounded-[12px] border border-dashed border-border bg-surface px-4 text-center text-[12px] leading-[1.7] text-text-3">
                          <Show
                            when={infoError()}
                            fallback={t("discover.online.noIntro")}
                          >
                            <span class="text-danger">
                              {t("discover.online.introFailed", {
                                message: infoError(),
                              })}
                            </span>
                          </Show>
                        </div>
                      }
                    >
                      <div class="flex items-center justify-center gap-1.5 py-3 text-[12px] text-text-3">
                        <RefreshIcon size={14} class="animate-spin" />
                        {t("discover.online.introLoading")}
                      </div>
                    </Show>
                  }
                >
                  <p class="whitespace-pre-wrap break-words rounded-[12px] border border-border bg-surface px-3.5 py-3 text-[12.5px] leading-[1.75] text-text-2">
                    {hanText(info()!.intro!)}
                  </p>
                </Show>
              </section>

              <Show when={previewChapter()}>
                <section class="mt-4 rounded-xl border border-border p-3">
                  <h3 class="mb-2 text-sm font-semibold">{hanText(previewChapter()!.chapterName)}</h3>
                  <Show when={contentBusy()}><p class="text-xs text-text-3">{t("common.loading")}</p></Show>
                  <Show when={contentError()}><p class="text-xs text-danger">{contentError()}</p></Show>
                  <div class="max-h-64 overflow-y-auto text-sm leading-relaxed">
                    <For each={previewText()}>{(paragraph) => <p class="mb-2 whitespace-pre-wrap">{hanText(paragraph)}</p>}</For>
                    <Show when={!contentBusy() && !contentError() && !previewText().length}><p>{t("discover.sources.emptyText")}</p></Show>
                  </div>
                </section>
              </Show>

              {/* 目录 */}
              <section class="mt-4">
                <div class="mb-2 flex items-center gap-1.5">
                  <ListIcon size={15} class="flex-none text-text-3" />
                  <h3 class="text-[12.5px] font-medium tracking-[0.04em] text-text-3">
                    {t("discover.online.toc")}
                  </h3>
                  <Show when={tocCount() > 0}>
                    <span class="ml-auto text-[11px] text-text-3">
                      {t("discover.online.tocCount", { count: tocCount() })}
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
                              {t("discover.online.tocLoading")}
                            </div>
                          }
                        >
                          <div class="flex items-center gap-2 rounded-[12px] border border-border bg-surface px-3.5 py-2.5 text-[12px] text-danger">
                            <span class="min-w-0 flex-1">{tocError()}</span>
                            <Show when={!tocUnsupported()}>
                              <button
                                class="flex-none rounded-lg bg-danger-weak px-2.5 py-1 text-[11.5px] font-semibold text-danger active:opacity-80"
                                onClick={() => beginLoad(selected())}
                              >
                                {t("common.retry")}
                              </button>
                            </Show>
                          </div>
                        </Show>
                      }
                    >
                      <div class="flex items-center justify-center gap-1.5 py-3 text-[12px] text-text-3">
                        <RefreshIcon size={14} class="animate-spin" />
                        {t("discover.online.tocFetching")}
                      </div>
                    </Show>
                  }
                >
                  <div class="divide-y divide-border overflow-hidden rounded-[12px] border border-border bg-surface">
                    <For each={visibleChapters()}>
                      {(ch, index) => (
                        <button class="flex w-full items-center gap-2.5 px-3 py-[9px] text-left active:bg-surface-2" disabled={adding()} onClick={() => void previewContent(ch)}>
                          <span class="w-9 flex-none text-right text-[11px] tabular-nums text-text-3">
                            {index() + 1}
                          </span>
                          <span class="min-w-0 flex-1 truncate text-[12.5px] text-text">
                            {hanText(ch.chapterName)}
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={collapsedCount() > 0 && !showAllChapters()}>
                    <button
                      class="mt-2 flex w-full items-center justify-center rounded-[10px] border border-border bg-surface py-2 text-[12px] font-medium text-text-2 active:bg-surface-2"
                      onClick={() => setShowAllChapters(true)}
                    >
                      {t("discover.online.expandChapters", {
                        count: collapsedCount(),
                      })}
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
            <Show when={confirmSwitch() !== null}>
              <div class="mb-3 rounded-xl border border-border p-3" role="alert">
                <p class="text-xs leading-relaxed">{t("discover.sources.confirm")}</p>
                <div class="mt-2 flex gap-3">
                  <button disabled={adding()} onClick={() => setConfirmSwitch(null)}>{t("common.cancel")}</button>
                  <button class="text-accent" disabled={adding()} onClick={() => void addToShelf(confirmSwitch()!, true)}>{t("discover.sources.apply")}</button>
                </div>
              </div>
            </Show>
            <div class="flex items-center gap-2.5">
              <Show when={!inShelf() || switchTarget()}>
                <button
                  class="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-bg px-3 py-[11px] text-[13.5px] font-medium text-text-2 transition-colors active:bg-surface-2 disabled:opacity-50"
                  disabled={adding() || !tocReady()}
                  onClick={() => void addToShelf(false)}
                >
                  {switchTarget() ? t("discover.sources.apply") : t("discover.online.addToShelf")}
                </button>
              </Show>
              <button
                class="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-[11px] text-[13.5px] font-semibold text-on-accent transition-[scale,opacity] duration-100 active:scale-[0.98] active:opacity-90 disabled:opacity-50"
                disabled={adding() || ((!!switchTarget() || !inShelf()) && !tocReady())}
                onClick={() => void addToShelf(true)}
              >
                <Show
                  when={adding()}
                  fallback={
                    switchTarget() ? t("discover.sources.applyAndRead") : inShelf()
                      ? t("discover.online.startReading")
                      : t("discover.online.addAndRead")
                  }
                >
                  <RefreshIcon size={16} class="animate-spin" />
                  {t("discover.online.adding")}
                </Show>
              </button>
            </div>
          </div>
        </Drawer>
      </Portal>
    </Show>
  );
}

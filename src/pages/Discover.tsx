import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import {
  ChevronRightIcon,
  CompassIcon,
  RefreshIcon,
  SearchIcon,
  SourceIcon,
} from "../components/icons";
import {
  bookSourceList,
  bookSourcesReady,
  ensureBookSourcesLoaded,
} from "../lib/bookSources";
import {
  SOURCE_FILTER_ALL,
  SOURCE_FILTER_NONE,
  ensureSourceGroupsLoaded,
  filterSourcesByGroup,
  resolveSourceFilter,
  sourceGroupById,
  sourceGroupList,
} from "../lib/sourceGroups";
import { SourceGroupChips, sourceGroupChips } from "../components/SourceGroupChips";
import { callRemoteSource } from "../lib/backend";
import type { BookItem, BookSourceSummary } from "../lib/bookSourcesTypes";
import { normalizeBookTags } from "../lib/booksTypes";
import { hanText } from "../lib/hanDisplay";
import { rememberPicked, type PickedBook } from "../lib/online";
import { currentSourceParallel, lastSourceGroupFilter, rememberSourceGroupFilter } from "../lib/store";
import { OnlineBookSheet } from "../components/OnlineBookSheet";
import { SourceCover } from "../components/SourceCover";

type Mode = "search" | "discover";

/** 搜索/发现列表最多展示的条数（搜索结果边到边上屏，超出部分丢弃） */
const RESULT_LIMIT = 120;

interface ResultEntry {
  source: BookSourceSummary;
  item: BookItem;
}

/** 把书源返回的裸记录归一化成 BookItem（bookName/bookUrl 必填，其余字段过滤后透传） */
function toItem(raw: unknown): BookItem | null {
  const item = raw as Record<string, unknown> | null;
  if (!item || typeof item.bookName !== "string" || typeof item.bookUrl !== "string") {
    return null;
  }
  const bookName: string = item.bookName;
  const bookUrl: string = item.bookUrl;
  const str = (key: string): string | undefined =>
    typeof item[key] === "string" ? (item[key] as string) : undefined;
  const tags = normalizeBookTags(item.tags);
  return {
    bookName,
    bookUrl,
    author: str("author"),
    cover: str("cover"),
    intro: str("intro"),
    latest: str("latest"),
    updateTime: str("updateTime"),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/** 搜索结果/发现列表共用行 */
function ResultRow(props: { entry: ResultEntry; onClick: () => void }) {
  const { source, item } = props.entry;
  // 简繁转换只作用于展示副本：书源返回的原始数据（含入架落盘的内容）不变
  const name = () => hanText(item.bookName);
  const author = () => (item.author ? hanText(item.author) : "");
  const latest = () => (item.latest ? hanText(item.latest) : "");
  const intro = () => (item.intro ? hanText(item.intro) : "");
  return (
    <button
      class="flex w-full items-center gap-3 px-4 py-2.5 text-left active:bg-surface-2"
      onClick={props.onClick}
    >
      {/* 书源返回 cover 时展示真实封面（经书源会话下载）；无封面回退首字渐变占位 */}
      <SourceCover
        variant="row"
        sourceId={source.id}
        url={item.cover}
        referer={item.bookUrl}
        title={name()}
      />
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="flex items-center gap-1.5">
          <span class="truncate text-[14.5px] font-medium">{name()}</span>
        </span>
        <span class="flex items-center gap-1.5 text-[11px] text-text-3">
          {author() ? <span class="truncate">{author()}</span> : null}
          {latest() ? (
            <>
              <span aria-hidden="true">·</span>
              <span class="truncate text-accent">{latest()}</span>
            </>
          ) : null}
        </span>
        {(intro() || item.updateTime) && (
          <span class="truncate text-[11px] text-text-3/90">
            {item.updateTime ? `${item.updateTime} · ` : ""}
            {intro()}
          </span>
        )}
      </span>
      <span class="flex flex-none flex-col items-end gap-0.5">
        <i class="not-italic block max-w-[110px] truncate rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-semibold text-text-3">
          {source.name}
        </i>
        <ChevronRightIcon size={16} class="text-text-3/70" />
      </span>
    </button>
  );
}

export default function DiscoverPage() {
  const navigate = useNavigate();
  void ensureBookSourcesLoaded();
  void ensureSourceGroupsLoaded();

  const [mode, setMode] = createSignal<Mode>("search");
  const [keyword, setKeyword] = createSignal("");
  const [searching, setSearching] = createSignal(false);
  const [searchDone, setSearchDone] = createSignal(false);
  const [searchProgress, setSearchProgress] = createSignal(0);
  const [searchTotal, setSearchTotal] = createSignal(0);
  const [results, setResults] = createSignal<ResultEntry[]>([]);
  const [errorText, setErrorText] = createSignal("");
  // 点击结果后弹出的在线书详情抽屉（不切路由，保留搜索/发现页状态）
  const [preview, setPreview] = createSignal<PickedBook | null>(null);
  // 外部入口（如详情页点击标签 / 带 ?q= 深链）请求的「快速搜索」词，等待书源就绪后自动执行
  const [pendingQuick, setPendingQuick] = createSignal<string | null>(null);

  // 发现模式
  const [discoverSourceId, setDiscoverSourceId] = createSignal("");
  const [categories, setCategories] = createSignal<{ name: string; url: string }[]>([]);
  const [categoryUrl, setCategoryUrl] = createSignal("");
  const [discResults, setDiscResults] = createSignal<ResultEntry[]>([]);
  const [discPage, setDiscPage] = createSignal(1);
  const [discBusy, setDiscBusy] = createSignal(false);
  const [discError, setDiscError] = createSignal("");

  /** 当前生效的书源分组筛选（与书源管理页共用同一个记忆值；分组被删则回落「全部」） */
  const groupFilter = (): string => resolveSourceFilter(lastSourceGroupFilter());

  /** 参与搜索 / 发现的书源：已启用 + 对应能力 + 落在当前分组内 */
  const searchSources = createMemo(() =>
    filterSourcesByGroup(
      bookSourceList().filter((s) => s.enabled && s.capabilities.search),
      groupFilter(),
    ),
  );

  const discoverSources = createMemo(() =>
    filterSourcesByGroup(
      bookSourceList().filter((s) => s.enabled && s.capabilities.discover),
      groupFilter(),
    ),
  );

  const canSearch = createMemo(() => searchSources().length > 0);

  /** 分组筛选条的数量：按当前模式统计该分组内可用的书源数 */
  const groupChipCounts = createMemo<Record<string, number>>(() => {
    const usable = bookSourceList().filter(
      (s) => s.enabled && (mode() === "search" ? s.capabilities.search : s.capabilities.discover),
    );
    const counts: Record<string, number> = {
      [SOURCE_FILTER_ALL]: usable.length,
      [SOURCE_FILTER_NONE]: 0,
    };
    for (const source of usable) {
      if (!sourceGroupById(source.groupId)) {
        counts[SOURCE_FILTER_NONE] += 1;
        continue;
      }
      counts[source.groupId!] = (counts[source.groupId!] ?? 0) + 1;
    }
    return counts;
  });

  const filterChips = createMemo(() => sourceGroupChips(groupChipCounts(), groupFilter()));

  // 分组筛选把当前发现源排除在外时（切分组 / 该书源被停用）收起其分类与结果，
  // 避免「加载更多」继续向筛选范围外的书源要数据
  createEffect(() => {
    const id = discoverSourceId();
    if (!id || discoverSources().some((source) => source.id === id)) return;
    setDiscoverSourceId("");
    setCategories([]);
    setCategoryUrl("");
    setDiscResults([]);
    setDiscError("");
  });

  /** 分组把可用书源筛空时的说明（与全局没有可用书源区分开） */
  const emptyScopeText = (what: string): string =>
    groupFilter() === SOURCE_FILTER_ALL
      ? `没有${what}的已启用书源`
      : `该分组没有${what}的已启用书源`;

  function openPreview(entry: ResultEntry) {
    // 仍登记会话级 pick，保持与 /online/:key 深链的兼容
    const key = rememberPicked(entry.source, entry.item);
    setPreview({ key, source: entry.source, item: entry.item });
  }

  /**
   * 快速搜索入口（点击标签 / URL 带 ?q= 深链进入时调用）：
   * 切回「搜索」模式并把标签作为关键词，书源就绪后自动执行一次全源搜索。
   */
  function quickSearch(kwRaw: string) {
    const kw = kwRaw.trim();
    if (!kw) return;
    setMode("search");
    setKeyword(kw);
    setSearchDone(false);
    setErrorText("");
    setResults([]);
    setPendingQuick(kw);
  }

  // URL 带 ?q=xxx（如书籍详情页点击标签跳转过来）→ 自动发起快速搜索
  const [searchParams] = useSearchParams();
  createEffect(() => {
    const q = searchParams.q;
    if (typeof q === "string" && q.trim()) quickSearch(q);
  });

  // 快速搜索词在书源就绪前只暂存，就绪后再真正跑搜索（避免源清单为空白搜一场）
  createEffect(() => {
    const kw = pendingQuick();
    if (!kw || !bookSourcesReady()) return;
    setPendingQuick(null);
    if (!canSearch()) return; // 没有支持搜索的已启用书源 → 只预填关键词不空搜
    void onSearch(kw);
  });

  // 搜索请求序号：防止上一次未跑完的搜索在完成时把新搜索的进度/结果覆盖掉
  let searchSeq = 0;

  async function onSearch(rawKw?: string) {
    const kw = (rawKw ?? keyword()).trim();
    if (!kw) return;
    const sources = searchSources();
    const seq = ++searchSeq;
    setSearching(true);
    setSearchDone(false);
    setErrorText("");
    setResults([]);
    setSearchProgress(0);
    setSearchTotal(sources.length);
    const errors: string[] = [];
    let found = 0;
    // 并发运行的书源数取用户设置；固定 worker 池逐源分发，避免一次性压满全部源
    const limit = Math.max(
      1,
      Math.min(8, Math.round(currentSourceParallel())),
    );
    let cursor = 0;
    let doneSources = 0;
    async function runOne(source: BookSourceSummary): Promise<void> {
      const r = await callRemoteSource(source.id, "searchBook", [kw]);
      if (seq !== searchSeq) return; // 已被更新的搜索接管，不再写入本轮结果
      if (r.ok && Array.isArray(r.value)) {
        const batch: ResultEntry[] = [];
        for (const raw of r.value as unknown[]) {
          const item = toItem(raw);
          if (item) batch.push({ source, item });
        }
        if (batch.length > 0) {
          // 该源一出结果就上屏（不等其余书源跑完），列表顺序即书源返回顺序
          found += batch.length;
          setResults((prev) => [...prev, ...batch].slice(0, RESULT_LIMIT));
        }
      } else if (r.error) {
        errors.push(`${source.name}: ${r.error}`);
      }
      doneSources += 1;
      setSearchProgress(doneSources);
    }
    async function worker(): Promise<void> {
      while (cursor < sources.length) {
        const idx = cursor;
        cursor += 1;
        await runOne(sources[idx]);
      }
    }
    const workers = Math.min(limit, sources.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    if (seq !== searchSeq) return; // 已被更新的搜索接管，丢弃本次结果
    setSearching(false);
    setSearchDone(true);
    if (errors.length > 0 && found === 0) {
      setErrorText(errors[0]);
    }
  }

  async function selectDiscoverSource(source: BookSourceSummary) {
    setDiscoverSourceId(source.id);
    setCategories([]);
    setCategoryUrl("");
    setDiscResults([]);
    setDiscError("");
    setDiscBusy(true);
    const r = await callRemoteSource(source.id, "discoverCategories", []);
    if (r.ok && Array.isArray(r.value)) {
      const cats: { name: string; url: string }[] = [];
      for (const raw of r.value as unknown[]) {
        const c = raw as Record<string, unknown>;
        if (typeof c?.name === "string" && typeof c.url === "string") {
          cats.push({ name: c.name, url: c.url });
        }
      }
      setCategories(cats);
      if (cats.length === 0) {
        // 无分类函数/结果 → 直接走默认发现
        await loadDiscoverPage(source, null, 1, true);
      } else {
        await loadDiscoverPage(source, cats[0], 1, true);
      }
    } else {
      // 无 discoverCategories → 直接默认发现
      await loadDiscoverPage(source, null, 1, true);
    }
    setDiscBusy(false);
  }

  async function loadDiscoverPage(
    source: BookSourceSummary,
    category: { name: string; url: string } | null,
    page: number,
    replace: boolean,
  ) {
    if (category) setCategoryUrl(category.url);
    else setCategoryUrl("");
    setDiscBusy(true);
    setDiscError("");
    // 整页替换（重选分类/书源标签）时先清空旧列表，让「加载中…」占位可见
    if (replace) setDiscResults([]);
    const cat = category ?? { name: "", url: categoryUrl() };
    const args = [cat, page];
    const r = await callRemoteSource(source.id, "discoverBooks", args);
    if (r.ok && Array.isArray(r.value)) {
      const list: ResultEntry[] = [];
      for (const raw of r.value as unknown[]) {
        const item = toItem(raw);
        if (item) list.push({ source, item });
      }
      setDiscResults((prev) => (replace ? list : [...prev, ...list]));
      setDiscPage(page);
    } else if (r.error) {
      setDiscError(r.error);
    }
    setDiscBusy(false);
  }

  return (
    <div class="page">
      <PageHeader
        title="发现"
        right={
          <button
            class="grid h-10 w-10 place-items-center rounded-xl text-text-2 transition-[background-color,scale] duration-150 active:scale-[0.94] active:bg-surface-2"
            aria-label="书源管理"
            onClick={() => navigate("/sources")}
          >
            <SourceIcon size={21} />
          </button>
        }
      >
        {/* 模式分段 */}
        <div class="px-[18px] pb-2 pt-0.5">
          <div class="flex gap-0.5 rounded-[10px] bg-surface-2 p-[3px]">
            {(
              [
                { value: "search", label: "搜索" },
                { value: "discover", label: "发现" },
              ] as { value: Mode; label: string }[]
            ).map((opt) => (
              <button
                class="flex-1 rounded-lg py-1.5 text-[13px] text-text-2"
                classList={{
                  "bg-surface font-semibold text-text shadow-sm shadow-black/10":
                    mode() === opt.value,
                }}
                onClick={() => setMode(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </PageHeader>

      <div class="px-[18px] pb-[calc(36px+env(safe-area-inset-bottom))] pt-1">
        <Show
          when={bookSourcesReady()}
          fallback={<p class="py-10 text-center text-[12px] text-text-3">书源加载中…</p>}
        >
          <Show
            when={bookSourceList().some((s) => s.enabled)}
            fallback={
              <div class="flex flex-col items-center gap-2 px-6 py-16 text-center text-text-3">
                <CompassIcon size={46} class="text-text-3/70" />
                <p class="text-[15px] font-semibold text-text-2">没有已启用的书源</p>
                <button
                  class="mt-2 inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-semibold text-on-accent active:scale-[0.97]"
                  onClick={() => navigate("/sources")}
                >
                  去管理书源
                </button>
              </div>
            }
          >
            {/* 分组筛选：在管理页分的组可以直接限定本页搜索 / 发现用的书源 */}
            <Show when={sourceGroupList().length > 0 || groupFilter() !== SOURCE_FILTER_ALL}>
              <div class="mb-1">
                <SourceGroupChips
                  chips={filterChips()}
                  value={groupFilter()}
                  onSelect={(key) => rememberSourceGroupFilter(key)}
                />
              </div>
            </Show>

            <Show when={mode() === "search"}>
              <div class="mb-3 flex items-center gap-2">
                <div class="flex min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2">
                  <SearchIcon size={17} class="flex-none text-text-3" />
                  <input
                    class="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-text-3"
                    placeholder="输入书名 / 作者…"
                    value={keyword()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void onSearch();
                    }}
                    onInput={(e) => setKeyword(e.currentTarget.value)}
                  />
                </div>
                <button
                  class="grid h-[42px] w-[42px] flex-none place-items-center rounded-[10px] bg-accent text-on-accent active:scale-[0.95] disabled:opacity-50"
                  aria-label="搜索"
                  disabled={searching() || !canSearch()}
                  onClick={() => void onSearch()}
                >
                  <SearchIcon size={19} />
                </button>
              </div>
              <Show when={!canSearch()}>
                <p class="pb-2 text-center text-[12px] text-text-3">
                  {emptyScopeText("可搜索")}
                </p>
              </Show>
              <Show when={searching()}>
                <div
                  class="flex items-center justify-center gap-2 text-[12.5px] text-text-3"
                  classList={{ "py-8": results().length === 0, "py-3": results().length > 0 }}
                >
                  <RefreshIcon size={16} class="animate-spin" />
                  正在搜索书源 {searchProgress()} / {searchTotal() || "…"}（并发
                  {currentSourceParallel()}）
                </div>
              </Show>
              <Show when={!searching() && searchDone() && results().length === 0}>
                <p class="py-8 text-center text-[12.5px] text-text-3">
                  {errorText() ? `搜索失败：${errorText()}` : "没有找到结果"}
                </p>
              </Show>
              <Show when={results().length > 0}>
                <div class="overflow-hidden rounded-[14px] border border-border bg-surface">
                  <For each={results()}>
                    {(entry) => (
                      <ResultRow entry={entry} onClick={() => openPreview(entry)} />
                    )}
                  </For>
                </div>
                <p class="mt-2 text-center text-[11px] text-text-3">
                  {searching()
                    ? `已找到 ${results().length} 条 · 仍在搜索其他书源…`
                    : `${results().length} 条结果 · 点击查看详情并加入书架`}
                </p>
              </Show>
            </Show>

            <Show when={mode() === "discover"}>
              <Show when={discoverSources().length === 0}>
                <p class="py-8 text-center text-[12.5px] text-text-3">
                  {emptyScopeText("支持「发现」")}
                </p>
              </Show>
              <Show when={discoverSources().length > 0}>
                <div class="mb-2.5 flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                  {discoverSources().map((s) => (
                    <button
                      class="shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-medium"
                      classList={{
                        "border-accent bg-accent-weak text-accent":
                          discoverSourceId() === s.id,
                        "border-border bg-surface text-text-2": discoverSourceId() !== s.id,
                      }}
                      onClick={() => void selectDiscoverSource(s)}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
                <Show when={categories().length > 1}>
                  <div class="mb-2 flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                    {categories().map((c) => (
                      <button
                        class="shrink-0 rounded-full px-3 py-1 text-[12px]"
                        classList={{
                          "bg-text text-bg": categoryUrl() === c.url,
                          "bg-surface-2 text-text-2": categoryUrl() !== c.url,
                        }}
                        onClick={() => {
                          const source = bookSourceList().find(
                            (x) => x.id === discoverSourceId(),
                          );
                          if (source) void loadDiscoverPage(source, c, 1, true);
                        }}
                      >
                        {hanText(c.name)}
                      </button>
                    ))}
                  </div>
                </Show>
                <Show when={discBusy() && discResults().length === 0}>
                  <div class="flex items-center justify-center gap-2 py-8 text-[12.5px] text-text-3">
                    <RefreshIcon size={16} class="animate-spin" />
                    加载中…
                  </div>
                </Show>
                <Show when={discError()}>
                  <p class="mb-2 rounded-[10px] bg-danger-weak px-3 py-2 text-[12px] text-danger">
                    {discError()}
                  </p>
                </Show>
                <Show when={discResults().length > 0}>
                  <div class="overflow-hidden rounded-[14px] border border-border bg-surface">
                    <For each={discResults()}>
                      {(entry) => (
                        <ResultRow entry={entry} onClick={() => openPreview(entry)} />
                      )}
                    </For>
                  </div>
                  <button
                    class="mt-2.5 flex w-full items-center justify-center gap-1 rounded-[12px] border border-border bg-surface py-2.5 text-[13px] font-semibold text-text-2 active:bg-surface-2 disabled:opacity-50"
                    disabled={discBusy()}
                    onClick={() => {
                      const source = bookSourceList().find(
                        (x) => x.id === discoverSourceId(),
                      );
                      if (!source) return;
                      const cat = categories().find((c) => c.url === categoryUrl()) ?? null;
                      void loadDiscoverPage(source, cat, discPage() + 1, false);
                    }}
                  >
                    加载更多
                  </button>
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>

      {/* 在线书详情抽屉：点击结果行弹出，不离开本页（保留搜索词 / 结果 / 滚动状态） */}
      <OnlineBookSheet
        pick={preview()}
        onClose={() => setPreview(null)}
        onTagSearch={(tag) => {
          // 点标签 → 收起抽屉并按该标签快速搜索
          setPreview(null);
          quickSearch(tag);
        }}
      />
    </div>
  );
}

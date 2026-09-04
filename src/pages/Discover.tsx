import { createMemo, createSignal, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
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
import { callRemoteSource } from "../lib/backend";
import type { BookItem, BookSourceSummary } from "../lib/bookSourcesTypes";
import { rememberPicked } from "../lib/online";
import { currentSourceParallel } from "../lib/store";

type Mode = "search" | "discover";

interface ResultEntry {
  source: BookSourceSummary;
  item: BookItem;
}

function hueOf(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** 搜索结果/发现列表共用行 */
function ResultRow(props: { entry: ResultEntry; onClick: () => void }) {
  const { source, item } = props.entry;
  return (
    <button
      class="flex w-full items-center gap-3 px-4 py-2.5 text-left active:bg-surface-2"
      onClick={props.onClick}
    >
      <span
        class="grid h-[52px] w-[40px] flex-none place-items-center rounded-[8px] text-[20px] font-bold text-white shadow-inner"
        style={{
          background: `linear-gradient(165deg, hsl(${hueOf(item.bookName)} 58% 52%), hsl(${(hueOf(item.bookName) + 24) % 360} 62% 34%))`,
        }}
      >
        {item.bookName.charAt(0)}
      </span>
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="flex items-center gap-1.5">
          <span class="truncate text-[14.5px] font-medium">{item.bookName}</span>
        </span>
        <span class="flex items-center gap-1.5 text-[11px] text-text-3">
          {item.author ? <span class="truncate">{item.author}</span> : null}
          {item.latest ? (
            <>
              <span aria-hidden="true">·</span>
              <span class="truncate text-accent">{item.latest}</span>
            </>
          ) : null}
        </span>
        {(item.intro || item.updateTime) && (
          <span class="truncate text-[11px] text-text-3/90">
            {item.updateTime ? `${item.updateTime} · ` : ""}
            {item.intro}
          </span>
        )}
      </span>
      <span class="flex flex-none flex-col items-end gap-0.5">
        <i class="not-italic rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-semibold text-text-3">
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

  const [mode, setMode] = createSignal<Mode>("search");
  const [keyword, setKeyword] = createSignal("");
  const [searching, setSearching] = createSignal(false);
  const [searchDone, setSearchDone] = createSignal(false);
  const [searchProgress, setSearchProgress] = createSignal(0);
  const [searchTotal, setSearchTotal] = createSignal(0);
  const [results, setResults] = createSignal<ResultEntry[]>([]);
  const [errorText, setErrorText] = createSignal("");

  // 发现模式
  const [discoverSourceId, setDiscoverSourceId] = createSignal("");
  const [categories, setCategories] = createSignal<{ name: string; url: string }[]>([]);
  const [categoryUrl, setCategoryUrl] = createSignal("");
  const [discResults, setDiscResults] = createSignal<ResultEntry[]>([]);
  const [discPage, setDiscPage] = createSignal(1);
  const [discBusy, setDiscBusy] = createSignal(false);
  const [discError, setDiscError] = createSignal("");

  const discoverSources = createMemo(() =>
    bookSourceList().filter((s) => s.enabled && s.capabilities.discover),
  );

  const canSearch = createMemo(
    () => bookSourceList().filter((s) => s.enabled && s.capabilities.search).length > 0,
  );

  function goOnline(entry: ResultEntry) {
    const key = rememberPicked(entry.source, entry.item);
    navigate(`/online/${key}`);
  }

  async function onSearch() {
    const kw = keyword().trim();
    if (!kw) return;
    const sources = bookSourceList().filter((s) => s.enabled && s.capabilities.search);
    setSearching(true);
    setSearchDone(false);
    setErrorText("");
    setSearchProgress(0);
    setSearchTotal(sources.length);
    const out: ResultEntry[] = [];
    const errors: string[] = [];
    // 并发运行的书源数取用户设置；固定 worker 池逐源分发，避免一次性压满全部源
    const limit = Math.max(
      1,
      Math.min(8, Math.round(currentSourceParallel())),
    );
    let cursor = 0;
    let doneSources = 0;
    async function runOne(source: BookSourceSummary): Promise<void> {
      const r = await callRemoteSource(source.id, "searchBook", [kw]);
      if (r.ok && Array.isArray(r.value)) {
        for (const raw of r.value as unknown[]) {
          const item = raw as Record<string, unknown>;
          if (
            typeof item?.bookName === "string" &&
            typeof item.bookUrl === "string"
          ) {
            out.push({
              source,
              item: {
                bookName: item.bookName,
                author: typeof item.author === "string" ? item.author : undefined,
                cover: typeof item.cover === "string" ? item.cover : undefined,
                intro: typeof item.intro === "string" ? item.intro : undefined,
                latest: typeof item.latest === "string" ? item.latest : undefined,
                updateTime:
                  typeof item.updateTime === "string" ? item.updateTime : undefined,
                bookUrl: item.bookUrl,
              },
            });
          }
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
    out.sort((a, b) => a.source.name.localeCompare(b.source.name, "zh"));
    setResults(out.slice(0, 120));
    setSearching(false);
    setSearchDone(true);
    if (errors.length > 0 && out.length === 0) {
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
    const cat = category ?? { name: "", url: categoryUrl() };
    const args = [cat, page];
    const r = await callRemoteSource(source.id, "discoverBooks", args);
    if (r.ok && Array.isArray(r.value)) {
      const list: ResultEntry[] = [];
      for (const raw of r.value as unknown[]) {
        const item = raw as Record<string, unknown>;
        if (typeof item?.bookName === "string" && typeof item.bookUrl === "string") {
          list.push({
            source,
            item: {
              bookName: item.bookName,
              author: typeof item.author === "string" ? item.author : undefined,
              cover: typeof item.cover === "string" ? item.cover : undefined,
              intro: typeof item.intro === "string" ? item.intro : undefined,
              latest: typeof item.latest === "string" ? item.latest : undefined,
              updateTime: typeof item.updateTime === "string" ? item.updateTime : undefined,
              bookUrl: item.bookUrl,
            },
          });
        }
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
              <Show when={searching()}>
                <div class="flex items-center justify-center gap-2 py-8 text-[12.5px] text-text-3">
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
              <Show when={!searching() && results().length > 0}>
                <div class="overflow-hidden rounded-[14px] border border-border bg-surface">
                  <For each={results()}>
                    {(entry) => (
                      <ResultRow entry={entry} onClick={() => goOnline(entry)} />
                    )}
                  </For>
                </div>
                <p class="mt-2 text-center text-[11px] text-text-3">
                  {results().length} 条结果 · 点击查看详情并加入书架
                </p>
              </Show>
            </Show>

            <Show when={mode() === "discover"}>
              <Show when={discoverSources().length === 0}>
                <p class="py-8 text-center text-[12.5px] text-text-3">
                  没有支持「发现」的已启用书源
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
                        {c.name}
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
                        <ResultRow entry={entry} onClick={() => goOnline(entry)} />
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
    </div>
  );
}

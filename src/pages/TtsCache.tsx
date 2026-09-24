import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import { HeadphonesIcon, TrashIcon } from "../components/icons";
import {
  applyTtsAudioCacheLimit,
  clearTtsAudioCache,
  loadTtsAudioCaches,
  type TtsCacheOverview,
} from "../lib/audioCache";
import { ensureLocalBooksLoaded, bookMetaById } from "../lib/books";
import { hanText } from "../lib/hanDisplay";
import {
  currentTtsCacheLimit,
  setTtsCacheLimit,
  TTS_CACHE_LIMIT_PRESETS,
  TTS_CACHE_LIMIT_UNLIMITED,
} from "../lib/store";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 额度档位的展示文案（0 = 不限） */
function limitLabel(limit: number): string {
  return limit === TTS_CACHE_LIMIT_UNLIMITED ? "不限" : `${limit} 段`;
}

export default function TtsCachePage() {
  const navigate = useNavigate();
  const [overview, setOverview] = createSignal<TtsCacheOverview | null>(null);
  const [cacheBusy, setCacheBusy] = createSignal(false);
  const [clearAllConfirming, setClearAllConfirming] = createSignal(false);
  let timer: number | undefined;

  onCleanup(() => {
    window.clearTimeout(timer);
  });

  async function refreshTtsCaches() {
    await ensureLocalBooksLoaded();
    const next = await loadTtsAudioCaches();
    setOverview(next);
    // 以后端回传的上限为准（改了状态文件、或换了版本时前端可能落后）。
    // setTtsCacheLimit 是幂等的：值相同就只 resolve、不写盘。
    await setTtsCacheLimit(next.limit);
  }

  createEffect(() => {
    void refreshTtsCaches();
  });

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/settings");
  }

  /** 换额度：先落盘新值，再让后端按它立即收敛（下调时马上释放磁盘） */
  async function chooseLimit(limit: number) {
    if (cacheBusy() || limit === currentTtsCacheLimit()) return;
    setCacheBusy(true);
    try {
      // 必须等新额度落盘，后端才读得到它
      await setTtsCacheLimit(limit);
      await applyTtsAudioCacheLimit();
      await refreshTtsCaches();
    } finally {
      setCacheBusy(false);
    }
  }

  async function clearOneBook(bookId: string) {
    if (cacheBusy()) return;
    setCacheBusy(true);
    try {
      await clearTtsAudioCache(bookId);
      await refreshTtsCaches();
    } finally {
      setCacheBusy(false);
    }
  }

  function onClearAllTts() {
    if (cacheBusy()) return;
    if (!clearAllConfirming()) {
      setClearAllConfirming(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setClearAllConfirming(false), 3000);
      return;
    }
    window.clearTimeout(timer);
    setClearAllConfirming(false);
    setCacheBusy(true);
    void clearTtsAudioCache()
      .then(() => refreshTtsCaches())
      .finally(() => setCacheBusy(false));
  }

  const bookTitle = (id: string) => hanText(bookMetaById(id)?.title || id);

  return (
    <div class="page">
      <PageHeader
        title="听书缓存"
        subtitle="本机合成音频"
        onBack={goBack}
      />

      <div class="px-[18px] pb-[calc(36px+env(safe-area-inset-bottom))] pt-2">
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            每本书额度
          </h2>
          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <div class="px-4 py-[13px]">
              <div class="mb-2.5 flex gap-2">
                <For each={TTS_CACHE_LIMIT_PRESETS}>
                  {(preset) => (
                    <button
                      class="flex-1 select-none rounded-full px-3 py-[7px] text-[13px] touch-manipulation transition-colors duration-150 disabled:opacity-40"
                      classList={{
                        "bg-accent font-semibold text-on-accent":
                          currentTtsCacheLimit() === preset,
                        "border border-border bg-surface text-text-2":
                          currentTtsCacheLimit() !== preset,
                      }}
                      disabled={cacheBusy()}
                      onClick={() => void chooseLimit(preset)}
                    >
                      {limitLabel(preset)}
                    </button>
                  )}
                </For>
              </div>
              <p class="text-[11.5px] leading-[1.6] text-text-3">
                额度是每本书各自的上限，写满后写入新音频会淘汰最旧的；选「不限」则一直保留
              </p>
            </div>
          </div>
        </section>

        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            缓存书籍
          </h2>
          <p class="mx-1 mb-2 text-[11.5px] leading-[1.6] text-text-3">
            自定义源合成好的音频按书籍保存在本机，同一本书、同一声源再次朗读时直接使用缓存；删除书籍时缓存会自动清理
          </p>
          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <Show
              when={(overview()?.books ?? []).length > 0}
              fallback={
                <div class="px-4 py-3 text-[12.5px] text-text-3">
                  暂无听书缓存
                </div>
              }
            >
              <For each={overview()?.books ?? []}>
                {(cache) => (
                  <button
                    class="flex w-full items-center gap-3 px-4 py-[13px] text-left transition-colors duration-150 active:bg-surface-2 disabled:opacity-40"
                    disabled={cacheBusy()}
                    onClick={() => void clearOneBook(cache.bookId)}
                  >
                    <span
                      class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-surface-2 text-text-2"
                      aria-hidden="true"
                    >
                      <HeadphonesIcon size={18} />
                    </span>
                    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span class="truncate text-[14px] font-medium">
                        {bookTitle(cache.bookId)}
                      </span>
                      <span class="text-[11.5px] text-text-3">
                        {currentTtsCacheLimit() === TTS_CACHE_LIMIT_UNLIMITED
                          ? `${cache.files} 段 · ${formatBytes(cache.bytes)}`
                          : `${cache.files} / ${currentTtsCacheLimit()} 段 · ${formatBytes(cache.bytes)}`}
                      </span>
                    </span>
                    <span class="flex-none text-danger">清除</span>
                  </button>
                )}
              </For>
            </Show>
            <button
              class="flex w-full items-center gap-3 px-4 py-[13px] text-left text-danger transition-colors duration-150 active:bg-surface-2 disabled:opacity-40"
              disabled={cacheBusy()}
              onClick={onClearAllTts}
            >
              <span
                class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-danger-weak text-danger"
                aria-hidden="true"
              >
                <TrashIcon size={18} />
              </span>
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">
                  {clearAllConfirming()
                    ? "再点一次确认清空"
                    : "清空全部听书缓存"}
                </span>
                <span class="text-[11.5px] text-text-3">
                  删除所有书籍的合成音频，之后重新朗读会再次合成
                </span>
              </span>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

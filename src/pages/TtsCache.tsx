import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { PageHeader } from "../components/PageHeader";
import { HeadphonesIcon, TrashIcon } from "../components/icons";
import {
  clearTtsAudioCache,
  listTtsAudioCaches,
  type TtsCacheStat,
} from "../lib/audioCache";
import { ensureLocalBooksLoaded, localBookById } from "../lib/books";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function TtsCachePage() {
  const navigate = useNavigate();
  const [ttsCaches, setTtsCaches] = createSignal<TtsCacheStat[] | null>(null);
  const [cacheBusy, setCacheBusy] = createSignal(false);
  const [clearAllConfirming, setClearAllConfirming] = createSignal(false);
  let timer: number | undefined;

  onCleanup(() => {
    window.clearTimeout(timer);
  });

  async function refreshTtsCaches() {
    await ensureLocalBooksLoaded();
    const stats = await listTtsAudioCaches();
    setTtsCaches(stats);
  }

  createEffect(() => {
    void refreshTtsCaches();
  });

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/settings");
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

  const bookTitle = (id: string) => localBookById(id)?.title || id;

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
            缓存书籍
          </h2>
          <p class="mx-1 mb-2 text-[11.5px] leading-[1.6] text-text-3">
            自定义源合成好的音频按书籍保存在本机，同一本书、同一声源再次朗读时直接使用缓存；删除书籍时缓存会自动清理
          </p>
          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <Show
              when={(ttsCaches() ?? []).length > 0}
              fallback={
                <div class="px-4 py-3 text-[12.5px] text-text-3">
                  暂无听书缓存
                </div>
              }
            >
              <For each={ttsCaches() ?? []}>
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
                        {cache.files} 段 · {formatBytes(cache.bytes)}
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

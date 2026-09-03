import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  BookOpenIcon,
  ChevronRightIcon,
  GitHubIcon,
  RegexIcon,
  TrashIcon,
} from "../components/icons";
import { PageHeader } from "../components/PageHeader";
import { GroupManager } from "../components/GroupManager";
import { clearTtsAudioCache, listTtsAudioCaches, type TtsCacheStat } from "../lib/audioCache";
import { ensureLocalBooksLoaded, localBookById } from "../lib/books";
import {
  FONT_MAX,
  FONT_MIN,
  PARA_SPACING_MAX,
  PARA_SPACING_MIN,
  PARA_SPACING_STEP,
  currentFontSize,
  currentPageMode,
  currentParaSpacing,
  currentTheme,
  resetReadingProgress,
  setFontSize,
  setPageMode,
  setParaSpacing,
  setTheme,
  type PageMode,
  type ThemeMode,
} from "../lib/store";
import { initGroups } from "../lib/groups";
import { appVersion, loadAppVersion } from "../lib/version";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "sepia", label: "护眼" },
];

const PAGE_MODE_OPTIONS: { value: PageMode; label: string }[] = [
  { value: "paged", label: "左右翻页" },
  { value: "scroll", label: "上下滚动" },
];

const GITHUB_URL = "https://github.com/zilorn/readerx";

async function openGitHub() {
  if (isTauri()) {
    await openUrl(GITHUB_URL);
  } else {
    window.open(GITHUB_URL, "_blank", "noopener,noreferrer");
  }
}

function Row(props: {
  icon?: JSX.Element;
  label: string;
  desc?: string;
  danger?: boolean;
  onClick?: () => void;
  children?: JSX.Element;
}) {
  const iconClass = props.danger
    ? "bg-danger-weak text-danger"
    : "bg-surface-2 text-text-2";
  return (
    <button
      class="flex w-full items-center gap-3 px-4 py-[13px] text-left transition-colors duration-150 active:bg-surface-2"
      classList={{ "text-danger": props.danger }}
      onClick={props.onClick}
    >
      {props.icon && (
        <span
          class={`grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] ${iconClass}`}
          aria-hidden="true"
        >
          {props.icon}
        </span>
      )}
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-[14.5px] font-medium">{props.label}</span>
        {props.desc && (
          <span class="text-[11.5px] text-text-3">{props.desc}</span>
        )}
      </span>
      {props.children}
    </button>
  );
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const [resetConfirming, setResetConfirming] = createSignal(false);
  let timer: number | undefined;

  onCleanup(() => {
    window.clearTimeout(timer);
  });

  createEffect(() => {
    void initGroups();
    void loadAppVersion();
  });

  function onResetProgress() {
    if (!resetConfirming()) {
      setResetConfirming(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setResetConfirming(false), 3000);
      return;
    }
    window.clearTimeout(timer);
    setResetConfirming(false);
    resetReadingProgress();
  }

  // ---- 听书缓存管理 ----
  const [ttsCaches, setTtsCaches] = createSignal<TtsCacheStat[] | null>(null);
  const [cacheBusy, setCacheBusy] = createSignal(false);
  const [clearAllConfirming, setClearAllConfirming] = createSignal(false);

  async function refreshTtsCaches() {
    await ensureLocalBooksLoaded();
    const stats = await listTtsAudioCaches();
    setTtsCaches(stats);
  }

  createEffect(() => {
    void refreshTtsCaches();
  });

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
      <PageHeader title="设置" />

      <div class="px-[18px] pb-[calc(36px+env(safe-area-inset-bottom))] pt-2">
        {/* 外观 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            外观
          </h2>
          <div class="overflow-hidden rounded-[14px] border border-border bg-surface">
            <div class="flex w-full cursor-default items-center gap-3 px-4 py-[13px] text-left">
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">主题</span>
              </span>
              <div
                class="flex flex-none gap-0.5 rounded-[10px] bg-surface-2 p-[3px]"
                role="radiogroup"
                aria-label="主题"
              >
                {THEME_OPTIONS.map((opt) => (
                  <button
                    role="radio"
                    aria-checked={currentTheme() === opt.value}
                    class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-[11px] py-[7px] text-[12.5px] text-text-2 transition-all duration-150"
                    classList={{
                      "bg-surface font-semibold text-text shadow-sm shadow-black/15":
                        currentTheme() === opt.value,
                    }}
                    onClick={() => setTheme(opt.value)}
                  >
                    <i
                      class="size-[9px] flex-none rounded-full border border-black/30"
                      style={{
                        background:
                          opt.value === "light"
                            ? "var(--dot-light)"
                            : opt.value === "dark"
                              ? "var(--dot-dark)"
                              : "var(--dot-sepia)",
                      }}
                    />
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* 阅读 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            阅读
          </h2>
          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <div class="flex w-full cursor-default items-center gap-3 px-4 py-[13px] text-left">
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">正文字号</span>
              </span>
              <div class="flex flex-none items-center gap-2.5">
                <button
                  class="grid h-[34px] w-[34px] place-items-center rounded-lg border border-border text-[13px] font-bold text-text-2 disabled:opacity-35"
                  aria-label="减小正文字号"
                  disabled={currentFontSize() <= FONT_MIN}
                  onClick={() => setFontSize(currentFontSize() - 1)}
                >
                  A−
                </button>
                <span class="min-w-[46px] text-center text-[13.5px] font-semibold tabular-nums">
                  {currentFontSize()}px
                </span>
                <button
                  class="grid h-[34px] w-[34px] place-items-center rounded-lg border border-border text-[13px] font-bold text-text-2 disabled:opacity-35"
                  aria-label="增大正文字号"
                  disabled={currentFontSize() >= FONT_MAX}
                  onClick={() => setFontSize(currentFontSize() + 1)}
                >
                  A+
                </button>
              </div>
            </div>
            <div class="flex w-full cursor-default items-center gap-3 px-4 py-[13px] text-left">
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">段落间距</span>
                <span class="text-[11.5px] text-text-3">正文段落之间的留白</span>
              </span>
              <div class="flex flex-none items-center gap-3">
                <span class="min-w-[42px] text-right text-[13px] font-semibold tabular-nums">
                  {currentParaSpacing().toFixed(2)}
                </span>
                <input
                  type="range"
                  class="accent-accent"
                  min={PARA_SPACING_MIN}
                  max={PARA_SPACING_MAX}
                  step={PARA_SPACING_STEP}
                  value={currentParaSpacing()}
                  aria-label="段落间距"
                  onInput={(e) => setParaSpacing(Number(e.currentTarget.value))}
                />
              </div>
            </div>
            <div class="flex w-full cursor-default items-center gap-3 px-4 py-[13px] text-left">
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">翻页方式</span>
              </span>
              <div
                class="flex flex-none gap-0.5 rounded-[10px] bg-surface-2 p-[3px]"
                role="radiogroup"
                aria-label="翻页方式"
              >
                {PAGE_MODE_OPTIONS.map((opt) => (
                  <button
                    role="radio"
                    aria-checked={currentPageMode() === opt.value}
                    class="inline-flex items-center whitespace-nowrap rounded-lg px-[11px] py-[7px] text-[12.5px] text-text-2 transition-all duration-150"
                    classList={{
                      "bg-surface font-semibold text-text shadow-sm shadow-black/15":
                        currentPageMode() === opt.value,
                    }}
                    onClick={() => setPageMode(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* 听书缓存 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            听书缓存
          </h2>
          <p class="mx-1 mb-2 text-[11.5px] leading-[1.6] text-text-3">
            自定义源合成好的音频按书籍保存在本机，同一本书、同一声源再次朗读时直接使用缓存，不再请求服务端合成；删除书籍时缓存会自动清理
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
            <Row
              icon={<TrashIcon size={18} />}
              label={clearAllConfirming() ? "再点一次确认清空" : "清空全部听书缓存"}
              desc="删除所有书籍的合成音频，之后重新朗读会再次合成"
              danger
              onClick={onClearAllTts}
            />
          </div>
        </section>

        {/* 导入 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            导入
          </h2>
          <div class="overflow-hidden rounded-[14px] border border-border bg-surface">
            <Row
              icon={<RegexIcon size={18} />}
              label="分章规则"
              desc="管理导入 TXT 时的自动分章"
              onClick={() => navigate("/chapter-rules")}
            >
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </Row>
          </div>
        </section>

        {/* 书架分组 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            书架分组
          </h2>
          <p class="mx-1 mb-2 text-[11.5px] leading-[1.6] text-text-3">
            本地书都可归入分组，在书架顶部按分组筛选
          </p>
          <GroupManager />
        </section>

        {/* 数据 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            数据
          </h2>
          <div class="overflow-hidden rounded-[14px] border border-border bg-surface">
            <Row
              icon={<TrashIcon size={18} />}
              label={resetConfirming() ? "再点一次确认重置" : "重置全部阅读进度"}
              desc="所有书籍回到第 1 章，本地书籍文件不会删除"
              danger
              onClick={onResetProgress}
            />
          </div>
        </section>

        {/* 关于 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            关于
          </h2>
          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <div class="flex items-center gap-[13px] p-4">
              <span class="grid h-[42px] w-[42px] flex-none place-items-center rounded-[12px] bg-[linear-gradient(150deg,var(--accent),color-mix(in_srgb,var(--accent)_55%,var(--accent-deep)))] text-on-accent shadow-lg shadow-accent/30">
                <BookOpenIcon size={22} />
              </span>
              <span class="flex flex-col gap-0.5">
                <strong class="text-[16px] font-bold tracking-[0.03em]">ReaderX</strong>
                <span class="text-[11.5px] text-text-3">本地电子书阅读器</span>
              </span>
              <span class="ml-auto text-xs text-text-3">v{appVersion()}</span>
            </div>
            <Row
              icon={<GitHubIcon size={18} />}
              label="GitHub 主页"
              desc="查看源码与发布动态"
              onClick={() => void openGitHub()}
            >
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </Row>
            <Row label="开源许可" desc="MIT License">
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </Row>
          </div>
        </section>

        <p class="-mt-2 mb-2.5 text-center text-[11px] text-text-3">
          ReaderX {appVersion()} · 基于 Tauri 2 构建
        </p>
      </div>
    </div>
  );
}

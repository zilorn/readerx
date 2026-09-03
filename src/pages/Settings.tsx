import { Show, createEffect, createSignal, on, onCleanup, type JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  BookOpenIcon,
  ChevronRightIcon,
  LinkIcon,
  RegexIcon,
  TrashIcon,
} from "../components/icons";
import { PageHeader } from "../components/PageHeader";
import { GroupManager } from "../components/GroupManager";
import {
  FONT_MAX,
  FONT_MIN,
  PARA_SPACING_MAX,
  PARA_SPACING_MIN,
  PARA_SPACING_STEP,
  currentFontSize,
  currentParaSpacing,
  currentTheme,
  resetReadingProgress,
  setFontSize,
  setParaSpacing,
  setTheme,
  type ThemeMode,
} from "../lib/store";
import {
  clearTransbookUrl,
  currentTransbookUrl,
  initTransbookConfig,
  saveTransbookUrl,
  transbookReady,
} from "../lib/transbook";
import { initGroups } from "../lib/groups";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "sepia", label: "护眼" },
];

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
  const [urlInput, setUrlInput] = createSignal("");
  const [savingUrl, setSavingUrl] = createSignal(false);
  const [urlMsg, setUrlMsg] = createSignal<string | null>(null);
  let timer: number | undefined;
  let urlTimer: number | undefined;

  onCleanup(() => {
    window.clearTimeout(timer);
    window.clearTimeout(urlTimer);
  });

  createEffect(() => {
    void initTransbookConfig();
  });

  createEffect(() => {
    void initGroups();
  });

  createEffect(
    on(transbookReady, (ready) => {
      if (ready) setUrlInput(currentTransbookUrl());
    }),
  );

  async function onSaveBookSource() {
    setSavingUrl(true);
    setUrlMsg(null);
    try {
      await saveTransbookUrl(urlInput());
      setUrlMsg("已保存并连接");
    } catch {
      setUrlMsg("保存失败，请重试");
    } finally {
      setSavingUrl(false);
      window.clearTimeout(urlTimer);
      urlTimer = window.setTimeout(() => setUrlMsg(null), 2600);
    }
  }

  async function onClearBookSource() {
    await clearTransbookUrl();
    setUrlInput("");
    setUrlMsg("已清除连接");
    window.clearTimeout(urlTimer);
    urlTimer = window.setTimeout(() => setUrlMsg(null), 2600);
  }

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
              <span class="flex-none text-[13px] text-text-3">上下滚动</span>
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </div>
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

        {/* 书源 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            书源
          </h2>
          <div class="overflow-hidden rounded-[14px] border border-border bg-surface">
            <div class="px-4 py-[13px]">
              <div class="flex items-center gap-3">
                <span class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-surface-2 text-text-2">
                  <LinkIcon size={18} />
                </span>
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="text-[14.5px] font-medium">TransBook 服务器</span>
                  <span class="text-[11.5px] text-text-3">
                    连接后可浏览远程书架与书籍
                  </span>
                </span>
                <Show when={currentTransbookUrl()}>
                  <span class="flex-none rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                    已连接
                  </span>
                </Show>
              </div>
              <input
                type="url"
                placeholder="http://192.168.0.104:8300"
                value={urlInput()}
                onInput={(e) => setUrlInput(e.currentTarget.value)}
                class="mt-3 w-full rounded-[10px] border border-border bg-bg px-3 py-[9px] text-[14px] text-text outline-none transition-colors placeholder:text-text-3 focus:border-accent"
                aria-label="TransBook 服务器地址"
              />
              <div class="mt-2.5 flex items-center gap-2">
                <button
                  class="inline-flex h-[38px] flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-accent px-3 text-[13.5px] font-semibold text-on-accent transition-[scale,opacity] duration-100 active:scale-[0.97] active:opacity-90 disabled:opacity-50"
                  disabled={savingUrl()}
                  onClick={() => void onSaveBookSource()}
                >
                  <LinkIcon size={16} />
                  保存
                </button>
                <button
                  class="inline-flex h-[38px] items-center justify-center rounded-[10px] border border-border bg-surface px-3 text-[13.5px] text-text-2 transition-colors active:bg-surface-2"
                  onClick={() => void onClearBookSource()}
                >
                  清除
                </button>
              </div>
              <Show when={urlMsg()}>
                <p class="mt-2 text-[11.5px] text-text-3">{urlMsg()}</p>
              </Show>
            </div>
          </div>
        </section>

        {/* 书架分组 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            书架分组
          </h2>
          <p class="mx-1 mb-2 text-[11.5px] leading-[1.6] text-text-3">
            本地书与云端书都可归入分组，在书架顶部按分组筛选
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
              <span class="ml-auto text-xs text-text-3">v0.2.0</span>
            </div>
            <Row label="技术栈" desc="Tauri 2 · SolidJS · TypeScript · Vite">
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </Row>
            <Row label="开源许可" desc="MIT License">
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </Row>
          </div>
        </section>

        <p class="-mt-2 mb-2.5 text-center text-[11px] text-text-3">
          ReaderX 0.2.0 · 基于 Tauri 2 构建
        </p>
      </div>
    </div>
  );
}

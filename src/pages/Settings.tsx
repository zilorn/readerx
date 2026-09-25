import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { openExternal } from "../lib/external";
import {
  BookOpenIcon,
  ChevronRightIcon,
  FileTextIcon,
  GitHubIcon,
  HeadphonesIcon,
  LibraryIcon,
  PackageIcon,
  RegexIcon,
  SourceIcon,
  TerminalIcon,
  TrashIcon,
} from "../components/icons";
import { PageHeader } from "../components/PageHeader";
import { LicenseSheet } from "../components/LicenseSheet";
import { LogSheet } from "../components/LogSheet";
import { ThirdPartyNoticesSheet } from "../components/ThirdPartyNoticesSheet";
import { ToggleSwitch } from "../components/ToggleSwitch";
import { openDevTools } from "../lib/backend";
import { isDesktopPlatform } from "../lib/platform";
import {
  SOURCE_PARALLEL_MAX,
  SOURCE_PARALLEL_MIN,
  currentSourceParallel,
  currentTheme,
  resetReadingProgress,
  setSourceParallel,
  setShelfSourceFilterEnabled,
  setTheme,
  shelfSourceFilterEnabled,
  type ThemeMode,
} from "../lib/store";
import { appVersion, loadAppVersion } from "../lib/version";
import { t, type MessageKey } from "../lib/i18n";
import { ReadingSettingsRows } from "../components/ReadingSettingsRows";
import { LanguageRow } from "../components/LanguageRow";

const THEME_OPTIONS: { value: ThemeMode; labelKey: MessageKey }[] = [
  { value: "light", labelKey: "settings.theme.light" },
  { value: "dark", labelKey: "settings.theme.dark" },
  { value: "sepia", labelKey: "settings.theme.sepia" },
];

const GITHUB_URL = "https://github.com/zilorn/readerx";

async function openGitHub() {
  await openExternal(GITHUB_URL);
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
  const [licenseOpen, setLicenseOpen] = createSignal(false);
  const [noticesOpen, setNoticesOpen] = createSignal(false);
  const [logOpen, setLogOpen] = createSignal(false);
  let timer: number | undefined;

  onCleanup(() => {
    window.clearTimeout(timer);
  });

  createEffect(() => {
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

  return (
    <div class="page">
      <PageHeader title={t("shell.tab.settings")} />

      <div class="px-[18px] pb-[calc(36px+env(safe-area-inset-bottom))] pt-2">
        {/* 外观 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            {t("settings.section.appearance")}
          </h2>
          <div class="overflow-hidden rounded-[14px] border border-border bg-surface">
            <div class="flex w-full cursor-default items-center gap-3 px-4 py-[13px] text-left">
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">{t("settings.theme.title")}</span>
              </span>
              <div
                class="flex flex-none gap-0.5 rounded-[10px] bg-surface-2 p-[3px]"
                role="radiogroup"
                aria-label={t("settings.theme.title")}
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
                    {t(opt.labelKey)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* 语言 */}
        <LanguageRow />

        {/* 阅读 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            {t("settings.section.reading")}
          </h2>          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <ReadingSettingsRows />
          </div>
        </section>

        {/* 书源 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            {t("settings.section.sources")}
          </h2>
          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <Row
              icon={<SourceIcon size={18} />}
              label={t("settings.sources.manage")}
              desc={t("settings.sources.manageDesc")}
              onClick={() => navigate("/sources")}
            >
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </Row>
            <div class="flex w-full cursor-default items-center gap-3 px-4 py-[13px] text-left">
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">{t("settings.sources.parallel")}</span>
                <span class="text-[11.5px] text-text-3">{t("settings.sources.parallelDesc")}</span>
              </span>
              <div class="flex flex-none items-center gap-1">
                <button
                  class="grid h-8 w-8 place-items-center rounded-lg border border-border text-[13px] font-bold text-text-2 disabled:opacity-35"
                  aria-label={t("settings.sources.parallelDecrease")}
                  disabled={currentSourceParallel() <= SOURCE_PARALLEL_MIN}
                  onClick={() => setSourceParallel(currentSourceParallel() - 1)}
                >
                  −
                </button>
                <span class="min-w-[44px] text-center text-[13.5px] font-semibold tabular-nums">
                  {currentSourceParallel()}
                </span>
                <button
                  class="grid h-8 w-8 place-items-center rounded-lg border border-border text-[13px] font-bold text-text-2 disabled:opacity-35"
                  aria-label={t("settings.sources.parallelIncrease")}
                  disabled={currentSourceParallel() >= SOURCE_PARALLEL_MAX}
                  onClick={() => setSourceParallel(currentSourceParallel() + 1)}
                >
                  +
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* 导入 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            {t("settings.section.import")}
          </h2>
          <div class="overflow-hidden rounded-[14px] border border-border bg-surface">
            <Row
              icon={<RegexIcon size={18} />}
              label={t("settings.chapterRules.title")}
              desc={t("settings.chapterRules.desc")}
              onClick={() => navigate("/chapter-rules")}
            >
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </Row>
          </div>
        </section>

        {/* 书架 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            {t("shell.tab.shelf")}
          </h2>
          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <div class="flex w-full items-center gap-3 px-4 py-[13px] text-left">
              <span
                class="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-surface-2 text-text-2"
                aria-hidden="true"
              >
                <LibraryIcon size={18} />
              </span>
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[14.5px] font-medium">{t("settings.shelf.sourceFilter")}</span>
                <span class="text-[11.5px] text-text-3">
                  {t("settings.shelf.sourceFilterDesc")}
                </span>
              </span>
              <ToggleSwitch
                on={shelfSourceFilterEnabled()}
                label={t("settings.shelf.sourceFilterToggle")}
                onChange={() =>
                  setShelfSourceFilterEnabled(!shelfSourceFilterEnabled())
                }
              />
            </div>
          </div>
        </section>

        {/* 数据 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            {t("settings.section.data")}
          </h2>
          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <Row
              icon={<HeadphonesIcon size={18} />}
              label={t("settings.data.ttsCache")}
              desc={t("settings.data.ttsCacheDesc")}
              onClick={() => navigate("/tts-cache")}
            >
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </Row>
            <Row
              icon={<TrashIcon size={18} />}
              label={
                resetConfirming()
                  ? t("settings.data.resetConfirm")
                  : t("settings.data.resetProgress")
              }
              desc={t("settings.data.resetProgressDesc")}
              danger
              onClick={onResetProgress}
            />
          </div>
        </section>

        {/* 调试：应用日志两端都有（手机上没有它就只能连电脑抓 logcat），
            开发者工具仅桌面端（Android 的 WebView 不提供该 API） */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            {t("settings.section.debug")}
          </h2>
          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <Row
              icon={<TerminalIcon size={18} />}
              label={t("settings.logs.title")}
              desc={t("settings.debug.logsDesc")}
              onClick={() => setLogOpen(true)}
            >
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </Row>
            <Show when={isDesktopPlatform()}>
              <Row
                icon={<TerminalIcon size={18} />}
                label={t("settings.debug.devTools")}
                desc={t("settings.debug.devToolsDesc")}
                onClick={() => void openDevTools()}
              >
                <ChevronRightIcon size={18} class="flex-none text-text-3" />
              </Row>
            </Show>
          </div>
        </section>

        {/* 关于 */}
        <section class="mb-6">
          <h2 class="mx-1 mb-2 text-[12.5px] font-medium tracking-[0.04em] text-text-3">
            {t("settings.section.about")}
          </h2>
          <div class="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface">
            <div class="flex items-center gap-[13px] p-4">
              <span class="grid h-[42px] w-[42px] flex-none place-items-center rounded-[12px] bg-[linear-gradient(150deg,var(--accent),color-mix(in_srgb,var(--accent)_55%,var(--accent-deep)))] text-on-accent shadow-lg shadow-accent/30">
                <BookOpenIcon size={22} />
              </span>
              <span class="flex flex-col gap-0.5">
                <strong class="text-[16px] font-bold tracking-[0.03em]">ReaderX</strong>
                <span class="text-[11.5px] text-text-3">{t("settings.about.tagline")}</span>
              </span>
              <span class="ml-auto text-xs text-text-3">v{appVersion()}</span>
            </div>
            <Row
              icon={<GitHubIcon size={18} />}
              label={t("settings.about.github")}
              desc={t("settings.about.githubDesc")}
              onClick={() => void openGitHub()}
            >
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </Row>
            <Row
              icon={<FileTextIcon size={18} />}
              label={t("settings.license.title")}
              desc="MIT License"
              onClick={() => setLicenseOpen(true)}
            >
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </Row>
            <Row
              icon={<PackageIcon size={18} />}
              label={t("settings.notices.title")}
              desc={t("settings.notices.desc")}
              onClick={() => setNoticesOpen(true)}
            >
              <ChevronRightIcon size={18} class="flex-none text-text-3" />
            </Row>
          </div>
        </section>

        <LicenseSheet open={licenseOpen()} onClose={() => setLicenseOpen(false)} />
        <ThirdPartyNoticesSheet
          open={noticesOpen()}
          onClose={() => setNoticesOpen(false)}
        />
        <LogSheet open={logOpen()} onClose={() => setLogOpen(false)} />

        <p class="-mt-2 mb-2.5 text-center text-[11px] text-text-3">
          {t("settings.about.builtWith", { version: appVersion() })}
        </p>
      </div>
    </div>
  );
}

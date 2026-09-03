import { createSignal, onCleanup, type JSX } from "solid-js";
import {
  BookOpenIcon,
  ChevronRightIcon,
  TrashIcon,
} from "../components/icons";
import { PageHeader } from "../components/PageHeader";
import {
  FONT_MAX,
  FONT_MIN,
  currentFontSize,
  currentTheme,
  setFontSize,
  setTheme,
  clearShelf,
  type ThemeMode,
} from "../lib/store";

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
  return (
    <button
      class="settings-row"
      classList={{ "settings-row--danger": props.danger }}
      onClick={props.onClick}
    >
      {props.icon && (
        <span class="settings-row__icon" aria-hidden="true">
          {props.icon}
        </span>
      )}
      <span class="settings-row__main">
        <span class="settings-row__label">{props.label}</span>
        {props.desc && <span class="settings-row__desc">{props.desc}</span>}
      </span>
      {props.children}
    </button>
  );
}

export default function SettingsPage() {
  const [confirming, setConfirming] = createSignal(false);
  let timer: number | undefined;

  function onClearShelf() {
    if (!confirming()) {
      setConfirming(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setConfirming(false), 3000);
      return;
    }
    window.clearTimeout(timer);
    setConfirming(false);
    clearShelf();
  }

  onCleanup(() => window.clearTimeout(timer));

  const font = () => currentFontSize();

  return (
    <div class="page">
      <PageHeader title="设置" />

      <div class="page-body page-body--settings">
        {/* 外观 */}
        <section class="settings-group">
          <h2 class="settings-group__title">外观</h2>
          <div class="settings-group__body">
            <div class="settings-row settings-row--static">
              <span class="settings-row__main">
                <span class="settings-row__label">主题</span>
              </span>
              <div class="segmented" role="radiogroup" aria-label="主题">
                {THEME_OPTIONS.map((opt) => (
                  <button
                    role="radio"
                    aria-checked={currentTheme() === opt.value}
                    class="seg"
                    classList={{ "seg--active": currentTheme() === opt.value }}
                    onClick={() => setTheme(opt.value)}
                  >
                    <i
                      class="seg__dot"
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
        <section class="settings-group">
          <h2 class="settings-group__title">阅读</h2>
          <div class="settings-group__body">
            <div class="settings-row settings-row--static">
              <span class="settings-row__main">
                <span class="settings-row__label">正文字号</span>
              </span>
              <div class="stepper">
                <button
                  class="stepper__btn"
                  aria-label="减小正文字号"
                  disabled={font() <= FONT_MIN}
                  onClick={() => setFontSize(font() - 1)}
                >
                  A−
                </button>
                <span class="stepper__val">{font()}px</span>
                <button
                  class="stepper__btn"
                  aria-label="增大正文字号"
                  disabled={font() >= FONT_MAX}
                  onClick={() => setFontSize(font() + 1)}
                >
                  A+
                </button>
              </div>
            </div>
            <div class="settings-row settings-row--static">
              <span class="settings-row__main">
                <span class="settings-row__label">翻页方式</span>
              </span>
              <span class="settings-row__value">上下滚动</span>
              <ChevronRightIcon size={18} class="settings-row__chevron" />
            </div>
          </div>
        </section>

        {/* 数据 */}
        <section class="settings-group">
          <h2 class="settings-group__title">数据</h2>
          <div class="settings-group__body">
            <Row
              icon={<TrashIcon size={18} />}
              label={confirming() ? "再点一次确认清空" : "清空书架数据"}
              desc="移除书架记录与阅读进度，仅影响本地缓存"
              danger
              onClick={onClearShelf}
            />
          </div>
        </section>

        {/* 关于 */}
        <section class="settings-group">
          <h2 class="settings-group__title">关于</h2>
          <div class="settings-group__body">
            <div class="app-about">
              <span class="app-about__logo">
                <BookOpenIcon size={22} />
              </span>
              <span class="app-about__main">
                <strong class="app-about__name">ReaderX</strong>
                <span class="app-about__desc">移动端极简阅读器</span>
              </span>
              <span class="app-about__version">v0.1.0</span>
            </div>
            <Row label="技术栈" desc="Tauri 2 · SolidJS · TypeScript · Vite">
              <ChevronRightIcon size={18} class="settings-row__chevron" />
            </Row>
            <Row label="检查更新">
              <ChevronRightIcon size={18} class="settings-row__chevron" />
            </Row>
            <Row label="开源许可" desc="MIT License">
              <ChevronRightIcon size={18} class="settings-row__chevron" />
            </Row>
          </div>
        </section>

        <p class="settings-footer">ReaderX 0.1.0 · 基于 Tauri 2 构建</p>
      </div>
    </div>
  );
}

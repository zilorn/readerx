/**
 * 阅读设置行（正文字号 / 段落间距 / 翻页方式）：
 * 由「设置」页的阅读区块与阅读器「阅读设置」面板共用，
 * 两处展示与改动只需维护这一份，避免重复操作。
 * 状态存于全局 store（src/lib/store.ts），改动实时联动阅读页排版。
 */
import {
  FONT_MAX,
  FONT_MIN,
  PARA_SPACING_MAX,
  PARA_SPACING_MIN,
  PARA_SPACING_STEP,
  currentFontSize,
  currentPageMode,
  currentParaSpacing,
  setFontSize,
  setPageMode,
  setParaSpacing,
  type PageMode,
} from "../lib/store";

const PAGE_MODE_OPTIONS: { value: PageMode; label: string }[] = [
  { value: "paged", label: "左右翻页" },
  { value: "scroll", label: "上下滚动" },
];

/** 正文字号：A− / 数值 / A+ */
function FontSizeRow() {
  return (
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
  );
}

/** 段落间距：数值 + 滑块 */
function ParaSpacingRow() {
  return (
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
  );
}

/** 翻页方式：左右翻页 / 上下滚动 */
function PageModeRow() {
  return (
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
  );
}

/** 阅读设置三行（需放入带 divide-y 的卡片容器内使用） */
export function ReadingSettingsRows() {
  return (
    <>
      <FontSizeRow />
      <ParaSpacingRow />
      <PageModeRow />
    </>
  );
}

/**
 * 阅读页几何：正文列宽与「单页 / 双页」的弹性判定。
 *
 * 宽窗口下不再把一行文字一路拉长，而是把一屏拆成**并排的两页**（像翻开的书）：
 * 先按可用宽度决定一屏放几页，再据此算出单页正文宽度。判定只看宽度，
 * 所以手机列（外壳限宽 480px）与桌面窄窗口自然算出一页，排版与既有实现完全一致，
 * 桌面宽窗口（内容区 ≥ 阈值）才并排两页 —— 拉宽/收窄窗口时自动在单页与双页之间切换。
 *
 * 这里只算**几何**，不碰分页引擎（`lib/pagination.ts`）：引擎始终按**单页列宽**排版，
 * 双页只是把相邻两页并排显示（第 N 屏 = 第 2N、2N+1 页），翻页一次走一屏。
 */

/** 单页正文左右留白（px） */
export const READER_PAGE_PAD_X = 24;

/** 双页并排时两页之间的中缝（px） */
export const READER_PAGE_GAP = 64;

/** 单页正文最大宽度（px）：超过这个宽度不再拉长行，改为并排第二页 */
export const READER_COLUMN_MAX = 620;

/** 双页模式下单页正文最小宽度（px）：再窄就退回单页，避免一页只剩十来个字 */
export const READER_COLUMN_MIN = 440;

/**
 * 阅读页最大宽度（px，含页面左右留白）：正好放得下并排的两页最大列宽。
 * 桌面外壳据此给阅读页留位（见 `shell/DesktopStage.tsx`），再宽也只是两侧留白。
 */
export const READER_MAX_WIDTH = READER_COLUMN_MAX * 2 + READER_PAGE_GAP + READER_PAGE_PAD_X * 2;

/** 可用面积小于该值时视为还没量出尺寸 / 窗口不可用，不做排版 */
const MIN_AREA_WIDTH = 100;
const MIN_AREA_HEIGHT = 140;

/** 阅读页几何（分页渲染 + 滚动渲染共用同一份口径） */
export interface ReaderGeometry {
  /** 一屏并排的页数 */
  columns: 1 | 2;
  /** 单页正文宽度 px（分页引擎的排版列宽） */
  columnWidth: number;
  /** 两页之间的中缝 px（单页为 0） */
  gap: number;
  /** 一屏正文块总宽度 px（两页 + 中缝；居中显示用） */
  blockWidth: number;
  /** 滚动模式的正文宽 px（上下滚动只有单栏，不看并排页数） */
  flowWidth: number;
  /** 单页正文可用高度 px */
  pageHeight: number;
}

/**
 * 可用面积 → 阅读页几何；面积无效（尚未挂载 / 窗口过小）返回 null。
 * `pads` 为单页正文上下留白（含安全区），由阅读页实测后传入。
 */
export function resolveReaderGeometry(
  area: { w: number; h: number },
  pads: { top: number; bottom: number },
): ReaderGeometry | null {
  if (area.w < MIN_AREA_WIDTH || area.h < MIN_AREA_HEIGHT) return null;
  const inner = Math.max(0, area.w - READER_PAGE_PAD_X * 2);
  const columns: 1 | 2 =
    inner >= READER_COLUMN_MIN * 2 + READER_PAGE_GAP ? 2 : 1;
  const gap = columns === 2 ? READER_PAGE_GAP : 0;
  const columnWidth = Math.max(
    1,
    Math.floor(Math.min(READER_COLUMN_MAX, (inner - gap) / columns)),
  );
  return {
    columns,
    columnWidth,
    gap,
    blockWidth: columnWidth * columns + gap,
    flowWidth: Math.max(1, Math.floor(Math.min(READER_COLUMN_MAX, inner))),
    pageHeight: area.h - pads.top - pads.bottom,
  };
}

/**
 * 页下标 → 所在屏的第一页：双页模式的屏首恒为 `page % columns === 0`
 * （翻页、进度条跳页、书签定位都要先落到屏首，否则会停在「半屏」上）。
 */
export function spreadStart(page: number, columns: number): number {
  const index = Math.max(0, Math.floor(page) || 0);
  return columns > 1 ? index - (index % columns) : index;
}

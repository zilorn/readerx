/**
 * 阅读视图的「渲染窗口」判定。
 *
 * 在线书的正文由后台按预取窗口（`online.ts` 的 LAZY_WINDOW，当前章 ±5 章）逐章抓取并写回书库，
 * 书库对象因此被反复整本替换。但屏幕上的一页只用到三章：当前章 + 上一章 + 下一章。
 * 窗口外章节的正文回写如果也去惊动渲染链路，就会出现「下载时高频闪烁」：
 * 面积测量 → 排版参数 → 当前章整章重新分页 → 页面闪断。
 *
 * 所以阅读视图改为只读取下面这份「窗口视图」：只要窗口内章节与书籍元信息都没变，
 * 就沿用上一次的书对象引用，依赖它的 memo / effect 全部因引用未变而跳过。
 */
import { samePlainFields, type LocalBook } from "./booksTypes";

/** 渲染窗口半径：阅读视图读取「当前章 ±1 章」，恰好够顺序翻页与跟读跨章 */
export const RENDER_WINDOW = 1;

/**
 * 两份书对象在「第 chapterIndex 章的 ±RENDER_WINDOW」窗口内是否等价：
 * - 书籍身份 / 章节数（目录结构）必须一致 —— 末尾追加、整本覆盖、重新导入要立刻反映；
 * - 窗口内章节按引用比较（未变的章节对象在正文回写时被原样复用，指针比较即可判定）；
 * - 标题 / 作者 / 封面 / 标签等非正文字段逐字段浅比较。
 *
 * 返回 true 表示这次书库更新与当前渲染无关，可以继续用旧对象。
 */
export function sameRenderWindow(
  a: LocalBook,
  b: LocalBook,
  chapterIndex: number,
): boolean {
  if (a.id !== b.id) return false;
  const x = a.chapters;
  const y = b.chapters;
  if (x.length !== y.length) return false;
  const lo = Math.max(0, chapterIndex - RENDER_WINDOW);
  const hi = Math.min(y.length - 1, chapterIndex + RENDER_WINDOW);
  for (let i = lo; i <= hi; i++) {
    if (x[i] !== y[i]) return false;
  }
  return samePlainFields(a, b, "chapters");
}

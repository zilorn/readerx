/**
 * 命中高亮渲染：把一段文本按命中区间切成片段，命中片段着强调色。
 * 全书搜索面板与书签面板共用（标记只认字符区间，与各自的坐标口径无关）。
 */
import { For, createMemo } from "solid-js";

/** 相对传入文本的命中区间 */
export interface HighlightMark {
  from: number;
  to: number;
}

export interface HighlightTextProps {
  text: string;
  marks: readonly HighlightMark[];
}

interface TextSeg {
  text: string;
  hit: boolean;
}

/** 把文本按命中区间切成片段（合并/跳过重叠或乱序标记） */
export function segmentByMarks(text: string, marks: readonly HighlightMark[]): TextSeg[] {
  const segs: TextSeg[] = [];
  let cursor = 0;
  const sorted = marks.slice().sort((a, b) => a.from - b.from);
  for (const mark of sorted) {
    if (mark.to <= cursor || mark.from < cursor) continue;
    if (mark.from > cursor) segs.push({ text: text.slice(cursor, mark.from), hit: false });
    segs.push({ text: text.slice(mark.from, mark.to), hit: true });
    cursor = mark.to;
  }
  if (cursor < text.length) segs.push({ text: text.slice(cursor), hit: false });
  if (segs.length === 0) segs.push({ text, hit: false });
  return segs;
}

export function HighlightText(props: HighlightTextProps) {
  const segs = createMemo(() => segmentByMarks(props.text, props.marks));
  return (
    <For each={segs()}>
      {(seg) =>
        seg.hit ? (
          <span class="rounded-[3px] bg-accent-weak font-semibold text-accent">{seg.text}</span>
        ) : (
          seg.text
        )
      }
    </For>
  );
}

import { splitSpeechLocal } from "./ttsSegment";

/** 长按起选：按听书规则选中所在句段，并裁剪到被长按的单页。偏移均为单元内偏移。 */
export function sentenceSelectionRange(
  text: string,
  offset: number,
  pageStart: number,
  pageEnd: number,
): [number, number] | null {
  if (offset < pageStart || offset >= pageEnd || offset < 0 || offset >= text.length) return null;
  const sentence = splitSpeechLocal(text).find(({ s, e }) => offset >= s && offset < e);
  // 空白或纯标点不属于朗读句段时，保留单字符起选；代理对不能被截断。
  let start = sentence?.s ?? offset;
  let end = sentence?.e ?? offset + (text.codePointAt(offset)! > 0xffff ? 2 : 1);
  if (!sentence && /[\uDC00-\uDFFF]/.test(text[offset]) && offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1])) {
    start--;
  }
  start = Math.max(pageStart, start, 0);
  end = Math.min(pageEnd, end, text.length);
  return end > start ? [start, end] : null;
}

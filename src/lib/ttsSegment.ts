/**
 * 听书分句：把正文切成逐句朗读的单元。
 *
 * 关键规则：
 * - 按 。！？!?… 等强断句符切句，ASCII 句点遇数字/字母（小数、域名）不切；
 * - 引号/括号内部照常断句，连续句末标点与尾随闭合符号归入前句；
 *   开放符号归入下一句，避免多句对白被合并成一个朗读单元；
 * - 不含可读文字（字母/数字/汉字）的纯标点片段直接丢弃，不被朗读；
 * - 超长无标点段落用逗号等软边界兜底切分，避免一句过长。
 *
 * 所有偏移都基于 JS 字符串（UTF-16 code unit）下标，与正文镜像的字符偏移口径一致。
 */
import type { LocalBookChapter } from "./booksTypes";
import { chapterUnits, type ReaderBlock } from "./pagination";
import { buildTextMirror } from "./bookmarks";

/** 单元内一个朗读句的局部区间 */
export interface SpeechRange {
  /** 局部起始（含） */
  s: number;
  /** 局部结束（不含） */
  e: number;
  /** 实际交给 TTS 的文本（已去首尾空白） */
  text: string;
}

/** 章节级朗读句：带单元与章节镜像全局偏移 */
export interface ChapterSpeechItem {
  /** chapterUnits 中的单元序号（p/h）；章节标题项为 -1（不在正文镜像内） */
  unit: number;
  /** 单元内局部区间 */
  ls: number;
  le: number;
  /** 章节镜像文本中的全局偏移（图片不占位，与书签口径一致）；标题项为 -1 */
  start: number;
  end: number;
  /** 是否为章节标题（朗读到章首的标题，正文无高亮位置） */
  isTitle?: boolean;
  /** 待合成文本 */
  text: string;
}

/** 强断句符 */
const END_CHARS = new Set(["。", "！", "？", "!", "?", "…", "⋯"]);

/** 引号/括号开放字符 */
const OPEN_CHARS = new Set([
  "“", "‘", "「", "『", "（", "【", "《", "〈", "(", "[", "{", "<",
]);

/** 引号/括号闭合映射（与开放字符一一对应） */
const CLOSE_MAP: Record<string, string> = {
  "”": "“", "’": "‘", "」": "「", "』": "『", "）": "（", "】": "【", "》": "《",
  "〉": "〈", ")": "(", "]": "[", "}": "{", ">": "<",
};

/** 软边界（仅超长兜底时使用） */
const SOFT_CHARS = new Set([
  "，", ",", "、", "；", ";", "：", ":", "·", "—", "–", "-", " ", "　", "\u00a0",
]);

/** 超出该长度且仍无法收句时强制按软边界切分 */
const SOFT_LIMIT = 320;

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "　" || ch === "\u00a0" || ch === "\ufeff";
}

function hasSpeakable(slice: string): boolean {
  // 字母 / 数字 / 汉字等才算“可朗读文本”；纯标点、空白不算
  return /[\p{L}\p{N}]/u.test(slice);
}

/** 字符是否为强断句符（ASCII 句点须避开小数/缩写） */
function isTerm(text: string, i: number): boolean {
  const ch = text[i];
  if (END_CHARS.has(ch)) return true;
  if (ch === ".") {
    const next = text[i + 1];
    if (next !== undefined && /[0-9A-Za-z]/.test(next)) return false;
    return true;
  }
  return false;
}

/**
 * 把单个自然段（单元）切成一串可朗读句子。
 * 返回的区间不含纯标点/空白；若整段没有可读文字返回 []。
 */
export function splitSpeechLocal(text: string): SpeechRange[] {
  const out: SpeechRange[] = [];
  const n = text.length;
  const stack: string[] = [];
  let segStart = 0;
  let cand = -1; // 最近一次可收句的排他下标（含尾随闭合引号）
  let lastSoft = -1; // 最近软边界下标

  const push = (end: number): void => {
    if (end <= segStart) {
      segStart = end;
      cand = -1;
      lastSoft = -1;
      return;
    }
    let s0 = segStart;
    let e0 = end;
    while (s0 < e0 && isWhitespace(text[s0])) s0++;
    while (e0 > s0 && isWhitespace(text[e0 - 1])) e0--;
    if (e0 > s0 && hasSpeakable(text.slice(s0, e0))) {
      out.push({ s: s0, e: e0, text: text.slice(s0, e0) });
    }
    segStart = end;
    cand = -1;
    lastSoft = -1;
  };

  let i = 0;
  while (i < n) {
    // 超长兜底：段内太久没遇到可收句位置时，按最近的软边界/断句位置切开
    if (i - segStart >= SOFT_LIMIT) {
      let cut = i;
      if (lastSoft > segStart && i - lastSoft <= 90) cut = lastSoft + 1;
      else if (cand > segStart && i - cand <= 120) cut = cand;
      push(cut);
      continue;
    }

    const ch = text[i];
    const top = stack[stack.length - 1];
    const closing = ch in CLOSE_MAP || (ch === '"' && top === '"');

    // 不等待引号/括号配平：内部下一句开始时即可收句。
    // 连续标点、闭合符号仍留在前句，开放符号则是下一句的起点。
    if (cand >= 0 && !isTerm(text, i) && !closing && !isWhitespace(ch)) {
      push(cand);
      continue;
    }

    if (OPEN_CHARS.has(ch)) {
      stack.push(ch);
    } else if (ch in CLOSE_MAP) {
      if (top === CLOSE_MAP[ch]) stack.pop();
      if (cand >= 0) cand = i + 1;
    } else if (ch === '"') {
      // ASCII 双引号成对开关，用于判断它属于前句还是后句。
      if (top === '"') {
        stack.pop();
        if (cand >= 0) cand = i + 1;
      } else {
        stack.push('"');
      }
    } else if (isTerm(text, i)) {
      cand = i + 1;
    } else if (SOFT_CHARS.has(ch)) {
      lastSoft = i;
    }

    i++;
  }

  push(n);
  return out;
}

/** 章节 → 逐句朗读项（按章节镜像偏移排序；图片/无文字段自动跳过）。
 *  每章第一项固定为「章节标题」（朗读章首先报标题，正文无对应高亮位置）。 */
export function buildChapterSpeechItems(chapter: LocalBookChapter): ChapterSpeechItem[] {
  const units: ReaderBlock[] = chapterUnits(chapter);
  const mirror = buildTextMirror(units);
  const items: ChapterSpeechItem[] = [];
  // 章节标题：朗读每章时先读标题（TTS 引擎按标题文本直接朗读）
  const title = chapter.title?.trim();
  if (title && hasSpeakable(title)) {
    items.push({ unit: -1, ls: 0, le: 0, start: -1, end: -1, isTitle: true, text: title });
  }
  units.forEach((unit, idx) => {
    if (unit.kind !== "p" && unit.kind !== "h") return;
    const base = mirror.unitStart[idx] ?? 0;
    for (const range of splitSpeechLocal(unit.text)) {
      items.push({
        unit: idx,
        ls: range.s,
        le: range.e,
        start: base + range.s,
        end: base + range.e,
        text: range.text,
      });
    }
  });
  return items;
}

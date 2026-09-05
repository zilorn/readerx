/**
 * 文本替换（阅读时显示级替换）模块。
 *
 * 语义：
 * - 每条替换规则带作用域：global = 对所有书生效；book = 只对某一本书生效；
 * - 规则按创建顺序整体保存，应用时只取「对本书生效」的子集，顺序不变；
 * - 替换只作用于阅读展示（正文单元文本 / TTS 分句 / 搜索高亮等一律走
 *   withDisplayReplacements 的“显示副本”），绝不改动书库里的原文；
 * - regex = true 时 find 为正则源码（自动全局匹配，支持 $1 等捕获组引用），
 *   regex = false 时 find 按普通文本字面匹配。
 *
 * 持久化走 Rust 后端 readState/writeState（WebView 不落盘）。
 */
import { createSignal } from "solid-js";
import { readState, writeState } from "./backend";
import type { LocalBook, LocalBookChapter } from "./booksTypes";

export type ReplaceScope = "global" | "book";

export interface TextReplaceRule {
  id: string;
  /** global = 所有书生效；book = 只对 bookId 这本书生效 */
  scope: ReplaceScope;
  /** scope=book 时生效的书 id；scope=global 时为空串 */
  bookId: string;
  /** 查找内容：regex=false 按普通文本；regex=true 作为正则源码（已去 /…/ 包裹） */
  find: string;
  /** 替换为；可留空（等价删除匹配文字）；regex 模式下支持 $1 捕获组 */
  replace: string;
  regex: boolean;
  createdAt: number;
}

const STORAGE_KEY = "readerx.textReplacements";

const [ruleListSignal, setRuleListSignal] = createSignal<TextReplaceRule[]>([]);
let initialized = false;
let writeQueue: Promise<void> = Promise.resolve();

function isValidRule(rule: unknown): rule is TextReplaceRule {
  if (!rule || typeof rule !== "object") return false;
  const r = rule as Partial<TextReplaceRule>;
  return (
    typeof r.id === "string" &&
    (r.scope === "global" || r.scope === "book") &&
    typeof r.bookId === "string" &&
    typeof r.find === "string" &&
    typeof r.replace === "string" &&
    typeof r.regex === "boolean"
  );
}

/** 应用启动时从 Rust 后端载入替换规则（幂等） */
export async function initTextReplacements(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const stored = await readState<unknown>(STORAGE_KEY);
    if (!Array.isArray(stored)) return;
    const rules = stored.filter((item): item is TextReplaceRule => isValidRule(item));
    if (rules.length > 0) setRuleListSignal(rules);
  } catch {
    /* 后端不可用时保持空列表 */
  }
}

/** 全部替换规则（响应式，按创建顺序） */
export function replaceRuleList(): TextReplaceRule[] {
  return ruleListSignal();
}

/** 对某本书生效的规则子集（保持创建顺序；规则为空返回 []） */
export function effectiveReplaceRules(bookId: string): TextReplaceRule[] {
  const list = ruleListSignal();
  if (list.length === 0) return list;
  return list.filter((rule) => rule.scope === "global" || rule.bookId === bookId);
}

function persist(next: TextReplaceRule[]): void {
  setRuleListSignal(next);
  writeQueue = writeQueue.then(() => writeState(STORAGE_KEY, next));
}

export function newReplaceRuleId(): string {
  return `rep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 新增一条替换规则 */
export function addReplaceRule(rule: TextReplaceRule): void {
  persist([...ruleListSignal(), rule]);
}

/** 按 id 更新一条替换规则（不存在时忽略） */
export function updateReplaceRule(rule: TextReplaceRule): void {
  const list = ruleListSignal();
  if (!list.some((item) => item.id === rule.id)) return;
  persist(list.map((item) => (item.id === rule.id ? rule : item)));
}

/** 按 id 删除一条替换规则 */
export function removeReplaceRule(id: string): void {
  const list = ruleListSignal();
  if (!list.some((item) => item.id === id)) return;
  persist(list.filter((item) => item.id !== id));
}

// ---------------------------------------------------------------------------
// 输入规整与校验
// ---------------------------------------------------------------------------

/**
 * 把用户输入规整为存储形态：正则模式下去掉习惯性粘贴的 /…/ 包裹
 * （普通文本模式原样保留，避免误伤真正的斜杠文本）。
 */
export function normalizeFindInput(input: string, regex: boolean): string {
  let value = input;
  if (regex) {
    value = value.trim();
    if (value.startsWith("/")) {
      const last = value.lastIndexOf("/");
      if (last > 0) value = value.slice(1, last);
    }
  }
  return value;
}

/** 返回 null 表示可保存，否则返回错误信息 */
export function validateReplaceRule(find: string, regex: boolean): string | null {
  if (!find.trim()) return "请填写要查找的文字";
  const normalized = normalizeFindInput(find, regex);
  if (!normalized) return "请填写要查找的文字";
  if (regex) {
    try {
      new RegExp(normalized);
    } catch (err) {
      return err instanceof Error ? err.message : "正则表达式无法解析";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 应用（显示副本）
// ---------------------------------------------------------------------------

/** 用单条规则替换文本；规则不可用（空查找 / 正则编译失败）时原样返回 */
export function applyRuleToText(text: string, rule: TextReplaceRule): string {
  const find = rule.find;
  if (!text || !find) return text;
  try {
    if (rule.regex) {
      return text.replace(new RegExp(find, "g"), rule.replace);
    }
    return text.split(find).join(rule.replace);
  } catch {
    return text;
  }
}

/** 依次应用多条规则（链式，后一条在前一条的结果上继续） */
export function applyReplaceRulesToText(text: string, rules: TextReplaceRule[]): string {
  let out = text;
  for (const rule of rules) {
    out = applyRuleToText(out, rule);
  }
  return out;
}

/**
 * 返回应用规则后的章节副本；无任何文本改动时返回原引用（便于下游跳过重排）。
 * 章节标题 / cid 等元信息不改动（替换只针对正文显示）。
 */
export function applyReplacementsToChapter(
  chapter: LocalBookChapter,
  rules: TextReplaceRule[],
): LocalBookChapter {
  if (rules.length === 0) return chapter;
  let changed = false;
  const mapText = (text: string): string => {
    const out = applyReplaceRulesToText(text, rules);
    if (out !== text) changed = true;
    return out;
  };
  const hasBlocks = !!chapter.blocks && chapter.blocks.length > 0;
  const blocks = hasBlocks
    ? chapter.blocks!.map((block) =>
        block.kind === "img" ? block : { ...block, text: mapText(block.text) },
      )
    : undefined;
  const paragraphs = chapter.paragraphs.map(mapText);
  if (!changed) return chapter;
  const next: LocalBookChapter = { ...chapter };
  if (blocks) next.blocks = blocks;
  next.paragraphs = paragraphs;
  return next;
}

/**
 * 返回“显示副本”书籍：正文单元文本应用了该书生效的替换规则。
 * 无规则 / 无实际改动时原样返回原书对象，避免多余重渲染。
 */
export function withDisplayReplacements(
  book: LocalBook | undefined,
  bookId: string,
): LocalBook | undefined {
  if (!book) return undefined;
  const rules = effectiveReplaceRules(bookId);
  if (rules.length === 0) return book;
  let changedAny = false;
  const chapters = book.chapters.map((chapter) => {
    const next = applyReplacementsToChapter(chapter, rules);
    if (next !== chapter) changedAny = true;
    return next;
  });
  if (!changedAny) return book;
  return { ...book, chapters };
}

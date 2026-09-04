/**
 * 分章规则模块：
 * - 内置若干常见“章节标题”正则，按列表顺序尝试；
 * - 某条规则若能切出有效章节即生效，否则继续尝试下一条；
 *   「简介在前」内置规则命中后，会把开头简介独立成章放最前，
 *   即使整书正文标题只匹配到一次也不再回退按字数分章；
 * - 全部规则都未命中时回退为“按字数分章”。
 * 用户自定义规则由 Rust 后端持久化，可在分章规则页增删。
 */
import { createSignal } from "solid-js";
import { readState, writeState } from "./backend";

export interface ChapterRule {
  id: string;
  name: string;
  /** 正则源码，统一以 g + i + m 编译（行首 ^ 按行生效） */
  pattern: string;
  builtin: boolean;
  /**
   * 仅部分内置规则使用：命中时若标题之前还有真实“简介”文本，
   * 把简介独立成章置于最前（见 trySplitFrontIntro）。
   */
  frontIntro?: boolean;
}

export interface SplitChapter {
  title: string;
  paragraphs: string[];
}

export interface TextSplitResult {
  mode: "regex" | "chars";
  rule?: ChapterRule;
  /** 人类可读的分章方式，如“中文章节标题 / 按字数分章” */
  ruleName: string;
  chapters: SplitChapter[];
}

/** 默认回退分章字数 */
export const DEFAULT_CHARS_PER_CHAPTER = 3000;

const RULES_KEY = "readerx.chapterRules";

/** 中文章节标题正则（第X章 / 回 / 节），被普通规则与“简介在前”规则共用 */
const ZH_CHAPTER_PATTERN = String.raw`^\s*第\s*[0-9０-９一二三四五六七八九十百千万零〇两]+\s*[章回节][^\n]{0,60}`;

/** 内置规则：顺序即自动匹配时的尝试顺序 */
const BUILTIN_RULES: ChapterRule[] = [
  {
    // 覆盖“开头是一段无标题简介、后面才有 第一章/第二章…”的常见 TXT：
    // 简介独立成章放最前，而不是因为开头匹配不到标题而回退按字数分章。
    id: "builtin-zh-prelude",
    name: "中文章节（开头可带简介）",
    pattern: ZH_CHAPTER_PATTERN,
    builtin: true,
    frontIntro: true,
  },
  {
    id: "builtin-zh-chapter",
    name: "中文章节（第X章 / 回 / 节）",
    pattern: ZH_CHAPTER_PATTERN,
    builtin: true,
  },
  {
    id: "builtin-zh-front",
    name: "序章 / 楔子 / 尾声 / 番外",
    pattern: String.raw`^\s*(?:序章|序言|楔子|引子|引言|前言|绪章|尾声|后记|番外|终章|结局)[^\n]{0,60}`,
    builtin: true,
  },
  {
    id: "builtin-en-chapter",
    name: "英文 Chapter / CHAPTER",
    pattern: String.raw`^\s*chapter\s+(?:[0-9]+|[一二三四五六七八九十百千万零〇]+|[ivxlcdm]+)[^\n]{0,70}`,
    builtin: true,
  },
  {
    id: "builtin-zh-volume",
    name: "卷 / 部 / 集 分卷",
    pattern: String.raw`^\s*(?:第\s*[0-9０-９一二三四五六七八九十百千万零〇两]+\s*[卷部集]|[上中下]卷|[一二三四五六七八九十]+卷)[^\n]{0,70}`,
    builtin: true,
  },
];

/** 去掉用户在输入框里习惯性粘贴的 /…/gi 包裹 */
export function normalizeUserPattern(input: string): string {
  let pattern = input.trim();
  if (pattern.startsWith("/")) {
    const last = pattern.lastIndexOf("/");
    if (last > 0) pattern = pattern.slice(1, last);
  }
  return pattern.trim();
}

/** 返回 null 表示可编译，否则返回错误信息 */
export function validateRulePattern(pattern: string): string | null {
  const normalized = normalizeUserPattern(pattern);
  if (!normalized) return "请输入正则表达式";
  try {
    new RegExp(normalized, "gim");
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "正则表达式无法解析";
  }
}

function isValidRule(rule: unknown): rule is ChapterRule {
  if (!rule || typeof rule !== "object") return false;
  const r = rule as Partial<ChapterRule>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.pattern === "string" &&
    typeof r.builtin === "boolean"
  );
}

const [rulesSignal, setRulesSignal] = createSignal<ChapterRule[]>([...BUILTIN_RULES]);
let rulesInitialized = false;
let rulesWriteQueue: Promise<void> = Promise.resolve();

/** 应用启动时从 Rust 后端载入用户自定义规则（幂等） */
export async function initChapterRules(): Promise<void> {
  if (rulesInitialized) return;
  rulesInitialized = true;
  const stored = await readState<unknown>(RULES_KEY);
  if (!Array.isArray(stored)) return;
  const custom = stored.filter(
    (item): item is ChapterRule => isValidRule(item) && !item.builtin,
  );
  if (custom.length > 0) {
    setRulesSignal([...BUILTIN_RULES, ...custom]);
  }
}

/** 当前生效的全部规则（内置在前，用户自定义在后） */
export function chapterRuleList(): ChapterRule[] {
  return rulesSignal();
}

function persistRules(next: ChapterRule[]): void {
  setRulesSignal(next);
  const custom = next.filter((rule) => !rule.builtin);
  rulesWriteQueue = rulesWriteQueue.then(() => writeState(RULES_KEY, custom));
}

export interface AddRuleResult {
  ok: boolean;
  error?: string;
  rule?: ChapterRule;
}

/** 新增一条用户规则；名称必填、正则需可编译 */
export function addChapterRule(name: string, pattern: string): AddRuleResult {
  const trimmedName = name.trim();
  if (!trimmedName) return { ok: false, error: "请填写规则名称" };
  const normalized = normalizeUserPattern(pattern);
  const error = validateRulePattern(normalized);
  if (error) return { ok: false, error };

  const rule: ChapterRule = {
    id: `user-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: trimmedName,
    pattern: normalized,
    builtin: false,
  };
  persistRules([...rulesSignal(), rule]);
  return { ok: true, rule };
}

/** 删除用户自定义规则；内置规则不可删除 */
export function removeChapterRule(id: string): boolean {
  const target = rulesSignal().find((rule) => rule.id === id);
  if (!target || target.builtin) return false;
  persistRules(rulesSignal().filter((rule) => rule.id !== id));
  return true;
}

// ---------------------------------------------------------------------------
// 文本预处理与分段

function normalizeLineEndings(text: string): string {
  return text
    .replace(/\uFEFF/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\u0000/g, "");
}

function collapseBlock(block: string): string {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  const joined = lines.join(lines.some((line) => /[\u3400-\u9fff]/.test(line)) ? "" : " ");
  return joined.replace(/\s+/g, " ").trim();
}

/**
 * 把章节正文拆成自然段：
 * - 有空行分隔时按空行分段；
 * - 否则按单个换行分段；
 * - 完全没有换行时作为一整段返回。
 */
export function paragraphsFromText(text: string): string[] {
  const normalized = normalizeLineEndings(text).trim();
  if (!normalized) return [];

  const blocks = normalized
    .split(/\n\s*\n+/)
    .map(collapseBlock)
    .filter(Boolean);
  if (blocks.length >= 2) return blocks;

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length >= 2) return lines.map((line) => line.replace(/\s+/g, " "));

  return [normalized.replace(/\s+/g, " ")];
}

/** 把超长段落在合适的分句标点处切碎，供字数分章使用 */
function splitLongParagraph(paragraph: string, limit: number): string[] {
  if (paragraph.length <= limit) return [paragraph];
  const parts: string[] = [];
  let rest = paragraph;
  const punctuation = "。！？；!?；…";
  while (rest.length > limit) {
    const floor = Math.floor(limit * 0.55);
    let cut = limit;
    for (let i = limit; i > floor; i--) {
      if (punctuation.includes(rest.charAt(i - 1))) {
        cut = i;
        break;
      }
    }
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

// ---------------------------------------------------------------------------
// 按正则 / 按字数分章

interface RawSplitChapter {
  title: string;
  body: string;
}

/** 章节标题前的短行通常只是书名/作者/来源，属于噪音而非正文 */
function looksLikeTitleBlock(frontMatter: string): boolean {
  const lines = frontMatter.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every(
    (line) => line.length <= 32 && !/[。！？；：…]/.test(line),
  );
}

/** 把简介文本拆成“章节名 + 正文”：
 * 若开头有“内容简介/文案/楔子…”这类短标行，用它作章节名（标签独占一行时
 * 从正文去掉，避免重复）；找不到标签则统一叫「开篇」且全文保留。 */
function splitFrontIntro(frontMatter: string): { title: string; body: string } {
  const labels =
    /^(?:内容简介|作品简介|故事简介|故事梗概|内容介绍|内容提要|文案|楔子|引子|序章|序言|前言|卷首语|写在前面|序)$/;
  const lines = frontMatter.split("\n").map((line) => line.trim()).filter(Boolean);
  let title = "开篇";
  const kept: string[] = [];
  for (const line of lines) {
    // 允许“内容简介：…”这种标签直接带正文在同一行
    const label = line.replace(/[:：].*$/, "").trim();
    if (title === "开篇" && label && label.length <= 12 && labels.test(label)) {
      title = label;
      if (line === label) continue; // 标签独占一行：已用作章节名，正文不再重复
    }
    kept.push(line);
  }
  return { title, body: kept.join("\n") };
}

/** 单条规则分章；不满足“至少两个有效章节”时返回 null */
function trySplitByRule(text: string, rule: ChapterRule): RawSplitChapter[] | null {
  let regex: RegExp;
  try {
    regex = new RegExp(rule.pattern, "gim");
  } catch {
    return null;
  }

  const matches = Array.from(text.matchAll(regex));
  if (matches.length < 2) return null;

  const firstIndex = matches[0].index ?? 0;
  const frontMatter = text.slice(0, firstIndex).trim();
  const chapters: RawSplitChapter[] = [];

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const heading = (matches[i][0] ?? "").trim();
    let body = text.slice(start + (matches[i][0]?.length ?? 0), end).trim();

    if (i === 0 && frontMatter && !looksLikeTitleBlock(frontMatter)) {
      if (frontMatter.length > 800) {
        chapters.push({ title: "开篇", body: frontMatter });
      } else {
        body = body ? `${frontMatter}\n\n${body}` : frontMatter;
      }
    }
    chapters.push({
      title: heading.slice(0, 80) || `第${chapters.length + 1}节`,
      body,
    });
  }

  const valid = chapters.filter((chapter) => chapter.body.length >= 80).length;
  // 若多数“章节”几乎没有正文，大概率命中文件开头的目录，放弃该规则
  if (valid === 0 || valid / chapters.length < 0.4) return null;
  return chapters.filter((chapter) => chapter.body.length > 0);
}

/**
 * 「简介在前 · 正文标题后置」分章：
 * 开头是一段没有标题的简介，后面才出现 第一章/第二章…（甚至全书只有一个正文标题）。
 * 命中条件：
 * - 前置存在真实“简介”文本（书名/作者等短行噪音不算）；
 * - 其后至少匹配到一个章节标题。
 * 命中时简介独立成章放在最前（标题取“内容简介/文案/楔子”等短标行，否则「开篇」），
 * 不并入第一章，也不因篇幅短被吞掉；只有 1 个标题章也允许切（简介本身补足一段）。
 * 若标题章普遍没有正文（目录/分卷空壳），判定不是这种格式，交还后续规则。
 */
function trySplitFrontIntro(text: string, headingPattern: string): RawSplitChapter[] | null {
  let regex: RegExp;
  try {
    regex = new RegExp(headingPattern, "gim");
  } catch {
    return null;
  }

  const matches = Array.from(text.matchAll(regex));
  if (matches.length === 0) return null;

  const firstIndex = matches[0].index ?? 0;
  const frontMatter = text.slice(0, firstIndex).trim();
  // 没有前置内容，或前置只是书名/作者/来源短行 → 不是“简介在前”场景，交给普通规则
  if (!frontMatter || looksLikeTitleBlock(frontMatter)) return null;

  const intro = splitFrontIntro(frontMatter);
  const chapters: RawSplitChapter[] = [
    { title: intro.title, body: intro.body },
  ];

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const heading = (matches[i][0] ?? "").trim();
    const body = text.slice(start + (matches[i][0]?.length ?? 0), end).trim();
    chapters.push({
      title: heading.slice(0, 80) || `第${i + 1}节`,
      body,
    });
  }

  const headingChapters = chapters.slice(1);
  const valid = headingChapters.filter((chapter) => chapter.body.length >= 80).length;
  // 标题章普遍没有正文 → 更像开头目录/分卷列表，不是正文分章
  if (valid === 0 || valid / headingChapters.length < 0.4) return null;

  return chapters.filter((chapter) => chapter.body.length > 0);
}

/** 按字数分章，段落尽量完整保留；超过单章上限的段落再按句切分 */
export function splitTextByChars(
  text: string,
  charsPerChapter = DEFAULT_CHARS_PER_CHAPTER,
): SplitChapter[] {
  const paragraphs = paragraphsFromText(text);
  const chapters: SplitChapter[] = [];
  let buffer: string[] = [];
  let bufferedChars = 0;

  const pushChapter = () => {
    if (buffer.length === 0) return;
    chapters.push({ title: `第${chapters.length + 1}章`, paragraphs: buffer });
    buffer = [];
    bufferedChars = 0;
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length <= charsPerChapter) {
      if (bufferedChars > 0 && bufferedChars + paragraph.length > charsPerChapter) {
        pushChapter();
      }
      buffer.push(paragraph);
      bufferedChars += paragraph.length;
      continue;
    }

    pushChapter();
    for (const chunk of splitLongParagraph(paragraph, charsPerChapter)) {
      if (bufferedChars > 0 && bufferedChars + chunk.length > charsPerChapter) pushChapter();
      buffer.push(chunk);
      bufferedChars += chunk.length;
    }
  }
  pushChapter();
  return chapters;
}

/**
 * 按给定规则列表分章：第一条能切出有效章节的规则生效，
 * 否则回退按字数分章。
 */
export function splitText(
  text: string,
  rules: ChapterRule[] = chapterRuleList(),
  charsPerChapter = DEFAULT_CHARS_PER_CHAPTER,
): TextSplitResult {
  const normalized = normalizeLineEndings(text);
  for (const rule of rules) {
    const raw = rule.frontIntro
      ? trySplitFrontIntro(normalized, rule.pattern)
      : trySplitByRule(normalized, rule);
    if (raw) {
      return {
        mode: "regex",
        rule,
        ruleName: rule.name,
        chapters: raw.map((chapter) => ({
          title: chapter.title,
          paragraphs: paragraphsFromText(chapter.body),
        })),
      };
    }
  }
  return {
    mode: "chars",
    ruleName: `按字数分章（每章约 ${charsPerChapter} 字）`,
    chapters: splitTextByChars(normalized, charsPerChapter),
  };
}

#!/usr/bin/env node
/**
 * i18n 词典校验（`pnpm run i18n:check`）。
 *
 * 检查项与判定见 docs/i18n.md「校验」：
 *   1. en 是否覆盖 zh-CN 的全部 key（tsc 也保证，这里再兜一层，且不需要走一遍类型检查）；
 *   2. 同一个 key 是否在多个模块文件里重复定义（跨文件重复会被后展开的模块静默覆盖）；
 *   3. 中英占位符集合是否一致；
 *   4. `_one` / `_other` 变体是否有对应的基础 key；
 *   5. 定义了但代码里没用到的 key（提示，不算失败）；
 *   6. `src/` 里疑似漏改的硬编码中文（JSX 文本与常见属性算失败，日志行跳过）。
 *
 * 词典模块都是自包含的纯字面量对象，直接用 Node 的类型擦除 import 即可，
 * 因此本脚本没有任何依赖，也不需要先跑构建。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOCALES_DIR = join(ROOT, "src/lib/i18n/locales");
const SRC_DIR = join(ROOT, "src");
const CJK = /[\u4e00-\u9fff]/;
/** 复数变体后缀（英语按需提供） */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

const problems = [];
const warnings = [];
const fail = (message) => problems.push(message);
const warn = (message) => warnings.push(message);

/** 从汇总文件里取模块名（`import { x } from "./zh-CN/x"`），保证与运行时汇总的是同一批文件 */
function localeModules() {
  const source = readFileSync(join(LOCALES_DIR, "zh-CN.ts"), "utf8");
  const names = [...source.matchAll(/from "\.\/zh-CN\/([\w-]+)"/g)].map(
    (match) => match[1],
  );
  if (names.length === 0) fail("locales/zh-CN.ts 里没有解析到任何模块");
  return names;
}

async function loadTable(locale, name) {
  const file = join(LOCALES_DIR, locale, `${name}.ts`);
  const module = await import(pathToFileURL(file).href);
  const table = module[name];
  if (!table || typeof table !== "object") {
    fail(`${relative(ROOT, file)} 没有导出 ${name} 对象`);
    return {};
  }
  return table;
}

/** 模板里的占位符名，排序后便于比较 */
function placeholders(template) {
  return [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

async function collect() {
  const zh = new Map();
  const en = new Map();
  for (const name of localeModules()) {
    for (const [key, value] of Object.entries(await loadTable("zh-CN", name))) {
      if (zh.has(key)) fail(`zh-CN 重复 key：${key}（${zh.get(key).module} 与 ${name}）`);
      zh.set(key, { value, module: name });
    }
    for (const [key, value] of Object.entries(await loadTable("en", name))) {
      if (en.has(key)) fail(`en 重复 key：${key}（${en.get(key).module} 与 ${name}）`);
      en.set(key, { value, module: name });
    }
  }
  return { zh, en };
}

function checkCoverage(zh, en) {
  for (const key of zh.keys()) {
    if (!en.has(key)) fail(`en 缺少文案：${key}`);
  }
  for (const key of en.keys()) {
    if (zh.has(key)) continue;
    const base = key.replace(PLURAL_SUFFIX, "");
    if (!zh.has(base)) fail(`en 多出无法对应的 key：${key}`);
  }
}

function checkPlaceholders(zh, en) {
  for (const [key, zhEntry] of zh) {
    const enEntry = en.get(key);
    if (!enEntry) continue;
    const expected = placeholders(zhEntry.value);
    const actual = placeholders(enEntry.value);
    if (expected.join(",") !== actual.join(",")) {
      fail(
        `占位符不一致：${key}\n    zh-CN: {${expected.join("} {")}}\n    en:    {${actual.join("} {")}}`,
      );
    }
  }
  for (const [key, enEntry] of en) {
    const suffix = key.match(PLURAL_SUFFIX)?.[0];
    if (!suffix) continue;
    const base = key.slice(0, -suffix.length);
    const zhEntry = zh.get(base);
    if (!zhEntry) {
      fail(`复数变体缺少基础 key：${key}`);
      continue;
    }
    const allowed = new Set(placeholders(zhEntry.value));
    const extra = placeholders(enEntry.value).filter((name) => !allowed.has(name));
    if (extra.length > 0) {
      fail(`复数变体 ${key} 用了基础文案没有的占位符：${extra.join(", ")}`);
    }
  }
}

/** 代码里出现过的 key（`t("x")` / `labelKey: "x"` / 字符串里出现过都算用了） */
function usedKeys(sources) {
  const used = new Set();
  for (const source of sources.values()) {
    for (const match of source.matchAll(/"([\w.-]+)"/g)) used.add(match[1]);
  }
  return used;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(path)) out.push(path);
  }
  return out;
}

/**
 * 硬编码中文扫描：只认「真正会渲染出去」的中文 ——
 * 用行内分词器把字符串字面量、正则字面量、注释（含 JSX 注释块）分开：
 *   · 字符串之外还有中文（去掉正则与注释后）→ JSX 文本节点，算失败；
 *   · 只在字符串里出现的中文 → 可能是漏改的兜底文案（`?? "未知错误"`），列成提示；
 *   · 注释与正则里的中文（`// 说明`、`/^(封面|cover)$/`）一律忽略 —— 它们本就是中文。
 * `log.*` / `console.*` 所在行整体跳过（日志保持中文）。
 */
function scanLine(line, state) {
  let code = "";
  let strings = "";
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    const next = line[index + 1];
    if (state.block) {
      if (char === "*" && next === "/") {
        state.block = false;
        index += 2;
      } else index += 1;
      continue;
    }
    if (state.jsxComment) {
      if (char === "*" && next === "/") {
        state.jsxComment = false;
        index += 2;
      } else index += 1;
      continue;
    }
    if (state.template) {
      strings += char;
      if (char === "\\") {
        strings += next ?? "";
        index += 2;
        continue;
      }
      if (char === "`") state.template = false;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") break; // 行尾注释
    if (char === "/" && next === "*") {
      state.block = true;
      index += 2;
      continue;
    }
    if (char === "{" && next === "/" && line[index + 2] === "*") {
      state.jsxComment = true;
      index += 3;
      continue;
    }
    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < line.length && line[end] !== char) {
        if (line[end] === "\\") end += 1;
        end += 1;
      }
      strings += line.slice(index, Math.min(end + 1, line.length));
      index = end + 1;
      continue;
    }
    if (char === "`") {
      state.template = true;
      strings += char;
      index += 1;
      continue;
    }
    // 正则字面量：前一个非空字符不像「值」时才算正则（`= /x/`、`(/x/)`、`return /x/`）
    if (char === "/" && /(^|[=(,:;[!&|?{}]|\breturn|\btypeof)$/.test(code.trimEnd())) {
      let end = index + 1;
      let inClass = false;
      while (end < line.length) {
        const current = line[end];
        if (current === "\\") end += 1;
        else if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) break;
        end += 1;
      }
      index = line[end] === "/" ? end + 1 : end;
      continue;
    }
    code += char;
    index += 1;
  }
  return { code, strings };
}

function checkHardcodedCjk() {
  const files = walk(SRC_DIR).filter(
    (path) => !path.includes(`${join("src", "lib", "i18n", "locales")}`),
  );
  const jsxHits = [];
  const stringHits = [];
  for (const path of files) {
    const lines = readFileSync(path, "utf8").split("\n");
    const state = { block: false, jsxComment: false, template: false };
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (state.template) {
        // 跨行模板字面量：整行按字符串看待
        if (CJK.test(line)) stringHits.push(`${relative(ROOT, path)}:${index + 1}  ${trimmed}`);
        const closers = (line.match(/(?<!\\)`/g) ?? []).length;
        if (closers % 2 === 1) state.template = false;
        return;
      }
      if (state.block || state.jsxComment) {
        // 注释续行：只维护状态
        if (state.block && trimmed.includes("*/")) state.block = false;
        if (state.jsxComment && trimmed.includes("*/")) state.jsxComment = false;
        return;
      }
      // 每一行都要过一遍分词器：即使本行没有中文，也要正确推进「块注释 / 模板串」状态
      const { code, strings } = scanLine(line, state);
      if (!CJK.test(line)) return;
      if (/\b(?:log|console)\.\w+\(/.test(line)) return;
      const where = `${relative(ROOT, path)}:${index + 1}`;
      if (CJK.test(code)) {
        jsxHits.push(`${where}  ${trimmed}`);
        return;
      }
      // 属性上的中文一定是界面文案（`aria-label="…"` 等），不只是提示；
      // 但要排除同名局部变量声明（`let title = "开篇"` 这类哨兵值不是界面文案）
      const isDeclaration = /\b(?:let|const|var)\s+(?:\w+\s*,\s*)*[\w$]*\b(?:label|title|placeholder|desc|errorText|backLabel|subtitle)\s*=/.test(
        line,
      );
      if (
        !isDeclaration &&
        /(?:^|[^\w.$])(?:label|title|placeholder|aria-label|alt|desc|errorText|backLabel|subtitle)\s*=\s*["'`][^"'`]*[\u4e00-\u9fff]/.test(
          line,
        )
      ) {
        jsxHits.push(`${where}  ${trimmed}`);
        return;
      }
      if (CJK.test(strings)) stringHits.push(`${where}  ${trimmed}`);
    });
  }
  for (const hit of jsxHits) fail(`疑似漏改的界面中文：${hit}`);
  // 默认只列前 40 条；`I18N_CHECK_ALL=1` 时全列（复核用）
  const limit = process.env.I18N_CHECK_ALL ? stringHits.length : 40;
  for (const hit of stringHits.slice(0, limit)) warn(`字符串里的中文，请确认是否文案：${hit}`);
  if (stringHits.length > limit) warn(`……另有 ${stringHits.length - limit} 处，见上方规律`);
  return { jsxHits: jsxHits.length, stringHits: stringHits.length };
}

/**
 * 英文词典里残留的中文：除了语言名（语言用自身语言书写）与刻意保留的 CJK 标记之外，
 * 都说明这条没翻译（或复制粘贴时忘了改）。
 */
const CJK_IN_EN_ALLOWED = new Set([
  "app.language.zhCN", // 语言名用自身语言书写
  "chapterRules.builtin.zhChapter", // 说明内置正则匹配什么，保留 CJK 标记
  "chapterRules.builtin.zhVolume",
]);

function checkUntranslatedEn(zh, en) {
  const cjk = /[\u4e00-\u9fff]/;
  const leftovers = [...zh.keys()].filter(
    (key) => !CJK_IN_EN_ALLOWED.has(key) && cjk.test(en.get(key)?.value ?? ""),
  );
  if (leftovers.length > 0) {
    warn(`英文词典里仍有中文（确认是否漏翻）：${leftovers.join(", ")}`);
  }
}

/** 用了 {count} 却没给英语复数变体的 key：可能是漏了 _one / _other，也可能英文不需要变化 */
function checkPluralCoverage(zh, en) {
  const missing = [];
  for (const [key, zhEntry] of zh) {
    if (!zhEntry.value.includes("{count}")) continue;
    if (en.has(`${key}_one`) || en.has(`${key}_other`)) continue;
    missing.push(key);
  }
  if (missing.length > 0) {
    warn(
      `含 {count} 但没有 _one / _other 变体（英文名词若不随数量变化可忽略）：${missing.join(", ")}`,
    );
  }
}

async function main() {
  const { zh, en } = await collect();
  checkCoverage(zh, en);
  checkPlaceholders(zh, en);
  checkPluralCoverage(zh, en);
  checkUntranslatedEn(zh, en);

  const sources = new Map(walk(SRC_DIR).map((path) => [path, readFileSync(path, "utf8")]));
  const used = usedKeys(sources);
  const unused = [...zh.keys()].filter((key) => !used.has(key));
  for (const key of unused) warn(`未被引用的 key：${key}`);

  const { jsxHits, stringHits } = checkHardcodedCjk();

  const perModule = new Map();
  for (const { module } of zh.values()) {
    perModule.set(module, (perModule.get(module) ?? 0) + 1);
  }
  const summary = [...perModule.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ${count}`)
    .join("，");
  console.log(`文案：zh-CN ${zh.size} 条，en 基础 key ${[...en.keys()].filter((k) => !PLURAL_SUFFIX.test(k)).length} 条（含复数变体共 ${en.size} 条）`);
  console.log(`分布：${summary}`);
  console.log(`未引用：${unused.length} 条；硬编码中文：JSX ${jsxHits} 处、字符串 ${stringHits} 处`);

  if (warnings.length > 0) {
    console.log(`\n提示（${warnings.length}）：`);
    for (const message of warnings) console.log(`  · ${message}`);
  }
  if (problems.length > 0) {
    console.error(`\n错误（${problems.length}）：`);
    for (const message of problems) console.error(`  ✗ ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log("\ni18n 词典校验通过");
}

await main();

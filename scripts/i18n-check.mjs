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
 * 硬编码中文扫描：块注释与行注释跳过，`log.*` / `console.*` 所在行跳过（日志保持中文）。
 * 去掉字符串字面量后仍有中文 → JSX 文本，算失败；中文只在字符串里 → 可能仍是漏改
 * （如 `?? "未知错误"`），列成提示人工确认。
 */
function checkHardcodedCjk() {
  const files = walk(SRC_DIR).filter(
    (path) => !path.includes(`${join("src", "lib", "i18n", "locales")}`),
  );
  const jsxHits = [];
  const stringHits = [];
  for (const path of files) {
    const lines = readFileSync(path, "utf8").split("\n");
    let inBlockComment = false;
    let inTemplate = false;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      let text = line;
      if (inBlockComment) {
        if (trimmed.includes("*/")) inBlockComment = false;
        return;
      }
      if (inTemplate) {
        // 跨行模板字面量：整行按字符串看待，是否文案交给人判断
        if (CJK.test(text)) {
          stringHits.push(`${relative(ROOT, path)}:${index + 1}  ${trimmed}`);
        }
        if ((text.match(/(?<!\\)`/g) ?? []).length % 2 === 1) inTemplate = false;
        return;
      }
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlockComment = true;
        return;
      }
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      // JSX 注释 {/* … */}：整个注释块都不是界面文案
      text = text.replace(/\{\/\*.*?\*\/\}/g, "");
      if (trimmed.startsWith("{/*") && !trimmed.includes("*/")) return;
      if (/\b(?:log|console)\.\w+\(/.test(text)) return;
      if (!CJK.test(text)) return;
      const where = `${relative(ROOT, path)}:${index + 1}`;
      // 常见属性上的硬编码文案：几乎一定是漏改
      if (
        /\b(?:label|title|placeholder|aria-label|alt|desc|errorText|backLabel|subtitle)\s*=\s*"[^"]*[\u4e00-\u9fff]/.test(
          text,
        )
      ) {
        jsxHits.push(`${where}  ${trimmed}`);
        return;
      }
      // 去掉字符串 / 模板字面量后还剩中文 → JSX 文本节点
      const withoutStrings = text
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/`(?:[^`\\]|\\.)*`/g, "``");
      if (CJK.test(withoutStrings)) {
        jsxHits.push(`${where}  ${trimmed}`);
        return;
      }
      // 字符串里的中文：日志之外仍可能是文案（默认值 / 三元兜底）
      stringHits.push(`${where}  ${trimmed}`);
      // 本行开了跨行模板字面量：后续行按字符串看待
      if ((text.match(/(?<!\\)`/g) ?? []).length % 2 === 1) inTemplate = true;
    });
  }
  for (const hit of jsxHits) fail(`疑似漏改的界面中文：${hit}`);
  for (const hit of stringHits.slice(0, 40)) warn(`字符串里的中文，请确认是否文案：${hit}`);
  if (stringHits.length > 40) warn(`……另有 ${stringHits.length - 40} 处，见上方规律`);
  return { jsxHits: jsxHits.length, stringHits: stringHits.length };
}

async function main() {
  const { zh, en } = await collect();
  checkCoverage(zh, en);
  checkPlaceholders(zh, en);

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

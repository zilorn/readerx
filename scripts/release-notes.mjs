#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 中提取指定版本的发布说明（作为 GitHub Release body）。
 *
 * 用法：
 *   node scripts/release-notes.mjs 1.2.3
 *   node scripts/release-notes.mjs v1.2.3     # 兼容带 v 前缀的 tag
 *
 * 匹配规则（Keep a Changelog 风格，均可带可选的“ - YYYY-MM-DD”日期）：
 *   ## [1.2.3]
 *   ## [v1.2.3] - 2026-09-04
 *   ## 1.2.3
 *   等变体；取该标题到下一个二级标题（^## ）之间的内容输出到 stdout。
 *
 * 未找到对应区块时以非零码退出，便于 CI 提前失败。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEADING_RE = /^##\s+(.*)$/;

/**
 * 归一化版本标题：去掉首尾空白、可选包裹方括号、可选“ - YYYY-MM-DD”日期与可选 v 前缀。
 * 例："[v1.2.3] - 2026-09-04" -> "1.2.3"
 */
function normalize(value) {
  return value
    .trim()
    .replace(/\s*-\s*\d{4}-\d{2}-\d{2}\s*$/, "")
    .replace(/^\[/, "")
    .replace(/\]\s*$/, "")
    .replace(/^v/i, "")
    .trim();
}

function usage() {
  console.error("用法: node scripts/release-notes.mjs <版本号>");
  console.error("示例: node scripts/release-notes.mjs 1.2.3");
}

const target = process.argv[2];
if (!target) {
  usage();
  process.exit(2);
}

let changelog;
try {
  changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
} catch (error) {
  console.error(`✗ 无法读取 CHANGELOG.md：${error.message}`);
  process.exit(1);
}

const wanted = normalize(target);
const lines = changelog.split(/\r?\n/);

let start = -1;
for (let i = 0; i < lines.length; i++) {
  const match = HEADING_RE.exec(lines[i]);
  if (match && normalize(match[1]) === wanted) {
    start = i + 1;
    break;
  }
}

if (start === -1) {
  const headings = lines
    .map((line, i) => HEADING_RE.exec(line) && { i, title: HEADING_RE.exec(line)[1].trim() })
    .filter(Boolean)
    .map(({ i, title }) => `${i + 1}: ${title}`)
    .join("\n");
  console.error(`✗ CHANGELOG.md 中未找到版本 ${wanted} 对应的区块。`);
  console.error("  请在 CHANGELOG.md 中添加形如 `## [1.2.3] - YYYY-MM-DD` 的标题。");
  if (headings) {
    console.error(`  现有二级标题：\n${headings}`);
  }
  process.exit(1);
}

const body = [];
for (let i = start; i < lines.length && !HEADING_RE.test(lines[i]); i++) {
  body.push(lines[i]);
}

// 过滤 changelog 底部的版本链接引用定义（形如 `[1.2.3]: https://...`），它们不属于正文。
const LINK_REF_RE = /^\[\s*[^\]\n]+\s*\]:\s*\S+\s*$/;
const text = body.filter((line) => !LINK_REF_RE.test(line)).join("\n").trim();
if (!text) {
  console.error(`✗ CHANGELOG.md 中版本 ${wanted} 的区块为空。`);
  process.exit(1);
}

process.stdout.write(`${text}\n`);

#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 中提取指定版本的发布说明（作为 GitHub Release body）。
 *
 * 用法：
 *   node scripts/release-notes.mjs 1.2.3
 *   node scripts/release-notes.mjs v1.2.3     # 兼容带 v 前缀的 tag
 *
 * 输出 = `scripts/tip.md`（下载与安装说明：各平台 / 架构怎么选、签名情况）+ CHANGELOG 对应区块。
 * 安装说明与产物形态绑定（新增平台、换打包方式、改签名策略都要改它），放在这里是为了
 * 让这类文案改动不必进工作流；拼接口径固定为「说明在前、更新内容在后」。
 *
 * 匹配规则（Keep a Changelog 风格，均可带可选的“ - YYYY-MM-DD”日期）：
 *   ## [1.2.3]
 *   ## [v1.2.3] - 2026-09-04
 *   ## 1.2.3
 *   等变体；取该标题到下一个二级标题（^## ）之间的内容输出到 stdout。
 *
 * 版本区块缺失时**回退到 `## [Unreleased]`**（即「已提交但未发布」的变更，发版时忘写本版条目
 * 也能出一份真实的说明），回退会往 stderr 打一条告警，便于在 CI 日志里发现漏写的条目。
 * 连 Unreleased 也没有（或该区块为空）时以非零码退出，便于 CI 提前失败。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEADING_RE = /^##\s+(.*)$/;
// changelog 底部的版本链接引用定义（形如 `[1.2.3]: https://...`），它们不属于正文。
const LINK_REF_RE = /^\[\s*[^\]\n]+\s*\]:\s*\S+\s*$/;
// Keep a Changelog 约定里「已提交但未发布」的固定落点，版本区块缺失时回退到它。
const UNRELEASED_RE = /^unreleased$/i;

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
if (!wanted) {
  console.error(`✗ 版本号无效：${target}`);
  process.exit(2);
}

const lines = changelog.split(/\r?\n/);

/** 按行序返回第一个满足 predicate 的二级标题所在行号（predicate 收到归一化后的标题），无则 -1。 */
function findHeading(predicate) {
  for (let i = 0; i < lines.length; i++) {
    const match = HEADING_RE.exec(lines[i]);
    if (match && predicate(normalize(match[1]))) {
      return i;
    }
  }
  return -1;
}

/**
 * 取标题行到下一个二级标题之间的正文，去掉不属于正文的链接引用定义，空行已裁剪。
 * 正文里只剩小标题（例如没写条目的 `### Added`）时同样返回空串 —— 否则回退到 [Unreleased] 会
 * 发出一份只有小标题、没有内容的说明。
 */
function sectionText(headingIndex) {
  const body = [];
  for (let i = headingIndex + 1; i < lines.length && !HEADING_RE.test(lines[i]); i++) {
    body.push(lines[i]);
  }
  const meaningful = body.some((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !/^#{1,6}\s/.test(trimmed);
  });
  if (!meaningful) {
    return "";
  }
  return body.filter((line) => !LINK_REF_RE.test(line)).join("\n").trim();
}

// 先按版本号精确匹配；找不到再退到 [Unreleased]（忘写本版条目时，Release 仍能拿到一份真实的
// 变更说明）。回退只是兜底，仍会告警提醒补写条目。
let fallback = false;
let headingIndex = findHeading((title) => title === wanted);
if (headingIndex === -1) {
  headingIndex = findHeading((title) => UNRELEASED_RE.test(title));
  fallback = headingIndex !== -1;
}

if (headingIndex === -1) {
  const headings = lines
    .map((line, i) => {
      const match = HEADING_RE.exec(line);
      return match ? `${i + 1}: ${match[1].trim()}` : null;
    })
    .filter(Boolean)
    .join("\n");
  console.error(`✗ CHANGELOG.md 中未找到版本 ${wanted} 对应的区块，也没有可回退的 [Unreleased]。`);
  console.error("  请在 CHANGELOG.md 中添加形如 `## [1.2.3] - YYYY-MM-DD` 的标题。");
  if (headings) {
    console.error(`  现有二级标题：\n${headings}`);
  }
  process.exit(1);
}

const text = sectionText(headingIndex);
if (!text) {
  console.error(
    fallback
      ? `✗ CHANGELOG.md 中未找到版本 ${wanted} 对应的区块，用于回退的 [Unreleased] 也是空的。`
      : `✗ CHANGELOG.md 中版本 ${wanted} 的区块为空。`,
  );
  process.exit(1);
}

if (fallback) {
  const heading = lines[headingIndex].trim();
  console.error(`⚠ CHANGELOG.md 中未找到版本 ${wanted} 对应的区块，已回退到 ${heading}。`);
  console.error(`  建议补写 \`## [${wanted}] - YYYY-MM-DD\` 后再发版。`);
}

const t = readFileSync(join(ROOT, "scripts", "tip.md"), "utf-8");

process.stdout.write(`${t}\n${text}\n`);

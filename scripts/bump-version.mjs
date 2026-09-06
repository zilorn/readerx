#!/usr/bin/env node
/**
 * 一键同步 ReaderX 版本号
 *
 * 单一输入同步多处来源，避免版本号漂移：
 *   - package.json
 *   - src-tauri/tauri.conf.json
 *   - src-tauri/Cargo.toml
 *   - src-tauri/Cargo.lock
 *   - CHANGELOG.md（仅正式版本）
 *
 * 用法：
 *   node scripts/bump-version.mjs 0.3.0   # 显式指定新版本（语义化版本）
 *   node scripts/bump-version.mjs patch   # 相对当前版本递进：patch | minor | major
 *
 * 说明：
 *   - 新版本为正式版本（无预发布后缀，如 0.1.3 而非 0.1.3-beta.1）时，会同步归档
 *     CHANGELOG.md：保留顶部 [Unreleased]，把其正文移入新版本区块并取当天日期——
 *       ## [0.1.3] - YYYY-MM-DD
 *     归档后 [Unreleased] 重新留空，供继续记录改动；预发布版本只改版本来源，不动 CHANGELOG.md。
 *   - 若当前版本带预发布后缀（如 0.1.0-beta.1），`patch` 会收敛为正式版本 0.1.0，
 *     与 `npm version patch` 语义一致；
 *   - Cargo 不支持 semver 的 build metadata（+xxx），此类输入会被拒绝。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const KINDS = new Set(["major", "minor", "patch"]);

const MANIFESTS = {
  "package.json": true,
  [join("src-tauri", "tauri.conf.json")]: true,
};

function read(file) {
  return readFileSync(join(ROOT, file), "utf8");
}

function write(file, content) {
  writeFileSync(join(ROOT, file), content);
}

function updateJson(file, version) {
  const full = join(ROOT, file);
  const obj = JSON.parse(readFileSync(full, "utf8"));
  obj.version = version;
  writeFileSync(full, `${JSON.stringify(obj, null, 2)}\n`);
}

function bumpKind(current, kind) {
  const core = current.split("-")[0];
  const [maj, min, pat] = core.split(".").map(Number);
  if (current.includes("-") && kind === "patch") return core;
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function replaceCargoToml(version) {
  const full = join(ROOT, "src-tauri", "Cargo.toml");
  const lines = read("src-tauri/Cargo.toml").split("\n");
  let inPackage = false;
  let hit = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\[package\]/.test(line)) {
      inPackage = true;
      continue;
    }
    if (inPackage && /^\[/.test(line)) break; // 离开 [package] 区块
    if (inPackage && /^version\s*=\s*"/.test(line)) {
      lines[i] = `version = "${version}"`;
      hit = true;
      break;
    }
  }
  if (!hit) {
    console.error(`✗ ${full} 中未找到 [package] 区块的 version 字段`);
    process.exit(1);
  }
  write("src-tauri/Cargo.toml", `${lines.join("\n")}\n`);
}

function replaceCargoLock(version) {
  const full = join(ROOT, "src-tauri", "Cargo.lock");
  const lines = read("src-tauri/Cargo.lock").split("\n");
  let hit = false;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i] === "[[package]]" && lines[i + 1] === 'name = "readerx"') {
      // Cargo.lock 固定格式：name 之后紧跟 version
      const verIdx = i + 2;
      if (!/^version = "/.test(lines[verIdx] ?? "")) {
        console.error(`✗ ${full} 中 readerx 条目格式异常`);
        process.exit(1);
      }
      lines[verIdx] = `version = "${version}"`;
      hit = true;
      break;
    }
  }
  if (!hit) {
    console.error(`✗ ${full} 中未找到 name = "readerx" 的 [[package]] 条目`);
    process.exit(1);
  }
  write("src-tauri/Cargo.lock", `${lines.join("\n")}\n`);
}

/** 当天日期，格式 YYYY-MM-DD */
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 把 CHANGELOG.md 顶部 [Unreleased] 的正文归档到 `## [version] - date` 区块：
 * [Unreleased] 标题保留并清空，新版本区块插在其后、排在旧版本之前。
 * 找不到 [Unreleased] 返回 null，否则返回改写后的完整内容。
 */
function archiveUnreleased(content, version, date) {
  const heading = "## [Unreleased]";
  const uIdx = content.indexOf(heading);
  if (uIdx === -1) return null;

  const head = content.slice(0, uIdx); // 文件头（含标题前的空行）
  const tail = content.slice(uIdx + heading.length); // 标题行之后的所有内容
  const nextIdx = tail.search(/\n## /); // 下一个二级标题（已发布版本 / 文件尾）
  const body = (nextIdx === -1 ? tail : tail.slice(0, nextIdx)).trim();
  const rest =
    nextIdx === -1 ? "" : content.slice(uIdx + heading.length + nextIdx + 1);

  let out = `${head}${heading}\n\n## [${version}] - ${date}`;
  if (body) out += `\n\n${body}`;
  if (rest) out += `\n\n${rest}`;
  return `${out.replace(/\s+$/, "")}\n`;
}

/** 正式发版：把 CHANGELOG.md 的 [Unreleased] 归档到指定版本（当天日期） */
function releaseChangelog(version) {
  const file = "CHANGELOG.md";
  const next = archiveUnreleased(read(file), version, today());
  if (next === null) {
    console.error(`✗ ${file} 中未找到 "## [Unreleased]" 区块，无法归档`);
    process.exit(1);
  }
  write(file, next);
  console.log(`✓ ${file}  [Unreleased] 已归档 -> [${version}] - ${today()}`);
}

function usage(current) {
  console.log(
    [
      "用法: node scripts/bump-version.mjs <major|minor|patch|版本号>",
      `当前版本: ${current}`,
      "示例: node scripts/bump-version.mjs 0.3.0",
    ].join("\n"),
  );
}

const arg = process.argv[2];
const current = JSON.parse(read("package.json")).version;

if (!arg) {
  usage(current);
  process.exit(1);
}

let next;
if (KINDS.has(arg)) {
  next = bumpKind(current, arg);
} else if (SEMVER.test(arg)) {
  next = arg;
} else {
  console.error(
    `✗ 非法版本 "${arg}"：需要 major|minor|patch 或形如 0.3.0 / 1.2.0-beta.1 的语义化版本（Cargo 不支持 +build 元数据）`,
  );
  process.exit(1);
}

if (next === current) {
  console.log(`版本未变化，跳过（当前即为 ${current}）`);
  process.exit(0);
}

// 正式版本（无预发布后缀）才归档 CHANGELOG；先校验，避免版本已改才报错
const isRelease = !next.includes("-");
if (isRelease && !read("CHANGELOG.md").includes("## [Unreleased]")) {
  console.error(`✗ CHANGELOG.md 中未找到 "## [Unreleased]" 区块，正式发版前需在其中记录本次改动`);
  process.exit(1);
}

updateJson("package.json", next);
updateJson(join("src-tauri", "tauri.conf.json"), next);
replaceCargoToml(next);
replaceCargoLock(next);

for (const file of Object.keys(MANIFESTS)) {
  console.log(`✓ ${file}  ${current} -> ${next}`);
}
console.log(`✓ ${join("src-tauri", "Cargo.toml")}   ${current} -> ${next}`);
console.log(`✓ ${join("src-tauri", "Cargo.lock")}   ${current} -> ${next}`);
if (isRelease) releaseChangelog(next);
console.log("\n提示：设置页显示的是运行中二进制的真实版本，重新构建（pnpm build / pnpm tauri build）后生效。");

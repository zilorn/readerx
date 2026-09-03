#!/usr/bin/env node
/**
 * 一键同步 ReaderX 版本号
 *
 * 单一输入同步四处来源，避免版本号漂移：
 *   - package.json
 *   - src-tauri/tauri.conf.json
 *   - src-tauri/Cargo.toml
 *   - src-tauri/Cargo.lock
 *
 * 用法：
 *   node scripts/bump-version.mjs 0.3.0   # 显式指定新版本（语义化版本）
 *   node scripts/bump-version.mjs patch   # 相对当前版本递进：patch | minor | major
 *
 * 说明：
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

updateJson("package.json", next);
updateJson(join("src-tauri", "tauri.conf.json"), next);
replaceCargoToml(next);
replaceCargoLock(next);

for (const file of Object.keys(MANIFESTS)) {
  console.log(`✓ ${file}  ${current} -> ${next}`);
}
console.log(`✓ ${join("src-tauri", "Cargo.toml")}   ${current} -> ${next}`);
console.log(`✓ ${join("src-tauri", "Cargo.lock")}   ${current} -> ${next}`);
console.log("\n提示：设置页显示的是运行中二进制的真实版本，重新构建（pnpm build / pnpm tauri build）后生效。");

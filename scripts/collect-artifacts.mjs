#!/usr/bin/env node
/**
 * 收集构建产物并统一改名（三条工作流的唯一起名口径）
 *
 * 命名：`<应用名>-<版本>-<平台>-<架构>[-setup][-debug].<扩展名>`
 *   Linux   readerx-0.2.0-linux-x86_64.AppImage / .deb / .rpm
 *   Windows readerx-0.2.0-windows-x86_64-setup.exe、readerx-0.2.0-windows-aarch64-setup.exe
 *   Android readerx-0.2.0-android-arm64-v8a.apk（debug 变体为 …-android-universal-debug.apk）
 *
 * 为什么不直接用 Tauri 的产物名：它只带架构、不带平台
 * （`readerx_0.2.0_amd64.AppImage`、`readerx_0.2.0_x64-setup.exe`），Release 的下载列表里
 * 看不出哪份是 Linux、哪份是 Windows，Android 的 APK 同理。平台与架构都写进文件名，
 * 用户按名字就能选对包；Actions artifact 与 Release 资产也因此同名同源。
 *
 * 用法：
 *   node scripts/collect-artifacts.mjs desktop --target x86_64-unknown-linux-gnu --out <目录>
 *   node scripts/collect-artifacts.mjs android --out <目录>
 *   node scripts/collect-artifacts.mjs android --debug --out <目录>
 *
 * 参数：
 *   desktop | android   产物来源（前者读 Tauri bundle，后者读 Gradle 的 APK 输出）
 *   --target <三元组>   desktop 必填，平台与架构都从三元组解析（如 aarch64-pc-windows-msvc）
 *   --target-dir <目录> desktop 的 target 根目录，默认 src-tauri/target
 *   --out <目录>        产物输出目录，不存在则创建
 *   --debug             android 收集 debug 变体（默认 release）
 *
 * 收不到任何产物、或 release APK 未签名时以非零码退出：宁可让工作流失败，
 * 也不要让用户拿到一份名字对不上内容的包。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "src-tauri", "tauri.conf.json");

/** 三元组里的系统段 -> 文件名里的平台段；只列本项目会出包的平台 */
const PLATFORMS = { linux: "linux", windows: "windows" };

/** desktop 认得的 bundle 产物（Tauri 的 NSIS 包是 `-setup.exe`，没有可单独识别的扩展名） */
const DESKTOP_TAILS = [".AppImage", ".deb", ".rpm", "-setup.exe"];

/** Gradle 的 flavor 目录名 -> APK 文件名里的 ABI 段 */
const ANDROID_ABIS = {
  universal: "universal",
  arm64: "arm64-v8a",
  arm: "armeabi-v7a",
  x86: "x86",
  x86_64: "x86_64",
};

/** release 必须出齐这四个 ABI（`--split-per-abi` 的产物），少一个就说明构建不完整 */
const ANDROID_RELEASE_FLAVORS = ["arm64", "arm", "x86", "x86_64"];

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function usage() {
  console.error("用法:");
  console.error("  node scripts/collect-artifacts.mjs desktop --target <Rust 三元组> --out <目录>");
  console.error("  node scripts/collect-artifacts.mjs android [--debug] --out <目录>");
}

/** 解析命令行；未知参数直接报错，避免工作流里写错参数却静默少收产物 */
function parseArgs(argv) {
  const options = {
    mode: argv[0],
    debug: false,
    target: "",
    targetDir: join(ROOT, "src-tauri", "target"),
    out: "",
  };

  if (options.mode !== "desktop" && options.mode !== "android") {
    usage();
    fail(`未知的产物来源 "${options.mode ?? ""}"（只支持 desktop / android）`);
  }

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--debug") {
      options.debug = true;
      continue;
    }
    if (arg !== "--target" && arg !== "--target-dir" && arg !== "--out") fail(`未知参数 "${arg}"`);
    const value = argv[++i];
    if (!value) fail(`${arg} 缺少取值`);
    if (arg === "--target") options.target = value;
    else if (arg === "--target-dir") options.targetDir = value;
    else options.out = value;
  }

  if (!options.out) fail("缺少 --out <目录>");
  if (options.mode === "desktop" && !options.target) fail("desktop 需要 --target <Rust 三元组>");
  if (options.mode === "desktop" && options.debug) fail("--debug 只适用于 android");
  if (options.mode === "android" && options.target) fail("--target 只适用于 desktop");
  return options;
}

/** Tauri 的 bundle 目录：bundle/<打包方式>/<产物文件>，各打包方式互不覆盖 */
function desktopArtifacts(targetDir, target) {
  const bundleDir = join(targetDir, target, "release", "bundle");
  if (!existsSync(bundleDir)) fail(`未找到 bundle 目录 ${relative(ROOT, bundleDir)}`);

  const found = [];
  for (const kind of readdirSync(bundleDir).sort()) {
    const kindDir = join(bundleDir, kind);
    if (!statSync(kindDir).isDirectory()) continue;
    for (const name of readdirSync(kindDir).sort()) {
      const file = join(kindDir, name);
      if (!statSync(file).isFile()) continue;
      const tail = DESKTOP_TAILS.find((candidate) => name.endsWith(candidate));
      if (tail) found.push({ file, tail });
    }
  }
  if (found.length === 0) {
    fail(`${relative(ROOT, bundleDir)} 下没有 ${DESKTOP_TAILS.join(" / ")} 产物，检查构建是否成功`);
  }
  return found;
}

/**
 * Gradle 的 APK 输出目录：apk/<flavor>/<debug|release>/<文件>。
 * debug 变体按实际存在的 flavor 收（`--apk` 出 universal，指定单一目标时只出那一个 ABI）；
 * release 变体要求四个 ABI 齐全，且不接受未签名产物 —— 签名没接上要当场失败。
 */
function androidArtifacts(debug) {
  const apkDir = join(ROOT, "src-tauri", "gen", "android", "app", "build", "outputs", "apk");
  if (!existsSync(apkDir)) fail(`未找到 APK 输出目录 ${relative(ROOT, apkDir)}`);

  const flavors = debug
    ? readdirSync(apkDir)
        .filter((name) => ANDROID_ABIS[name] && existsSync(join(apkDir, name, "debug")))
        .sort()
    : ANDROID_RELEASE_FLAVORS;

  const found = [];
  for (const flavor of flavors) {
    const variant = debug ? "debug" : "release";
    const variantDir = join(apkDir, flavor, variant);
    const abi = ANDROID_ABIS[flavor];
    if (!existsSync(variantDir)) {
      fail(`未找到 ${abi} 的 ${variant} 产物目录（期望 ${relative(ROOT, variantDir)}），检查打包参数`);
    }
    if (!debug && existsSync(join(variantDir, `app-${flavor}-release-unsigned.apk`))) {
      fail(
        `${abi} 产物未签名（app-${flavor}-release-unsigned.apk），` +
          "检查签名步骤与 app/build.gradle.kts 的 signingConfigs",
      );
    }
    const names = readdirSync(variantDir)
      .filter((name) => extname(name) === ".apk")
      .sort();
    const name = names.find((candidate) => candidate === `app-${flavor}-${variant}.apk`) ?? names[0];
    if (!name) fail(`未找到 ${abi} 的 ${variant} APK（期望 ${relative(ROOT, variantDir)}/*.apk）`);
    found.push({ file: join(variantDir, name), abi });
  }
  return found;
}

function humanSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const options = parseArgs(process.argv.slice(2));

let version = "";
let product = "";
try {
  const config = JSON.parse(readFileSync(CONFIG, "utf8"));
  version = config.version;
  product = config.productName;
} catch (error) {
  fail(`无法读取 ${relative(ROOT, CONFIG)}：${error.message}`);
}
if (!version || !product) fail(`${relative(ROOT, CONFIG)} 缺少 version 或 productName`);

let renames;
if (options.mode === "desktop") {
  const [arch, , system] = options.target.split("-");
  const platform = PLATFORMS[system];
  if (!arch || !platform) {
    fail(`无法从三元组 "${options.target}" 判断平台（目前只支持 ${Object.values(PLATFORMS).join(" / ")}）`);
  }
  renames = desktopArtifacts(options.targetDir, options.target).map(({ file, tail }) => ({
    file,
    name: `${product}-${version}-${platform}-${arch}${tail}`,
  }));
} else {
  const suffix = options.debug ? "-debug" : "";
  renames = androidArtifacts(options.debug).map(({ file, abi }) => ({
    file,
    name: `${product}-${version}-android-${abi}${suffix}.apk`,
  }));
}

const seen = new Set();
for (const { name } of renames) {
  if (seen.has(name)) fail(`产物重名 ${name}：命名口径需要补上区分维度`);
  seen.add(name);
}
if (renames.length === 0) fail("没有收集到任何产物，检查构建是否真的产出并落到了预期目录");

mkdirSync(options.out, { recursive: true });
for (const { file, name } of renames) {
  const dest = join(options.out, name);
  cpSync(file, dest);
  console.log(`✓ ${name}  ${humanSize(statSync(dest).size)}  <- ${relative(ROOT, file)}`);
}
console.log(`共收集 ${renames.length} 个产物到 ${options.out}`);
